//! Opt-in activity-log store (#190): a compact, redacted record of which app
//! was foreground and for how long, for the "review your day" flow. Pure
//! storage + retention + redaction + the on/off + retention settings; the
//! collector that writes rows and the IPC that toggles it land in a follow-up.
//!
//! This is deliberately separate from the debug `capture_raw_signals` NDJSON
//! dump: it is user-facing, privacy-controlled, and retention-bounded. The
//! exclusion list runs upstream at the collector, so an excluded app never
//! reaches `insert`; `title_hint` is always run through [`redact_title`].
//!
//! `#![allow(dead_code)]` until the collector + IPC consume these (PR 2);
//! remove it the moment a non-test caller exists.
#![allow(dead_code)]

use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};
use sqlx::{Row, SqlitePool};

/// One stored activity span. `serde(camelCase)` so it crosses IPC unchanged.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ActivityRow {
    pub id: i64,
    pub started_at: String,
    pub ended_at: String,
    pub app_name: String,
    pub title_hint: Option<String>,
    pub source: String,
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

/// The window-title segment kept in the log: the text before the first " — "
/// separator, trimmed. `None` when that segment is empty. Everything after the
/// separator is dropped, so a full title is never stored — the privacy
/// contract for this log (see `docs/PRIVACY.md`).
pub fn redact_title(title: &str) -> Option<String> {
    let head = title.split(" — ").next().unwrap_or("").trim();
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

/// Total rows currently stored.
pub async fn count(pool: &SqlitePool) -> Result<i64, sqlx::Error> {
    let row = sqlx::query("SELECT COUNT(*) AS n FROM activity_log")
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::test_db;

    #[test]
    fn redact_title_keeps_only_the_segment_before_the_separator() {
        assert_eq!(redact_title("file.tsx — cairn"), Some("file.tsx".into()));
        assert_eq!(redact_title("Inbox — Gmail — Chrome"), Some("Inbox".into()),);
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
