use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

/// Frontend listens for this on the popover webview and runs the
/// JS-side start/stop logic (project resolution + IPC + announcer).
/// Keeping the dispatch in TS lets us reuse `last project = first
/// today entry` from `use-shortcut-listeners.ts` without porting it
/// to Rust.
pub const SHORTCUT_TOGGLE_TIMER_EVENT: &str = "shortcut:toggle-timer";
pub const POPOVER_LABEL: &str = "popover";

pub fn toggle(app: &AppHandle) {
    let Some(window) = app.get_webview_window(POPOVER_LABEL) else {
        log::warn!("popover: window not found");
        return;
    };

    match window.is_visible() {
        Ok(true) => {
            let _ = window.hide();
        }
        _ => {
            // Persistent window (#100): show where the user left it
            // (restored by tauri-plugin-window-state) rather than re-
            // anchoring to the tray corner on every open.
            let _ = window.show();
            let _ = window.set_focus();
        }
    }
}

/// Forwards `⌃⌥␣` to the popover webview. The window stays hidden —
/// the frontend listener decides whether to start or stop the timer
/// from the in-memory `current_running` state.
fn dispatch_toggle_timer(app: &AppHandle) {
    if let Err(e) = app.emit_to(POPOVER_LABEL, SHORTCUT_TOGGLE_TIMER_EVENT, ()) {
        log::warn!("popover: emit {SHORTCUT_TOGGLE_TIMER_EVENT} failed: {e}");
    }
}

pub fn register_shortcut(app: &AppHandle) {
    let toggle_popover = Shortcut::new(Some(Modifiers::CONTROL | Modifiers::ALT), Code::KeyT);
    let toggle_timer = Shortcut::new(Some(Modifiers::CONTROL | Modifiers::ALT), Code::Space);

    let handle = app.clone();
    let result = app
        .global_shortcut()
        .on_shortcut(toggle_popover, move |_app, _sc, event| {
            if matches!(event.state(), ShortcutState::Pressed) {
                toggle(&handle);
            }
        });

    if let Err(e) = result {
        log::warn!("popover: failed to register global shortcut Ctrl+Alt+T: {e}");
    }

    let handle_timer = app.clone();
    let result = app
        .global_shortcut()
        .on_shortcut(toggle_timer, move |_app, _sc, event| {
            if matches!(event.state(), ShortcutState::Pressed) {
                dispatch_toggle_timer(&handle_timer);
            }
        });

    if let Err(e) = result {
        log::warn!("popover: failed to register global shortcut Ctrl+Alt+Space: {e}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn event_name_is_namespaced_under_shortcut() {
        // The frontend listener (`use-shortcut-listeners.ts`) hard-
        // codes the same string. A typo on either side silently
        // drops the binding, which is exactly the kind of regression
        // we caught manually in #33 — assert the contract so a rename
        // forces a coordinated change.
        assert_eq!(SHORTCUT_TOGGLE_TIMER_EVENT, "shortcut:toggle-timer");
    }

    #[test]
    fn popover_label_matches_fanout_constant() {
        // `signals::fanout` emits to the same window; sharing the
        // constant means a future window-id rename doesn't silently
        // break either path.
        assert_eq!(POPOVER_LABEL, "popover");
    }

    #[test]
    fn toggle_timer_shortcut_uses_control_alt_space() {
        let sc = Shortcut::new(Some(Modifiers::CONTROL | Modifiers::ALT), Code::Space);
        let mods = sc.mods;
        assert!(mods.contains(Modifiers::CONTROL));
        assert!(mods.contains(Modifiers::ALT));
        assert_eq!(sc.key, Code::Space);
    }
}
