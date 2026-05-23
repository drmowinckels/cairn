//! SQLite persistence for calendar sources.
//!
//! Holds **non-secret** metadata only. The URL token / file path that
//! could read calendar data lives in the OS keychain for `url` kind; the
//! file path *is* visible here because it's just a path on the user's
//! disk — same trust as any other settings field.

use anyhow::Result;
use chrono::Utc;
use sqlx::{Row, SqlitePool};

use super::registry::{CalendarKind, CalendarSource};

pub async fn list(pool: &SqlitePool) -> Result<Vec<CalendarSource>> {
    let rows = sqlx::query(
        r#"
        SELECT id, kind, label, location, poll_seconds, enabled,
               last_synced_at, last_etag, last_modified, last_error
          FROM calendar_sources
         ORDER BY label ASC
        "#,
    )
    .fetch_all(pool)
    .await?;

    Ok(rows.into_iter().map(row_to_source).collect())
}

pub async fn get(pool: &SqlitePool, id: &str) -> Result<Option<CalendarSource>> {
    let row = sqlx::query(
        r#"
        SELECT id, kind, label, location, poll_seconds, enabled,
               last_synced_at, last_etag, last_modified, last_error
          FROM calendar_sources WHERE id = ?1
        "#,
    )
    .bind(id)
    .fetch_optional(pool)
    .await?;
    Ok(row.map(row_to_source))
}

pub async fn insert(pool: &SqlitePool, src: &CalendarSource) -> Result<()> {
    let now = Utc::now().to_rfc3339();
    sqlx::query(
        r#"
        INSERT INTO calendar_sources
            (id, kind, label, location, poll_seconds, enabled,
             last_synced_at, last_etag, last_modified, last_error,
             created_at, updated_at)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL, NULL, NULL, NULL, ?7, ?7)
        "#,
    )
    .bind(&src.id)
    .bind(kind_str(src.kind))
    .bind(&src.label)
    .bind(&src.location)
    .bind(src.poll_seconds)
    .bind(src.enabled as i64)
    .bind(&now)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn update_meta(pool: &SqlitePool, src: &CalendarSource) -> Result<()> {
    let now = Utc::now().to_rfc3339();
    sqlx::query(
        r#"
        UPDATE calendar_sources
           SET label = ?2,
               poll_seconds = ?3,
               enabled = ?4,
               updated_at = ?5
         WHERE id = ?1
        "#,
    )
    .bind(&src.id)
    .bind(&src.label)
    .bind(src.poll_seconds)
    .bind(src.enabled as i64)
    .bind(&now)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn record_sync_ok(
    pool: &SqlitePool,
    id: &str,
    etag: Option<&str>,
    last_modified: Option<&str>,
) -> Result<()> {
    let now = Utc::now().to_rfc3339();
    sqlx::query(
        r#"
        UPDATE calendar_sources
           SET last_synced_at = ?2,
               last_etag = ?3,
               last_modified = ?4,
               last_error = NULL,
               updated_at = ?2
         WHERE id = ?1
        "#,
    )
    .bind(id)
    .bind(&now)
    .bind(etag)
    .bind(last_modified)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn record_sync_err(pool: &SqlitePool, id: &str, err: &str) -> Result<()> {
    let now = Utc::now().to_rfc3339();
    sqlx::query(
        r#"
        UPDATE calendar_sources
           SET last_error = ?2,
               updated_at = ?3
         WHERE id = ?1
        "#,
    )
    .bind(id)
    .bind(err)
    .bind(&now)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn delete(pool: &SqlitePool, id: &str) -> Result<()> {
    sqlx::query("DELETE FROM calendar_sources WHERE id = ?1")
        .bind(id)
        .execute(pool)
        .await?;
    Ok(())
}

fn row_to_source(row: sqlx::sqlite::SqliteRow) -> CalendarSource {
    let kind: String = row.get("kind");
    CalendarSource {
        id: row.get("id"),
        kind: parse_kind(&kind),
        label: row.get("label"),
        location: row.get("location"),
        poll_seconds: row.get::<i64, _>("poll_seconds"),
        enabled: row.get::<i64, _>("enabled") != 0,
        last_synced_at: row.get::<Option<String>, _>("last_synced_at"),
        last_etag: row.get::<Option<String>, _>("last_etag"),
        last_modified: row.get::<Option<String>, _>("last_modified"),
        last_error: row.get::<Option<String>, _>("last_error"),
    }
}

fn kind_str(k: CalendarKind) -> &'static str {
    match k {
        CalendarKind::Url => "url",
        CalendarKind::File => "file",
    }
}

fn parse_kind(s: &str) -> CalendarKind {
    match s {
        "file" => CalendarKind::File,
        _ => CalendarKind::Url,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::test_db;

    fn sample(id: &str, kind: CalendarKind, label: &str) -> CalendarSource {
        CalendarSource {
            id: id.into(),
            kind,
            label: label.into(),
            location: match kind {
                CalendarKind::Url => "https://cal.example/…".into(),
                CalendarKind::File => "/tmp/cal.ics".into(),
            },
            poll_seconds: 900,
            enabled: true,
            last_synced_at: None,
            last_etag: None,
            last_modified: None,
            last_error: None,
        }
    }

    #[tokio::test]
    async fn list_is_empty_on_fresh_db() {
        let (_dir, db) = test_db().await;
        let out = list(&db.pool).await.unwrap();
        assert!(out.is_empty());
    }

    #[tokio::test]
    async fn insert_and_get_round_trip_a_url_source() {
        let (_dir, db) = test_db().await;
        let src = sample("src-url", CalendarKind::Url, "Work");
        insert(&db.pool, &src).await.unwrap();

        let fetched = get(&db.pool, "src-url").await.unwrap().unwrap();
        assert_eq!(fetched.id, src.id);
        assert!(matches!(fetched.kind, CalendarKind::Url));
        assert_eq!(fetched.label, "Work");
        assert_eq!(fetched.location, src.location);
        assert_eq!(fetched.poll_seconds, 900);
        assert!(fetched.enabled);
        assert!(fetched.last_synced_at.is_none());
        assert!(fetched.last_etag.is_none());
        assert!(fetched.last_modified.is_none());
        assert!(fetched.last_error.is_none());
    }

    #[tokio::test]
    async fn insert_round_trips_a_file_source() {
        let (_dir, db) = test_db().await;
        let mut src = sample("src-file", CalendarKind::File, "Local");
        src.poll_seconds = 60;
        src.enabled = false;
        insert(&db.pool, &src).await.unwrap();
        let fetched = get(&db.pool, "src-file").await.unwrap().unwrap();
        assert!(matches!(fetched.kind, CalendarKind::File));
        assert_eq!(fetched.poll_seconds, 60);
        assert!(!fetched.enabled);
    }

    #[tokio::test]
    async fn get_returns_none_for_missing_id() {
        let (_dir, db) = test_db().await;
        let out = get(&db.pool, "nope").await.unwrap();
        assert!(out.is_none());
    }

    #[tokio::test]
    async fn update_meta_changes_label_poll_enabled() {
        let (_dir, db) = test_db().await;
        let src = sample("src-1", CalendarKind::File, "Original");
        insert(&db.pool, &src).await.unwrap();

        let mut next = src.clone();
        next.label = "Renamed".into();
        next.poll_seconds = 120;
        next.enabled = false;
        update_meta(&db.pool, &next).await.unwrap();

        let fetched = get(&db.pool, "src-1").await.unwrap().unwrap();
        assert_eq!(fetched.label, "Renamed");
        assert_eq!(fetched.poll_seconds, 120);
        assert!(!fetched.enabled);
    }

    #[tokio::test]
    async fn record_sync_ok_sets_etag_last_modified_and_clears_error() {
        let (_dir, db) = test_db().await;
        let src = sample("src-1", CalendarKind::File, "Plan");
        insert(&db.pool, &src).await.unwrap();
        record_sync_err(&db.pool, "src-1", "network down")
            .await
            .unwrap();
        let with_err = get(&db.pool, "src-1").await.unwrap().unwrap();
        assert_eq!(with_err.last_error.as_deref(), Some("network down"));

        record_sync_ok(
            &db.pool,
            "src-1",
            Some("etag-abc"),
            Some("Mon, 01 Jan 2026 00:00:00 GMT"),
        )
        .await
        .unwrap();
        let after = get(&db.pool, "src-1").await.unwrap().unwrap();
        assert_eq!(after.last_etag.as_deref(), Some("etag-abc"));
        assert_eq!(
            after.last_modified.as_deref(),
            Some("Mon, 01 Jan 2026 00:00:00 GMT")
        );
        assert!(after.last_error.is_none(), "ok clears last_error");
        assert!(after.last_synced_at.is_some());
    }

    #[tokio::test]
    async fn record_sync_err_writes_last_error() {
        let (_dir, db) = test_db().await;
        let src = sample("src-1", CalendarKind::Url, "Work");
        insert(&db.pool, &src).await.unwrap();
        record_sync_err(&db.pool, "src-1", "timeout").await.unwrap();
        let after = get(&db.pool, "src-1").await.unwrap().unwrap();
        assert_eq!(after.last_error.as_deref(), Some("timeout"));
    }

    #[tokio::test]
    async fn delete_removes_the_row() {
        let (_dir, db) = test_db().await;
        let src = sample("src-1", CalendarKind::File, "Doomed");
        insert(&db.pool, &src).await.unwrap();
        delete(&db.pool, "src-1").await.unwrap();
        assert!(get(&db.pool, "src-1").await.unwrap().is_none());
    }

    #[tokio::test]
    async fn list_orders_sources_by_label() {
        let (_dir, db) = test_db().await;
        insert(&db.pool, &sample("a", CalendarKind::File, "Zeta"))
            .await
            .unwrap();
        insert(&db.pool, &sample("b", CalendarKind::File, "Alpha"))
            .await
            .unwrap();
        let out = list(&db.pool).await.unwrap();
        assert_eq!(out[0].label, "Alpha");
        assert_eq!(out[1].label, "Zeta");
    }

    #[test]
    fn parse_kind_recognises_known_values_and_defaults_to_url() {
        assert!(matches!(parse_kind("file"), CalendarKind::File));
        assert!(matches!(parse_kind("url"), CalendarKind::Url));
        assert!(
            matches!(parse_kind("???"), CalendarKind::Url),
            "unknown kind defaults to Url for forward-compat"
        );
    }

    #[test]
    fn kind_str_matches_db_check_constraint() {
        assert_eq!(kind_str(CalendarKind::Url), "url");
        assert_eq!(kind_str(CalendarKind::File), "file");
    }
}
