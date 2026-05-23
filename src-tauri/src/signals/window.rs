//! Frontmost window collector.
//!
//! Returns the OS-level "active" window's app name and title, plus a
//! best-effort derived IDE folder (the project root the active editor
//! has open). Every platform implementation is allowed to return
//! `None` — there is no platform whose live snapshot is required for
//! the rules engine to function; it just degrades to "no signal".
//!
//! ## Permissions
//!
//! - **macOS** needs Accessibility permission for the title. Without
//!   it, the system silently denies the AppleScript call and we
//!   return `title: None`. The UI is expected to prompt for the
//!   permission once and never block on it.
//! - **Windows** needs no permissions.
//! - **Linux X11** needs `xdotool` on PATH. Wayland support will arrive
//!   with the Hyprland/Sway adapters in a follow-up.
//!
//! ## Privacy
//!
//! Per `docs/PRIVACY.md`: the title is read into memory, evaluated
//! against rules, and discarded. Nothing in this module writes to disk
//! or persists state.

use std::path::PathBuf;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FrontWindow {
    pub app_name: String,
    pub title: Option<String>,
}

#[cfg(target_os = "macos")]
pub fn current() -> Option<FrontWindow> {
    let app_name = macos::frontmost_app_name()?;
    let title = macos::frontmost_window_title();
    Some(FrontWindow { app_name, title })
}

#[cfg(target_os = "windows")]
pub fn current() -> Option<FrontWindow> {
    windows::current_front_window()
}

#[cfg(all(unix, not(target_os = "macos")))]
pub fn current() -> Option<FrontWindow> {
    linux::current_front_window()
}

#[cfg(not(any(target_os = "macos", target_os = "windows", unix)))]
pub fn current() -> Option<FrontWindow> {
    None
}

// -----------------------------------------------------------------
// IDE folder derivation — pure Rust, runs everywhere, unit-testable.
// -----------------------------------------------------------------

/// Best-effort: from an editor window title (e.g. "rules.tsx — cairn"
/// in Zed, "settings.tsx - Visual Studio Code"), return the project
/// root path the editor is showing. Falls back to `None` when the
/// title doesn't follow a recognised editor pattern.
///
/// This is intentionally a pure function over strings — no IO — so
/// the rules engine can resolve `ide.folder` deterministically and the
/// tests can pin behaviour across every supported editor without
/// touching the filesystem.
///
/// The returned `PathBuf` is the *folder name* only (e.g. `cairn`,
/// `my-project`), not a fully-qualified path. The rules engine's
/// `ide.folder contains "cairn"` op works on substring match, so a
/// folder name is sufficient. The `git` collector contributes the
/// fully-qualified repo path through its own snapshot field.
pub fn derive_ide_folder(app_name: &str, title: &str) -> Option<PathBuf> {
    let candidate = match app_name {
        // Zed, Sublime, RustRover, IntelliJ family, PyCharm, WebStorm,
        // GoLand, RubyMine, CLion, Android Studio: "file — project"
        "Zed"
        | "Sublime Text"
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
        | "Android Studio" => extract_after_em_dash(title),
        // VS Code / Cursor / Code — OSS: "file - project - Visual Studio Code"
        "Code" | "Visual Studio Code" | "Cursor" | "VSCodium" => extract_vscode_project(title),
        // Xcode: "Cairn — main — file.swift" → project is first segment
        "Xcode" => extract_first_em_dash_segment(title),
        // RStudio: "project - RStudio" or "~/path/to/file — project — RStudio"
        "RStudio" => extract_rstudio_project(title),
        // Nova: "file.tsx — project"
        "Nova" => extract_after_em_dash(title),
        // Emacs / GNU Emacs: "file.el — project" (varies)
        "Emacs" | "GNU Emacs" => extract_after_em_dash(title),
        // Neovim / Vim run in a terminal — title is usually the terminal
        // emulator's app name, not the IDE. Best to skip; the user can
        // model this via the git collector instead.
        _ => None,
    }?;
    let trimmed = candidate.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(PathBuf::from(trimmed))
    }
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

// -----------------------------------------------------------------
// macOS
// -----------------------------------------------------------------

#[cfg(target_os = "macos")]
mod macos {
    use objc2::rc::autoreleasepool;
    use objc2_app_kit::NSWorkspace;

    pub(super) fn frontmost_app_name() -> Option<String> {
        autoreleasepool(|_| {
            let workspace = NSWorkspace::sharedWorkspace();
            let app = workspace.frontmostApplication()?;
            let name = app.localizedName()?;
            Some(name.to_string())
        })
    }

    /// Get the title of the focused window of the frontmost app via
    /// AppleScript / System Events. Returns `None` if the user has
    /// not granted Accessibility / Automation permission — that's
    /// the same wire shape the UI gets when there is no window.
    ///
    /// AppleScript-via-subprocess is the simplest implementation that
    /// requires no extra deps. Switching to native `AXUIElement` calls
    /// when the polling cadence makes the subprocess overhead matter
    /// is tracked as a perf follow-up.
    pub(super) fn frontmost_window_title() -> Option<String> {
        let script = r#"
            tell application "System Events"
                set frontProc to first process whose frontmost is true
                tell frontProc
                    if (count of windows) > 0 then
                        return name of front window
                    else
                        return ""
                    end if
                end tell
            end tell
        "#;
        let output = std::process::Command::new("osascript")
            .args(["-e", script])
            .output()
            .ok()?;
        if !output.status.success() {
            return None;
        }
        let s = String::from_utf8(output.stdout).ok()?;
        let trimmed = s.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        }
    }
}

// -----------------------------------------------------------------
// Windows
// -----------------------------------------------------------------

#[cfg(target_os = "windows")]
mod windows {
    use std::os::windows::ffi::OsStringExt;
    use std::path::Path;

    use windows_sys::Win32::Foundation::{CloseHandle, HWND, MAX_PATH};
    use windows_sys::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
        PROCESS_QUERY_LIMITED_INFORMATION,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        GetForegroundWindow, GetWindowTextLengthW, GetWindowTextW, GetWindowThreadProcessId,
    };

    use super::FrontWindow;

    pub(super) fn current_front_window() -> Option<FrontWindow> {
        // SAFETY: GetForegroundWindow is a thread-safe read; it returns
        // 0 (null HWND) when no window has focus, which we treat as
        // "no signal" by returning None.
        let hwnd: HWND = unsafe { GetForegroundWindow() };
        if hwnd.is_null() {
            return None;
        }
        let title = read_window_title(hwnd);
        let app_name = read_owning_process_basename(hwnd)?;
        Some(FrontWindow { app_name, title })
    }

    fn read_window_title(hwnd: HWND) -> Option<String> {
        // SAFETY: hwnd was just returned by GetForegroundWindow and
        // hasn't crossed a thread boundary. GetWindowTextLengthW is a
        // pure read.
        let len = unsafe { GetWindowTextLengthW(hwnd) };
        if len <= 0 {
            return None;
        }
        let mut buf = vec![0u16; (len as usize) + 1];
        // SAFETY: buf is large enough for `len + 1` UTF-16 code units.
        let written = unsafe { GetWindowTextW(hwnd, buf.as_mut_ptr(), buf.len() as i32) };
        if written <= 0 {
            return None;
        }
        buf.truncate(written as usize);
        let title = std::ffi::OsString::from_wide(&buf)
            .to_string_lossy()
            .into_owned();
        if title.is_empty() {
            None
        } else {
            Some(title)
        }
    }

    fn read_owning_process_basename(hwnd: HWND) -> Option<String> {
        let mut pid: u32 = 0;
        // SAFETY: pid is a writable u32; GetWindowThreadProcessId writes
        // to it. Return value is the thread id, which we don't need.
        unsafe { GetWindowThreadProcessId(hwnd, &mut pid) };
        if pid == 0 {
            return None;
        }
        // SAFETY: PROCESS_QUERY_LIMITED_INFORMATION is the minimum
        // access we need for QueryFullProcessImageNameW and is allowed
        // even for processes running as a different user on modern
        // Windows. We close the handle on every exit path.
        let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
        if handle.is_null() {
            return None;
        }
        let mut buf = vec![0u16; MAX_PATH as usize];
        let mut size = buf.len() as u32;
        // SAFETY: handle is valid, buf has `size` writable UTF-16 cells,
        // size is a pointer to its capacity.
        let ok = unsafe {
            QueryFullProcessImageNameW(handle, PROCESS_NAME_WIN32, buf.as_mut_ptr(), &mut size)
        };
        // SAFETY: close the handle we opened.
        unsafe { CloseHandle(handle) };
        if ok == 0 {
            return None;
        }
        buf.truncate(size as usize);
        let path = std::ffi::OsString::from_wide(&buf)
            .to_string_lossy()
            .into_owned();
        Path::new(&path)
            .file_stem()
            .and_then(|s| s.to_str())
            .map(str::to_string)
    }
}

// -----------------------------------------------------------------
// Linux (X11 first; Wayland adapters follow in M1.x)
// -----------------------------------------------------------------

#[cfg(all(unix, not(target_os = "macos")))]
mod linux {
    use std::process::Command;

    use super::FrontWindow;

    pub(super) fn current_front_window() -> Option<FrontWindow> {
        // Try X11 via xdotool first. Hyprland (hyprctl) and Sway
        // (swaymsg) adapters are tracked separately and will be added
        // when we have access to those compositors for testing.
        x11_via_xdotool()
    }

    fn x11_via_xdotool() -> Option<FrontWindow> {
        let id = Command::new("xdotool")
            .arg("getactivewindow")
            .output()
            .ok()
            .filter(|o| o.status.success())?;
        let id = String::from_utf8(id.stdout).ok()?;
        let id = id.trim();
        if id.is_empty() {
            return None;
        }
        let name = Command::new("xdotool")
            .args(["getwindowname", id])
            .output()
            .ok()
            .filter(|o| o.status.success())?;
        let title = String::from_utf8(name.stdout).ok()?.trim().to_string();
        let app = Command::new("xdotool")
            .args(["getwindowclassname", id])
            .output()
            .ok()
            .filter(|o| o.status.success())?;
        let app_name = String::from_utf8(app.stdout).ok()?.trim().to_string();
        if app_name.is_empty() {
            return None;
        }
        Some(FrontWindow {
            app_name,
            title: (!title.is_empty()).then_some(title),
        })
    }
}

// -----------------------------------------------------------------
// Tests
// -----------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn zed_pattern() {
        assert_eq!(
            derive_ide_folder("Zed", "rules.tsx — cairn"),
            Some(PathBuf::from("cairn")),
        );
    }

    #[test]
    fn zed_with_unsaved_marker_still_picks_project() {
        // Zed uses " ●" to mark unsaved buffers; the project name is
        // unchanged.
        assert_eq!(
            derive_ide_folder("Zed", "rules.tsx ● — cairn"),
            Some(PathBuf::from("cairn")),
        );
    }

    #[test]
    fn vscode_pattern_with_project() {
        assert_eq!(
            derive_ide_folder("Code", "settings.tsx - cairn - Visual Studio Code"),
            Some(PathBuf::from("cairn")),
        );
    }

    #[test]
    fn vscode_pattern_without_project_returns_none() {
        assert!(
            derive_ide_folder("Code", "settings.tsx - Visual Studio Code").is_none(),
            "no project segment → no derived folder"
        );
    }

    #[test]
    fn cursor_uses_the_vscode_pattern() {
        assert_eq!(
            derive_ide_folder("Cursor", "foo.rs - cairn - Visual Studio Code"),
            Some(PathBuf::from("cairn")),
        );
    }

    #[test]
    fn intellij_uses_the_em_dash_pattern() {
        assert_eq!(
            derive_ide_folder("IntelliJ IDEA", "Main.kt — server"),
            Some(PathBuf::from("server")),
        );
    }

    #[test]
    fn xcode_first_segment_is_project() {
        assert_eq!(
            derive_ide_folder("Xcode", "Cairn — main — AppDelegate.swift"),
            Some(PathBuf::from("main")),
        );
    }

    #[test]
    fn rstudio_short_form() {
        assert_eq!(
            derive_ide_folder("RStudio", "cairn - RStudio"),
            Some(PathBuf::from("cairn")),
        );
    }

    #[test]
    fn rstudio_long_form_with_em_dash() {
        assert_eq!(
            derive_ide_folder("RStudio", "~/code/cairn/foo.R — cairn — RStudio"),
            Some(PathBuf::from("cairn")),
        );
    }

    #[test]
    fn nova_em_dash_pattern() {
        assert_eq!(
            derive_ide_folder("Nova", "page.tsx — site"),
            Some(PathBuf::from("site")),
        );
    }

    #[test]
    fn unknown_app_returns_none() {
        // Safari / Slack / random apps: we don't try to derive a
        // folder from their titles. The browser and other signals
        // carry that info instead.
        assert!(derive_ide_folder("Safari", "GitHub - cairn-app/cairn").is_none());
        assert!(derive_ide_folder("Slack", "general — Acme").is_none());
    }

    #[test]
    fn title_without_em_dash_returns_none() {
        assert!(derive_ide_folder("Zed", "settings.tsx").is_none());
    }

    #[test]
    fn empty_project_segment_returns_none() {
        assert!(derive_ide_folder("Zed", "file.tsx — ").is_none());
    }

    #[test]
    fn whitespace_only_project_is_treated_as_empty() {
        assert!(derive_ide_folder("Zed", "file.tsx —    ").is_none());
    }
}
