//! Shared hardening for Cairn's frameless overlay windows.
//!
//! The idle prompt (#261), the suggestion notification (#267) and the About
//! window (#300) are all configured `transparent + alwaysOnTop +
//! decorations:false` and created hidden. `transparent` does **not** make a
//! window click-through, so any one of them becomes an invisible,
//! undismissable input trap in the middle of the screen if its webview never
//! paints — the exact failure #261 documented.
//!
//! Every overlay therefore follows the same contract: shown click-through
//! with its paint flag cleared, made interactive only once the frontend
//! confirms first paint, and hidden by a watchdog if that confirmation never
//! arrives. This module is the single implementation of that contract; each
//! window contributes only its [`Overlay`] descriptor.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering::SeqCst};
use std::time::Duration;

use tauri::{AppHandle, Manager, Runtime, WebviewWindow};

use crate::AppState;

/// How long an overlay may stay shown without the frontend confirming its
/// webview painted before the watchdog hides it. Generous because the window
/// is click-through until the paint ack lands, so a slow-but-working paint is
/// harmless — only a webview that never renders reaches the timeout, and
/// hiding it beats leaving an invisible, undismissable, always-on-top
/// overlay.
pub(crate) const PAINT_WATCHDOG_TIMEOUT: Duration = Duration::from_secs(4);

/// Everything that differs between overlays. The show / watchdog / paint-ack
/// behaviour itself is identical for all of them.
pub(crate) struct Overlay {
    /// Window label, matching `tauri.conf.json`.
    pub label: &'static str,
    /// Where this overlay's show-generation and painted flag live in
    /// `AppState`.
    pub paint_state: fn(&AppState) -> (&AtomicU64, &AtomicBool),
    /// Whether confirming paint should also take OS focus.
    pub focus_on_paint: bool,
    /// Extra bookkeeping to run once the window has been shown.
    pub after_show: fn(&AppState),
    /// Extra bookkeeping to run when the watchdog hides the window.
    pub after_hide: fn(&AppState),
    /// Issue reference for the watchdog's warning log.
    pub issue: &'static str,
}

fn no_op(_: &AppState) {}

/// The idle prompt (#93). A forced choice the user must resolve, so it takes
/// focus once painted.
pub(crate) static IDLE: Overlay = Overlay {
    label: crate::signals::fanout::IDLE_LABEL,
    paint_state: |s| (&s.idle_show_gen, &s.idle_painted),
    focus_on_paint: true,
    after_show: no_op,
    after_hide: no_op,
    issue: "#261",
};

/// The suggestion notification (#267). Deliberately does **not** take focus:
/// it's a dismissible proposal, and stealing focus from whatever the user is
/// actively doing would be a worse interruption than the inline banner it
/// replaces. Its `notify_currently_shown` de-dup flag has to be cleared when
/// the watchdog hides it, or the window would never be shown again.
pub(crate) static NOTIFY: Overlay = Overlay {
    label: crate::signals::fanout::NOTIFY_LABEL,
    paint_state: |s| (&s.notify_show_gen, &s.notify_painted),
    focus_on_paint: false,
    after_show: |s| s.notify_currently_shown.store(true, SeqCst),
    after_hide: |s| s.notify_currently_shown.store(false, SeqCst),
    issue: "#267",
};

/// The About window (#300). Opened explicitly from the tray, so it takes
/// focus once painted — the user just asked for it and expects to be able to
/// Escape out of it.
pub(crate) static ABOUT: Overlay = Overlay {
    label: crate::tray::ABOUT_LABEL,
    paint_state: |s| (&s.about_show_gen, &s.about_painted),
    focus_on_paint: true,
    after_show: no_op,
    after_hide: no_op,
    issue: "#300",
};

/// Present an overlay safely and arm its paint watchdog. Returns the show
/// generation the watchdog guards, or `None` when app state is unavailable
/// (then nothing is armed).
///
/// Positioned with `WebviewWindow::center()`, not `tauri_plugin_positioner`'s
/// `move_window` — the plugin's `calculate_position` does
/// `window.current_monitor()?.unwrap()`, which panics outright when no
/// monitor is available. `center()` returns a `Result` instead.
pub(crate) fn show_with_watchdog<R: Runtime>(
    app: &AppHandle<R>,
    win: &WebviewWindow<R>,
    overlay: &'static Overlay,
    timeout: Duration,
) -> Option<u64> {
    // State first, *then* show. Bailing out after `show()` would leave the
    // window up, click-through and unwatched — no paint ack can arrive to
    // make it interactive and no watchdog can hide it, which is exactly the
    // unprotected state this module exists to prevent. Not reachable in
    // production (setup manages `AppState` long before any overlay can be
    // shown), but the ordering shouldn't be the thing standing between us
    // and a permanent invisible overlay.
    let state = app.try_state::<AppState>()?;

    let _ = win.set_ignore_cursor_events(true);
    let _ = win.center();
    let _ = win.show();

    let (show_gen, painted) = (overlay.paint_state)(&state);
    painted.store(false, SeqCst);
    let generation = show_gen.fetch_add(1, SeqCst) + 1;
    (overlay.after_show)(&state);
    spawn_watchdog(app.clone(), overlay, generation, timeout);
    Some(generation)
}

/// Spawn the paint watchdog for a given show generation. Split from its body
/// so the timing-free decision (`enforce_watchdog`) is unit-tested directly
/// without waiting on the real timeout.
fn spawn_watchdog<R: Runtime>(
    app: AppHandle<R>,
    overlay: &'static Overlay,
    generation: u64,
    timeout: Duration,
) {
    tauri::async_runtime::spawn(watchdog_task(app, overlay, generation, timeout));
}

pub(crate) async fn watchdog_task<R: Runtime>(
    app: AppHandle<R>,
    overlay: &'static Overlay,
    generation: u64,
    timeout: Duration,
) {
    tokio::time::sleep(timeout).await;
    enforce_watchdog(&app, overlay, generation);
}

/// Watchdog action after the timeout: if this show is still the current one
/// and the webview never confirmed paint, hide the window (and drop its
/// click-through state) so it can't linger as an invisible overlay. Returns
/// whether it hid the window.
pub(crate) fn enforce_watchdog<R: Runtime>(
    app: &AppHandle<R>,
    overlay: &'static Overlay,
    generation: u64,
) -> bool {
    let Some(state) = app.try_state::<AppState>() else {
        return false;
    };
    let (show_gen, painted) = (overlay.paint_state)(&state);
    if !should_hide(generation, show_gen.load(SeqCst), painted.load(SeqCst)) {
        return false;
    }
    let Some(win) = app.get_webview_window(overlay.label) else {
        return false;
    };
    // Deliberately does not name a duration: this function doesn't know the
    // timeout its caller waited (tests pass a short one), and a log line
    // stating a wait it never measured is worse than one that omits it.
    log::warn!(
        "overlay: {} window never confirmed paint before the watchdog timeout; hiding to avoid an invisible input trap ({})",
        overlay.label,
        overlay.issue
    );
    let _ = win.set_ignore_cursor_events(false);
    let _ = win.hide();
    (overlay.after_hide)(&state);
    true
}

/// Pure decision for the paint watchdog: hide only when this show is still
/// the latest (not superseded by a newer show) and the webview never
/// confirmed paint.
pub(crate) fn should_hide(shown_generation: u64, current_generation: u64, painted: bool) -> bool {
    shown_generation == current_generation && !painted
}

/// Record the frontend's confirmation that an overlay's webview painted.
/// Marking the show painted cancels the paint watchdog; clearing
/// `ignore_cursor_events` makes the now-visible window interactive.
pub(crate) fn confirm_painted<R: Runtime>(
    app: &AppHandle<R>,
    state: &AppState,
    overlay: &'static Overlay,
) {
    (overlay.paint_state)(state).1.store(true, SeqCst);
    if let Some(win) = app.get_webview_window(overlay.label) {
        let _ = win.set_ignore_cursor_events(false);
        if overlay.focus_on_paint {
            let _ = win.set_focus();
        }
    }
}

// Gated as a whole rather than per-test: every test here needs
// `tauri::test::MockRuntime`, which this codebase can't build on Windows (see
// Cargo.toml's target-gated `tauri = { features = ["test"] }` dev-dep). With
// per-item gates the module compiles empty on Windows and the leftover
// `use super::*` trips `-D warnings`. The pure `should_hide` decision is still
// covered on Windows via `signals::fanout`'s ungated test.
#[cfg(all(test, not(target_os = "windows")))]
mod tests {
    use super::*;

    // The idle and notify overlays are exercised end-to-end through their
    // `signals::fanout` wrappers; these cover the About overlay (#300), the
    // third window onto this shared machinery.

    async fn about_window<R: Runtime>(app: &AppHandle<R>) -> tauri::WebviewWindow<R> {
        tauri::WebviewWindowBuilder::new(app, ABOUT.label, tauri::WebviewUrl::default())
            .visible(false)
            .build()
            .expect("about window builds")
    }

    #[tokio::test]
    async fn show_about_presents_click_through_and_arms_watchdog() {
        let (_dir, app, _db) = crate::test_support::mock_app_with_db().await;
        let handle = app.handle().clone();
        let win = about_window(&handle).await;

        let generation = show_with_watchdog(&handle, &win, &ABOUT, PAINT_WATCHDOG_TIMEOUT)
            .expect("state present → watchdog armed");

        assert_eq!(generation, 1, "first show is generation 1");
        assert!(win.is_visible().unwrap(), "window is shown");
        let state = app.try_state::<crate::AppState>().unwrap();
        assert_eq!(state.about_show_gen.load(SeqCst), 1);
        assert!(
            !state.about_painted.load(SeqCst),
            "painted is cleared until the frontend confirms"
        );
    }

    #[tokio::test]
    async fn show_about_without_app_state_arms_nothing() {
        use tauri::test::{mock_builder, mock_context, noop_assets};
        let app = mock_builder()
            .build(mock_context(noop_assets()))
            .expect("bare mock app");
        let win = about_window(app.handle()).await;
        assert!(
            show_with_watchdog(app.handle(), &win, &ABOUT, PAINT_WATCHDOG_TIMEOUT).is_none(),
            "no AppState → no generation, no watchdog"
        );
    }

    #[tokio::test]
    async fn about_watchdog_hides_a_current_unpainted_window() {
        let (_dir, app, _db) = crate::test_support::mock_app_with_db().await;
        let handle = app.handle().clone();
        let _win = about_window(&handle).await;
        let state = app.try_state::<crate::AppState>().unwrap();
        state.about_show_gen.store(1, SeqCst);
        state.about_painted.store(false, SeqCst);

        // Assert on the return value, not `is_visible()`: MockRuntime's
        // `hide()` doesn't synchronously flip visibility, but `enforce`
        // returns `true` exactly when it ran the hide path.
        assert!(
            enforce_watchdog(&handle, &ABOUT, 1),
            "current + unpainted → hidden, so it can't trap input"
        );
    }

    #[tokio::test]
    async fn about_watchdog_leaves_a_painted_window_up() {
        let (_dir, app, _db) = crate::test_support::mock_app_with_db().await;
        let handle = app.handle().clone();
        let win = about_window(&handle).await;
        let generation =
            show_with_watchdog(&handle, &win, &ABOUT, PAINT_WATCHDOG_TIMEOUT).expect("armed");
        app.try_state::<crate::AppState>()
            .unwrap()
            .about_painted
            .store(true, SeqCst);

        assert!(
            !enforce_watchdog(&handle, &ABOUT, generation),
            "painted → not hidden"
        );
        assert!(win.is_visible().unwrap(), "the About window stays up");
    }

    #[tokio::test]
    async fn about_watchdog_ignores_a_superseded_generation() {
        let (_dir, app, _db) = crate::test_support::mock_app_with_db().await;
        let handle = app.handle().clone();
        let win = about_window(&handle).await;
        let first =
            show_with_watchdog(&handle, &win, &ABOUT, PAINT_WATCHDOG_TIMEOUT).expect("armed");
        let _second =
            show_with_watchdog(&handle, &win, &ABOUT, PAINT_WATCHDOG_TIMEOUT).expect("armed");

        assert!(
            !enforce_watchdog(&handle, &ABOUT, first),
            "stale generation → no-op"
        );
        assert!(win.is_visible().unwrap());
    }

    #[tokio::test]
    async fn about_watchdog_without_app_state_is_a_noop() {
        use tauri::test::{mock_builder, mock_context, noop_assets};
        let app = mock_builder()
            .build(mock_context(noop_assets()))
            .expect("bare mock app");
        assert!(
            !enforce_watchdog(app.handle(), &ABOUT, 1),
            "no AppState → nothing to enforce"
        );
    }

    #[tokio::test]
    async fn about_watchdog_without_a_window_is_a_noop() {
        let (_dir, app, _db) = crate::test_support::mock_app_with_db().await;
        let state = app.try_state::<crate::AppState>().unwrap();
        state.about_show_gen.store(1, SeqCst);
        state.about_painted.store(false, SeqCst);
        assert!(
            !enforce_watchdog(app.handle(), &ABOUT, 1),
            "no About window → nothing to hide"
        );
    }

    #[tokio::test]
    async fn about_paint_ack_marks_painted_and_focuses() {
        let (_dir, app, _db) = crate::test_support::mock_app_with_db().await;
        let handle = app.handle().clone();
        let win = about_window(&handle).await;
        show_with_watchdog(&handle, &win, &ABOUT, PAINT_WATCHDOG_TIMEOUT).expect("armed");
        let state = app.try_state::<crate::AppState>().unwrap();

        confirm_painted(&handle, &state, &ABOUT);

        assert!(
            state.about_painted.load(SeqCst),
            "the show is marked painted, cancelling the watchdog"
        );
    }

    #[tokio::test]
    async fn about_paint_ack_is_safe_without_a_window() {
        let (_dir, app, _db) = crate::test_support::mock_app_with_db().await;
        let state = app.try_state::<crate::AppState>().unwrap();
        state.about_painted.store(false, SeqCst);

        // No About window exists — must not panic and still record the ack.
        confirm_painted(app.handle(), &state, &ABOUT);

        assert!(state.about_painted.load(SeqCst));
    }
}
