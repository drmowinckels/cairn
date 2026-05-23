//! Git branch + repo collector.
//!
//! Reads `.git/HEAD` to surface the branch the user is on and
//! `.git/config` to surface the `origin` remote URL. Both fall back
//! to `None` rather than failing — a snapshot without a `git_branch`
//! is a valid signal state (the user might not be inside a repo).
//!
//! ## Scope of this file
//!
//! Pure I/O over the on-disk `.git` directory plus a `find_git_dir`
//! walker. The full notify-based watcher and the user-configurable
//! discovery roots (see issue #4's "watches `.git/HEAD` for branch
//! changes within ≤500ms") land in a follow-up PR — that's the
//! snapshot-stream-and-scheduler work tracked under #5. Here we
//! commit the read primitives, the parsers, and the snapshot wiring.
//!
//! ## Privacy
//!
//! Branch names and origin URLs are read into memory, evaluated
//! against rules, and discarded on the next snapshot tick. Nothing
//! in this module writes to disk. The `origin` URL is treated as
//! potentially-secret (some HTTPS clone URLs include credentials) —
//! the persisted entry never carries it; only the resolved time
//! entry's project + tag.

use std::path::{Path, PathBuf};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GitContext {
    /// Working-tree root (the directory containing `.git`).
    pub repo_path: PathBuf,
    /// Current branch. `None` when HEAD is detached.
    pub branch: Option<String>,
    /// Origin remote URL, if any.
    pub origin: Option<String>,
}

/// Walk up the directory tree from `start` until a `.git` entry
/// (dir or file) is found. Returns the path to that entry, not the
/// containing repo root. Use [`repo_root_of_git_path`] to climb one
/// level if you need the working-tree root.
pub fn find_git_dir(start: &Path) -> Option<PathBuf> {
    let mut current: PathBuf = start.to_path_buf();
    loop {
        let candidate = current.join(".git");
        if candidate.exists() {
            return Some(candidate);
        }
        if !current.pop() {
            return None;
        }
    }
}

/// Given a path to a `.git` entry, return the working-tree root —
/// the directory that *contained* `.git`. Returns `None` if `git`
/// has no parent (shouldn't happen for a real `.git` path).
pub fn repo_root_of_git_path(git: &Path) -> Option<PathBuf> {
    git.parent().map(Path::to_path_buf)
}

/// Parse the contents of `.git/HEAD`.
///
/// Two valid shapes:
/// - `ref: refs/heads/<branch>` → `Some(branch)`
/// - 40-char SHA (detached HEAD) → `None`
///
/// We treat detached HEAD as "no branch" rather than inventing a
/// pseudo-branch name. The rules engine's `git.branch contains "..."`
/// op simply doesn't match in that state, which is the right
/// default — a detached HEAD isn't a place users want their rules
/// to fire automatically.
pub fn parse_head(contents: &str) -> Option<String> {
    let trimmed = contents.trim();
    let rest = trimmed.strip_prefix("ref: refs/heads/")?;
    let branch = rest.trim();
    if branch.is_empty() {
        None
    } else {
        Some(branch.to_string())
    }
}

/// Parse `.git/config` and return the `[remote "origin"]` URL, if any.
///
/// The config format is git-ini: `[section]` headers (with optional
/// quoted subsection), `key = value` pairs, leading whitespace and
/// comments. We scan for the `[remote "origin"]` section and pick the
/// first `url = ...` inside it. Other sections — including other
/// remotes — are ignored.
pub fn parse_origin_url(config: &str) -> Option<String> {
    let mut in_origin = false;
    for raw in config.lines() {
        let line = strip_comment(raw).trim();
        if line.is_empty() {
            continue;
        }
        if let Some(section) = parse_section_header(line) {
            in_origin = section.eq_ignore_ascii_case("remote.origin");
            continue;
        }
        if !in_origin {
            continue;
        }
        if let Some(url) = parse_url_value(line) {
            return Some(url);
        }
    }
    None
}

/// Read a git context starting from `start`, walking up to find the
/// nearest `.git`. Returns `None` if there's no enclosing repo, the
/// `HEAD` is missing, or the file isn't readable.
///
/// Handles both standard `.git/` directories and worktree-style
/// `.git` files (a single line `gitdir: /abs/path/to/main/.git/worktrees/<name>`).
pub fn read_git_context(start: &Path) -> Option<GitContext> {
    let git_path = find_git_dir(start)?;
    let (head_path, config_path, repo_path) = resolve_git_paths(&git_path)?;
    let head = std::fs::read_to_string(&head_path).ok()?;
    let branch = parse_head(&head);
    let origin = std::fs::read_to_string(&config_path)
        .ok()
        .and_then(|c| parse_origin_url(&c));
    Some(GitContext {
        repo_path,
        branch,
        origin,
    })
}

// -----------------------------------------------------------------
// internals
// -----------------------------------------------------------------

fn strip_comment(line: &str) -> &str {
    // git-config supports both ; and # for comments. A quoted value
    // can contain either, but we're scanning at `key = value` level
    // and our values (URLs) never contain unescaped ; or #, so a
    // first-occurrence split is fine.
    if let Some(idx) = line.find([';', '#']) {
        &line[..idx]
    } else {
        line
    }
}

/// `[remote "origin"]`  →  `Some("remote.origin")`
/// `[core]`             →  `Some("core")`
/// `not a section`      →  `None`
fn parse_section_header(line: &str) -> Option<String> {
    let inner = line.strip_prefix('[')?.strip_suffix(']')?.trim();
    // Split on the first whitespace; the subsection (if any) follows
    // and is quoted.
    let mut parts = inner.splitn(2, char::is_whitespace);
    let section = parts.next()?.trim();
    if section.is_empty() {
        return None;
    }
    match parts.next() {
        Some(sub) => {
            let sub = sub.trim();
            let stripped = sub.strip_prefix('"').and_then(|s| s.strip_suffix('"'))?;
            Some(format!("{section}.{stripped}"))
        }
        None => Some(section.to_string()),
    }
}

fn parse_url_value(line: &str) -> Option<String> {
    let (key, value) = line.split_once('=')?;
    if !key.trim().eq_ignore_ascii_case("url") {
        return None;
    }
    let value = value.trim();
    if value.is_empty() {
        None
    } else {
        Some(value.to_string())
    }
}

fn resolve_git_paths(git: &Path) -> Option<(PathBuf, PathBuf, PathBuf)> {
    if git.is_dir() {
        let head = git.join("HEAD");
        let config = git.join("config");
        let repo = repo_root_of_git_path(git)?;
        return Some((head, config, repo));
    }
    // Worktree case: `.git` is a single-line file
    //   "gitdir: /abs/path/to/main/.git/worktrees/<name>\n"
    // HEAD is per-worktree (in that gitdir); config lives at the
    // main repo's `.git/` (gitdir.parent().parent()).
    let contents = std::fs::read_to_string(git).ok()?;
    let gitdir_line = contents.lines().find_map(|l| l.strip_prefix("gitdir: "))?;
    let gitdir = PathBuf::from(gitdir_line.trim());
    let head = gitdir.join("HEAD");
    let config = gitdir
        .parent()
        .and_then(|p| p.parent())
        .map(|main_git| main_git.join("config"))
        .unwrap_or_else(|| gitdir.join("config"));
    let repo = repo_root_of_git_path(git)?;
    Some((head, config, repo))
}

// -----------------------------------------------------------------
// Tests
// -----------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    // -- parse_head ---------------------------------------------------

    #[test]
    fn parse_head_recognises_ref() {
        assert_eq!(
            parse_head("ref: refs/heads/main\n"),
            Some("main".to_string()),
        );
    }

    #[test]
    fn parse_head_recognises_branch_with_slashes() {
        assert_eq!(
            parse_head("ref: refs/heads/feat/rules-ui\n"),
            Some("feat/rules-ui".to_string()),
        );
    }

    #[test]
    fn parse_head_recognises_branch_without_trailing_newline() {
        assert_eq!(parse_head("ref: refs/heads/main"), Some("main".to_string()),);
    }

    #[test]
    fn parse_head_returns_none_for_detached_sha() {
        // A typical detached HEAD is just the 40-char SHA.
        assert!(parse_head("0123456789abcdef0123456789abcdef01234567\n").is_none());
    }

    #[test]
    fn parse_head_returns_none_for_other_ref_namespaces() {
        // ref: refs/tags/v1 — not a branch. Today we only follow
        // refs/heads/ since that's what most users land on; tag-checkouts
        // and remote-tracking branches are detached for git's purposes.
        assert!(parse_head("ref: refs/tags/v1\n").is_none());
    }

    #[test]
    fn parse_head_returns_none_for_empty_branch() {
        assert!(parse_head("ref: refs/heads/\n").is_none());
        assert!(parse_head("").is_none());
    }

    // -- parse_origin_url ---------------------------------------------

    #[test]
    fn parse_origin_url_picks_url_inside_origin_section() {
        let cfg = r#"
[core]
	bare = false
[remote "origin"]
	url = git@github.com:drmowinckels/cairn.git
	fetch = +refs/heads/*:refs/remotes/origin/*
"#;
        assert_eq!(
            parse_origin_url(cfg),
            Some("git@github.com:drmowinckels/cairn.git".to_string()),
        );
    }

    #[test]
    fn parse_origin_url_handles_https_remote() {
        let cfg = r#"
[remote "origin"]
	url = https://github.com/drmowinckels/cairn.git
"#;
        assert_eq!(
            parse_origin_url(cfg),
            Some("https://github.com/drmowinckels/cairn.git".to_string()),
        );
    }

    #[test]
    fn parse_origin_url_ignores_other_remotes() {
        let cfg = r#"
[remote "upstream"]
	url = git@github.com:other/cairn.git
[remote "origin"]
	url = git@github.com:drmowinckels/cairn.git
"#;
        assert_eq!(
            parse_origin_url(cfg).as_deref(),
            Some("git@github.com:drmowinckels/cairn.git"),
        );
    }

    #[test]
    fn parse_origin_url_returns_none_without_origin_section() {
        let cfg = r#"
[core]
	bare = false
[remote "upstream"]
	url = git@github.com:other/cairn.git
"#;
        assert!(parse_origin_url(cfg).is_none());
    }

    #[test]
    fn parse_origin_url_returns_none_when_origin_has_no_url() {
        let cfg = r#"
[remote "origin"]
	fetch = +refs/heads/*:refs/remotes/origin/*
"#;
        assert!(parse_origin_url(cfg).is_none());
    }

    #[test]
    fn parse_origin_url_skips_comments() {
        let cfg = r#"
; the next remote is origin
[remote "origin"]
	# url commented out
	url = git@github.com:drmowinckels/cairn.git
"#;
        assert_eq!(
            parse_origin_url(cfg).as_deref(),
            Some("git@github.com:drmowinckels/cairn.git"),
        );
    }

    #[test]
    fn parse_origin_url_handles_key_value_without_spaces() {
        let cfg = r#"
[remote "origin"]
url=git@example.com:x/y.git
"#;
        assert_eq!(
            parse_origin_url(cfg).as_deref(),
            Some("git@example.com:x/y.git"),
        );
    }

    // -- parse_section_header (internal) ------------------------------

    #[test]
    fn section_header_unqualified() {
        assert_eq!(parse_section_header("[core]"), Some("core".to_string()));
    }

    #[test]
    fn section_header_with_quoted_subsection() {
        assert_eq!(
            parse_section_header("[remote \"origin\"]"),
            Some("remote.origin".to_string()),
        );
    }

    #[test]
    fn section_header_invalid() {
        assert!(parse_section_header("not a section").is_none());
        assert!(parse_section_header("[]").is_none());
    }

    // -- find_git_dir + read_git_context (integration) ----------------

    fn fake_repo(dir: &Path, head: &str, config: &str) {
        let git = dir.join(".git");
        std::fs::create_dir(&git).unwrap();
        std::fs::write(git.join("HEAD"), head).unwrap();
        std::fs::write(git.join("config"), config).unwrap();
    }

    #[test]
    fn find_git_dir_locates_repo_from_subdirectory() {
        let tmp = tempfile::tempdir().unwrap();
        fake_repo(tmp.path(), "ref: refs/heads/main\n", "");
        let nested = tmp.path().join("src").join("foo");
        std::fs::create_dir_all(&nested).unwrap();
        let found = find_git_dir(&nested).unwrap();
        assert_eq!(found, tmp.path().join(".git"));
    }

    #[test]
    fn find_git_dir_returns_none_outside_a_repo() {
        let tmp = tempfile::tempdir().unwrap();
        // No `.git` anywhere up to filesystem root from inside `tmp` —
        // but the user's `$HOME` might be a git repo and `tmp` is a
        // descendant, depending on the host. We assert "either None
        // OR a real .git on the path", not strict None.
        let result = find_git_dir(tmp.path());
        if let Some(p) = result {
            assert!(p.ends_with(".git"), "found {p:?} that is not a .git path");
        }
    }

    #[test]
    fn read_git_context_returns_branch_and_origin() {
        let tmp = tempfile::tempdir().unwrap();
        fake_repo(
            tmp.path(),
            "ref: refs/heads/feat/rules-ui\n",
            r#"[remote "origin"]
	url = git@github.com:drmowinckels/cairn.git
"#,
        );
        let ctx = read_git_context(tmp.path()).unwrap();
        assert_eq!(ctx.branch.as_deref(), Some("feat/rules-ui"));
        assert_eq!(
            ctx.origin.as_deref(),
            Some("git@github.com:drmowinckels/cairn.git"),
        );
        assert_eq!(ctx.repo_path, tmp.path());
    }

    #[test]
    fn read_git_context_handles_detached_head() {
        let tmp = tempfile::tempdir().unwrap();
        fake_repo(tmp.path(), "0123456789abcdef0123456789abcdef01234567\n", "");
        let ctx = read_git_context(tmp.path()).unwrap();
        assert!(ctx.branch.is_none());
        assert!(ctx.origin.is_none());
    }

    #[test]
    fn read_git_context_handles_missing_config() {
        let tmp = tempfile::tempdir().unwrap();
        let git = tmp.path().join(".git");
        std::fs::create_dir(&git).unwrap();
        std::fs::write(git.join("HEAD"), "ref: refs/heads/main\n").unwrap();
        // No config file.
        let ctx = read_git_context(tmp.path()).unwrap();
        assert_eq!(ctx.branch.as_deref(), Some("main"));
        assert!(ctx.origin.is_none());
    }

    #[test]
    fn read_git_context_handles_worktree_gitfile() {
        // Simulate the worktree layout:
        //   /tmp/main/.git/                            ← main repo
        //   /tmp/main/.git/config                      ← shared remote config
        //   /tmp/main/.git/worktrees/feat/HEAD         ← worktree's branch ref
        //   /tmp/main-feat/.git                        ← worktree's git-file
        let tmp = tempfile::tempdir().unwrap();
        let main_git = tmp.path().join("main").join(".git");
        std::fs::create_dir_all(&main_git).unwrap();
        std::fs::write(
            main_git.join("config"),
            r#"[remote "origin"]
	url = git@github.com:drmowinckels/cairn.git
"#,
        )
        .unwrap();
        let wt_internal = main_git.join("worktrees").join("feat");
        std::fs::create_dir_all(&wt_internal).unwrap();
        std::fs::write(wt_internal.join("HEAD"), "ref: refs/heads/feat/x\n").unwrap();

        let wt_root = tmp.path().join("main-feat");
        std::fs::create_dir(&wt_root).unwrap();
        let gitfile = format!("gitdir: {}\n", wt_internal.display());
        std::fs::write(wt_root.join(".git"), gitfile).unwrap();

        let ctx = read_git_context(&wt_root).unwrap();
        assert_eq!(ctx.branch.as_deref(), Some("feat/x"));
        assert_eq!(
            ctx.origin.as_deref(),
            Some("git@github.com:drmowinckels/cairn.git"),
        );
    }
}
