use tauri::{
    image::Image,
    menu::{Menu, MenuBuilder, MenuItemBuilder},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Runtime,
};

use crate::popover;

/// Menu item id: opens the popover. Same effect as left-clicking
/// the tray icon, surfaced explicitly so users discovering the
/// menu first don't have to guess.
const MENU_ID_OPEN: &str = "tray.open";

/// Menu item id: quits the application. Closes #54 — until this
/// existed, the only way to quit was Force Quit from the OS
/// (the popover's close button just hides the window).
const MENU_ID_QUIT: &str = "tray.quit";

/// What the tray menu's `on_menu_event` should do for a given
/// menu id. Pure — no side effects, no `AppHandle`. The wiring in
/// `setup` translates each variant into the actual call. Keeping
/// dispatch and side effects separate is what makes the dispatch
/// rule unit-testable without a real Tauri runtime.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum TrayMenuAction {
    OpenPopover,
    Quit,
    Unknown,
}

/// Pure dispatch: id ↦ action. The `on_menu_event` closure routes
/// every invocation through this so the menu wiring stays narrow.
pub(crate) fn dispatch_menu_id(id: &str) -> TrayMenuAction {
    match id {
        MENU_ID_OPEN => TrayMenuAction::OpenPopover,
        MENU_ID_QUIT => TrayMenuAction::Quit,
        _ => TrayMenuAction::Unknown,
    }
}

pub fn setup(app: &AppHandle) -> tauri::Result<()> {
    let icon = default_icon(app)?;
    let menu = build_menu(app)?;

    TrayIconBuilder::with_id("cairn-tray")
        .icon(icon)
        .icon_as_template(true)
        .menu(&menu)
        // Default on macOS is "left-click shows the menu"; flip it
        // so left-click still toggles the popover (existing UX) and
        // the menu is right-click only. Matches the convention used
        // by other macOS tray apps (Slack, Things) that pair a
        // primary panel with a secondary menu.
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match dispatch_menu_id(event.id().as_ref()) {
            TrayMenuAction::OpenPopover => popover::toggle(app),
            TrayMenuAction::Quit => {
                // `app.exit(0)` runs Tauri's cleanup: stops the
                // background tasks (via runtime drop), closes the
                // popover, exits the process with the given code.
                app.exit(0);
            }
            TrayMenuAction::Unknown => {
                // Unreachable as long as `build_menu` and
                // `dispatch_menu_id` stay in sync. Log so a future
                // regression surfaces in app logs rather than
                // silently no-op-ing.
                log::warn!("tray: unknown menu event id {:?}", event.id().as_ref());
            }
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                popover::toggle(tray.app_handle());
            }
        })
        .build(app)?;

    Ok(())
}

fn build_menu<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let open = MenuItemBuilder::with_id(MENU_ID_OPEN, "Open Cairn").build(app)?;
    let quit = MenuItemBuilder::with_id(MENU_ID_QUIT, "Quit Cairn").build(app)?;
    MenuBuilder::new(app)
        .item(&open)
        .separator()
        .item(&quit)
        .build()
}

fn default_icon(app: &AppHandle) -> tauri::Result<Image<'_>> {
    app.default_window_icon()
        .cloned()
        .ok_or_else(|| tauri::Error::AssetNotFound("default tray icon".into()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dispatch_open_menu_id_returns_open_action() {
        assert_eq!(dispatch_menu_id(MENU_ID_OPEN), TrayMenuAction::OpenPopover);
    }

    #[test]
    fn dispatch_quit_menu_id_returns_quit_action() {
        assert_eq!(dispatch_menu_id(MENU_ID_QUIT), TrayMenuAction::Quit);
    }

    #[test]
    fn dispatch_unknown_menu_id_returns_unknown() {
        // Unknown id must NOT silently route to Quit (or any other
        // active variant) — that would be a regression where a typo
        // in `build_menu` could exit the app on every click.
        assert_eq!(dispatch_menu_id("tray.no-such-id"), TrayMenuAction::Unknown);
        assert_eq!(dispatch_menu_id(""), TrayMenuAction::Unknown);
    }

    #[test]
    fn open_and_quit_menu_ids_are_distinct() {
        // The ids are user-invisible string keys. If they ever
        // collide (e.g. someone copy-pastes the const), every
        // "Open Cairn" click would route to whichever match arm
        // comes first — and #54's discoverable Quit would vanish.
        assert_ne!(MENU_ID_OPEN, MENU_ID_QUIT);
    }

    // `build_menu` is intentionally not unit-tested. `muda::Menu`
    // (the Tauri-2 menu backend on macOS) requires the main thread
    // — every tokio::test worker hits a `panic!("can only be
    // created on the main thread")`. The wiring it produces is
    // exercised end-to-end via the `dispatch_menu_id` tests above
    // plus the actual Tauri setup at app launch.
}
