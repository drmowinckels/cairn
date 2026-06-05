//! Calendar signal-source plugin (#111).
//!
//! Lives under `plugins/` — not `signals/` — because calendar is an
//! optional, networked (ICS fetch), secrets-bearing (keychain) signal
//! source behind the plugin boundary; see `docs/PLUGINS.md`. Core's
//! always-on collectors (window · git · idle) stay in `signals/`.
//!
//! Reads VEVENTs from user-registered ICS sources (subscription URLs from
//! Google Calendar / iCloud / Outlook / Fastmail, or local files) and
//! holds the *currently active* events in memory for the rules engine.
//!
//! Privacy:
//! - Event titles, attendees, descriptions live in memory only; they are
//!   never persisted by Cairn. They are evaluated against rules and then
//!   replaced by the next fetch.
//! - Fetches go only to URLs the user explicitly added.
//! - URL secrets (Google's secret-address tokens etc.) live in the OS
//!   keychain, not in the SQLite store.

pub mod autostop;
pub mod fetcher;
pub mod parser;
mod plugin;
pub mod registry;
pub mod secrets;
pub mod store;

pub use parser::ActiveEvent;
pub use plugin::CalendarPlugin;
pub use registry::{CalendarKind, CalendarRegistry, CalendarSource, SyncStatus};

use crate::rules::CalendarEvent;

/// Map the registry's `ActiveEvent`s into the rules-engine
/// `CalendarEvent` shape that travels in a `SignalSnapshot`. Shared by
/// the calendar signal source (`signals::stream::calendar_source`) and
/// the cold-start fallback builder (`signals::snapshot::build`) so the
/// projection lives in one place — the calendar module that owns the
/// types — rather than being duplicated at each consumer.
pub fn to_calendar_events(active: Vec<ActiveEvent>) -> Vec<CalendarEvent> {
    active
        .into_iter()
        .map(|a| CalendarEvent {
            title: a.event.summary,
            source_label: a.source_label,
            attendees: a.event.attendees,
            all_day: a.event.all_day,
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::parser::{ActiveEvent, ParsedEvent};
    use super::*;
    use chrono::Utc;

    fn active(
        summary: &str,
        source_label: &str,
        attendees: Vec<String>,
        all_day: bool,
    ) -> ActiveEvent {
        let now = Utc::now();
        ActiveEvent {
            source_id: "src-1".into(),
            source_label: source_label.into(),
            event: ParsedEvent {
                uid: "uid-1".into(),
                summary: summary.into(),
                start: now,
                end: now,
                all_day,
                attendees,
            },
        }
    }

    #[test]
    fn maps_active_events_into_snapshot_shape() {
        let events = to_calendar_events(vec![
            active("Stand-up", "Work", vec!["a@x.test".into()], false),
            active("All-hands", "Work", vec![], true),
        ]);
        assert_eq!(events.len(), 2);
        assert_eq!(events[0].title, "Stand-up");
        assert_eq!(events[0].source_label, "Work");
        assert_eq!(events[0].attendees, vec!["a@x.test".to_string()]);
        assert!(!events[0].all_day);
        assert_eq!(events[1].title, "All-hands");
        assert!(events[1].all_day);
        assert!(events[1].attendees.is_empty());
    }

    #[test]
    fn maps_empty_input_to_empty_output() {
        assert!(to_calendar_events(vec![]).is_empty());
    }
}
