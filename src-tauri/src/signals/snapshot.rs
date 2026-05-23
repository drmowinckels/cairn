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

    SignalSnapshot {
        ide_folder,
        git_branch: None,
        window_title,
        app_name,
        browser_domain: None,
        calendar,
    }
}
