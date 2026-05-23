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
