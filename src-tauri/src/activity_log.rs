//! Opt-in activity-log store (#190): a compact, redacted record of which app
//! was foreground and for how long, for the "review your day" flow. Pure
//! storage + retention + redaction + the on/off + retention settings; the
//! collector that writes rows and the IPC that toggles it land in a follow-up.
//!
//! This is deliberately separate from the debug `capture_raw_signals` NDJSON
//! dump: it is user-facing, privacy-controlled, and retention-bounded. The
//! exclusion list runs upstream at the collector, so an excluded app never
//! reaches `insert`; `title_hint` is always run through [`redact_title`].

use std::path::Path;

use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};
use sqlx::{Row, SqlitePool};
use tokio::io::AsyncWriteExt;

use crate::backup::csv_escape;

/// One stored activity span, surfaced to the "review your day" UI (#190).
/// `serde(camelCase)` so it crosses IPC unchanged.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ActivityRow {
    pub id: i64,
    pub started_at: String,
    pub ended_at: String,
    pub app_name: String,
    pub title_hint: Option<String>,
    pub source: String,
    /// True when an `entries` row already links back to this span
    /// (`entries.activity_row_id`) — the "Add" in the review UI already ran
    /// for it. Computed, not stored.
    pub has_entry: bool,
}

/// User-controlled activity-log settings, stored on the singleton app_state
/// row so the collector can read them without the webview open.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ActivityLogSettings {
    pub enabled: bool,
    /// Days to keep rows; `0` means keep until the user deletes.
    pub retention_days: u32,
}

impl Default for ActivityLogSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            retention_days: 7,
        }
    }
}

/// Dash separators apps use between the document and the app/project in a
/// window title: em-dash (macOS / Zed), en-dash (JetBrains), and hyphen
/// (VS Code / Chrome / most Windows + Linux apps) — mirroring the set
/// `signals::ide` parses.
const TITLE_SEPARATORS: [&str; 3] = [" — ", " – ", " - "];

/// The window-title segment kept in the log: the text before the EARLIEST dash
/// separator, trimmed. `None` when that segment is empty. Everything from the
/// separator onward is dropped, so the full multi-part title is never stored —
/// the privacy contract for this log (see `docs/PRIVACY.md`).
pub fn redact_title(title: &str) -> Option<String> {
    let cut = TITLE_SEPARATORS
        .iter()
        .filter_map(|sep| title.find(sep))
        .min();
    let head = match cut {
        Some(i) => &title[..i],
        None => title,
    }
    .trim();
    if head.is_empty() {
        None
    } else {
        Some(head.to_string())
    }
}

/// Append one activity span. `title_hint` must already be redacted (callers
/// pass the result of [`redact_title`]).
pub async fn insert(
    pool: &SqlitePool,
    started_at: &str,
    ended_at: &str,
    app_name: &str,
    title_hint: Option<&str>,
    source: &str,
    now: DateTime<Utc>,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "INSERT INTO activity_log \
            (started_at, ended_at, app_name, title_hint, source, created_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
    )
    .bind(started_at)
    .bind(ended_at)
    .bind(app_name)
    .bind(title_hint)
    .bind(source)
    .bind(now.to_rfc3339())
    .execute(pool)
    .await?;
    Ok(())
}

/// Total rows currently stored. Used by tests today; the review UI (the
/// "Time by app" stats) will read it.
#[allow(dead_code)]
pub async fn count(pool: &SqlitePool) -> Result<i64, sqlx::Error> {
    let row = sqlx::query("SELECT COUNT(*) AS n FROM activity_log")
        .fetch_one(pool)
        .await?;
    Ok(row.get::<i64, _>("n"))
}

/// Spans whose start falls in `[start, end)` (RFC3339 UTC bounds), oldest
/// first — the day's activity for the review surface (#190). Mirrors the
/// `started_at`-window semantics `list_day` uses for entries.
pub async fn list_in_range(
    pool: &SqlitePool,
    start: &str,
    end: &str,
) -> Result<Vec<ActivityRow>, sqlx::Error> {
    let rows = sqlx::query(
        "SELECT a.id, a.started_at, a.ended_at, a.app_name, a.title_hint, a.source, \
                EXISTS(SELECT 1 FROM entries e WHERE e.activity_row_id = a.id) AS has_entry \
           FROM activity_log a \
          WHERE a.started_at >= ?1 AND a.started_at < ?2 \
          ORDER BY a.started_at ASC",
    )
    .bind(start)
    .bind(end)
    .fetch_all(pool)
    .await?;
    Ok(rows
        .into_iter()
        .map(|r| ActivityRow {
            id: r.get("id"),
            started_at: r.get("started_at"),
            ended_at: r.get("ended_at"),
            app_name: r.get("app_name"),
            title_hint: r.get("title_hint"),
            source: r.get("source"),
            has_entry: r.get::<i64, _>("has_entry") != 0,
        })
        .collect())
}

/// Count of spans in `[start, end)` with no linked `entries` row yet — the
/// cheap check the "Workday in Review" banner trigger polls, so it doesn't
/// need to pull every row just to know whether anything's left to review.
pub async fn count_uncategorized_in_range(
    pool: &SqlitePool,
    start: &str,
    end: &str,
) -> Result<i64, sqlx::Error> {
    let row = sqlx::query(
        "SELECT COUNT(*) AS n FROM activity_log a \
          WHERE a.started_at >= ?1 AND a.started_at < ?2 \
            AND NOT EXISTS (SELECT 1 FROM entries e WHERE e.activity_row_id = a.id)",
    )
    .bind(start)
    .bind(end)
    .fetch_one(pool)
    .await?;
    Ok(row.get::<i64, _>("n"))
}

/// Hard-delete every row (the "Delete activity log now" action). Returns the
/// number removed.
pub async fn delete_all(pool: &SqlitePool) -> Result<u64, sqlx::Error> {
    let r = sqlx::query("DELETE FROM activity_log")
        .execute(pool)
        .await?;
    Ok(r.rows_affected())
}

/// Drop rows older than the retention window. `retention_days == 0` keeps
/// everything (the "until I delete" option). Returns the number removed.
pub async fn purge_older_than(
    pool: &SqlitePool,
    retention_days: u32,
    now: DateTime<Utc>,
) -> Result<u64, sqlx::Error> {
    if retention_days == 0 {
        return Ok(0);
    }
    let cutoff = (now - Duration::days(i64::from(retention_days))).to_rfc3339();
    let r = sqlx::query("DELETE FROM activity_log WHERE started_at < ?1")
        .bind(cutoff)
        .execute(pool)
        .await?;
    Ok(r.rows_affected())
}

/// Load the on/off + retention settings; defaults on any read error.
pub async fn load_settings(pool: &SqlitePool) -> ActivityLogSettings {
    let row = sqlx::query(
        "SELECT activity_log_enabled, activity_log_retention_days \
           FROM app_state WHERE singleton = 1",
    )
    .fetch_optional(pool)
    .await
    .ok()
    .flatten();
    match row {
        None => ActivityLogSettings::default(),
        Some(r) => ActivityLogSettings {
            enabled: r.get::<i64, _>("activity_log_enabled") != 0,
            retention_days: r
                .get::<i64, _>("activity_log_retention_days")
                .clamp(0, i64::from(u32::MAX)) as u32,
        },
    }
}

/// Persist the on/off + retention settings on the singleton row.
pub async fn save_settings(
    pool: &SqlitePool,
    settings: ActivityLogSettings,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "UPDATE app_state \
            SET activity_log_enabled = ?1, activity_log_retention_days = ?2 \
          WHERE singleton = 1",
    )
    .bind(i64::from(settings.enabled))
    .bind(i64::from(settings.retention_days))
    .execute(pool)
    .await?;
    Ok(())
}

/// Header for the activity-log CSV export (#190). Deliberately distinct from
/// the entries export (`backup::CSV_HEADER`): this is the redacted foreground
/// record, not time entries, and the two must never be conflated.
pub const CSV_HEADER: &str =
    "activity_id,started_at,ended_at,duration_minutes,app_name,title_hint,source";

/// Whole-minute span duration for the export's `duration_minutes` column.
/// Activity rows always carry both bounds; an unparseable bound degrades to an
/// empty cell (defensive — stored values are RFC3339).
fn csv_duration_minutes(started: &str, ended: &str) -> String {
    let (Ok(start), Ok(end)) = (
        DateTime::parse_from_rfc3339(started),
        DateTime::parse_from_rfc3339(ended),
    ) else {
        return String::new();
    };
    ((end - start).num_seconds() / 60).to_string()
}

/// Write every activity-log row to `dest` as CSV, oldest first — the separate
/// "Export activity log" action (#190). Distinct from the entries export, which
/// never reads this table. `dest` comes from the system save dialog, so its
/// parent directory already exists (unlike `backup::export_csv_to`'s
/// programmatic targets, we don't create it).
pub async fn export_csv_to(pool: &SqlitePool, dest: &Path) -> Result<(), String> {
    let rows = sqlx::query(
        "SELECT id, started_at, ended_at, app_name, title_hint, source \
           FROM activity_log ORDER BY started_at ASC",
    )
    .fetch_all(pool)
    .await
    .map_err(err)?;

    let mut file = tokio::fs::File::create(dest).await.map_err(err)?;
    file.write_all(format!("{CSV_HEADER}\n").as_bytes())
        .await
        .map_err(err)?;
    for row in rows {
        let id: i64 = row.get("id");
        let started: String = row.get("started_at");
        let ended: String = row.get("ended_at");
        let app_name: String = row.get("app_name");
        let title_hint: Option<String> = row.get("title_hint");
        let source: String = row.get("source");
        let line = format!(
            "{},{},{},{},{},{},{}\n",
            id,
            csv_escape(&started),
            csv_escape(&ended),
            csv_duration_minutes(&started, &ended),
            csv_escape(&app_name),
            csv_escape(title_hint.as_deref().unwrap_or("")),
            csv_escape(&source),
        );
        file.write_all(line.as_bytes()).await.map_err(err)?;
    }
    file.flush().await.map_err(err)?;
    Ok(())
}

fn err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::test_db;

    #[test]
    fn redact_title_keeps_only_the_segment_before_the_earliest_separator() {
        // em-dash (macOS / Zed)
        assert_eq!(redact_title("file.tsx — cairn"), Some("file.tsx".into()));
        assert_eq!(redact_title("Inbox — Gmail — Chrome"), Some("Inbox".into()));
        // hyphen (VS Code / Chrome / most Windows + Linux) — the bug fix: the
        // full multi-part title must NOT be stored.
        assert_eq!(
            redact_title("report.xlsx - hr - Visual Studio Code"),
            Some("report.xlsx".into()),
        );
        assert_eq!(
            redact_title("Re: draft - Gmail - Google Chrome"),
            Some("Re: draft".into()),
        );
        // en-dash (JetBrains)
        assert_eq!(redact_title("main.rs – cairn"), Some("main.rs".into()));
        // Mixed separators → the earliest one wins.
        assert_eq!(redact_title("a - b — c"), Some("a".into()));
        // No separator → the whole (trimmed) title is the leading segment.
        assert_eq!(redact_title("Zoom Meeting"), Some("Zoom Meeting".into()));
        assert_eq!(redact_title("   "), None);
        assert_eq!(redact_title(" — trailing"), None);
    }

    #[tokio::test]
    async fn insert_and_count_round_trip() {
        let (_dir, db) = test_db().await;
        assert_eq!(count(&db.pool).await.unwrap(), 0);
        insert(
            &db.pool,
            "2026-06-16T09:00:00+00:00",
            "2026-06-16T09:05:00+00:00",
            "zoom.us",
            Some("Standup"),
            "window",
            Utc::now(),
        )
        .await
        .unwrap();
        assert_eq!(count(&db.pool).await.unwrap(), 1);
    }

    #[tokio::test]
    async fn list_in_range_returns_only_in_window_rows_oldest_first() {
        let (_dir, db) = test_db().await;
        // Two in-window (09:00, 11:00) + one before the window (yesterday).
        for (start, app) in [
            ("2026-06-16T11:00:00+00:00", "Code"),
            ("2026-06-16T09:00:00+00:00", "Zoom"),
            ("2026-06-15T23:00:00+00:00", "Old"),
        ] {
            insert(&db.pool, start, start, app, None, "window", Utc::now())
                .await
                .unwrap();
        }
        let rows = list_in_range(
            &db.pool,
            "2026-06-16T00:00:00+00:00",
            "2026-06-17T00:00:00+00:00",
        )
        .await
        .unwrap();
        assert_eq!(
            rows.iter().map(|r| r.app_name.as_str()).collect::<Vec<_>>(),
            ["Zoom", "Code"], // oldest first; the previous day is excluded
        );
    }

    /// Links `entry_id`'s `activity_row_id` to `row_id` via a minimal raw
    /// `entries` insert — mirrors the `createEntry` call the "Add" button
    /// makes, without pulling in the whole `ipc` module.
    async fn link_entry(pool: &SqlitePool, entry_id: &str, row_id: i64) {
        sqlx::query(
            "INSERT INTO entries \
                (id, project_id, task_id, description, started_at, ended_at, source, activity_row_id, created_at, updated_at) \
             VALUES (?1, NULL, NULL, '', '2026-06-16T09:00:00+00:00', '2026-06-16T09:05:00+00:00', 'activity_log', ?2, '2026-06-16T09:05:00+00:00', '2026-06-16T09:05:00+00:00')",
        )
        .bind(entry_id)
        .bind(row_id)
        .execute(pool)
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn list_in_range_marks_has_entry_only_for_linked_spans() {
        let (_dir, db) = test_db().await;
        insert(
            &db.pool,
            "2026-06-16T09:00:00+00:00",
            "2026-06-16T09:05:00+00:00",
            "Code",
            None,
            "window",
            Utc::now(),
        )
        .await
        .unwrap();
        insert(
            &db.pool,
            "2026-06-16T10:00:00+00:00",
            "2026-06-16T10:05:00+00:00",
            "Zoom",
            None,
            "window",
            Utc::now(),
        )
        .await
        .unwrap();
        link_entry(&db.pool, "e-linked", 1).await;

        let rows = list_in_range(
            &db.pool,
            "2026-06-16T00:00:00+00:00",
            "2026-06-17T00:00:00+00:00",
        )
        .await
        .unwrap();
        assert!(rows.iter().find(|r| r.id == 1).unwrap().has_entry);
        assert!(!rows.iter().find(|r| r.id == 2).unwrap().has_entry);
    }

    #[tokio::test]
    async fn count_uncategorized_in_range_excludes_linked_spans_and_out_of_window_ones() {
        let (_dir, db) = test_db().await;
        for start in [
            "2026-06-16T09:00:00+00:00",
            "2026-06-16T10:00:00+00:00",
            "2026-06-15T23:00:00+00:00", // previous day, out of window
        ] {
            insert(&db.pool, start, start, "Code", None, "window", Utc::now())
                .await
                .unwrap();
        }
        link_entry(&db.pool, "e-linked", 1).await;

        let n = count_uncategorized_in_range(
            &db.pool,
            "2026-06-16T00:00:00+00:00",
            "2026-06-17T00:00:00+00:00",
        )
        .await
        .unwrap();
        // Row 1 is linked, row 3 is outside the window — only row 2 counts.
        assert_eq!(n, 1);
    }

    #[tokio::test]
    async fn delete_all_clears_every_row() {
        let (_dir, db) = test_db().await;
        for _ in 0..3 {
            insert(
                &db.pool,
                "2026-06-16T09:00:00+00:00",
                "2026-06-16T09:05:00+00:00",
                "Code",
                None,
                "window",
                Utc::now(),
            )
            .await
            .unwrap();
        }
        assert_eq!(delete_all(&db.pool).await.unwrap(), 3);
        assert_eq!(count(&db.pool).await.unwrap(), 0);
    }

    #[tokio::test]
    async fn purge_drops_rows_past_retention_and_keeps_recent_ones() {
        let (_dir, db) = test_db().await;
        let now = Utc::now();
        let old = (now - Duration::days(10)).to_rfc3339();
        let fresh = (now - Duration::hours(1)).to_rfc3339();
        insert(&db.pool, &old, &old, "Old", None, "window", now)
            .await
            .unwrap();
        insert(&db.pool, &fresh, &fresh, "Fresh", None, "window", now)
            .await
            .unwrap();
        let removed = purge_older_than(&db.pool, 7, now).await.unwrap();
        assert_eq!(removed, 1);
        assert_eq!(count(&db.pool).await.unwrap(), 1);
    }

    #[tokio::test]
    async fn purge_with_zero_retention_keeps_everything() {
        let (_dir, db) = test_db().await;
        let now = Utc::now();
        let old = (now - Duration::days(365)).to_rfc3339();
        insert(&db.pool, &old, &old, "Ancient", None, "window", now)
            .await
            .unwrap();
        assert_eq!(purge_older_than(&db.pool, 0, now).await.unwrap(), 0);
        assert_eq!(count(&db.pool).await.unwrap(), 1);
    }

    #[tokio::test]
    async fn settings_default_off_with_seven_day_retention() {
        let (_dir, db) = test_db().await;
        let s = load_settings(&db.pool).await;
        assert_eq!(s, ActivityLogSettings::default());
        assert!(!s.enabled);
        assert_eq!(s.retention_days, 7);
    }

    #[tokio::test]
    async fn settings_default_when_app_state_row_missing() {
        // The singleton is always seeded in practice; cover the defensive
        // "no row" arm by removing it.
        let (_dir, db) = test_db().await;
        sqlx::query("DELETE FROM app_state")
            .execute(&db.pool)
            .await
            .unwrap();
        assert_eq!(
            load_settings(&db.pool).await,
            ActivityLogSettings::default(),
        );
    }

    #[test]
    fn csv_duration_minutes_floors_to_whole_minutes_and_degrades() {
        assert_eq!(
            csv_duration_minutes("2026-06-16T09:00:00+00:00", "2026-06-16T09:02:25+00:00",),
            "2", // 145s → 2m
        );
        assert_eq!(
            csv_duration_minutes("nope", "2026-06-16T09:00:00+00:00"),
            ""
        );
        assert_eq!(csv_duration_minutes("2026-06-16T09:00:00+00:00", "bad"), "");
    }

    #[tokio::test]
    async fn export_csv_writes_header_only_when_empty() {
        let (dir, db) = test_db().await;
        let dest = dir.path().join("activity.csv");
        export_csv_to(&db.pool, &dest).await.unwrap();
        let body = tokio::fs::read_to_string(&dest).await.unwrap();
        assert_eq!(body, format!("{CSV_HEADER}\n"));
    }

    #[tokio::test]
    async fn export_csv_surfaces_a_query_error() {
        // Closing the pool makes the SELECT fail, exercising the error path
        // (`map_err(err)`) the success cases never reach.
        let (dir, db) = test_db().await;
        db.pool.close().await;
        let dest = dir.path().join("activity.csv");
        assert!(export_csv_to(&db.pool, &dest).await.is_err());
    }

    #[tokio::test]
    async fn export_csv_writes_rows_oldest_first_with_duration_and_escaping() {
        let (dir, db) = test_db().await;
        // Out-of-order inserts; a title with a comma must be quoted.
        insert(
            &db.pool,
            "2026-06-16T11:00:00+00:00",
            "2026-06-16T11:30:00+00:00",
            "Code",
            Some("a, b"),
            "window",
            Utc::now(),
        )
        .await
        .unwrap();
        insert(
            &db.pool,
            "2026-06-16T09:00:00+00:00",
            "2026-06-16T09:05:00+00:00",
            "Zoom",
            None,
            "window",
            Utc::now(),
        )
        .await
        .unwrap();

        let dest = dir.path().join("activity.csv");
        export_csv_to(&db.pool, &dest).await.unwrap();
        let lines: Vec<String> = tokio::fs::read_to_string(&dest)
            .await
            .unwrap()
            .lines()
            .map(str::to_string)
            .collect();
        assert_eq!(lines[0], CSV_HEADER);
        // Oldest first; empty title_hint → empty cell; 5-minute span → "5".
        assert_eq!(
            lines[1],
            "2,2026-06-16T09:00:00+00:00,2026-06-16T09:05:00+00:00,5,Zoom,,window",
        );
        // 30-minute span; the comma in the hint forces quoting.
        assert_eq!(
            lines[2],
            "1,2026-06-16T11:00:00+00:00,2026-06-16T11:30:00+00:00,30,Code,\"a, b\",window",
        );
    }

    #[tokio::test]
    async fn settings_round_trip() {
        let (_dir, db) = test_db().await;
        save_settings(
            &db.pool,
            ActivityLogSettings {
                enabled: true,
                retention_days: 30,
            },
        )
        .await
        .unwrap();
        let s = load_settings(&db.pool).await;
        assert!(s.enabled);
        assert_eq!(s.retention_days, 30);
    }
}
