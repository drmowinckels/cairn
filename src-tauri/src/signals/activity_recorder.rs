//! Activity-log recorder (#190): turns the live `SignalSnapshot` stream into
//! foreground-app *spans* and writes them to the `activity_log` table while the
//! opt-in toggle is on.
//!
//! Like [`super::capture`] it hangs off `stream.subscribe()`, so it records
//! exactly what the rules engine sees — the exclusion list has already redacted
//! excluded apps to `app_name = None`, which the recorder treats as "no
//! foreground" (a gap), so excluded apps never produce a row. Window titles are
//! run through [`crate::activity_log::redact_title`] before storage.
//!
//! The span logic ([`SpanBuilder`]) is a pure state machine, separated from the
//! async/DB/clock plumbing so it can be unit-tested with injected times.

use std::sync::Arc;

use chrono::{DateTime, Utc};
use sqlx::SqlitePool;
use tokio::sync::{oneshot, watch, Mutex};
use tokio::task::JoinHandle;

use crate::activity_log;
use crate::rules::SignalSnapshot;

/// A finished foreground span, ready to persist.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CompletedSpan {
    pub app_name: String,
    pub title_hint: Option<String>,
    pub start: DateTime<Utc>,
    pub end: DateTime<Utc>,
}

struct OpenSpan {
    app_name: String,
    title_hint: Option<String>,
    start: DateTime<Utc>,
}

/// Folds a sequence of `(foreground app, time)` observations into spans. A span
/// opens when an app takes the foreground and completes when the foreground
/// changes to a different app or away entirely (`None`). Same-app observations
/// extend the open span (the first title hint wins).
#[derive(Default)]
pub struct SpanBuilder {
    open: Option<OpenSpan>,
}

impl SpanBuilder {
    /// Observe the foreground app at `at`. `app_name = None` means no tracked
    /// foreground (excluded / idle / no window). Returns a completed span when
    /// this observation closes a previously-open one.
    pub fn observe(
        &mut self,
        app_name: Option<String>,
        title_hint: Option<String>,
        at: DateTime<Utc>,
    ) -> Option<CompletedSpan> {
        if let (Some(open), Some(app)) = (&self.open, &app_name) {
            if open.app_name == *app {
                return None; // same app — extend the open span
            }
        }
        let completed = self.open.take().map(|o| CompletedSpan {
            app_name: o.app_name,
            title_hint: o.title_hint,
            start: o.start,
            end: at,
        });
        if let Some(app) = app_name {
            self.open = Some(OpenSpan {
                app_name: app,
                title_hint,
                start: at,
            });
        }
        completed
    }

    /// Close any open span at `at` (called on stop/shutdown).
    pub fn flush(&mut self, at: DateTime<Utc>) -> Option<CompletedSpan> {
        self.open.take().map(|o| CompletedSpan {
            app_name: o.app_name,
            title_hint: o.title_hint,
            start: o.start,
            end: at,
        })
    }
}

/// Map a snapshot to its `(app_name, redacted title_hint)`. `None` app means no
/// tracked foreground this tick.
fn snapshot_foreground(snap: &SignalSnapshot) -> (Option<String>, Option<String>) {
    let app = snap.app_name.clone();
    let hint = snap
        .window_title
        .as_deref()
        .and_then(activity_log::redact_title);
    (app, hint)
}

/// Foreground of a (possibly absent) snapshot. A missing snapshot is "no
/// foreground" — the recorder treats it the same as an excluded app.
fn foreground_of(next: Option<&SignalSnapshot>) -> (Option<String>, Option<String>) {
    match next {
        Some(snap) => snapshot_foreground(snap),
        None => (None, None),
    }
}

struct Session {
    stop_tx: Option<oneshot::Sender<()>>,
    task: Option<JoinHandle<()>>,
}

/// In-memory handle to the running recorder. Starting/stopping is driven by the
/// activity-log settings toggle; unlike the toggle, this handle is recreated
/// fresh each launch.
#[derive(Default, Clone)]
pub struct ActivityRecorder {
    inner: Arc<Mutex<Option<Session>>>,
}

impl ActivityRecorder {
    pub fn new() -> Self {
        Self::default()
    }

    pub async fn is_active(&self) -> bool {
        self.inner.lock().await.is_some()
    }

    /// Start recording spans from `snapshot_rx` into `activity_log`. No-op
    /// error if already running.
    pub async fn start_with_receiver(
        &self,
        pool: SqlitePool,
        snapshot_rx: watch::Receiver<Option<SignalSnapshot>>,
    ) -> Result<(), String> {
        let mut guard = self.inner.lock().await;
        if guard.is_some() {
            return Err("activity recorder already running".into());
        }
        let (stop_tx, stop_rx) = oneshot::channel();
        let task = tokio::spawn(recorder_loop(pool, snapshot_rx, stop_rx));
        *guard = Some(Session {
            stop_tx: Some(stop_tx),
            task: Some(task),
        });
        Ok(())
    }

    /// Stop recording. The writer flushes its open span before exiting.
    pub async fn stop(&self) {
        let session = self.inner.lock().await.take();
        let Some(mut session) = session else {
            return;
        };
        if let Some(tx) = session.stop_tx.take() {
            let _ = tx.send(());
        }
        if let Some(task) = session.task.take() {
            let _ = task.await;
        }
    }
}

async fn recorder_loop(
    pool: SqlitePool,
    mut snapshot_rx: watch::Receiver<Option<SignalSnapshot>>,
    mut stop_rx: oneshot::Receiver<()>,
) {
    let mut builder = SpanBuilder::default();

    // Seed from the current value so a foreground present at start opens a
    // span. A fresh builder has nothing open, so this only ever opens — it
    // never completes a span — hence the return value is intentionally unused.
    let initial = snapshot_rx.borrow().clone();
    if let Some(snap) = initial {
        let (app, hint) = snapshot_foreground(&snap);
        builder.observe(app, hint, Utc::now());
    }

    loop {
        tokio::select! {
            biased;
            _ = &mut stop_rx => break,
            changed = snapshot_rx.changed() => {
                if changed.is_err() {
                    break; // stream gone
                }
                let next = snapshot_rx.borrow().clone();
                let (app, hint) = foreground_of(next.as_ref());
                if let Some(span) = builder.observe(app, hint, Utc::now()) {
                    persist(&pool, &span).await;
                }
            }
        }
    }
    if let Some(span) = builder.flush(Utc::now()) {
        persist(&pool, &span).await;
    }
}

async fn persist(pool: &SqlitePool, span: &CompletedSpan) {
    if let Err(e) = activity_log::insert(
        pool,
        &span.start.to_rfc3339(),
        &span.end.to_rfc3339(),
        &span.app_name,
        span.title_hint.as_deref(),
        "window",
        Utc::now(),
    )
    .await
    {
        log::warn!("activity_log: span insert failed: {e}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::test_db;
    use chrono::Duration;

    fn t(min: i64) -> DateTime<Utc> {
        DateTime::from_timestamp(min * 60, 0).expect("valid timestamp")
    }

    #[test]
    fn open_then_switch_completes_the_first_span() {
        let mut b = SpanBuilder::default();
        assert_eq!(b.observe(Some("Zoom".into()), None, t(0)), None);
        let span = b
            .observe(Some("Code".into()), Some("main.rs".into()), t(5))
            .expect("switching apps completes the Zoom span");
        assert_eq!(span.app_name, "Zoom");
        assert_eq!(span.start, t(0));
        assert_eq!(span.end, t(5));
    }

    #[test]
    fn same_app_extends_without_completing() {
        let mut b = SpanBuilder::default();
        b.observe(Some("Code".into()), Some("a.rs".into()), t(0));
        // A later observation of the same app (even a new title) doesn't close.
        assert_eq!(
            b.observe(Some("Code".into()), Some("b.rs".into()), t(3)),
            None
        );
        let span = b.flush(t(10)).expect("flush closes the open span");
        assert_eq!(span.app_name, "Code");
        assert_eq!(span.title_hint.as_deref(), Some("a.rs")); // first hint wins
        assert_eq!(span.end, t(10));
    }

    #[test]
    fn none_foreground_closes_the_open_span_and_opens_nothing() {
        let mut b = SpanBuilder::default();
        b.observe(Some("Safari".into()), None, t(0));
        let span = b
            .observe(None, None, t(2))
            .expect("going idle closes the span");
        assert_eq!(span.app_name, "Safari");
        // Nothing open now: a flush yields nothing.
        assert_eq!(b.flush(t(9)), None);
    }

    #[test]
    fn flush_with_nothing_open_is_none() {
        let mut b = SpanBuilder::default();
        assert_eq!(b.flush(t(1)), None);
    }

    #[test]
    fn snapshot_foreground_redacts_the_title() {
        let snap = SignalSnapshot {
            ide_folder: None,
            git_branch: None,
            window_title: Some("main.rs — cairn".into()),
            app_name: Some("Code".into()),
            browser_domain: None,
            calendar: vec![],
        };
        let (app, hint) = snapshot_foreground(&snap);
        assert_eq!(app.as_deref(), Some("Code"));
        assert_eq!(hint.as_deref(), Some("main.rs"));
    }

    #[tokio::test]
    async fn records_a_span_to_the_db_when_the_foreground_changes() {
        let (_dir, db) = test_db().await;
        let snap = |app: &str| {
            Some(SignalSnapshot {
                ide_folder: None,
                git_branch: None,
                window_title: None,
                app_name: Some(app.into()),
                browser_domain: None,
                calendar: vec![],
            })
        };
        let (tx, rx) = watch::channel(snap("Zoom"));
        let rec = ActivityRecorder::new();
        rec.start_with_receiver(db.pool.clone(), rx).await.unwrap();
        assert!(rec.is_active().await);

        // Switch apps → the Zoom span completes and is written.
        tx.send(snap("Code")).unwrap();
        for _ in 0..200 {
            if activity_log::count(&db.pool).await.unwrap() >= 1 {
                break;
            }
            tokio::time::sleep(Duration::milliseconds(5).to_std().unwrap()).await;
        }
        rec.stop().await; // flushes the open Code span
        assert!(!rec.is_active().await);
        assert!(activity_log::count(&db.pool).await.unwrap() >= 1);
    }

    fn fg(app: Option<&str>) -> Option<SignalSnapshot> {
        Some(SignalSnapshot {
            ide_folder: None,
            git_branch: None,
            window_title: None,
            app_name: app.map(str::to_string),
            browser_domain: None,
            calendar: vec![],
        })
    }

    #[test]
    fn foreground_of_maps_absent_and_present_snapshots() {
        // A missing snapshot is "no foreground" (same as an excluded app).
        assert_eq!(foreground_of(None), (None, None));
        let snap = SignalSnapshot {
            ide_folder: None,
            git_branch: None,
            window_title: Some("notes.md — Obsidian".into()),
            app_name: Some("Obsidian".into()),
            browser_domain: None,
            calendar: vec![],
        };
        let (app, hint) = foreground_of(Some(&snap));
        assert_eq!(app.as_deref(), Some("Obsidian"));
        assert_eq!(hint.as_deref(), Some("notes.md"));
    }

    #[tokio::test]
    async fn recorder_exits_when_the_stream_sender_drops() {
        let (_dir, db) = test_db().await;
        let (tx, rx) = watch::channel(fg(Some("Zoom")));
        let rec = ActivityRecorder::new();
        rec.start_with_receiver(db.pool.clone(), rx).await.unwrap();
        drop(tx); // stream gone → the loop's `changed.is_err()` break
        rec.stop().await; // joins the already-exited task without hanging
        assert!(!rec.is_active().await);
    }

    #[tokio::test]
    async fn persist_swallows_and_logs_an_insert_error() {
        let (_dir, db) = test_db().await;
        sqlx::query("DROP TABLE activity_log")
            .execute(&db.pool)
            .await
            .unwrap();
        // Table gone → the insert errors; persist must log and not panic.
        persist(
            &db.pool,
            &CompletedSpan {
                app_name: "X".into(),
                title_hint: None,
                start: t(0),
                end: t(1),
            },
        )
        .await;
    }

    #[tokio::test]
    async fn double_start_is_rejected() {
        let (_dir, db) = test_db().await;
        let (_tx, rx) = watch::channel::<Option<SignalSnapshot>>(None);
        let rec = ActivityRecorder::new();
        rec.start_with_receiver(db.pool.clone(), rx.clone())
            .await
            .unwrap();
        let err = rec
            .start_with_receiver(db.pool.clone(), rx)
            .await
            .unwrap_err();
        assert!(err.contains("already running"));
        rec.stop().await;
    }

    #[tokio::test]
    async fn stop_without_start_is_a_noop() {
        let rec = ActivityRecorder::new();
        rec.stop().await; // must not panic
        assert!(!rec.is_active().await);
    }
}
