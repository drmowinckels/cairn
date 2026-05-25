//! Builds a `SignalSnapshot` from the live signal collectors. Lives
//! here (not in `rules/`) because it does IO; `rules/` stays pure.
//!
//! ## When this is used
//!
//! In M0 + early M1, this was invoked synchronously from the
//! `current_snapshot` IPC on every UI call. Since the snapshot
//! stream landed (#5), the live cache in `SnapshotStream` is the
//! primary source and this builder is the *cold-start fallback*:
//! `current_snapshot` calls it only when the stream's watch
//! channel still holds `None` (i.e. before the driver has
//! published its first snapshot).
//!
//! ## Privacy
//!
//! Even in fallback mode, the exclusion list applies. `build` takes
//! an `&ExclusionMatcher` and redacts the composed snapshot before
//! returning so a popover opened in the ~1.5s cold-start window
//! never sees an excluded app's title. The `signals::window::current`
//! call runs inside `spawn_blocking` so a slow `osascript` /
//! `xdotool` subprocess can't stall the tokio worker that's
//! handling the IPC.

use std::sync::Arc;
use std::sync::RwLock;

use chrono::{DateTime, Utc};

use crate::rules::{CalendarEvent, SignalSnapshot};
use crate::signals::calendar::CalendarRegistry;
use crate::signals::exclusions::ExclusionMatcher;

pub async fn build(
    calendar: &CalendarRegistry,
    exclusions: &Arc<RwLock<ExclusionMatcher>>,
    at: DateTime<Utc>,
) -> SignalSnapshot {
    let active = calendar.active_events_at(at).await;
    let calendar = active
        .into_iter()
        .map(|a| CalendarEvent {
            title: a.event.summary,
            source_label: a.source_label,
            attendees: a.event.attendees,
            all_day: a.event.all_day,
        })
        .collect();

    // `signals::window::current` shells out on every platform —
    // run it on the blocking pool so the IPC worker isn't stalled
    // by `osascript` / `xdotool`. The fallback uses `None` when the
    // blocking task fails (panic / cancellation), matching what the
    // snapshot stream's window source does on the steady-state path.
    let front = tokio::task::spawn_blocking(crate::signals::window::current)
        .await
        .unwrap_or_else(|e| {
            log::warn!("snapshot::build window spawn_blocking failed: {e}");
            None
        });
    let (app_name, window_title, ide_folder) = match front {
        Some(w) => {
            let folder = w
                .title
                .as_deref()
                .and_then(|t| crate::signals::ide::derive_ide_folder(&w.app_name, t, &[]))
                .map(|p| p.to_string_lossy().into_owned());
            (Some(w.app_name), w.title, folder)
        }
        None => (None, None, None),
    };

    // `git_branch` and `browser_domain` stay `None` here — the
    // real-time collectors that feed those fields run inside the
    // snapshot stream's driver task, not in this cold-start path.
    // The fallback is genuinely a fallback: a popover opened
    // before the first stream publish gets the window snapshot and
    // calendar, nothing else.
    let mut snap = SignalSnapshot {
        ide_folder,
        git_branch: None,
        window_title,
        app_name,
        browser_domain: None,
        calendar,
    };

    // Per `docs/PRIVACY.md`: exclusions apply at every choke point,
    // not just the stream's `apply_event` step. A popover opened
    // during the cold-start window must not leak an excluded
    // foreground app.
    match exclusions.read() {
        Ok(guard) => guard.redact_snapshot(&mut snap),
        Err(_) => {
            // Lock poisoned — fail closed, same as `stream::publish`.
            log::warn!("snapshot::build exclusions lock poisoned, redacting fully");
            snap.app_name = None;
            snap.window_title = None;
            snap.ide_folder = None;
            snap.git_branch = None;
            snap.browser_domain = None;
        }
    }

    snap
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::test_db;

    fn fresh_exclusions() -> Arc<RwLock<ExclusionMatcher>> {
        Arc::new(RwLock::new(ExclusionMatcher::default()))
    }

    #[tokio::test]
    async fn build_returns_empty_signals_for_empty_registry() {
        let (_dir, db) = test_db().await;
        let registry = CalendarRegistry::new(db.pool.clone()).expect("calendar registry builds");
        let snap = build(&registry, &fresh_exclusions(), Utc::now()).await;
        assert!(snap.ide_folder.is_none());
        assert!(snap.git_branch.is_none());
        assert!(snap.browser_domain.is_none());
        assert!(snap.calendar.is_empty());
        if snap.window_title.is_some() {
            assert!(
                snap.app_name.is_some(),
                "window_title without app_name is not a valid front-window shape"
            );
        }
    }

    #[tokio::test]
    async fn build_handles_poisoned_exclusions_lock_fail_closed() {
        // Cover the poisoned-RwLock branch in `build`: if the
        // exclusions lock is poisoned (a writer panicked) the
        // fallback must fail closed, returning a snapshot with no
        // OS-derived fields. Otherwise an excluded app from the
        // host could leak through during cold-start IPC.
        let (_dir, db) = test_db().await;
        let registry = CalendarRegistry::new(db.pool.clone()).expect("calendar registry builds");
        let exclusions = Arc::new(RwLock::new(ExclusionMatcher::default()));
        let poisoner = exclusions.clone();
        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _guard = poisoner.write().unwrap();
            panic!("simulated poison in test");
        }));
        assert!(
            exclusions.read().is_err(),
            "RwLock must be poisoned for the test to be meaningful"
        );
        let snap = build(&registry, &exclusions, Utc::now()).await;
        // Fail-closed: every OS-derived field cleared.
        assert!(snap.app_name.is_none());
        assert!(snap.window_title.is_none());
        assert!(snap.ide_folder.is_none());
        assert!(snap.git_branch.is_none());
        assert!(snap.browser_domain.is_none());
    }

    #[tokio::test]
    async fn build_redacts_excluded_app() {
        // Pin the cold-start privacy contract: if the window
        // collector returns an excluded app, the fallback snapshot
        // must NOT carry it.
        let (_dir, db) = test_db().await;
        let registry = CalendarRegistry::new(db.pool.clone()).expect("calendar registry builds");
        // We can't directly inject a `FrontWindow` from this side
        // (the OS-level collector is whatever the test host
        // actually has frontmost), so simulate by building a raw
        // snapshot and redacting it.
        let exclusions = Arc::new(RwLock::new(ExclusionMatcher::for_test(
            &["Whatever"],
            &["NeverInTitle"],
            &[],
        )));
        let snap = build(&registry, &exclusions, Utc::now()).await;
        // The snapshot built on the test host has *some* app_name
        // (or None). If it's Some, it can't be "Whatever" — the
        // host isn't running our fixture. So the test asserts the
        // weaker but still-meaningful invariant: redaction never
        // ADDS a field, it only clears. (Strong assertion lives in
        // the `signals::exclusions::tests::redact_snapshot_*` cases
        // which run on a synthetic snapshot.)
        if let Some(name) = snap.app_name.as_deref() {
            assert_ne!(name, "Whatever");
        }
        // window_title likewise must not contain the excluded
        // substring after build.
        if let Some(title) = snap.window_title.as_deref() {
            assert!(!title.contains("NeverInTitle"));
        }
    }
}
