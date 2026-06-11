//! Persistence for per-connector configuration params (`connector_params`
//! table, #110). Mirrors [`crate::connectors::state`] (enabled flags) and
//! [`crate::connectors::secret_state`] (secret presence): kept out of the host,
//! the only place that touches this table.
//!
//! A param is non-secret, user-entered config a manifest declares and
//! references as a `{{key}}` template variable — e.g. the GitHub connector's
//! `owner`. Unlike a secret, the value is not sensitive: it is stored here (not
//! the keychain), echoed back to the settings card, and editable in place. A
//! connector/param with no row reads as the empty string, which a manifest
//! treats as "unset".

use std::collections::{BTreeMap, HashMap};

use sqlx::{Row, SqlitePool};

/// Load every stored param, grouped by connector id. A connector with no stored
/// param is intentionally absent from the outer map; a param with no row is
/// absent from the inner map — callers treat "absent" as the empty string. A
/// query failure logs and returns an empty map, defaulting every param to unset
/// rather than failing the connector list.
pub async fn load_params(pool: &SqlitePool) -> HashMap<String, BTreeMap<String, String>> {
    match sqlx::query("SELECT connector_id, param_key, value FROM connector_params")
        .fetch_all(pool)
        .await
    {
        Ok(rows) => {
            let mut out: HashMap<String, BTreeMap<String, String>> = HashMap::new();
            for r in rows {
                out.entry(r.get::<String, _>("connector_id"))
                    .or_default()
                    .insert(r.get::<String, _>("param_key"), r.get::<String, _>("value"));
            }
            out
        }
        Err(e) => {
            log::warn!("connector_params load failed: {e}; treating all params as unset");
            HashMap::new()
        }
    }
}

/// The stored params for one connector, or an empty map when it has none.
pub fn params_for(
    loaded: &HashMap<String, BTreeMap<String, String>>,
    connector_id: &str,
) -> BTreeMap<String, String> {
    loaded.get(connector_id).cloned().unwrap_or_default()
}

/// Upsert a connector param. An empty (or whitespace-only) value clears the row
/// instead of storing it, so "unset" and "stored empty string" are the same
/// state — a manifest's blank-means-unset fallback can never be defeated by a
/// lingering empty row.
pub async fn set_param(
    pool: &SqlitePool,
    connector_id: &str,
    key: &str,
    value: &str,
) -> Result<(), String> {
    let value = value.trim();
    if value.is_empty() {
        sqlx::query("DELETE FROM connector_params WHERE connector_id = ?1 AND param_key = ?2")
            .bind(connector_id)
            .bind(key)
            .execute(pool)
            .await
            .map_err(|e| format!("could not clear param '{key}' for '{connector_id}': {e}"))?;
        return Ok(());
    }
    sqlx::query(
        "INSERT INTO connector_params (connector_id, param_key, value) VALUES (?1, ?2, ?3) \
         ON CONFLICT(connector_id, param_key) DO UPDATE SET value = ?3",
    )
    .bind(connector_id)
    .bind(key)
    .bind(value)
    .execute(pool)
    .await
    .map_err(|e| format!("could not persist param '{key}' for '{connector_id}': {e}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::test_db;

    #[tokio::test]
    async fn unset_connector_has_no_params() {
        let (_dir, db) = test_db().await;
        let loaded = load_params(&db.pool).await;
        assert!(!loaded.contains_key("github-projects"));
        assert!(
            params_for(&loaded, "github-projects").is_empty(),
            "a connector with no rows reads as no params"
        );
    }

    #[tokio::test]
    async fn set_then_load_roundtrips_and_groups_by_connector() {
        let (_dir, db) = test_db().await;
        set_param(&db.pool, "github-projects", "owner", "ggsegverse")
            .await
            .unwrap();
        set_param(&db.pool, "gitlab", "owner", "acme")
            .await
            .unwrap();

        let loaded = load_params(&db.pool).await;
        assert_eq!(
            params_for(&loaded, "github-projects")
                .get("owner")
                .map(String::as_str),
            Some("ggsegverse")
        );
        assert_eq!(
            params_for(&loaded, "gitlab")
                .get("owner")
                .map(String::as_str),
            Some("acme")
        );
    }

    #[tokio::test]
    async fn set_trims_and_upserts() {
        let (_dir, db) = test_db().await;
        set_param(&db.pool, "github-projects", "owner", "  ggsegverse  ")
            .await
            .unwrap();
        assert_eq!(
            params_for(&load_params(&db.pool).await, "github-projects")
                .get("owner")
                .map(String::as_str),
            Some("ggsegverse"),
            "the value is trimmed before storing"
        );

        set_param(&db.pool, "github-projects", "owner", "octocat")
            .await
            .unwrap();
        assert_eq!(
            params_for(&load_params(&db.pool).await, "github-projects")
                .get("owner")
                .map(String::as_str),
            Some("octocat"),
            "re-setting upserts"
        );
    }

    #[tokio::test]
    async fn empty_value_clears_the_row() {
        let (_dir, db) = test_db().await;
        set_param(&db.pool, "github-projects", "owner", "ggsegverse")
            .await
            .unwrap();
        // A blank (here: whitespace-only) value clears rather than storing an
        // empty string, so the manifest's blank-means-unset fallback holds.
        set_param(&db.pool, "github-projects", "owner", "   ")
            .await
            .unwrap();
        let loaded = load_params(&db.pool).await;
        assert!(
            params_for(&loaded, "github-projects").is_empty(),
            "an empty value removes the row"
        );
    }

    #[tokio::test]
    async fn set_param_surfaces_a_dead_pool_error() {
        let (_dir, db) = test_db().await;
        db.pool.close().await;
        let err = set_param(&db.pool, "github-projects", "owner", "x")
            .await
            .unwrap_err();
        assert!(err.contains("could not persist"), "{err}");
    }

    #[tokio::test]
    async fn clear_on_a_dead_pool_surfaces_an_error() {
        let (_dir, db) = test_db().await;
        db.pool.close().await;
        let err = set_param(&db.pool, "github-projects", "owner", "")
            .await
            .unwrap_err();
        assert!(err.contains("could not clear"), "{err}");
    }

    #[tokio::test]
    async fn load_params_treats_a_dead_pool_as_empty() {
        let (_dir, db) = test_db().await;
        db.pool.close().await;
        assert!(load_params(&db.pool).await.is_empty());
    }
}
