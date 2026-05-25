//! Process-exit cleanup.
//!
//! Tauri 2's run loop emits `RunEvent::ExitRequested` *before* the
//! Tokio runtime drops. We use that window to drain the SQLite
//! pool: in-flight `start_entry` / `stop_entry` / calendar-sync
//! writes complete cleanly instead of being aborted mid-
//! transaction (which is the bug the reviewers caught on PR #64).
//!
//! Triggered by every exit path: tray "Quit Cairn" (#54),
//! `backup::delete_everything`, OS Cmd+Q, and SIGTERM.

use tauri::{AppHandle, Manager};

use crate::AppState;

/// Drain the DB pool: wait for every in-flight transaction to
/// finish, then close. Safe to call when `AppState` hasn't been
/// managed (e.g. setup failed): silently no-ops in that case.
///
/// Async because tokio's `block_on` panics when called from inside
/// an existing tokio runtime, which would make this untestable
/// under `#[tokio::test]`. The synchronous wrapping happens at the
/// single caller in `lib.rs`'s run-loop closure (which runs on a
/// non-tokio thread).
///
/// `pub(crate)` so the run-loop closure in `lib.rs` can call it.
pub(crate) async fn drain_db_pool<R: tauri::Runtime>(app: &AppHandle<R>) {
    let Some(state) = app.try_state::<AppState>() else {
        // Setup failed (or never ran) — nothing to drain.
        return;
    };
    state.db.pool.close().await;
    log::info!("cairn: shutdown — DB pool drained");
}

#[cfg(test)]
#[cfg(not(target_os = "windows"))]
mod tests {
    use super::*;

    #[tokio::test]
    async fn drain_closes_the_pool() {
        // Regression for the bug both PR #64 reviewers caught:
        // `tray.rs`'s `app.exit(0)` used to abort in-flight SQLite
        // writes because no run-loop hook closed the pool first.
        // This test pins the contract: the helper actually closes
        // the pool. If it stops doing so, the bug is back.
        let (_dir, app, db) = crate::test_support::mock_app_with_db().await;
        assert!(
            !db.pool.is_closed(),
            "fresh test pool should be open before drain",
        );
        drain_db_pool(app.handle()).await;
        assert!(
            db.pool.is_closed(),
            "pool must be closed after drain — otherwise quit can lose writes",
        );
    }

    #[tokio::test]
    async fn drain_is_no_op_when_appstate_unmanaged() {
        // If setup() panicked before `app.manage(AppState { … })`
        // ran, the run-loop's ExitRequested handler still fires.
        // `try_state` returns None; we must NOT panic — that would
        // mask the original setup failure with a noisy shutdown
        // panic on top.
        use tauri::test::{mock_builder, mock_context, noop_assets};
        let app = mock_builder()
            .build(mock_context(noop_assets()))
            .expect("mock_app builds");
        drain_db_pool(app.handle()).await;
    }
}
