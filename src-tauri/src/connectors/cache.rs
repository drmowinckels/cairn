//! Offline cache for connector reads (`connector_cache` table, #110).
//!
//! A connector's projects/tasks come from a remote that may be down. The
//! IPC layer caches each successful read here and, when a later read fails,
//! falls back to the stored snapshot so time attribution still works
//! offline. This module is the only thing that touches the table — kept out
//! of the IPC orchestration so the SQL stays in one auditable place, same
//! split as `plugins::store`.
//!
//! A read error is logged and treated as a cache miss (`None`) rather than
//! propagated: the cache is best-effort, and a fallback that can't read the
//! cache should surface the *original* network error, not a DB one.

use sqlx::{Row, SqlitePool};

/// `scope` value for a connector's project list.
pub const PROJECTS_SCOPE: &str = "projects";

/// `scope` value for one project's task list.
pub fn tasks_scope(project_id: &str) -> String {
    format!("tasks:{project_id}")
}

/// A cached payload plus when it was taken (RFC 3339).
pub struct Cached {
    pub payload: String,
    pub fetched_at: String,
}

/// The cached payload for `(connector_id, scope)`, or `None` if absent or
/// unreadable (a DB error is logged and treated as a miss).
pub async fn get(pool: &SqlitePool, connector_id: &str, scope: &str) -> Option<Cached> {
    let row = sqlx::query(
        "SELECT payload, fetched_at FROM connector_cache WHERE connector_id = ?1 AND scope = ?2",
    )
    .bind(connector_id)
    .bind(scope)
    .fetch_optional(pool)
    .await;
    match row {
        Ok(Some(r)) => Some(Cached {
            payload: r.get::<String, _>("payload"),
            fetched_at: r.get::<String, _>("fetched_at"),
        }),
        Ok(None) => None,
        Err(e) => {
            log::warn!("connector_cache read failed: {e}");
            None
        }
    }
}

/// Upsert the cached payload for `(connector_id, scope)`.
pub async fn put(
    pool: &SqlitePool,
    connector_id: &str,
    scope: &str,
    payload: &str,
    fetched_at: &str,
) -> Result<(), String> {
    sqlx::query(
        "INSERT INTO connector_cache (connector_id, scope, payload, fetched_at) \
         VALUES (?1, ?2, ?3, ?4) \
         ON CONFLICT(connector_id, scope) DO UPDATE SET payload = ?3, fetched_at = ?4",
    )
    .bind(connector_id)
    .bind(scope)
    .bind(payload)
    .bind(fetched_at)
    .execute(pool)
    .await
    .map_err(|e| format!("could not cache connector read: {e}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::test_db;

    #[test]
    fn tasks_scope_is_namespaced_by_project() {
        assert_eq!(tasks_scope("cairn"), "tasks:cairn");
        assert_ne!(tasks_scope("a"), PROJECTS_SCOPE);
    }

    #[tokio::test]
    async fn put_then_get_roundtrips_and_upserts() {
        let (_dir, db) = test_db().await;
        assert!(
            get(&db.pool, "gh", PROJECTS_SCOPE).await.is_none(),
            "absent scope is a miss"
        );

        put(
            &db.pool,
            "gh",
            PROJECTS_SCOPE,
            "[1]",
            "2026-01-01T00:00:00Z",
        )
        .await
        .unwrap();
        let c = get(&db.pool, "gh", PROJECTS_SCOPE).await.unwrap();
        assert_eq!(c.payload, "[1]");
        assert_eq!(c.fetched_at, "2026-01-01T00:00:00Z");

        // A second put for the same key overwrites rather than duplicating.
        put(
            &db.pool,
            "gh",
            PROJECTS_SCOPE,
            "[1,2]",
            "2026-02-02T00:00:00Z",
        )
        .await
        .unwrap();
        let c = get(&db.pool, "gh", PROJECTS_SCOPE).await.unwrap();
        assert_eq!(c.payload, "[1,2]");
        assert_eq!(c.fetched_at, "2026-02-02T00:00:00Z");
    }

    #[tokio::test]
    async fn get_treats_a_dead_pool_as_a_miss() {
        let (_dir, db) = test_db().await;
        db.pool.close().await;
        assert!(
            get(&db.pool, "gh", PROJECTS_SCOPE).await.is_none(),
            "a DB error reads as a miss, not a panic"
        );
    }

    #[tokio::test]
    async fn put_surfaces_a_dead_pool_error() {
        let (_dir, db) = test_db().await;
        db.pool.close().await;
        let err = put(&db.pool, "gh", PROJECTS_SCOPE, "[]", "t")
            .await
            .unwrap_err();
        assert!(err.contains("could not cache"), "{err}");
    }
}
