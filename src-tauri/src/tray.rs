use tauri::{
    image::Image,
    menu::{Menu, MenuBuilder, MenuItemBuilder},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Runtime,
};

use crate::popover;

/// Tray icon id — shared by `setup` and `set_title` so a rename can't
/// silently break the title updates.
pub const TRAY_ID: &str = "cairn-tray";

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
    let icon = tray_icon()?;
    let menu = build_menu(app)?;

    TrayIconBuilder::with_id(TRAY_ID)
        .icon(icon)
        .icon_as_template(true)
        .menu(&menu)
        // macOS-only setting: the default is "left-click shows the
        // menu", which would hide the popover behind a menu the
        // user didn't ask for. Flip it so left-click toggles the
        // popover (existing UX) and the menu surfaces on right-
        // click. Matches Slack / Things conventions. On Linux and
        // Windows this call is a no-op; right-click shows the menu
        // by platform default. (Linux GTK-shell behaviour for tray
        // menus depends on the StatusNotifier implementation —
        // documented gap, tracked under Cairn's macOS-first scope.)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match dispatch_menu_id(event.id().as_ref()) {
            TrayMenuAction::OpenPopover => popover::toggle(app),
            TrayMenuAction::Quit => {
                // `app.exit(0)` triggers `RunEvent::ExitRequested`,
                // which the run-loop handler in `lib.rs` uses to
                // drain the SQLite pool before the Tokio runtime
                // drops. Without that hook, in-flight entry /
                // calendar writes would be aborted mid-transaction.
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

/// Set (or clear) the tray icon's title — the text shown beside the
/// menu-bar icon (#: show current project). `None` clears it. Driven by
/// the popover webview via the `set_tray_title` command as the running
/// timer changes; a no-op if the tray isn't present.
pub fn set_title<R: Runtime>(app: &AppHandle<R>, title: Option<&str>) {
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        if let Err(e) = tray.set_title(title) {
            log::warn!("tray: set_title failed: {e}");
        }
    }
}

fn build_menu<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let open = MenuItemBuilder::with_id(MENU_ID_OPEN, "Open Cairn").build(app)?;
    // `CmdOrCtrl+Q` is the standard quit accelerator: Cmd+Q on
    // macOS, Ctrl+Q on Linux+Windows. Tauri registers it as a
    // menu accelerator (active whenever the menu is alive — i.e.
    // the whole app lifetime for a tray menu). Without this,
    // power users reaching for Cmd+Q on a tray-only app get
    // nothing.
    let quit = MenuItemBuilder::with_id(MENU_ID_QUIT, "Quit Cairn")
        .accelerator("CmdOrCtrl+Q")
        .build(app)?;
    MenuBuilder::new(app)
        .item(&open)
        .separator()
        .item(&quit)
        .build()
}

/// The menu-bar tray uses a dedicated monochrome template rendered from
/// the Cairn brand mark (`icons/tray.png`) — NOT the full-colour app
/// icon. As a macOS template image (`icon_as_template(true)`) only the
/// alpha channel matters, so a full-bleed colour icon would collapse to
/// a solid blob; the template is the cairn silhouette on transparency,
/// which macOS then tints for the light/dark menu bar.
fn tray_icon() -> tauri::Result<Image<'static>> {
    Image::from_bytes(include_bytes!("../icons/tray.png"))
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

    // `build_menu` is intentionally not unit-tested. `muda::Menu`
    // (the Tauri-2 menu backend on macOS) requires the main thread
    // — every tokio::test worker hits a `panic!("can only be
    // created on the main thread")`. The wiring it produces is
    // exercised end-to-end via the `dispatch_menu_id` tests above
    // plus the actual Tauri setup at app launch.
}
