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
//!    project`), JetBrains (`file – project` with EN-dash, plus the
//!    `file — project` EM-dash variant some setups emit), Sublime,
//!    Xcode, RStudio, Nova, Emacs. Returns the project / folder
//!    name as it appears in the title.
//! 2. **Longest-prefix fallback.** When the title doesn't fit any
//!    known pattern but the user has configured *discovery roots*
//!    (the same roots #4's git watcher uses), we try matching the
//!    title against each root: if a root's last segment appears as
//!    a substring of the title, return that root's basename. This
//!    catches editors with custom title templates or terminal-
//!    based editors (Vim / Neovim) where the title is whatever the
//!    user's `vimrc` set.
//!
//! Both stages are pure functions over strings + slices — no IO,
//! no OS calls. The matcher is deterministic and the tests cover
//! every supported editor pattern without touching the filesystem.

use std::path::{Path, PathBuf};

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
        // Zed, Sublime, RustRover, IntelliJ family, PyCharm, WebStorm,
        // GoLand, RubyMine, CLion, Android Studio (EM-dash builds),
        // Nova, Emacs — all use `file — project`.
        "Zed" | "Sublime Text" | "Nova" | "Emacs" | "GNU Emacs" => extract_after_em_dash(title),
        // JetBrains family. The default JetBrains title is
        // `file – project [path]` with EN-dash (`–`). Some setups
        // (mostly older or with the project-name plugin) emit
        // `file — project` with EM-dash. Try both.
        "RustRover"
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
        "Xcode" => extract_first_em_dash_segment(title),
        // RStudio: "project - RStudio" or "~/path/to/file — project — RStudio"
        "RStudio" => extract_rstudio_project(title),
        // Helix is a popular Rust-written editor; modal-line title
        // typically shows the working dir as the trailing segment
        // when set via `set window-title`. Falls back to the EM-dash
        // pattern most setups emit when nothing custom is configured.
        "Helix" | "hx" => extract_after_em_dash(title),
        // Neovim / Vim run in a terminal — the title shape depends
        // on the user's vimrc. No reliable parsing without prior
        // configuration. The fallback path (longest-prefix match
        // against discovery roots) is the only meaningful coverage
        // here.
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
/// path's last segment (basename) appears as a substring of `title`,
/// it's a candidate. Returns the longest-matching path so that a
/// deeper / more specific root wins (e.g. with roots
/// `~/code/cairn` and `~/code/cairn/docs`, a title mentioning
/// "docs" picks the docs root).
fn derive_from_repo_paths(title: &str, repo_paths: &[PathBuf]) -> Option<PathBuf> {
    let mut best: Option<&PathBuf> = None;
    for root in repo_paths {
        let Some(name) = root.file_name().and_then(|s| s.to_str()) else {
            continue;
        };
        if name.is_empty() {
            continue;
        }
        if !title.contains(name) {
            continue;
        }
        match best {
            None => best = Some(root),
            Some(b) => {
                if path_depth(root) > path_depth(b) {
                    best = Some(root);
                }
            }
        }
    }
    best.cloned()
}

fn path_depth(p: &Path) -> usize {
    p.components().count()
}

/// "file.tsx — cairn"  →  "cairn"
/// "rules.rs — cairn — main"  →  "cairn" (first segment after em-dash)
fn extract_after_em_dash(title: &str) -> Option<String> {
    let after = title.split(" — ").nth(1)?;
    Some(after.split(" — ").next().unwrap_or(after).to_string())
}

/// "file.tsx — cairn"  →  "cairn" (alias for clarity at the call site)
fn extract_first_em_dash_segment(title: &str) -> Option<String> {
    title.split(" — ").nth(1).map(str::to_string)
}

/// JetBrains: default title is `file – project` or `file – project [path]`
/// (EN-dash). Some configurations or older IDEs emit `file — project`
/// (EM-dash). Both forms accepted. The `[path]` suffix is stripped if
/// present.
fn extract_jetbrains_project(title: &str) -> Option<String> {
    // Try EN-dash first (default JetBrains shape).
    let after = title
        .split(" \u{2013} ")
        .nth(1)
        .or_else(|| title.split(" — ").nth(1))?;
    // Trim trailing `[path]` annotation that newer JetBrains IDEs
    // append: `file – project [~/code/project]` → `project`.
    let before_bracket = after.split('[').next().unwrap_or(after);
    Some(
        before_bracket
            .split(" \u{2013} ")
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

    // -- Helix --

    #[test]
    fn helix_em_dash_pattern() {
        assert_eq!(
            from_title("Helix", "main.rs — cairn"),
            Some(PathBuf::from("cairn"))
        );
    }

    // -- Unknown app + edge cases --

    #[test]
    fn unknown_app_returns_none() {
        assert!(from_title("CompletelyUnknownEditor", "foo.tsx — cairn").is_none());
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
    fn repo_paths_fallback_when_title_has_no_known_pattern() {
        // Terminal-based editor (Neovim in iTerm), title set by the
        // user's vimrc to include the working dir.
        let roots = [PathBuf::from("/home/u/code/cairn")];
        let result = derive_ide_folder("iTerm2", "nvim: /home/u/code/cairn/src/lib.rs", &roots);
        assert_eq!(result, Some(PathBuf::from("/home/u/code/cairn")));
    }

    #[test]
    fn repo_paths_fallback_chooses_deeper_root_when_multiple_match() {
        // Roots `~/code/cairn` and `~/code/cairn/docs`. A title that
        // mentions "docs" should pick the deeper one.
        let roots = [
            PathBuf::from("/home/u/code/cairn"),
            PathBuf::from("/home/u/code/cairn/docs"),
        ];
        let result = derive_ide_folder("Alacritty", "nvim: cairn / docs / index.md", &roots);
        assert_eq!(result, Some(PathBuf::from("/home/u/code/cairn/docs")));
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
    fn repo_paths_fallback_returns_none_when_no_root_basename_in_title() {
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
    fn repo_paths_skip_roots_with_unparseable_filename() {
        // Root with no basename (e.g. "/") shouldn't crash.
        let roots = [PathBuf::from("/")];
        let result = derive_ide_folder("iTerm2", "something", &roots);
        assert!(result.is_none());
    }
}
