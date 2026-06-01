use tauri::{
    image::Image,
    menu::{Menu, MenuBuilder, MenuItemBuilder, SubmenuBuilder},
    tray::TrayIconBuilder,
    AppHandle, Emitter, Runtime,
};

use serde::Deserialize;

use crate::popover;

/// Tray icon id — shared by `setup` and `set_title` so a rename can't
/// silently break the title updates.
pub const TRAY_ID: &str = "cairn-tray";

/// Menu item id: opens the popover. Same effect as left-clicking
/// the tray icon, surfaced explicitly so users discovering the
/// menu first don't have to guess.
const MENU_ID_OPEN: &str = "tray.open";

/// Menu item id: shows the small About window (`?win=about`).
const MENU_ID_ABOUT: &str = "tray.about";

/// Window label of the About window — must match the `label` in
/// `tauri.conf.json` and the `?win=about` route the webview reads.
const ABOUT_LABEL: &str = "about";

/// Menu item id: quits the application. Closes #54 — until this
/// existed, the only way to quit was Force Quit from the OS
/// (the popover's close button just hides the window).
const MENU_ID_QUIT: &str = "tray.quit";

/// Menu item id: stops the currently-running timer (#104). Only built
/// into the menu while something is tracking.
const MENU_ID_STOP: &str = "tray.stop";

/// Menu item id prefix for the per-project quick-start entries (#104).
/// The full id is `tray.start.<projectId>`; the project id is the
/// suffix after this prefix. A prefix (rather than a fixed set of ids)
/// is what lets the menu carry a dynamic project list while keeping
/// `dispatch_menu_id` pure.
const MENU_ID_START_PREFIX: &str = "tray.start.";

/// Disabled status line at the top of the menu. Never dispatched (it's
/// not enabled), but it owns a stable id so a future regression that
/// makes it clickable surfaces as `Unknown` in the logs rather than
/// silently doing nothing.
const MENU_ID_STATUS: &str = "tray.status";

/// Event emitted to the popover webview when the user picks a project
/// from the tray's quick-start submenu (#104). The frontend listener
/// resolves the project and starts the timer, reusing the same
/// `use-timer` path the popover UI uses — so tray-started and UI-
/// started entries are identical. The payload is the project id.
pub const TRAY_START_PROJECT_EVENT: &str = "tray:start-project";

/// Event emitted to the popover webview when the user picks "Stop
/// tracking" from the tray menu (#104). No payload — the frontend
/// stops whatever is currently running.
pub const TRAY_STOP_EVENT: &str = "tray:stop";

/// One project, as pushed from the popover for the quick-start submenu.
/// Mirrors the frontend `TrayProject` shape (`src/lib/tray-menu.ts`).
#[derive(Debug, Clone, Deserialize)]
pub struct TrayProject {
    pub id: String,
    pub name: String,
}

/// The live state the tray menu renders (#104). Computed in the popover
/// webview (which already owns the timer + project list) and pushed via
/// the `update_tray_menu` IPC whenever it changes. Keeping the model a
/// plain pushed value — rather than querying the DB from the tray
/// module — mirrors the existing `set_tray_title` flow and keeps the
/// tray module free of `AppState` / SQLite access.
#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct TrayMenuModel {
    /// Human-readable status line, e.g. "Tracking: Cairn — 1h 23m",
    /// "Idle", or "Not tracking". Computed frontend-side so the
    /// elapsed-time formatting lives next to the timer that produces it.
    pub status_label: String,
    /// Whether a timer is currently running. Drives whether the menu
    /// shows "Stop tracking" and whether the project list reads as
    /// "Switch to" vs "Start tracking".
    pub is_running: bool,
    /// Projects offered for quick start/switch, already ordered and
    /// filtered (no archived) by the frontend.
    pub projects: Vec<TrayProject>,
}

/// What the tray menu's `on_menu_event` should do for a given
/// menu id. Pure — no side effects, no `AppHandle`. The wiring in
/// `setup` translates each variant into the actual call. Keeping
/// dispatch and side effects separate is what makes the dispatch
/// rule unit-testable without a real Tauri runtime.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum TrayMenuAction {
    OpenPopover,
    ShowAbout,
    Quit,
    StartProject(String),
    StopTimer,
    Unknown,
}

/// Pure dispatch: id ↦ action. The `on_menu_event` closure routes
/// every invocation through this so the menu wiring stays narrow.
pub(crate) fn dispatch_menu_id(id: &str) -> TrayMenuAction {
    match id {
        MENU_ID_OPEN => TrayMenuAction::OpenPopover,
        MENU_ID_ABOUT => TrayMenuAction::ShowAbout,
        MENU_ID_QUIT => TrayMenuAction::Quit,
        MENU_ID_STOP => TrayMenuAction::StopTimer,
        _ => match id.strip_prefix(MENU_ID_START_PREFIX) {
            // Reject an empty suffix: `tray.start.` with no project id
            // is malformed and must not start a timer with a blank
            // project. Routes to `Unknown` so it logs rather than acts.
            Some(project_id) if !project_id.is_empty() => {
                TrayMenuAction::StartProject(project_id.to_string())
            }
            _ => TrayMenuAction::Unknown,
        },
    }
}

/// Apply a dispatched action's side effects against the running app.
/// Split out of the `on_menu_event` closure so the closure stays a
/// one-liner and the dispatch table reads top-to-bottom.
fn apply_action(app: &AppHandle, action: TrayMenuAction) {
    match action {
        TrayMenuAction::OpenPopover => popover::toggle(app),
        TrayMenuAction::ShowAbout => show_about(app),
        TrayMenuAction::Quit => {
            // `app.exit(0)` triggers `RunEvent::ExitRequested`,
            // which the run-loop handler in `lib.rs` uses to
            // drain the SQLite pool before the Tokio runtime
            // drops. Without that hook, in-flight entry /
            // calendar writes would be aborted mid-transaction.
            app.exit(0);
        }
        TrayMenuAction::StartProject(project_id) => {
            // The webview owns the start path (project resolution +
            // IPC + announcer), same as the toggle-timer shortcut.
            // Emit and let it act; the menu rebuild follows from the
            // timer change the frontend pushes back.
            if let Err(e) =
                app.emit_to(popover::POPOVER_LABEL, TRAY_START_PROJECT_EVENT, project_id)
            {
                log::warn!("tray: emit {TRAY_START_PROJECT_EVENT} failed: {e}");
            }
        }
        TrayMenuAction::StopTimer => {
            if let Err(e) = app.emit_to(popover::POPOVER_LABEL, TRAY_STOP_EVENT, ()) {
                log::warn!("tray: emit {TRAY_STOP_EVENT} failed: {e}");
            }
        }
        TrayMenuAction::Unknown => {
            // Unreachable as long as `build_menu` and
            // `dispatch_menu_id` stay in sync. Log so a future
            // regression surfaces in app logs rather than
            // silently no-op-ing.
            log::warn!("tray: unknown menu event id");
        }
    }
}

/// Show the small About window (`?win=about`), centered + focused.
/// The window is created hidden in `tauri.conf.json`; this reveals it
/// (and re-centres on each open). The webview's close button hides it
/// again. Mirrors the idle window's show flow.
fn show_about<R: Runtime>(app: &AppHandle<R>) {
    use tauri::Manager;
    if let Some(win) = app.get_webview_window(ABOUT_LABEL) {
        use tauri_plugin_positioner::{Position, WindowExt};
        let _ = win.move_window(Position::Center);
        let _ = win.show();
        let _ = win.set_focus();
    } else {
        log::warn!("tray: about window missing; not shown");
    }
}

pub fn setup(app: &AppHandle) -> tauri::Result<()> {
    let icon = tray_icon()?;
    let menu = build_menu(app, &TrayMenuModel::default())?;

    TrayIconBuilder::with_id(TRAY_ID)
        .icon(icon)
        .icon_as_template(true)
        .menu(&menu)
        // Left-click opens the menu (the "dropdown") directly — the user
        // asked for the default click to surface it. The menu's "Open Cairn"
        // item opens the full popover when wanted. macOS honours this flag;
        // on Linux and Windows the platform default already shows the menu on
        // click, so this is a no-op there.
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| apply_action(app, dispatch_menu_id(event.id().as_ref())))
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

/// Rebuild the tray menu from a fresh `model` and swap it in (#104).
/// Driven by the popover webview via the `update_tray_menu` command as
/// the timer / project list changes; a no-op if the tray isn't present.
pub fn update_menu<R: Runtime>(app: &AppHandle<R>, model: &TrayMenuModel) {
    let Some(tray) = app.tray_by_id(TRAY_ID) else {
        return;
    };
    match build_menu(app, model) {
        Ok(menu) => {
            if let Err(e) = tray.set_menu(Some(menu)) {
                log::warn!("tray: set_menu failed: {e}");
            }
        }
        Err(e) => log::warn!("tray: build_menu failed: {e}"),
    }
}

fn build_menu<R: Runtime>(app: &AppHandle<R>, model: &TrayMenuModel) -> tauri::Result<Menu<R>> {
    // Status line — disabled so it reads as a label, not an action.
    let status = MenuItemBuilder::with_id(MENU_ID_STATUS, status_text(&model.status_label))
        .enabled(false)
        .build(app)?;

    let open = MenuItemBuilder::with_id(MENU_ID_OPEN, "Open Cairn").build(app)?;
    let about = MenuItemBuilder::with_id(MENU_ID_ABOUT, "About Cairn").build(app)?;
    // `CmdOrCtrl+Q` is the standard quit accelerator: Cmd+Q on
    // macOS, Ctrl+Q on Linux+Windows. Tauri registers it as a
    // menu accelerator (active whenever the menu is alive — i.e.
    // the whole app lifetime for a tray menu). Without this,
    // power users reaching for Cmd+Q on a tray-only app get
    // nothing.
    let quit = MenuItemBuilder::with_id(MENU_ID_QUIT, "Quit Cairn")
        .accelerator("CmdOrCtrl+Q")
        .build(app)?;

    let mut builder = MenuBuilder::new(app).item(&status).separator();

    // Quick start / switch submenu. Only built when there are projects
    // to offer — an empty submenu would be a dead-end the user can't
    // act on; without projects the popover is the only entry point.
    if !model.projects.is_empty() {
        let mut submenu = SubmenuBuilder::new(app, project_submenu_label(model.is_running));
        for project in &model.projects {
            let item = MenuItemBuilder::with_id(start_menu_id(&project.id), project.name.clone())
                .build(app)?;
            submenu = submenu.item(&item);
        }
        builder = builder.item(&submenu.build()?);
    }

    // "Stop tracking" only makes sense while something is running.
    if model.is_running {
        let stop = MenuItemBuilder::with_id(MENU_ID_STOP, "Stop tracking").build(app)?;
        builder = builder.item(&stop);
    }

    builder
        .separator()
        .item(&open)
        .item(&about)
        .separator()
        .item(&quit)
        .build()
}

/// The full menu id for a project's quick-start item.
fn start_menu_id(project_id: &str) -> String {
    format!("{MENU_ID_START_PREFIX}{project_id}")
}

/// Submenu title: "Switch to" while a timer runs (the action replaces
/// the current entry), "Start tracking" otherwise.
fn project_submenu_label(is_running: bool) -> &'static str {
    if is_running {
        "Switch to"
    } else {
        "Start tracking"
    }
}

/// The status line's display text. Falls back to "Not tracking" when
/// the pushed label is blank (e.g. the popover hasn't computed one yet)
/// so the menu never shows an empty row.
fn status_text(label: &str) -> &str {
    let trimmed = label.trim();
    if trimmed.is_empty() {
        "Not tracking"
    } else {
        trimmed
    }
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
    fn dispatch_about_menu_id_returns_show_about_action() {
        assert_eq!(dispatch_menu_id(MENU_ID_ABOUT), TrayMenuAction::ShowAbout);
    }

    #[test]
    fn dispatch_quit_menu_id_returns_quit_action() {
        assert_eq!(dispatch_menu_id(MENU_ID_QUIT), TrayMenuAction::Quit);
    }

    #[test]
    fn dispatch_stop_menu_id_returns_stop_action() {
        assert_eq!(dispatch_menu_id(MENU_ID_STOP), TrayMenuAction::StopTimer);
    }

    #[test]
    fn dispatch_start_menu_id_returns_start_action_with_project_id() {
        assert_eq!(
            dispatch_menu_id("tray.start.proj-42"),
            TrayMenuAction::StartProject("proj-42".to_string())
        );
    }

    #[test]
    fn dispatch_start_menu_id_preserves_dotted_project_ids() {
        // Project ids are UUIDs today, but a future id scheme could
        // contain dots. `strip_prefix` only peels the first prefix, so
        // the rest of the suffix (dots included) is the project id.
        assert_eq!(
            dispatch_menu_id("tray.start.a.b.c"),
            TrayMenuAction::StartProject("a.b.c".to_string())
        );
    }

    #[test]
    fn dispatch_start_menu_id_with_empty_suffix_is_unknown() {
        // `tray.start.` with no project id must NOT start a blank timer.
        assert_eq!(dispatch_menu_id("tray.start."), TrayMenuAction::Unknown);
    }

    #[test]
    fn dispatch_unknown_menu_id_returns_unknown() {
        // Unknown id must NOT silently route to Quit (or any other
        // active variant) — that would be a regression where a typo
        // in `build_menu` could exit the app on every click.
        assert_eq!(dispatch_menu_id("tray.no-such-id"), TrayMenuAction::Unknown);
        assert_eq!(dispatch_menu_id(""), TrayMenuAction::Unknown);
        assert_eq!(dispatch_menu_id(MENU_ID_STATUS), TrayMenuAction::Unknown);
    }

    #[test]
    fn start_menu_id_round_trips_through_dispatch() {
        let id = start_menu_id("project-x");
        assert_eq!(
            dispatch_menu_id(&id),
            TrayMenuAction::StartProject("project-x".to_string())
        );
    }

    #[test]
    fn project_submenu_label_reflects_running_state() {
        assert_eq!(project_submenu_label(true), "Switch to");
        assert_eq!(project_submenu_label(false), "Start tracking");
    }

    #[test]
    fn status_text_falls_back_when_blank() {
        assert_eq!(status_text(""), "Not tracking");
        assert_eq!(status_text("   "), "Not tracking");
        assert_eq!(status_text("Idle"), "Idle");
        assert_eq!(status_text("  Tracking: Cairn  "), "Tracking: Cairn");
    }

    #[test]
    fn tray_event_names_are_namespaced() {
        // The frontend listeners hard-code these strings; a typo on
        // either side silently drops the binding. Assert the contract.
        assert_eq!(TRAY_START_PROJECT_EVENT, "tray:start-project");
        assert_eq!(TRAY_STOP_EVENT, "tray:stop");
    }

    // `build_menu` / `update_menu` are intentionally not unit-tested.
    // `muda::Menu` (the Tauri-2 menu backend on macOS) requires the
    // main thread — every tokio::test worker hits a `panic!("can only
    // be created on the main thread")`. The wiring they produce is
    // exercised end-to-end via the `dispatch_menu_id` tests above plus
    // the actual Tauri setup at app launch.
}
