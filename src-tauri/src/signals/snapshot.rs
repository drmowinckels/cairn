//! Builds a `SignalSnapshot` from the live signal collectors. Lives
//! here (not in `rules/`) because it does IO; `rules/` stays pure.
//!
//! Today this is mostly stubs — only calendar and frontmost-window are
//! wired up. The shape is in place so each follow-up collector (git,
//! browser, IDE folder) drops in without changing the rules-engine
//! interface.

use chrono::{DateTime, Utc};

use crate::rules::{CalendarEvent, SignalSnapshot};
use crate::signals::calendar::CalendarRegistry;

pub async fn build(calendar: &CalendarRegistry, at: DateTime<Utc>) -> SignalSnapshot {
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

    let front = crate::signals::window::current();
    let (app_name, window_title, ide_folder) = match front {
        Some(w) => {
            let folder = w
                .title
                .as_deref()
                .and_then(|t| crate::signals::window::derive_ide_folder(&w.app_name, t))
                .map(|p| p.to_string_lossy().into_owned());
            (Some(w.app_name), w.title, folder)
        }
        None => (None, None, None),
    };

    // Today, the only signal pointing at a candidate repo on disk is
    // the IDE's project folder. The M1 snapshot stream (issue #5)
    // will replace this with a watcher over user-configurable
    // discovery roots; until then the IDE folder is our best lead.
    let git_branch = ide_folder
        .as_deref()
        .and_then(|f| crate::signals::git::read_git_context(std::path::Path::new(f)))
        .and_then(|ctx| ctx.branch);

    SignalSnapshot {
        ide_folder,
        git_branch,
        window_title,
        app_name,
        browser_domain: None,
        calendar,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::test_db;

    #[tokio::test]
    async fn build_returns_empty_signals_for_empty_registry() {
        let (_dir, db) = test_db().await;
        let registry = CalendarRegistry::new(db.pool.clone()).expect("calendar registry builds");
        let snap = build(&registry, Utc::now()).await;
        // ide / git / browser collectors are stubbed today — every
        // snapshot lands with them as None until M1 lands the cross-
        // platform collectors. Pin that contract.
        assert!(snap.ide_folder.is_none());
        assert!(snap.git_branch.is_none());
        assert!(snap.browser_domain.is_none());
        // No calendar sources registered → no events.
        assert!(snap.calendar.is_empty());
        // window_title / app_name come from `signals::window::current()`,
        // whose return value depends on the host. The contract we pin
        // here is: a window_title is only ever returned alongside an
        // app_name (the macOS collector emits `app_name` with
        // `title: None`, so the inverse — `Some(title), None(app)` —
        // is not a valid shape).
        if snap.window_title.is_some() {
            assert!(
                snap.app_name.is_some(),
                "window_title without app_name is not a valid front-window shape"
            );
        }
    }
}
