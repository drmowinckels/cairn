//! Git branch collector.
//!
//! Reads `.git/HEAD` to surface the branch the user is currently on.
//! Returns `None` for detached HEAD, non-branch refs, or any
//! filesystem / parse failure — a snapshot without a `git_branch`
//! is a valid signal state (the user might not be inside a repo).
//!
//! ## Scope of this file
//!
//! Pure I/O over `.git/HEAD` plus a bounded `find_git_dir` walker.
//! The full notify-based watcher and the user-configurable
//! discovery roots (issue #4's `Watches .git/HEAD … within ≤500ms`
//! clause) belong with the snapshot stream in #5; we commit the
//! read primitives that the stream will plug into. The collector
//! deliberately does NOT expose the `origin` remote URL — git's
//! HTTPS clone URLs can carry `user:password@` credentials, and
//! the project's privacy contract is to never extract data we
//! don't have a concrete consumer for. Origin parsing will land
//! alongside a consumer (and a secret-redactor) in a follow-up.
//!
//! ## Privacy
//!
//! Branch names are read into memory, evaluated against rules,
//! and discarded on the next snapshot tick. Nothing in this
//! module writes to disk.

use std::path::{Path, PathBuf};

/// Hard ceiling for the `find_git_dir` walk-up. Eight levels covers
/// the typical "discovery root → project → subdir" depth without
/// letting the walker escape to filesystem root and pick up an
/// unrelated `.git` (e.g. a dotfile-versioned `~/.git`). The
/// snapshot stream in #5 will eventually pass an explicit root
/// instead; this is the defence-in-depth bound for the meantime.
const FIND_GIT_MAX_DEPTH: usize = 8;

/// Hard ceiling on how much we read from `.git/HEAD`. A real HEAD
/// is tens of bytes; 8 KiB is comfortably above the legitimate
/// ceiling while still bounding a pathological or corrupted file.
const HEAD_READ_LIMIT_BYTES: u64 = 8 * 1024;

/// Hard ceiling on how much we read from a worktree's `.git` file.
/// The file is a single `gitdir: …` line — well under 4 KiB even
/// for very long paths.
const GITFILE_READ_LIMIT_BYTES: u64 = 4 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GitContext {
    /// Working-tree root (the directory that contained `.git`).
    pub repo_path: PathBuf,
    /// Current branch. `None` when HEAD is detached or points at a
    /// non-`refs/heads/` ref.
    pub branch: Option<String>,
}

/// Walk up the directory tree from `start` until a `.git` entry
/// (dir or file) is found, capped at [`FIND_GIT_MAX_DEPTH`] levels.
/// Returns the path to that entry, not the containing repo root.
/// Use [`repo_root_of_git_path`] to climb one level if you need
/// the working-tree root.
///
/// The depth cap matters: without it, walking up from `/tmp/foo`
/// reaches filesystem root, which may have unrelated `.git`
/// entries on shared systems. With #5's discovery-roots config
/// the cap will become "do not escape the configured root"; until
/// then the cap is what stops the walker from leaking other repos
/// into Cairn's snapshot.
pub fn find_git_dir(start: &Path) -> Option<PathBuf> {
    let mut current: PathBuf = start.to_path_buf();
    for _ in 0..FIND_GIT_MAX_DEPTH {
        let candidate = current.join(".git");
        if candidate.exists() {
            return Some(candidate);
        }
        if !current.pop() {
            return None;
        }
    }
    None
}

/// Given a path to a `.git` entry, return the working-tree root —
/// the directory that contained `.git`. Returns `None` if `git`
/// has no parent (shouldn't happen for a real `.git` path).
pub fn repo_root_of_git_path(git: &Path) -> Option<PathBuf> {
    git.parent().map(Path::to_path_buf)
}

/// Parse the contents of `.git/HEAD`.
///
/// Returns `Some(branch)` only when HEAD points at a branch
/// (`ref: refs/heads/<name>`). Detached HEAD, `refs/tags/...`,
/// `refs/remotes/...`, malformed input — anything else returns
/// `None`. A detached state isn't a place users want their rules
/// to auto-fire, so the engine simply not matching is the right
/// default.
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

/// Read a git context starting from `start`, walking up to find
/// the nearest `.git` (within [`FIND_GIT_MAX_DEPTH`] levels).
/// Returns `None` if there's no enclosing repo, the `HEAD` file
/// is missing or too large to be a real HEAD, or the contents
/// don't point at a branch.
///
/// Handles both standard `.git/` directories and worktree-style
/// `.git` files (a single line `gitdir: /abs/path/to/main/.git/worktrees/<name>`).
pub fn read_git_context(start: &Path) -> Option<GitContext> {
    let git_path = find_git_dir(start)?;
    let (head_path, repo_path) = resolve_git_paths(&git_path)?;
    let head = read_capped(&head_path, HEAD_READ_LIMIT_BYTES)?;
    let branch = parse_head(&head);
    Some(GitContext { repo_path, branch })
}

// -----------------------------------------------------------------
// internals
// -----------------------------------------------------------------

/// Read up to `limit` bytes from `path` as a UTF-8 string. Returns
/// `None` on any I/O error, including the file simply not
/// existing. The cap stops a malicious or corrupted file from
/// pulling unbounded memory into the snapshot path.
fn read_capped(path: &Path, limit: u64) -> Option<String> {
    use std::io::Read;
    let file = std::fs::File::open(path).ok()?;
    let mut buf = String::new();
    file.take(limit).read_to_string(&mut buf).ok()?;
    Some(buf)
}

fn resolve_git_paths(git: &Path) -> Option<(PathBuf, PathBuf)> {
    if git.is_dir() {
        let head = git.join("HEAD");
        let repo = repo_root_of_git_path(git)?;
        return Some((head, repo));
    }
    // Worktree case: `.git` is a single-line file
    //   "gitdir: /abs/path/to/main/.git/worktrees/<name>\n"
    // HEAD is per-worktree (in that gitdir).
    let contents = read_capped(git, GITFILE_READ_LIMIT_BYTES)?;
    let gitdir_line = contents.lines().find_map(|l| l.strip_prefix("gitdir: "))?;
    let gitdir = PathBuf::from(gitdir_line.trim());
    let head = gitdir.join("HEAD");
    let repo = repo_root_of_git_path(git)?;
    Some((head, repo))
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
        assert_eq!(parse_head("ref: refs/heads/main"), Some("main".to_string()));
    }

    #[test]
    fn parse_head_returns_none_for_detached_sha() {
        // A typical detached HEAD is just the 40-char SHA.
        assert!(parse_head("0123456789abcdef0123456789abcdef01234567\n").is_none());
    }

    #[test]
    fn parse_head_returns_none_for_other_ref_namespaces() {
        // refs/tags / refs/remotes — not a branch.
        assert!(parse_head("ref: refs/tags/v1\n").is_none());
        assert!(parse_head("ref: refs/remotes/origin/main\n").is_none());
    }

    #[test]
    fn parse_head_returns_none_for_empty_branch() {
        assert!(parse_head("ref: refs/heads/\n").is_none());
        assert!(parse_head("ref: refs/heads/   \n").is_none());
        assert!(parse_head("").is_none());
    }

    // -- find_git_dir + read_git_context (integration) ----------------

    fn fake_repo(dir: &Path, head: &str) {
        let git = dir.join(".git");
        std::fs::create_dir(&git).expect("create .git/");
        std::fs::write(git.join("HEAD"), head).expect("write .git/HEAD");
    }

    #[test]
    fn find_git_dir_locates_repo_from_subdirectory() {
        let tmp = tempfile::tempdir().expect("tempdir");
        fake_repo(tmp.path(), "ref: refs/heads/main\n");
        let nested = tmp.path().join("src").join("foo");
        std::fs::create_dir_all(&nested).expect("nested dirs");
        let found = find_git_dir(&nested).expect("walker finds .git");
        assert_eq!(found, tmp.path().join(".git"));
    }

    #[test]
    fn find_git_dir_returns_none_outside_a_repo_within_depth_cap() {
        let tmp = tempfile::tempdir().expect("tempdir");
        // Build a nested chain deeper than the cap to ensure the
        // walker doesn't escape it. The cap prevents a stray
        // ~/.git or /.git from leaking into the snapshot.
        let deep = tmp
            .path()
            .join("a")
            .join("b")
            .join("c")
            .join("d")
            .join("e")
            .join("f")
            .join("g")
            .join("h")
            .join("i")
            .join("j");
        std::fs::create_dir_all(&deep).expect("deep nesting");
        assert!(
            find_git_dir(&deep).is_none(),
            "depth-capped walk must not escape the tempdir"
        );
    }

    #[test]
    fn find_git_dir_finds_dot_git_as_a_file_not_only_directory() {
        // Confirm the walker treats a `.git` file (worktree shape)
        // as a hit, not just a `.git` directory.
        let tmp = tempfile::tempdir().expect("tempdir");
        let git_file = tmp.path().join(".git");
        std::fs::write(&git_file, "gitdir: /nowhere\n").expect("write .git file");
        let found = find_git_dir(tmp.path()).expect("walker recognises .git file");
        assert_eq!(found, git_file);
    }

    #[test]
    fn repo_root_of_git_path_returns_parent_directory() {
        let path = PathBuf::from("/tmp/cairn/.git");
        assert_eq!(
            repo_root_of_git_path(&path),
            Some(PathBuf::from("/tmp/cairn"))
        );
    }

    #[test]
    fn read_git_context_returns_branch() {
        let tmp = tempfile::tempdir().expect("tempdir");
        fake_repo(tmp.path(), "ref: refs/heads/feat/rules-ui\n");
        let ctx = read_git_context(tmp.path()).expect("context");
        assert_eq!(ctx.branch.as_deref(), Some("feat/rules-ui"));
        assert_eq!(ctx.repo_path, tmp.path());
    }

    #[test]
    fn read_git_context_handles_detached_head() {
        let tmp = tempfile::tempdir().expect("tempdir");
        fake_repo(tmp.path(), "0123456789abcdef0123456789abcdef01234567\n");
        let ctx = read_git_context(tmp.path()).expect("context");
        assert!(ctx.branch.is_none());
    }

    #[test]
    fn read_git_context_caps_head_size() {
        // A `.git/HEAD` larger than the read cap is treated the
        // same as a corrupted ref: parse fails, branch is None.
        let tmp = tempfile::tempdir().expect("tempdir");
        let git = tmp.path().join(".git");
        std::fs::create_dir(&git).expect("create .git/");
        let bloated = "x".repeat((HEAD_READ_LIMIT_BYTES as usize) + 100);
        std::fs::write(git.join("HEAD"), &bloated).expect("write bloated HEAD");
        let ctx = read_git_context(tmp.path()).expect("context");
        assert!(
            ctx.branch.is_none(),
            "oversized HEAD must not surface a branch"
        );
    }

    #[test]
    fn read_git_context_handles_worktree_gitfile() {
        // Worktree layout:
        //   /tmp/main/.git/                        ← main repo
        //   /tmp/main/.git/worktrees/feat/HEAD     ← worktree's branch ref
        //   /tmp/main-feat/.git                    ← worktree's git-file
        let tmp = tempfile::tempdir().expect("tempdir");
        let main_git = tmp.path().join("main").join(".git");
        std::fs::create_dir_all(&main_git).expect("create main/.git");
        let wt_internal = main_git.join("worktrees").join("feat");
        std::fs::create_dir_all(&wt_internal).expect("create worktrees/feat");
        std::fs::write(wt_internal.join("HEAD"), "ref: refs/heads/feat/x\n")
            .expect("write worktree HEAD");

        let wt_root = tmp.path().join("main-feat");
        std::fs::create_dir(&wt_root).expect("create worktree root");
        let gitfile = format!("gitdir: {}\n", wt_internal.display());
        std::fs::write(wt_root.join(".git"), gitfile).expect("write worktree .git file");

        let ctx = read_git_context(&wt_root).expect("worktree context");
        assert_eq!(ctx.branch.as_deref(), Some("feat/x"));
        // The repo_path for a worktree is the worktree's checkout
        // root (where the user edits), not the main repo's root.
        assert_eq!(ctx.repo_path, wt_root);
    }
}
