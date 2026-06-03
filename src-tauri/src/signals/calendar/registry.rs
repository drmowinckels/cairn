//! In-memory registry that owns the parsed events per source, runs the
//! polling loop, and exposes `active_events_at(now)` to the rules
//! engine and to IPC.

use std::collections::HashMap;
use std::sync::Arc;

use anyhow::{anyhow, Context, Result};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;
use tokio::sync::{Mutex, RwLock};
use tokio::time::{interval, Duration, MissedTickBehavior};

use super::fetcher::{FetchOutcome, Fetcher};
use super::parser::{is_active, parse, ActiveEvent, ParsedEvent};
use super::{secrets, store};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CalendarKind {
    Url,
    File,
}

/// What the DB and the IPC layer see. The bearer URL secret never
/// appears in this struct.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CalendarSource {
    pub id: String,
    pub kind: CalendarKind,
    pub label: String,
    /// For `url`: redacted URL safe to display.
    /// For `file`: absolute path on disk.
    pub location: String,
    pub poll_seconds: i64,
    pub enabled: bool,
    pub last_synced_at: Option<String>,
    pub last_etag: Option<String>,
    pub last_modified: Option<String>,
    pub last_error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncStatus {
    pub source_id: String,
    pub last_synced_at: Option<String>,
    pub last_error: Option<String>,
    pub event_count: usize,
}

#[derive(Default)]
struct State {
    events: HashMap<String, Vec<ParsedEvent>>,
}

pub struct CalendarRegistry {
    pool: SqlitePool,
    fetcher: Arc<Fetcher>,
    state: RwLock<State>,
    sync_lock: Mutex<()>,
}

impl CalendarRegistry {
    pub fn new(pool: SqlitePool) -> Result<Self> {
        Ok(Self {
            pool,
            fetcher: Arc::new(Fetcher::new()?),
            state: RwLock::new(State::default()),
            sync_lock: Mutex::new(()),
        })
    }

    pub async fn list_sources(&self) -> Result<Vec<CalendarSource>> {
        store::list(&self.pool).await
    }

    /// Add a new source. `raw_secret` is required for `url` kind (the
    /// full URL including any token); it is written to the OS keychain
    /// and never returned. For `file` kind the location is the path
    /// itself and `raw_secret` is ignored.
    pub async fn add_source(
        &self,
        kind: CalendarKind,
        label: String,
        raw: String,
    ) -> Result<CalendarSource> {
        let id = uuid::Uuid::new_v4().to_string();
        // Compute the SQLite-bound `location` *before* writing the
        // secret to the keychain. For URL sources this must succeed
        // (redaction failing means we'd otherwise be forced to either
        // fall back to the raw URL — leaking the secret into SQLite —
        // or have a keychain entry pointing at a row we never wrote).
        // The error type carries no fragment of the raw URL, so it is
        // safe to bubble up as a user-visible message.
        let location = match kind {
            CalendarKind::Url => {
                secrets::redact_url(&raw).map_err(|e| anyhow!("invalid calendar URL: {e}"))?
            }
            CalendarKind::File => raw.clone(),
        };
        let src = CalendarSource {
            id: id.clone(),
            kind,
            label,
            location,
            poll_seconds: default_poll(kind),
            enabled: true,
            last_synced_at: None,
            last_etag: None,
            last_modified: None,
            last_error: None,
        };
        if matches!(kind, CalendarKind::Url) {
            secrets::store(&id, &raw).context("write calendar URL to keychain")?;
        }
        store::insert(&self.pool, &src).await?;
        // Kick off an immediate sync but don't block the add.
        let _ = self.sync_one(&id).await;
        Ok(src)
    }

    pub async fn remove_source(&self, id: &str) -> Result<()> {
        let _ = secrets::remove(id);
        store::delete(&self.pool, id).await?;
        let mut st = self.state.write().await;
        st.events.remove(id);
        Ok(())
    }

    pub async fn update_source(
        &self,
        id: &str,
        label: Option<String>,
        poll_seconds: Option<i64>,
        enabled: Option<bool>,
    ) -> Result<CalendarSource> {
        let mut src = store::get(&self.pool, id)
            .await?
            .ok_or_else(|| anyhow!("no calendar source with id {id}"))?;
        if let Some(l) = label {
            src.label = l;
        }
        if let Some(p) = poll_seconds {
            src.poll_seconds = p.clamp(60, 3_600);
        }
        if let Some(en) = enabled {
            src.enabled = en;
        }
        store::update_meta(&self.pool, &src).await?;
        Ok(src)
    }

    /// Force a refresh of a single source. Used by the manual "refresh"
    /// button in Settings.
    pub async fn refresh(&self, id: &str) -> Result<CalendarSource> {
        self.sync_one(id).await?;
        store::get(&self.pool, id)
            .await?
            .ok_or_else(|| anyhow!("calendar source {id} disappeared after refresh"))
    }

    pub async fn active_events_at(&self, at: DateTime<Utc>) -> Vec<ActiveEvent> {
        let sources = match store::list(&self.pool).await {
            Ok(s) => s,
            Err(e) => {
                log::warn!("calendar: list sources for active_events_at failed: {e}");
                return Vec::new();
            }
        };
        let st = self.state.read().await;
        let mut out = Vec::new();
        for src in sources.into_iter().filter(|s| s.enabled) {
            if let Some(events) = st.events.get(&src.id) {
                for ev in events.iter().filter(|e| is_active(e, at)) {
                    out.push(ActiveEvent {
                        source_id: src.id.clone(),
                        source_label: src.label.clone(),
                        event: ev.clone(),
                    });
                }
            }
        }
        out
    }

    /// The next `limit` events that start strictly after `at`, across
    /// every enabled source, sorted by start ascending. Powers the
    /// Today view's "Up next" list (issue #20). All-day events are
    /// included — the UI labels them but the row still renders.
    pub async fn upcoming_events_at(&self, at: DateTime<Utc>, limit: usize) -> Vec<ActiveEvent> {
        if limit == 0 {
            return Vec::new();
        }
        let sources = match store::list(&self.pool).await {
            Ok(s) => s,
            Err(e) => {
                log::warn!("calendar: list sources for upcoming_events_at failed: {e}");
                return Vec::new();
            }
        };
        let st = self.state.read().await;
        let mut out: Vec<ActiveEvent> = Vec::new();
        for src in sources.into_iter().filter(|s| s.enabled) {
            if let Some(events) = st.events.get(&src.id) {
                for ev in events.iter().filter(|e| e.start > at) {
                    out.push(ActiveEvent {
                        source_id: src.id.clone(),
                        source_label: src.label.clone(),
                        event: ev.clone(),
                    });
                }
            }
        }
        out.sort_by_key(|a| a.event.start);
        out.truncate(limit);
        out
    }

    pub async fn sync_status(&self) -> Vec<SyncStatus> {
        let sources = match store::list(&self.pool).await {
            Ok(s) => s,
            Err(e) => {
                log::warn!("calendar: list sources for sync_status failed: {e}");
                return Vec::new();
            }
        };
        let st = self.state.read().await;
        sources
            .into_iter()
            .map(|s| SyncStatus {
                event_count: st.events.get(&s.id).map(|v| v.len()).unwrap_or(0),
                source_id: s.id,
                last_synced_at: s.last_synced_at,
                last_error: s.last_error,
            })
            .collect()
    }

    /// The scheduler loop. The caller is responsible for spawning this
    /// onto a runtime (typically `tauri::async_runtime::spawn`). Ticks
    /// every 30 seconds and refreshes any source whose individual
    /// `poll_seconds` has elapsed since `last_synced_at`.
    pub async fn run_scheduler(self: Arc<Self>) {
        let mut ticker = interval(Duration::from_secs(30));
        ticker.set_missed_tick_behavior(MissedTickBehavior::Delay);
        loop {
            ticker.tick().await;
            if let Err(e) = self.tick().await {
                log::warn!("calendar scheduler tick failed: {e}");
            }
        }
    }

    async fn tick(&self) -> Result<()> {
        let sources = store::list(&self.pool).await?;
        let now = Utc::now();
        for src in sources.into_iter().filter(|s| s.enabled) {
            if !is_due(&src, now) {
                continue;
            }
            if let Err(e) = self.sync_one(&src.id).await {
                log::warn!("calendar source {} sync failed: {e}", src.id);
            }
        }
        Ok(())
    }

    async fn sync_one(&self, id: &str) -> Result<()> {
        let _guard = self.sync_lock.lock().await;
        let src = store::get(&self.pool, id)
            .await?
            .ok_or_else(|| anyhow!("no calendar source with id {id}"))?;

        let outcome = match src.kind {
            CalendarKind::Url => {
                let secret = secrets::load(id)?
                    .ok_or_else(|| anyhow!("calendar URL secret missing from keychain"))?;
                self.fetcher
                    .fetch(
                        &secret,
                        src.last_etag.as_deref(),
                        src.last_modified.as_deref(),
                    )
                    .await
            }
            CalendarKind::File => match tokio::fs::read_to_string(&src.location).await {
                Ok(body) => Ok(FetchOutcome::Changed(super::fetcher::FetchOk {
                    body,
                    etag: None,
                    last_modified: None,
                })),
                Err(e) => Err(anyhow::Error::from(e).context("read calendar file")),
            },
        };

        let fetched = match outcome {
            Ok(FetchOutcome::Unchanged) => {
                store::record_sync_ok(
                    &self.pool,
                    id,
                    src.last_etag.as_deref(),
                    src.last_modified.as_deref(),
                )
                .await?;
                return Ok(());
            }
            Ok(FetchOutcome::Changed(f)) => f,
            Err(e) => {
                let msg = format!("{e:#}");
                store::record_sync_err(&self.pool, id, &msg).await?;
                return Err(e);
            }
        };

        let parsed = match parse(&fetched.body, Utc::now()) {
            Ok(p) => p,
            Err(e) => {
                let msg = format!("{e:#}");
                store::record_sync_err(&self.pool, id, &msg).await?;
                return Err(e);
            }
        };

        store::record_sync_ok(
            &self.pool,
            id,
            fetched.etag.as_deref(),
            fetched.last_modified.as_deref(),
        )
        .await?;
        let mut st = self.state.write().await;
        st.events.insert(id.to_string(), parsed);
        Ok(())
    }
}

fn default_poll(kind: CalendarKind) -> i64 {
    match kind {
        CalendarKind::Url => 900, // 15 min
        CalendarKind::File => 60, // 1 min — local read is cheap
    }
}

fn is_due(src: &CalendarSource, now: DateTime<Utc>) -> bool {
    let Some(last) = src.last_synced_at.as_ref() else {
        return true;
    };
    let parsed = match DateTime::parse_from_rfc3339(last) {
        Ok(p) => p.with_timezone(&Utc),
        Err(_) => return true,
    };
    (now - parsed).num_seconds() >= src.poll_seconds
}

impl CalendarRegistry {
    /// Test-only: replace the in-memory parsed events for a source.
    /// Used to drive `active_events_at` / `upcoming_events_at` from
    /// unit tests without exercising the full ICS fetch + parse path.
    #[cfg(test)]
    pub(crate) async fn seed_events_for_test(&self, source_id: &str, events: Vec<ParsedEvent>) {
        let mut st = self.state.write().await;
        st.events.insert(source_id.to_string(), events);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::test_db;

    fn make_parsed(uid: &str, start: DateTime<Utc>, dur_minutes: i64) -> ParsedEvent {
        ParsedEvent {
            uid: uid.into(),
            summary: format!("event {uid}"),
            start,
            end: start + chrono::Duration::minutes(dur_minutes),
            all_day: false,
            attendees: vec![],
        }
    }

    #[tokio::test]
    async fn upcoming_events_at_empty_when_no_sources() {
        let (_dir, db) = test_db().await;
        let reg = CalendarRegistry::new(db.pool.clone()).unwrap();
        let out = reg.upcoming_events_at(Utc::now(), 3).await;
        assert!(out.is_empty());
    }

    #[tokio::test]
    async fn upcoming_events_at_returns_next_events_only() {
        let (_dir, db) = test_db().await;
        let reg = CalendarRegistry::new(db.pool.clone()).unwrap();
        let src = reg
            .add_source(CalendarKind::File, "Work".into(), "/tmp/none.ics".into())
            .await
            .unwrap();

        let now = Utc::now();
        // One past (already started), three future.
        let events = vec![
            make_parsed("past", now - chrono::Duration::minutes(10), 30),
            make_parsed("a", now + chrono::Duration::minutes(15), 30),
            make_parsed("b", now + chrono::Duration::minutes(45), 60),
            make_parsed("c", now + chrono::Duration::minutes(120), 30),
        ];
        reg.seed_events_for_test(&src.id, events).await;

        let out = reg.upcoming_events_at(now, 2).await;
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].event.uid, "a");
        assert_eq!(out[1].event.uid, "b");

        let limited = reg.upcoming_events_at(now, 0).await;
        assert!(limited.is_empty(), "limit=0 returns empty");
    }

    #[tokio::test]
    async fn upcoming_events_at_sorts_across_sources() {
        let (_dir, db) = test_db().await;
        let reg = CalendarRegistry::new(db.pool.clone()).unwrap();
        let s1 = reg
            .add_source(CalendarKind::File, "Work".into(), "/tmp/a.ics".into())
            .await
            .unwrap();
        let s2 = reg
            .add_source(CalendarKind::File, "Home".into(), "/tmp/b.ics".into())
            .await
            .unwrap();

        let now = Utc::now();
        reg.seed_events_for_test(
            &s1.id,
            vec![make_parsed("w1", now + chrono::Duration::minutes(30), 15)],
        )
        .await;
        reg.seed_events_for_test(
            &s2.id,
            vec![make_parsed("h1", now + chrono::Duration::minutes(10), 15)],
        )
        .await;

        let out = reg.upcoming_events_at(now, 5).await;
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].event.uid, "h1");
        assert_eq!(out[1].event.uid, "w1");
    }

    #[tokio::test]
    async fn active_events_at_returns_currently_running_events() {
        // Drives the `if let Some(events)` = Some arm of
        // `active_events_at`: at least one event is in-progress at
        // `at`. Without this, the inner `out.push(ActiveEvent { … })`
        // body stays uncovered even with the upcoming tests above.
        let (_dir, db) = test_db().await;
        let reg = CalendarRegistry::new(db.pool.clone()).unwrap();
        let src = reg
            .add_source(CalendarKind::File, "Work".into(), "/tmp/none.ics".into())
            .await
            .unwrap();
        let now = Utc::now();
        let events = vec![
            // 10 min ago → 20 min from now (active).
            make_parsed("now", now - chrono::Duration::minutes(10), 30),
            // 60 min ago → 30 min ago (past).
            make_parsed("past", now - chrono::Duration::minutes(60), 30),
        ];
        reg.seed_events_for_test(&src.id, events).await;
        let out = reg.active_events_at(now).await;
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].event.uid, "now");
        assert_eq!(out[0].source_label, "Work");
    }

    #[tokio::test]
    async fn upcoming_events_at_returns_empty_when_store_list_fails() {
        // Covers the `Err(e)` arm of `store::list(&self.pool).await`.
        // We close the pool to make `list` fail with an
        // `error returned from database: ...` — the function must log
        // and return an empty list rather than panic.
        let (_dir, db) = test_db().await;
        let reg = CalendarRegistry::new(db.pool.clone()).unwrap();
        db.pool.close().await;
        let out = reg.upcoming_events_at(Utc::now(), 3).await;
        assert!(out.is_empty());
    }

    #[tokio::test]
    async fn active_events_at_returns_empty_when_store_list_fails() {
        // Sibling of the test above for `active_events_at`.
        let (_dir, db) = test_db().await;
        let reg = CalendarRegistry::new(db.pool.clone()).unwrap();
        db.pool.close().await;
        let out = reg.active_events_at(Utc::now()).await;
        assert!(out.is_empty());
    }

    #[tokio::test]
    async fn upcoming_events_at_handles_source_without_seeded_events() {
        // Covers the `if let Some(events)` = None arm: an enabled source
        // that has never been synced is silently skipped instead of
        // panicking. Without this, the next `upcoming_events_at` call
        // after adding a fresh source would crash with a `None` unwrap.
        let (_dir, db) = test_db().await;
        let reg = CalendarRegistry::new(db.pool.clone()).unwrap();
        reg.add_source(CalendarKind::File, "Empty".into(), "/tmp/none.ics".into())
            .await
            .unwrap();
        let out = reg.upcoming_events_at(Utc::now(), 5).await;
        assert!(
            out.is_empty(),
            "enabled source with no events yields nothing"
        );
    }

    #[tokio::test]
    async fn active_events_at_handles_source_without_seeded_events() {
        // Mirrors the test above for `active_events_at` — the sibling
        // helper that powers `current_calendar_events`. Same `if let
        // Some(events)` = None arm.
        let (_dir, db) = test_db().await;
        let reg = CalendarRegistry::new(db.pool.clone()).unwrap();
        reg.add_source(CalendarKind::File, "Empty".into(), "/tmp/none.ics".into())
            .await
            .unwrap();
        let out = reg.active_events_at(Utc::now()).await;
        assert!(
            out.is_empty(),
            "enabled source with no events yields nothing"
        );
    }

    #[tokio::test]
    async fn upcoming_events_at_skips_disabled_sources() {
        let (_dir, db) = test_db().await;
        let reg = CalendarRegistry::new(db.pool.clone()).unwrap();
        let src = reg
            .add_source(CalendarKind::File, "Work".into(), "/tmp/a.ics".into())
            .await
            .unwrap();
        reg.update_source(&src.id, None, None, Some(false))
            .await
            .unwrap();

        let now = Utc::now();
        reg.seed_events_for_test(
            &src.id,
            vec![make_parsed("a", now + chrono::Duration::minutes(15), 30)],
        )
        .await;
        let out = reg.upcoming_events_at(now, 5).await;
        assert!(out.is_empty(), "disabled source should not contribute");
    }

    #[tokio::test]
    async fn sync_status_lists_sources() {
        let (_dir, db) = test_db().await;
        let reg = CalendarRegistry::new(db.pool.clone()).unwrap();
        let src = reg
            .add_source(CalendarKind::File, "Work".into(), "/tmp/a.ics".into())
            .await
            .unwrap();
        let status = reg.sync_status().await;
        assert_eq!(status.len(), 1);
        assert_eq!(status[0].source_id, src.id);
        assert_eq!(status[0].event_count, 0);
    }

    #[tokio::test]
    async fn sync_status_returns_empty_when_store_list_fails() {
        // Covers the `Err(e)` arm added in #141: a transient DB error
        // must be logged and degrade to an empty list rather than be
        // silently swallowed by `unwrap_or_default`.
        let (_dir, db) = test_db().await;
        let reg = CalendarRegistry::new(db.pool.clone()).unwrap();
        db.pool.close().await;
        let status = reg.sync_status().await;
        assert!(status.is_empty());
    }

    #[test]
    fn is_due_when_never_synced() {
        let src = sample(None, 900);
        assert!(is_due(&src, Utc::now()));
    }

    #[test]
    fn is_due_only_after_interval() {
        let now = Utc::now();
        let last = (now - chrono::Duration::seconds(600)).to_rfc3339();
        let src = sample(Some(last), 900);
        assert!(!is_due(&src, now), "10 min < 15 min poll interval");
    }

    #[test]
    fn is_due_after_interval() {
        let now = Utc::now();
        let last = (now - chrono::Duration::seconds(1000)).to_rfc3339();
        let src = sample(Some(last), 900);
        assert!(is_due(&src, now));
    }

    fn sample(last: Option<String>, poll: i64) -> CalendarSource {
        CalendarSource {
            id: "x".into(),
            kind: CalendarKind::Url,
            label: "Work".into(),
            location: "https://example.com/***".into(),
            poll_seconds: poll,
            enabled: true,
            last_synced_at: last,
            last_etag: None,
            last_modified: None,
            last_error: None,
        }
    }
}
