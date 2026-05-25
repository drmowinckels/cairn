//! Notify-based git HEAD watcher.
//!
//! Discovers `.git/` directories under the user's configured
//! discovery roots, watches each `.git/HEAD` via the `notify` crate
//! (FSEvents on macOS, inotify on Linux, ReadDirectoryChangesW on
//! Windows), and emits `SignalEvent::Git(Some(ctx))` into the
//! snapshot stream whenever a HEAD file changes — branch switch,
//! rebase, detached-HEAD checkout, etc.
//!
//! This is the closing slice of M1 #4. The read primitives —
//! `find_git_dir`, `read_git_context`, `parse_head` — already
//! shipped in PR #53; the only thing left was the watcher itself
//! plus the discovery-roots config that feeds it.
//!
//! ## Discovery walk
//!
//! `discover_repos` walks each root up to `MAX_DEPTH` levels deep,
//! skipping the usual heavy-but-uninteresting directories
//! (`node_modules`, `target`, `.venv`, plus hidden directories
//! other than `.git` itself). Returns one path per repository: the
//! containing directory of each `.git` entry found.
//!
//! ## Active-repo selection
//!
//! The watcher emits Git events for *every* discovered repo's
//! HEAD changes. The snapshot stream driver decides whether the
//! incoming change is relevant by comparing the changed repo's
//! `repo_path` against the active IDE folder — that resolution
//! already happens in `signals::ide::derive_ide_folder` (PR #59's
//! repo-paths fallback). When the user navigates to a different
//! repo, the next window-source event re-resolves the active
//! folder and the matcher picks up the new branch from whatever
//! the watcher most-recently emitted.

use std::path::{Path, PathBuf};
use std::time::Duration;

use notify::{EventKind, RecursiveMode, Watcher};
use tokio::sync::mpsc;

use crate::signals::git::read_git_context;
use crate::signals::stream::SignalEvent;

/// Max directory levels `discover_repos` will walk down from each
/// root. A user's home directory can contain dozens of project
/// trees with their own dependency dirs (which are skipped, but
/// the walker still has to inspect them). Three levels covers
/// `~/code/<project>` and `~/work/<client>/<project>` patterns
/// without spelunking into syncthing/cloud-sync directories.
pub const MAX_DISCOVERY_DEPTH: usize = 3;

/// Directory names skipped during discovery. Always-large or
/// platform-system; rarely a repo root anyone wants tracked.
///
/// The list deliberately excludes `Library` and `Applications`
/// because those names occasionally appear as legit project
/// subdirs. The macOS-system dirs of those names sit under
/// `$HOME` only, and the discovery roots (`~/code`, `~/workspace`,
/// etc.) don't include `$HOME` directly today.
const SKIP_DIRS: &[&str] = &[
    "node_modules",
    "target",
    ".venv",
    "venv",
    "__pycache__",
    "dist",
    "build",
    "coverage",
    ".cache",
    ".cargo",
    ".rustup",
    ".npm",
    ".yarn",
    ".pnpm-store",
    "vendor",
    "bower_components",
    "Pods",
    "DerivedData",
];

/// Default discovery roots when no user config has been written.
/// Conventional dev folders that exist on most users' machines.
/// Missing roots are silently ignored — `discover_repos` walks
/// what's there.
pub fn default_discovery_roots() -> Vec<PathBuf> {
    let mut out = Vec::new();
    if let Some(home) = dirs::home_dir() {
        for name in [
            "code",
            "Code",
            "workspace",
            "Workspace",
            "projects",
            "Projects",
            "dev",
            "src",
        ] {
            let p = home.join(name);
            if p.is_dir() {
                out.push(p);
            }
        }
    }
    out
}

/// Walk `roots` and return one path per discovered repository
/// (the directory that contains `.git`, not the `.git` entry
/// itself). Caps recursion at `MAX_DISCOVERY_DEPTH` and skips the
/// directories in `SKIP_DIRS`. Hidden directories other than
/// `.git` are skipped.
pub fn discover_repos(roots: &[PathBuf]) -> Vec<PathBuf> {
    let mut out = Vec::new();
    for root in roots {
        walk(root, 0, MAX_DISCOVERY_DEPTH, &mut out);
    }
    out.sort();
    out.dedup();
    out
}

fn walk(dir: &Path, depth: usize, max_depth: usize, out: &mut Vec<PathBuf>) {
    if depth > max_depth {
        return;
    }
    // If this dir contains a `.git` (either dir or file), it's a
    // repo root. Record it and stop descending — nested repos are
    // not the common case and walking into them inflates the watch
    // count.
    let git_path = dir.join(".git");
    if git_path.exists() {
        out.push(dir.to_path_buf());
        return;
    }
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if !file_type.is_dir() {
            continue;
        }
        let name = entry.file_name();
        let Some(name_str) = name.to_str() else {
            continue;
        };
        if name_str.starts_with('.') {
            continue;
        }
        if SKIP_DIRS.iter().any(|s| s.eq_ignore_ascii_case(name_str)) {
            continue;
        }
        walk(&entry.path(), depth + 1, max_depth, out);
    }
}

/// Spawn the git watcher task given a pre-discovered list of
/// repository paths. Sets up a `notify` watcher on every
/// `.git/HEAD` and pushes a `SignalEvent::Git(Some(ctx))` into
/// the stream whenever HEAD changes. Also emits one event per
/// repo on startup so the snapshot stream picks up the *current*
/// branch immediately.
///
/// Discovery is decoupled from spawning because callers
/// (`lib.rs::setup`) need the repo list *before* the snapshot
/// stream is built (the stream takes the list for its
/// `derive_ide_folder` repo-paths fallback).
pub fn spawn_watcher_task(event_tx: mpsc::Sender<SignalEvent>, repos: Vec<PathBuf>) {
    log::info!("git_watcher: discovered {} repos", repos.len());

    // Spawn into a tokio task — the startup-emit loop does file
    // I/O on each repo's `.git/HEAD`, which would otherwise block
    // the Tauri `setup()` callback. Inside the task we also push
    // events into a tokio mpsc (try_send is non-blocking) so a
    // user with hundreds of repos doesn't stall app launch.
    tokio::spawn(async move {
        // Emit one event per repo on startup so the snapshot
        // stream has the latest branch before any user-driven
        // event arrives. Sorted by `discover_repos`, so the
        // first-arriving event is the alphabetically-first repo;
        // the snapshot stream's `LiveState.git` only retains one
        // value, so subsequent repos overwrite — that's fine
        // because the *real* active-repo determination happens
        // via the window source + `derive_ide_folder`'s repo-paths
        // fallback once the user navigates.
        for repo in &repos {
            if let Some(ctx) = read_git_context(repo) {
                if let Err(e) = event_tx.try_send(SignalEvent::Git(Some(ctx))) {
                    log::warn!("git_watcher: startup try_send dropped event: {e}");
                }
            }
        }
        if let Err(e) = run(repos, event_tx).await {
            log::warn!("git_watcher: task exited: {e}");
        }
    });
}

async fn run(
    repos: Vec<PathBuf>,
    event_tx: mpsc::Sender<SignalEvent>,
) -> Result<(), notify::Error> {
    let (notify_tx, mut notify_rx) = tokio::sync::mpsc::unbounded_channel::<notify::Event>();

    // notify v8's `recommended_watcher` takes a sync callback. We
    // wrap it to forward into a tokio channel. The callback runs
    // on notify's internal thread; sending into a tokio mpsc from
    // there is safe (the Sender is Send + Sync).
    let mut watcher =
        notify::recommended_watcher(move |res: notify::Result<notify::Event>| match res {
            Ok(ev) => {
                let _ = notify_tx.send(ev);
            }
            Err(e) => log::warn!("git_watcher: notify error: {e}"),
        })?;

    // Watch each repo's `.git` directory non-recursively. The
    // `.git` directory contains HEAD plus refs/packed-refs etc;
    // any change in there could mean a branch switch. We filter
    // to actual HEAD changes inside the handler.
    //
    // Index each watched `.git` under BOTH its raw and canonical
    // forms so the event-path lookup matches whichever variant
    // notify hands us (macOS sends `/private/tmp/...` for paths
    // we passed in as `/tmp/...`). Without both keys, a failed
    // `canonicalize` on the event path would fall back to a
    // non-matching raw form and the event would be dropped
    // silently.
    let mut watched: std::collections::HashMap<PathBuf, PathBuf> = Default::default();
    for repo in &repos {
        let git_dir = repo.join(".git");
        // Tolerate `.git` being a file (worktree case) — in that
        // case we'd need to follow the gitdir pointer; skip for
        // simplicity in M1 (covered by the read path's
        // `resolve_git_paths`, but watching the linked path's HEAD
        // requires a different setup). Worktree support is a
        // tracked follow-up.
        if !git_dir.is_dir() {
            continue;
        }
        if let Err(e) = watcher.watch(&git_dir, RecursiveMode::NonRecursive) {
            log::warn!("git_watcher: watch {} failed: {e}", git_dir.display());
            continue;
        }
        // Insert raw form first; canonical may equal raw on
        // systems without symlink rewriting.
        watched.insert(git_dir.clone(), repo.clone());
        if let Ok(canonical) = git_dir.canonicalize() {
            if canonical != git_dir {
                watched.insert(canonical, repo.clone());
            }
        }
    }

    log::info!(
        "git_watcher: actively watching {} .git dirs",
        watched.len() / 2
    );

    // Debounce: HEAD changes often come as a burst (rename + write
    // + close on git checkout). Coalesce events within DEBOUNCE
    // per-repo before re-reading the GitContext. `Delay` (rather
    // than `Skip`) is the right behaviour for a drain timer — if
    // notify floods us with events, the ticker should serve them
    // promptly rather than coalesce intervals.
    let debounce = Duration::from_millis(200);
    let mut pending: std::collections::HashMap<PathBuf, tokio::time::Instant> = Default::default();
    let mut tick = tokio::time::interval(debounce);
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);

    loop {
        tokio::select! {
            biased;
            ev = notify_rx.recv() => {
                let Some(ev) = ev else { break; };
                // Filter to actual mutations of HEAD / refs/heads/*.
                if !is_head_event(&ev.kind) {
                    continue;
                }
                for path in &ev.paths {
                    // Only care about HEAD itself. Check the raw
                    // event path first — that's the cheap path —
                    // before falling back to canonicalize, which
                    // requires the file to exist (and may fail
                    // for transient temp paths during atomic
                    // rename).
                    if !path.ends_with("HEAD") {
                        continue;
                    }
                    // Try the raw path against the watch map
                    // first; if it doesn't match, canonicalize
                    // and retry. The map holds both forms (raw +
                    // canonical) per repo, so this covers macOS's
                    // /tmp ↔ /private/tmp rewriting without
                    // depending on canonicalize succeeding here.
                    let repo = watched
                        .iter()
                        .find(|(gd, _)| path.starts_with(gd.as_path()))
                        .map(|(_, r)| r.clone())
                        .or_else(|| {
                            let canonical = path.canonicalize().ok()?;
                            watched
                                .iter()
                                .find(|(gd, _)| canonical.starts_with(gd.as_path()))
                                .map(|(_, r)| r.clone())
                        });
                    let Some(repo) = repo else { continue };
                    pending.insert(repo, tokio::time::Instant::now() + debounce);
                }
            }
            _ = tick.tick() => {
                let now = tokio::time::Instant::now();
                let ready: Vec<PathBuf> = pending
                    .iter()
                    .filter(|(_, deadline)| **deadline <= now)
                    .map(|(p, _)| p.clone())
                    .collect();
                for repo in ready {
                    pending.remove(&repo);
                    if let Some(ctx) = read_git_context(&repo) {
                        if event_tx.send(SignalEvent::Git(Some(ctx))).await.is_err() {
                            // Snapshot stream is gone — exit.
                            return Ok(());
                        }
                    }
                }
            }
        }
    }

    Ok(())
}

/// True iff a notify event is the kind we care about for HEAD
/// changes. We accept any `Modify` (content writes from
/// `git checkout`, `git reset`, etc.) and any `Create` (atomic-
/// rename installations land as a Create on the destination
/// path). `EventKind::Other` is the platform-fallback bucket some
/// backends use when they can't classify; include it
/// defensively. `Remove` events on HEAD are deliberately
/// excluded — a Remove without a follow-up Create means git
/// failed mid-checkout and the HEAD will be replaced almost
/// immediately, so reading at remove-time would race the writer.
fn is_head_event(kind: &EventKind) -> bool {
    matches!(
        kind,
        EventKind::Modify(_) | EventKind::Create(_) | EventKind::Other
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn mk_repo(parent: &Path, name: &str) -> PathBuf {
        let repo = parent.join(name);
        fs::create_dir_all(&repo).unwrap();
        let git = repo.join(".git");
        fs::create_dir(&git).unwrap();
        fs::write(git.join("HEAD"), "ref: refs/heads/main\n").unwrap();
        repo
    }

    #[test]
    fn discover_repos_finds_top_level_repo() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = mk_repo(tmp.path(), "myproj");
        let found = discover_repos(&[tmp.path().to_path_buf()]);
        assert_eq!(found, vec![repo]);
    }

    #[test]
    fn discover_repos_finds_nested_repos_up_to_depth() {
        let tmp = tempfile::tempdir().unwrap();
        let nested = tmp.path().join("work").join("client-a");
        fs::create_dir_all(&nested).unwrap();
        let repo = mk_repo(&nested, "site");
        let found = discover_repos(&[tmp.path().to_path_buf()]);
        assert_eq!(found, vec![repo]);
    }

    #[test]
    fn discover_repos_does_not_descend_past_max_depth() {
        let tmp = tempfile::tempdir().unwrap();
        // 4 levels deep, but max is 3.
        let too_deep = tmp.path().join("a").join("b").join("c").join("d");
        fs::create_dir_all(&too_deep).unwrap();
        mk_repo(&too_deep, "x");
        let found = discover_repos(&[tmp.path().to_path_buf()]);
        assert!(
            found.is_empty(),
            "max-depth 3 should not reach a/b/c/d/x/.git"
        );
    }

    #[test]
    fn discover_repos_skips_node_modules() {
        let tmp = tempfile::tempdir().unwrap();
        let nm = tmp.path().join("node_modules").join("some-pkg");
        fs::create_dir_all(&nm).unwrap();
        // `.git` inside node_modules: real but uninteresting (and
        // sometimes 100k+ files).
        mk_repo(&nm, "git-mirror");
        let found = discover_repos(&[tmp.path().to_path_buf()]);
        assert!(
            found.is_empty(),
            "node_modules must be skipped to keep walk cheap"
        );
    }

    #[test]
    fn discover_repos_skips_hidden_dirs_other_than_dot_git() {
        let tmp = tempfile::tempdir().unwrap();
        // A `.config`-style dir shouldn't be walked.
        let hidden = tmp.path().join(".config").join("project");
        fs::create_dir_all(&hidden).unwrap();
        mk_repo(&hidden, "x");
        let found = discover_repos(&[tmp.path().to_path_buf()]);
        assert!(found.is_empty());
    }

    #[test]
    fn discover_repos_does_not_descend_into_a_repo() {
        // Once we find a repo, we don't keep walking into it —
        // nested submodules / vendored libs shouldn't surface as
        // separate repos at the discovery layer.
        let tmp = tempfile::tempdir().unwrap();
        let outer = mk_repo(tmp.path(), "outer");
        let inner = mk_repo(&outer, "vendor");
        let found = discover_repos(&[tmp.path().to_path_buf()]);
        assert_eq!(found, vec![outer]);
        assert!(!found.contains(&inner));
    }

    #[test]
    fn discover_repos_handles_missing_root_gracefully() {
        let nonexistent = PathBuf::from("/this/path/does/not/exist/qq");
        let found = discover_repos(&[nonexistent]);
        assert!(found.is_empty());
    }

    #[test]
    fn discover_repos_dedupes_and_sorts() {
        let tmp = tempfile::tempdir().unwrap();
        let _a = mk_repo(tmp.path(), "alpha");
        let _b = mk_repo(tmp.path(), "beta");
        // Same root twice.
        let found = discover_repos(&[tmp.path().to_path_buf(), tmp.path().to_path_buf()]);
        assert_eq!(found.len(), 2);
        assert!(found.windows(2).all(|w| w[0] < w[1]));
    }

    #[test]
    fn default_discovery_roots_returns_only_existing_dirs() {
        // We can't pre-create real home subdirs, but the function
        // must never panic on a missing root and never include
        // paths that don't exist.
        let roots = default_discovery_roots();
        for r in &roots {
            assert!(
                r.is_dir(),
                "default root {} must exist if listed",
                r.display()
            );
        }
    }

    // -- is_head_event filter --

    #[test]
    fn is_head_event_accepts_modify_create_other() {
        use notify::event::{CreateKind, ModifyKind};
        assert!(is_head_event(&EventKind::Modify(ModifyKind::Any)));
        assert!(is_head_event(&EventKind::Modify(ModifyKind::Data(
            notify::event::DataChange::Content
        ))));
        assert!(is_head_event(&EventKind::Modify(ModifyKind::Name(
            notify::event::RenameMode::To
        ))));
        assert!(is_head_event(&EventKind::Create(CreateKind::File)));
        assert!(is_head_event(&EventKind::Other));
    }

    #[test]
    fn is_head_event_rejects_remove_and_access() {
        use notify::event::{AccessKind, RemoveKind};
        assert!(!is_head_event(&EventKind::Remove(RemoveKind::File)));
        assert!(!is_head_event(&EventKind::Access(AccessKind::Read)));
        assert!(!is_head_event(&EventKind::Any));
    }

    // ---- Integration: spawn_watcher_task end-to-end -------------
    //
    // Exercises the real notify-based pipeline: spawn the task,
    // mutate a watched HEAD file, and assert a Git event lands in
    // the channel with the new branch.

    #[tokio::test]
    async fn spawn_watcher_emits_initial_event_per_repo() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = mk_repo(tmp.path(), "myproj");
        let (tx, mut rx) = mpsc::channel::<SignalEvent>(16);

        spawn_watcher_task(tx, vec![repo.clone()]);

        // The watcher emits one Git event per repo on startup so
        // the snapshot stream gets the current branch immediately.
        let ev = tokio::time::timeout(Duration::from_secs(2), rx.recv())
            .await
            .expect("startup event arrives")
            .expect("channel still open");
        let SignalEvent::Git(Some(ctx)) = ev else {
            panic!("expected Git event with context, got {ev:?}");
        };
        assert_eq!(ctx.branch.as_deref(), Some("main"));
        assert_eq!(ctx.repo_path, repo);
    }

    #[tokio::test]
    async fn watcher_emits_git_event_on_head_change() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = mk_repo(tmp.path(), "myproj");
        let (tx, mut rx) = mpsc::channel::<SignalEvent>(16);

        spawn_watcher_task(tx, vec![repo.clone()]);

        // Drain the startup event and assert it carries the
        // pre-change branch ("main"). This pins the order:
        // startup event THEN the user-driven change event.
        let startup = tokio::time::timeout(Duration::from_secs(2), rx.recv())
            .await
            .expect("startup event arrives")
            .expect("channel open");
        match startup {
            SignalEvent::Git(Some(ref ctx)) => {
                assert_eq!(ctx.branch.as_deref(), Some("main"));
                assert_eq!(ctx.repo_path, repo);
            }
            other => panic!("expected startup Git event with main, got {other:?}"),
        }

        // Give notify a moment to wire up the watch on the .git
        // dir. Without this small sleep on macOS the very first
        // write can land before FSEvents registers the path.
        tokio::time::sleep(Duration::from_millis(200)).await;

        // Simulate `git checkout feat/x` by rewriting HEAD.
        std::fs::write(repo.join(".git").join("HEAD"), "ref: refs/heads/feat/x\n").unwrap();

        // The notify event arrives, the 200ms debounce elapses,
        // and a Git event with the new branch lands. Allow up to
        // 2s total to absorb test-host filesystem latency. The
        // first Git event after the write must carry the new
        // branch — anything else means the debounce or the path
        // filter is letting noise through.
        let deadline = tokio::time::Instant::now() + Duration::from_secs(2);
        loop {
            let remaining = deadline
                .checked_duration_since(tokio::time::Instant::now())
                .unwrap_or_default();
            let ev = match tokio::time::timeout(remaining, rx.recv()).await {
                Ok(Some(ev)) => ev,
                _ => panic!("HEAD change event did not arrive within timeout"),
            };
            if let SignalEvent::Git(Some(ctx)) = ev {
                assert_eq!(
                    ctx.branch.as_deref(),
                    Some("feat/x"),
                    "first Git event after HEAD write must carry the new branch",
                );
                assert_eq!(ctx.repo_path, repo);
                return;
            }
            // Non-Git events: today the watcher only emits Git
            // events, so this branch is reachable only if a
            // future refactor adds something.
        }
    }
}
