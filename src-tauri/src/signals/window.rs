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

// `PathBuf` is no longer used in this file directly — IDE-folder
// derivation moved to `signals::ide`. The re-export keeps the
// pre-existing call site (`crate::signals::window::derive_ide_folder`)
// compiling for any consumer that hasn't migrated yet.

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
// IDE folder derivation lives in `signals::ide` now. Keeping a
// re-export here for callers that haven't migrated yet.
// -----------------------------------------------------------------

#[allow(unused_imports)]
pub use crate::signals::ide::derive_ide_folder;

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

// IDE-derivation tests live with the new code in `signals::ide`.
