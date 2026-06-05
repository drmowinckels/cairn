//! Persistence for per-plugin enabled state (`plugin_state` table).
//!
//! Kept out of the host (`plugins::mod`) so the host stays DB-free and
//! unit-testable in isolation — the host is handed the loaded flags and
//! reports back what changed; this module is the only thing that touches
//! SQLite. Same split as the rules engine vs. its store.

use std::collections::HashMap;

use sqlx::{Row, SqlitePool};

/// Load every persisted plugin enabled flag, keyed by plugin id. A
/// plugin with no row is intentionally absent from the map — callers
/// treat "absent" as enabled (a plugin that predates its row, e.g.
/// calendar, must stay on). A query failure logs and returns an empty
/// map, so a transient DB error defaults every plugin to enabled rather
/// than silently disabling them.
pub async fn load_enabled(pool: &SqlitePool) -> HashMap<String, bool> {
    match sqlx::query("SELECT id, enabled FROM plugin_state")
        .fetch_all(pool)
        .await
    {
        Ok(rows) => rows
            .into_iter()
            .map(|r| (r.get::<String, _>("id"), r.get::<i64, _>("enabled") != 0))
            .collect(),
        Err(e) => {
            log::warn!("plugin_state load failed: {e}; defaulting all plugins enabled");
            HashMap::new()
        }
    }
}

/// Upsert a plugin's enabled flag.
pub async fn set_enabled(pool: &SqlitePool, id: &str, enabled: bool) -> Result<(), String> {
    sqlx::query(
        "INSERT INTO plugin_state (id, enabled) VALUES (?1, ?2) \
         ON CONFLICT(id) DO UPDATE SET enabled = ?2",
    )
    .bind(id)
    .bind(enabled as i64)
    .execute(pool)
    .await
    .map_err(|e| format!("could not persist plugin state for '{id}': {e}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::test_db;

    #[tokio::test]
    async fn unset_plugin_is_absent_so_callers_default_enabled() {
        let (_dir, db) = test_db().await;
        let flags = load_enabled(&db.pool).await;
        assert!(
            !flags.contains_key("calendar"),
            "a plugin with no row is absent (callers treat absent as enabled)"
        );
    }

    #[tokio::test]
    async fn load_enabled_defaults_empty_on_query_error() {
        // A query failure (here: a closed pool) must not propagate — it
        // returns an empty map so callers default every plugin to
        // enabled rather than silently disabling them.
        let (_dir, db) = test_db().await;
        db.pool.close().await;
        let flags = load_enabled(&db.pool).await;
        assert!(flags.is_empty());
    }

    #[tokio::test]
    async fn set_enabled_round_trips_and_upserts() {
        let (_dir, db) = test_db().await;
        set_enabled(&db.pool, "calendar", false).await.unwrap();
        let flags = load_enabled(&db.pool).await;
        assert_eq!(flags.get("calendar"), Some(&false));

        // Upsert flips the same row rather than erroring on the PK.
        set_enabled(&db.pool, "calendar", true).await.unwrap();
        let flags = load_enabled(&db.pool).await;
        assert_eq!(flags.get("calendar"), Some(&true));
    }
}
