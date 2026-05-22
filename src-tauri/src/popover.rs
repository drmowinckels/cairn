use tauri::{AppHandle, Manager};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};
use tauri_plugin_positioner::{Position, WindowExt};

pub fn toggle(app: &AppHandle) {
    let Some(window) = app.get_webview_window("popover") else {
        log::warn!("popover: window not found");
        return;
    };

    match window.is_visible() {
        Ok(true) => {
            let _ = window.hide();
        }
        _ => {
            let _ = window.move_window(Position::TopRight);
            let _ = window.show();
            let _ = window.set_focus();
        }
    }
}

pub fn register_shortcut(app: &AppHandle) {
    let shortcut = Shortcut::new(
        Some(Modifiers::CONTROL | Modifiers::ALT),
        Code::KeyT,
    );

    let handle = app.clone();
    let result = app.global_shortcut().on_shortcut(shortcut, move |_app, _sc, event| {
        if matches!(event.state(), ShortcutState::Pressed) {
            toggle(&handle);
        }
    });

    if let Err(e) = result {
        log::warn!("popover: failed to register global shortcut Ctrl+Alt+T: {e}");
    }
}
