//! IDE folder derivation.
//!
//! Best-effort pure-Rust mapping from `(app_name, window_title) →
//! folder name (or repo path)`. Used by the snapshot stream to
//! populate `SignalSnapshot.ide_folder` from the frontmost-window
//! signal so the rules engine can match `ide.folder contains
//! "cairn"`-style conditions.
//!
//! See `docs/RULES_ENGINE.md` §1 — `ide.folder` is a *derived*
//! signal, not a direct OS API. This module is where the heuristic
//! lives.
//!
//! ## Two-stage derivation
//!
//! 1. **Title parsing.** Recognises common IDE title formats: VS
//!    Code (`file - project - Visual Studio Code`), Zed (`file —
//!    project`), JetBrains / Sublime (`file – project [path]` with
//!    EN-dash, plus the `file — project` EM-dash variant some setups
//!    emit), Xcode, RStudio, Nova, Emacs. Returns the project /
//!    folder name as it appears in the title.
//! 2. **Longest-prefix fallback.** When the title doesn't fit any
//!    known pattern but the user has configured *discovery roots*
//!    (the same roots #4's git watcher uses), we look for the
//!    longest root whose absolute-path string appears as a
//!    substring of the title (the title typically contains the full
//!    open-file path, e.g. `~/code/cairn/src/lib.rs - VSCodium`).
//!    Catches editors with custom title templates and terminal-
//!    based editors (Vim / Neovim) where the title is whatever the
//!    user's config set.
//!
//! Both stages are pure functions over strings + slices — no IO,
//! no OS calls. The matcher is deterministic and the tests cover
//! every supported editor pattern without touching the filesystem.

use std::path::PathBuf;

/// From a frontmost window's `app_name` + `title`, derive the
/// project folder the editor is showing. `repo_paths` is the
/// user's configured discovery roots — passed in so the title-
/// parsing fallback can do a longest-prefix match when no editor
/// pattern fires. Pass `&[]` if discovery roots aren't available
/// (production today; the watcher in #4's tail-end will populate
/// it).
///
/// Returns the project as a `PathBuf` containing either the folder
/// name (when derived from a title) or the full discovery-root
/// path (when derived from the longest-prefix fallback).
pub fn derive_ide_folder(app_name: &str, title: &str, repo_paths: &[PathBuf]) -> Option<PathBuf> {
    if let Some(folder) = derive_from_title(app_name, title) {
        return Some(folder);
    }
    derive_from_repo_paths(title, repo_paths)
}

/// Title-only derivation — the editor-pattern matcher. Returns
/// `None` if no known pattern fires. Exposed for callers that
/// genuinely have no discovery roots and want to skip the
/// fallback (e.g. cold-start `snapshot::build`).
pub fn derive_from_title(app_name: &str, title: &str) -> Option<PathBuf> {
    let candidate = match app_name {
        // Zed / Nova / Emacs: `file — project` with EM-dash.
        "Zed" | "Nova" | "Emacs" | "GNU Emacs" => extract_after_em_dash(title),
        // JetBrains family + Sublime Text: default title is
        // `file – project [path]` with EN-dash (U+2013). Some setups
        // (older versions or with custom title plugins) emit
        // `file — project` with EM-dash. The combined splitter
        // accepts either separator.
        "Sublime Text"
        | "RustRover"
        | "IntelliJ IDEA"
        | "IntelliJ IDEA Ultimate"
        | "IntelliJ IDEA Community Edition"
        | "PyCharm"
        | "PyCharm Professional Edition"
        | "PyCharm CE"
        | "WebStorm"
        | "GoLand"
        | "RubyMine"
        | "CLion"
        | "Android Studio" => extract_jetbrains_project(title),
        // VS Code / Cursor / Code — OSS: "file - project - Visual Studio Code"
        "Code" | "Visual Studio Code" | "Cursor" | "VSCodium" => extract_vscode_project(title),
        // Xcode: "Cairn — main — file.swift" → project is first segment
        "Xcode" => extract_segment_after_first_em_dash(title),
        // RStudio: "project - RStudio" or "~/path/to/file — project — RStudio"
        "RStudio" => extract_rstudio_project(title),
        // Terminal-based editors (Vim / Neovim / Helix) and
        // anything else: the title shape depends on the user's
        // config and isn't reliably parseable. We rely on the
        // discovery-roots fallback (`derive_from_repo_paths`) to
        // catch these — the title often contains the open file's
        // full path.
        _ => None,
    }?;
    let trimmed = candidate.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(PathBuf::from(trimmed))
    }
}

/// Longest-prefix fallback: for each path in `repo_paths`, if the
/// *full string form* of the path appears as a substring of `title`,
/// it's a candidate. Returns the longest matching path by
/// *character length* — a deeper / more specific root wins
/// because its string form is necessarily longer than any prefix
/// of it. Ties (rare in practice — two roots with the same
/// `to_str().len()`) break to the first match in the slice;
/// callers that want determinism should sort their input.
///
/// Matching against the absolute-path string (not just the
/// basename) avoids the false-positive footgun where a repo named
/// `cairn` matches a window title mentioning `cairn-app`.
fn derive_from_repo_paths(title: &str, repo_paths: &[PathBuf]) -> Option<PathBuf> {
    let mut best: Option<(&PathBuf, usize)> = None;
    for root in repo_paths {
        let Some(root_str) = root.to_str() else {
            continue;
        };
        if root_str.is_empty() {
            continue;
        }
        if !title.contains(root_str) {
            continue;
        }
        let len = root_str.len();
        match best {
            None => best = Some((root, len)),
            Some((_, prev_len)) if len > prev_len => best = Some((root, len)),
            _ => {}
        }
    }
    best.map(|(p, _)| p.clone())
}

/// "file.tsx — cairn"  →  "cairn"
/// "rules.rs — cairn — main"  →  "cairn" (first segment after em-dash)
fn extract_after_em_dash(title: &str) -> Option<String> {
    let after = title.split(" — ").nth(1)?;
    Some(after.split(" — ").next().unwrap_or(after).to_string())
}

/// "Cairn — main — AppDelegate.swift" → "main" (the segment that
/// follows the *first* EM-dash). Used for Xcode where the project
/// is in slot 0, the branch in slot 1, and the file in slot 2.
fn extract_segment_after_first_em_dash(title: &str) -> Option<String> {
    title.split(" — ").nth(1).map(str::to_string)
}

/// JetBrains + Sublime: default title is `file – project` or
/// `file – project [path]` (EN-dash, U+2013). Some configurations
/// or older IDEs emit `file — project` (EM-dash, U+2014). Both
/// forms accepted. The `[path]` suffix is stripped if present.
///
/// Crucially, the separator that splits the file from the project
/// is also used to split the project from any trailing segments —
/// mixing them produces wrong results. We pick the *one* separator
/// that actually matches and use it consistently.
fn extract_jetbrains_project(title: &str) -> Option<String> {
    // Try EN-dash first (default JetBrains shape). Remember which
    // separator matched so the post-split trimming uses the same
    // one and a `file — project — branch`-shape title's "branch"
    // doesn't leak into the result.
    let (after, sep) = if let Some(rest) = title.split(" \u{2013} ").nth(1) {
        (rest, " \u{2013} ")
    } else {
        (title.split(" — ").nth(1)?, " — ")
    };
    // Strip trailing `[path]` annotation that newer JetBrains IDEs
    // append: `file – project [~/code/project]` → `project`.
    let before_bracket = after.split('[').next().unwrap_or(after);
    Some(
        before_bracket
            .split(sep)
            .next()
            .unwrap_or(before_bracket)
            .trim()
            .to_string(),
    )
}

/// "settings.tsx - Visual Studio Code"           → None (no project name)
/// "settings.tsx - cairn - Visual Studio Code"  →  "cairn"
fn extract_vscode_project(title: &str) -> Option<String> {
    let parts: Vec<&str> = title.split(" - ").collect();
    if parts.len() < 3 {
        return None;
    }
    Some(parts[parts.len() - 2].to_string())
}

/// "cairn - RStudio"                                 →  "cairn"
/// "~/code/cairn/foo.R — cairn — RStudio"           →  "cairn"
fn extract_rstudio_project(title: &str) -> Option<String> {
    if let Some(rest) = title.strip_suffix(" - RStudio") {
        return Some(rest.to_string());
    }
    if let Some(rest) = title.strip_suffix(" — RStudio") {
        // pick the segment immediately preceding "— RStudio".
        // `Split<&str>` isn't a DoubleEndedIterator, so use `rsplit`.
        return rest.rsplit(" — ").next().map(str::to_string);
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn from_title(app: &str, title: &str) -> Option<PathBuf> {
        derive_ide_folder(app, title, &[])
    }

    // -- Zed-family (EM-dash) --

    #[test]
    fn zed_pattern() {
        assert_eq!(
            from_title("Zed", "rules.tsx — cairn"),
            Some(PathBuf::from("cairn"))
        );
    }

    #[test]
    fn zed_with_unsaved_marker_still_picks_project() {
        // Zed uses " ●" to mark unsaved buffers; the project name is
        // still the segment after the em-dash.
        assert_eq!(
            from_title("Zed", "rules.tsx ● — cairn"),
            Some(PathBuf::from("cairn"))
        );
    }

    #[test]
    fn nova_em_dash_pattern() {
        assert_eq!(
            from_title("Nova", "rules.tsx — cairn"),
            Some(PathBuf::from("cairn"))
        );
    }

    // -- JetBrains (EN-dash default + EM-dash legacy) --

    #[test]
    fn intellij_uses_en_dash_by_default() {
        assert_eq!(
            from_title("IntelliJ IDEA", "Main.kt \u{2013} server"),
            Some(PathBuf::from("server"))
        );
    }

    #[test]
    fn intellij_en_dash_with_path_bracket_suffix() {
        assert_eq!(
            from_title("IntelliJ IDEA", "Main.kt \u{2013} server [~/code/server]"),
            Some(PathBuf::from("server"))
        );
    }

    #[test]
    fn intellij_em_dash_legacy_form_still_recognised() {
        assert_eq!(
            from_title("IntelliJ IDEA", "Main.kt — server"),
            Some(PathBuf::from("server"))
        );
    }

    #[test]
    fn pycharm_en_dash() {
        assert_eq!(
            from_title(
                "PyCharm Professional Edition",
                "manage.py \u{2013} django-app"
            ),
            Some(PathBuf::from("django-app"))
        );
    }

    #[test]
    fn jetbrains_en_dash_with_three_segments_picks_project_not_branch() {
        // `file – project – branch` shape: must NOT leak the
        // trailing branch into the result. Regression for the
        // EN/EM-dash separator-asymmetry bug.
        assert_eq!(
            from_title("RustRover", "main.rs \u{2013} cairn \u{2013} feat/x"),
            Some(PathBuf::from("cairn"))
        );
    }

    #[test]
    fn jetbrains_em_dash_with_three_segments_picks_project_not_branch() {
        // Same as above but with EM-dash throughout. The fix has
        // to pick a single separator and use it consistently for
        // both splits.
        assert_eq!(
            from_title("RustRover", "main.rs — cairn — feat/x"),
            Some(PathBuf::from("cairn"))
        );
    }

    #[test]
    fn sublime_uses_jetbrains_en_dash_default() {
        // Sublime's default title is `file – project` with
        // EN-dash, same shape as JetBrains.
        assert_eq!(
            from_title("Sublime Text", "main.rs \u{2013} cairn"),
            Some(PathBuf::from("cairn"))
        );
    }

    // -- VS Code-family --

    #[test]
    fn vscode_pattern_with_project() {
        assert_eq!(
            from_title("Code", "settings.tsx - cairn - Visual Studio Code"),
            Some(PathBuf::from("cairn"))
        );
    }

    #[test]
    fn vscode_pattern_without_project_returns_none() {
        // Only 2 dash-separated segments (no project) → no derivation.
        assert!(from_title("Code", "settings.tsx - Visual Studio Code").is_none());
    }

    #[test]
    fn cursor_uses_the_vscode_pattern() {
        assert_eq!(
            from_title("Cursor", "foo.ts - my-app - Visual Studio Code"),
            Some(PathBuf::from("my-app"))
        );
    }

    // -- Xcode / RStudio --

    #[test]
    fn xcode_first_segment_is_project() {
        // Xcode title: "ProjectName — Branch — file.swift"
        assert_eq!(
            from_title("Xcode", "Cairn — main — AppDelegate.swift"),
            Some(PathBuf::from("main"))
        );
    }

    #[test]
    fn rstudio_short_form() {
        assert_eq!(
            from_title("RStudio", "my-paper - RStudio"),
            Some(PathBuf::from("my-paper"))
        );
    }

    #[test]
    fn rstudio_long_form_with_em_dash() {
        assert_eq!(
            from_title("RStudio", "~/code/my-paper/foo.R — my-paper — RStudio"),
            Some(PathBuf::from("my-paper"))
        );
    }

    // -- Unknown app + edge cases --

    #[test]
    fn unknown_app_returns_none() {
        // Helix, terminal-based editors, and anything else not in
        // the explicit allow-list fall through to the
        // discovery-roots fallback (covered below).
        assert!(from_title("CompletelyUnknownEditor", "foo.tsx — cairn").is_none());
        assert!(from_title("Helix", "main.rs — cairn").is_none());
    }

    #[test]
    fn title_without_em_dash_returns_none() {
        assert!(from_title("Zed", "no-dash-here").is_none());
    }

    #[test]
    fn empty_project_segment_returns_none() {
        assert!(from_title("Zed", "foo.tsx — ").is_none());
    }

    #[test]
    fn whitespace_only_project_is_treated_as_empty() {
        assert!(from_title("Zed", "foo.tsx —    ").is_none());
    }

    // -- Longest-prefix fallback against discovery roots --

    #[test]
    fn repo_paths_fallback_when_title_contains_full_root_path() {
        // Terminal-based editor (Neovim in iTerm), title set by the
        // user's vimrc to include the working dir.
        let roots = [PathBuf::from("/home/u/code/cairn")];
        let result = derive_ide_folder("iTerm2", "nvim: /home/u/code/cairn/src/lib.rs", &roots);
        assert_eq!(result, Some(PathBuf::from("/home/u/code/cairn")));
    }

    #[test]
    fn repo_paths_fallback_picks_longest_matching_root() {
        // Roots `/code/cairn` and `/code/cairn/docs`. A title that
        // contains the docs root must pick the longer one because
        // it's a more specific prefix.
        let roots = [
            PathBuf::from("/code/cairn"),
            PathBuf::from("/code/cairn/docs"),
        ];
        let title = "nvim: /code/cairn/docs/index.md";
        let result = derive_ide_folder("Alacritty", title, &roots);
        assert_eq!(result, Some(PathBuf::from("/code/cairn/docs")));
    }

    #[test]
    fn repo_paths_fallback_distinguishes_same_basename_different_paths() {
        // Two roots whose *basenames* collide (`cairn`) but absolute
        // paths differ. Substring-matching against the full path
        // ensures the title's actual path picks the right root —
        // the old basename-only approach would have picked one of
        // these non-deterministically.
        let roots = [
            PathBuf::from("/home/u/code/cairn"),
            PathBuf::from("/home/u/work/cairn"),
        ];
        let title = "nvim: /home/u/work/cairn/src/lib.rs";
        let result = derive_ide_folder("Alacritty", title, &roots);
        assert_eq!(result, Some(PathBuf::from("/home/u/work/cairn")));
    }

    #[test]
    fn repo_paths_fallback_no_false_positive_on_basename_substring() {
        // Old basename-`contains` behaviour would match "cairn"
        // inside "cairn-app" and return the wrong root. Switching
        // to full-path-substring fixes this.
        let roots = [PathBuf::from("/home/u/code/cairn")];
        let title = "nvim: ~/elsewhere/cairn-app/foo.rs";
        let result = derive_ide_folder("iTerm2", title, &roots);
        assert!(
            result.is_none(),
            "must not match `cairn` against `cairn-app`",
        );
    }

    #[test]
    fn repo_paths_fallback_does_not_override_title_match() {
        // A title that DOES match an editor pattern should take
        // precedence over the discovery-roots fallback.
        let roots = [PathBuf::from("/home/u/code/other-project")];
        assert_eq!(
            derive_ide_folder("Zed", "rules.tsx — cairn", &roots),
            Some(PathBuf::from("cairn")),
            "title parse wins over discovery roots fallback"
        );
    }

    #[test]
    fn repo_paths_fallback_returns_none_when_no_root_in_title() {
        let roots = [PathBuf::from("/home/u/code/cairn")];
        let result = derive_ide_folder("iTerm2", "nvim: ~/scratch/foo.rs", &roots);
        assert!(result.is_none());
    }

    #[test]
    fn empty_repo_paths_means_title_only() {
        let result = derive_ide_folder("iTerm2", "nvim: /home/u/code/cairn/src/lib.rs", &[]);
        assert!(result.is_none(), "with no roots, unknown apps return None");
    }

    #[test]
    fn repo_paths_handles_root_like_slash_safely() {
        // A pathological root like "/" exists in the slice but
        // doesn't appear as a substring of titles that don't
        // start with "/". Must not crash and must not match.
        let roots = [PathBuf::from("/")];
        let result = derive_ide_folder("iTerm2", "something", &roots);
        assert!(result.is_none());
    }
}
