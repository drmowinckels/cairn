//! Persistence for per-connector enabled state (`connector_state` table,
//! #110). Mirrors `plugins::store`: kept out of the host so the host stays
//! DB-free, and the only place that touches this table.

use std::collections::HashMap;

use sqlx::{Row, SqlitePool};

/// Load every persisted connector enabled flag, keyed by connector id. A
/// connector with no row is intentionally absent from the map — callers
/// treat "absent" as enabled, so a connector that predates its row stays on.
/// A query failure logs and returns an empty map, defaulting every connector
/// to enabled rather than silently disabling them.
pub async fn load_enabled(pool: &SqlitePool) -> HashMap<String, bool> {
    match sqlx::query("SELECT id, enabled FROM connector_state")
        .fetch_all(pool)
        .await
    {
        Ok(rows) => rows
            .into_iter()
            .map(|r| (r.get::<String, _>("id"), r.get::<i64, _>("enabled") != 0))
            .collect(),
        Err(e) => {
            log::warn!("connector_state load failed: {e}; defaulting all connectors enabled");
            HashMap::new()
        }
    }
}

/// Whether a connector is enabled, given the loaded flags. Absent = enabled.
pub fn is_enabled(flags: &HashMap<String, bool>, id: &str) -> bool {
    flags.get(id).copied().unwrap_or(true)
}

/// Upsert a connector's enabled flag.
pub async fn set_enabled(pool: &SqlitePool, id: &str, enabled: bool) -> Result<(), String> {
    sqlx::query(
        "INSERT INTO connector_state (id, enabled) VALUES (?1, ?2) \
         ON CONFLICT(id) DO UPDATE SET enabled = ?2",
    )
    .bind(id)
    .bind(enabled as i64)
    .execute(pool)
    .await
    .map_err(|e| format!("could not persist connector state for '{id}': {e}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::test_db;

    #[tokio::test]
    async fn unset_connector_is_absent_so_callers_default_enabled() {
        let (_dir, db) = test_db().await;
        let flags = load_enabled(&db.pool).await;
        assert!(!flags.contains_key("github-projects"));
        assert!(
            is_enabled(&flags, "github-projects"),
            "a connector with no row reads as enabled"
        );
    }

    #[tokio::test]
    async fn set_then_load_roundtrips_and_upserts() {
        let (_dir, db) = test_db().await;
        set_enabled(&db.pool, "github-projects", false)
            .await
            .unwrap();
        let flags = load_enabled(&db.pool).await;
        assert!(
            !is_enabled(&flags, "github-projects"),
            "stored disable sticks"
        );

        set_enabled(&db.pool, "github-projects", true)
            .await
            .unwrap();
        let flags = load_enabled(&db.pool).await;
        assert!(is_enabled(&flags, "github-projects"), "re-enable upserts");
    }

    #[tokio::test]
    async fn set_enabled_surfaces_a_dead_pool_error() {
        let (_dir, db) = test_db().await;
        db.pool.close().await;
        let err = set_enabled(&db.pool, "x", false).await.unwrap_err();
        assert!(err.contains("could not persist"), "{err}");
    }

    #[tokio::test]
    async fn load_enabled_treats_a_dead_pool_as_empty() {
        let (_dir, db) = test_db().await;
        db.pool.close().await;
        assert!(
            load_enabled(&db.pool).await.is_empty(),
            "a DB error defaults to an empty (all-enabled) map"
        );
    }
}
