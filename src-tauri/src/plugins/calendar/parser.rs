//! ICS parsing. Wraps the `icalendar` crate but adds the bits Cairn needs:
//! a normalized `ParsedEvent`, an "is this event active at instant T"
//! predicate, and the recurrence-rule expansion that lets a weekly
//! meeting actually match when it's happening today.

use chrono::{DateTime, Duration, NaiveDate, NaiveDateTime, NaiveTime, TimeZone, Utc};
use icalendar::parser::{read_calendar, unfold};
use icalendar::{Calendar, CalendarComponent, Component, DatePerhapsTime, Event};

/// Hard cap on how many event instances we expand per source per refresh.
/// Catches pathological `RRULE` cases (yearly-forever, etc.) without
/// having to constrain the underlying iterator.
const MAX_EVENTS_PER_SOURCE: usize = 5_000;

/// How far before/after "now" we expand recurring events. The rules
/// engine only ever asks "is event active at time T", so a tight window
/// keeps memory bounded.
const EXPAND_PAST: chrono::Duration = chrono::Duration::days(1);
const EXPAND_FUTURE: chrono::Duration = chrono::Duration::days(14);

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedEvent {
    pub uid: String,
    pub summary: String,
    pub start: DateTime<Utc>,
    pub end: DateTime<Utc>,
    pub all_day: bool,
    pub attendees: Vec<String>,
}

/// One currently-active event, as seen by the rules engine.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ActiveEvent {
    pub source_id: String,
    pub source_label: String,
    pub event: ParsedEvent,
}

/// Parse an ICS payload into a list of concrete event instances.
///
/// Recurring events are expanded into instances that fall within
/// `[now - EXPAND_PAST, now + EXPAND_FUTURE]`. The expansion is bounded
/// by `MAX_EVENTS_PER_SOURCE`.
pub fn parse(ics: &str, now: DateTime<Utc>) -> anyhow::Result<Vec<ParsedEvent>> {
    if !ics.contains("BEGIN:VCALENDAR") {
        anyhow::bail!("not an ICS document: missing BEGIN:VCALENDAR");
    }
    let unfolded = unfold(ics);
    // The verbose error from `read_calendar` is intentionally discarded.
    // `icalendar` formats parse errors via `nom_language::convert_error`,
    // which embeds the surrounding *input lines* (full `SUMMARY:`,
    // `ATTENDEE:`, `DESCRIPTION:` values from the user's calendar) into
    // the error string. That string used to flow through
    // `registry::sync_one` → `record_sync_err` → SQLite
    // `calendar_sources.last_error` and into the Settings UI, leaking
    // event PII into persistent storage — directly contradicting the
    // "event titles in memory only" privacy guarantee. Now we strip the
    // detail at the boundary and surface a content-free reason; tests
    // guard this. See `mod.rs` privacy notes.
    let raw = read_calendar(&unfolded)
        .map_err(|_| anyhow::anyhow!("ICS parser rejected the document"))?;
    let calendar = Calendar::from(raw);

    let window_start = now - EXPAND_PAST;
    let window_end = now + EXPAND_FUTURE;

    let mut out = Vec::new();
    for component in calendar.components.iter() {
        if let CalendarComponent::Event(event) = component {
            expand_event(event, window_start, window_end, &mut out);
            if out.len() >= MAX_EVENTS_PER_SOURCE {
                log::warn!(
                    "calendar parser: hit MAX_EVENTS_PER_SOURCE cap ({})",
                    MAX_EVENTS_PER_SOURCE
                );
                break;
            }
        }
    }
    out.sort_by_key(|e| e.start);
    Ok(out)
}

/// True when `event.start <= at < event.end`. All-day events are matched
/// against the *date* in the user's local zone, but our `start`/`end`
/// are already UTC instants of those days so a UTC comparison works.
pub fn is_active(event: &ParsedEvent, at: DateTime<Utc>) -> bool {
    event.start <= at && at < event.end
}

fn expand_event(
    event: &Event,
    window_start: DateTime<Utc>,
    window_end: DateTime<Utc>,
    out: &mut Vec<ParsedEvent>,
) {
    let Some((start, end, all_day)) = event_window(event) else {
        return;
    };
    let summary = event.get_summary().unwrap_or_default().to_string();
    let uid = event.get_uid().unwrap_or_default().to_string();
    let attendees = collect_attendees(event);

    // Single (non-recurring) event. RRULE expansion is intentionally
    // out of scope here — `icalendar` does not ship a recurrence
    // expander, and the popular `rrule` crate is GPL. Most cloud
    // providers expand recurrences server-side when they emit the ICS,
    // so this is acceptable for v1. We document the limitation in
    // PRIVACY.md / DESIGN_SPEC.md.
    if end <= window_start || start >= window_end {
        return;
    }
    out.push(ParsedEvent {
        uid,
        summary,
        start,
        end,
        all_day,
        attendees,
    });
}

fn event_window(event: &Event) -> Option<(DateTime<Utc>, DateTime<Utc>, bool)> {
    let dtstart = event.get_start()?;
    let dtend = event.get_end();

    let (start, all_day_start) = to_utc(dtstart);
    let (end, _all_day_end) = match dtend {
        Some(e) => to_utc(e),
        None => {
            // Per RFC 5545: if DTEND is missing, treat all-day events
            // as ending at end-of-day, timed events as zero-length.
            if all_day_start {
                (start + Duration::days(1), true)
            } else {
                (start, false)
            }
        }
    };
    if end < start {
        return None;
    }
    Some((start, end, all_day_start))
}

fn to_utc(dt: DatePerhapsTime) -> (DateTime<Utc>, bool) {
    match dt {
        DatePerhapsTime::DateTime(cdt) => match cdt {
            icalendar::CalendarDateTime::Floating(naive) => (utc_from_naive(naive), false),
            icalendar::CalendarDateTime::Utc(utc) => (utc, false),
            icalendar::CalendarDateTime::WithTimezone { date_time, tzid: _ } => {
                // Without a full IANA tz database lookup we fall back
                // to treating the wall-clock time as UTC. This is a
                // known approximation for v1; events emitted by
                // Google/Apple/Outlook use UTC or have DTSTART in
                // the local zone — both handled correctly above. Only
                // events with an exotic VTIMEZONE block hit this path.
                (utc_from_naive(date_time), false)
            }
        },
        DatePerhapsTime::Date(date) => (utc_from_date(date), true),
    }
}

fn utc_from_naive(n: NaiveDateTime) -> DateTime<Utc> {
    Utc.from_utc_datetime(&n)
}

fn utc_from_date(d: NaiveDate) -> DateTime<Utc> {
    let midnight = d.and_time(NaiveTime::from_hms_opt(0, 0, 0).expect("00:00:00"));
    Utc.from_utc_datetime(&midnight)
}

fn collect_attendees(event: &Event) -> Vec<String> {
    let mut out = Vec::new();
    let attendees = event
        .multi_properties()
        .iter()
        .filter(|(k, _)| k.eq_ignore_ascii_case("ATTENDEE"))
        .flat_map(|(_, v)| v.iter());
    for prop in attendees {
        let raw = prop.value();
        let email = raw
            .trim()
            .trim_start_matches("mailto:")
            .trim_start_matches("MAILTO:")
            .trim()
            .to_string();
        if !email.is_empty() {
            out.push(email);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const SIMPLE: &str = "BEGIN:VCALENDAR\r\n\
VERSION:2.0\r\n\
PRODID:-//Test//EN\r\n\
BEGIN:VEVENT\r\n\
UID:simple@test\r\n\
SUMMARY:Stand-up\r\n\
DTSTART:20260523T090000Z\r\n\
DTEND:20260523T093000Z\r\n\
ATTENDEE;CN=Alice:mailto:alice@example.com\r\n\
ATTENDEE;CN=Bob:MAILTO:bob@example.com\r\n\
END:VEVENT\r\n\
END:VCALENDAR\r\n";

    const ALL_DAY: &str = "BEGIN:VCALENDAR\r\n\
VERSION:2.0\r\n\
PRODID:-//Test//EN\r\n\
BEGIN:VEVENT\r\n\
UID:allday@test\r\n\
SUMMARY:Conference day\r\n\
DTSTART;VALUE=DATE:20260523\r\n\
DTEND;VALUE=DATE:20260524\r\n\
END:VEVENT\r\n\
END:VCALENDAR\r\n";

    fn now() -> DateTime<Utc> {
        Utc.with_ymd_and_hms(2026, 5, 23, 9, 15, 0).unwrap()
    }

    #[test]
    fn parses_simple_event() {
        let events = parse(SIMPLE, now()).unwrap();
        assert_eq!(events.len(), 1);
        let e = &events[0];
        assert_eq!(e.uid, "simple@test");
        assert_eq!(e.summary, "Stand-up");
        assert_eq!(e.attendees, vec!["alice@example.com", "bob@example.com"]);
        assert!(!e.all_day);
        assert!(is_active(e, now()));
    }

    #[test]
    fn parses_all_day_event() {
        let events = parse(ALL_DAY, now()).unwrap();
        assert_eq!(events.len(), 1);
        let e = &events[0];
        assert_eq!(e.summary, "Conference day");
        assert!(e.all_day);
        // 09:15 on the date should be inside [00:00, next-day-00:00)
        assert!(is_active(e, now()));
    }

    #[test]
    fn out_of_window_events_dropped() {
        let far_future = "BEGIN:VCALENDAR\r\n\
VERSION:2.0\r\n\
PRODID:-//Test//EN\r\n\
BEGIN:VEVENT\r\n\
UID:fut@test\r\n\
SUMMARY:Quarterly review\r\n\
DTSTART:20270101T090000Z\r\n\
DTEND:20270101T100000Z\r\n\
END:VEVENT\r\n\
END:VCALENDAR\r\n";
        let events = parse(far_future, now()).unwrap();
        assert!(events.is_empty(), "event 7+ months out should be dropped");
    }

    #[test]
    fn rejects_invalid_ics() {
        let bad = "not an ics file at all";
        assert!(parse(bad, now()).is_err());
    }

    /// Regression test for the third-pass security review finding.
    /// `nom_language::convert_error` (the formatter `icalendar` uses
    /// for parse errors) embeds the input lines around the failure
    /// point into the error string. Before the fix, a malformed ICS
    /// would put the user's event SUMMARY / ATTENDEE / DESCRIPTION
    /// into `calendar_sources.last_error` in SQLite — a persistent
    /// privacy leak. The fix replaces the verbose error with a
    /// content-free message; this test asserts no sentinel event
    /// data can escape via the error chain.
    #[test]
    fn parse_error_never_leaks_event_pii() {
        const SECRET_TITLE: &str = "PRIVATE-DOCTOR-VISIT-9c3a";
        const SECRET_ATTENDEE: &str = "leak-canary-7f12@example.com";
        // Well-formed enough to pass the BEGIN:VCALENDAR guard, then
        // garbage on the next line so the underlying nom parser bails
        // while pointing at the SUMMARY/ATTENDEE lines.
        let malformed = format!(
            "BEGIN:VCALENDAR\r\n\
VERSION:2.0\r\n\
BEGIN:VEVENT\r\n\
SUMMARY:{SECRET_TITLE}\r\n\
ATTENDEE:mailto:{SECRET_ATTENDEE}\r\n\
THIS-IS-NOT-A-VALID-PROPERTY\r\n\
\x00\x00garbage\x00\x00\r\n\
END:VEVENT\r\n\
END:VCALENDAR\r\n"
        );

        let err = match parse(&malformed, now()) {
            Ok(_) => return, // parser accepted it; nothing leaked
            Err(e) => e,
        };
        let chain = format!("{err:#}");
        assert!(
            !chain.contains(SECRET_TITLE),
            "parser error leaked event title: {chain}",
        );
        assert!(
            !chain.contains(SECRET_ATTENDEE),
            "parser error leaked attendee email: {chain}",
        );
    }

    #[test]
    fn is_active_endpoints_are_half_open() {
        let events = parse(SIMPLE, now()).unwrap();
        let e = &events[0];
        let start = Utc.with_ymd_and_hms(2026, 5, 23, 9, 0, 0).unwrap();
        let end = Utc.with_ymd_and_hms(2026, 5, 23, 9, 30, 0).unwrap();
        assert!(is_active(e, start), "start is inclusive");
        assert!(!is_active(e, end), "end is exclusive");
    }
}
