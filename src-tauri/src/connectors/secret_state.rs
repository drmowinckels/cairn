//! Persistence for connector-secret presence (`connector_secret_state` table,
//! #110). Mirrors [`crate::connectors::state`] (enabled flags): kept out of the
//! host, the only place that touches this table.
//!
//! The Settings → Connectors badge needs to know whether a token is stored, but
//! reading the keychain to find out re-prompts for access on every macOS dev
//! rebuild. So a boolean "is set" is mirrored here, written whenever a token is
//! set/cleared; [`list_connectors`] reads this table and never touches the
//! keychain. The token value never lands here — only its presence does.
//!
//! [`list_connectors`]: crate::ipc::list_connectors_impl

use std::collections::HashMap;

use sqlx::{Row, SqlitePool};

/// Load every secret-presence flag, keyed by the bare secret key. A key with
/// no row is intentionally absent from the map — callers treat "absent" as
/// missing. A query failure logs and returns an empty map, defaulting every
/// secret to missing rather than falsely claiming one is set.
pub async fn load_present(pool: &SqlitePool) -> HashMap<String, bool> {
    match sqlx::query("SELECT secret_key, present FROM connector_secret_state")
        .fetch_all(pool)
        .await
    {
        Ok(rows) => rows
            .into_iter()
            .map(|r| {
                (
                    r.get::<String, _>("secret_key"),
                    r.get::<i64, _>("present") != 0,
                )
            })
            .collect(),
        Err(e) => {
            log::warn!("connector_secret_state load failed: {e}; treating all secrets as missing");
            HashMap::new()
        }
    }
}

/// Whether a secret is present, given the loaded flags. Absent = missing.
pub fn is_present(flags: &HashMap<String, bool>, key: &str) -> bool {
    flags.get(key).copied().unwrap_or(false)
}

/// Upsert a secret's presence flag.
pub async fn set_present(pool: &SqlitePool, key: &str, present: bool) -> Result<(), String> {
    sqlx::query(
        "INSERT INTO connector_secret_state (secret_key, present) VALUES (?1, ?2) \
         ON CONFLICT(secret_key) DO UPDATE SET present = ?2",
    )
    .bind(key)
    .bind(present as i64)
    .execute(pool)
    .await
    .map_err(|e| format!("could not persist secret presence for '{key}': {e}"))?;
    Ok(())
}

/// One-time reconcile for keys with no row yet: read the keychain ONCE per
/// unknown key and record its presence. This lets a token set before this
/// table existed (or on a fresh keychain) show correctly without listing ever
/// reading the keychain again. Keys already recorded are skipped, so across
/// the app's lifetime each key triggers at most one keychain read — at the
/// first launch after upgrade — instead of one on every connector list.
pub async fn backfill_missing(
    pool: &SqlitePool,
    keys: &[&str],
    store: &dyn crate::connectors::http::SecretStore,
) {
    let known = load_present(pool).await;
    for key in keys {
        if known.contains_key(*key) {
            continue;
        }
        let present = store.token(key).is_some();
        if let Err(e) = set_present(pool, key, present).await {
            log::warn!("secret-presence backfill for '{key}' failed: {e}");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::connectors::http::SecretStore;
    use crate::test_support::test_db;
    use std::collections::HashMap as Map;

    /// In-memory keychain double for the backfill test.
    struct FakeStore(Map<String, String>);
    impl SecretStore for FakeStore {
        fn token(&self, key: &str) -> Option<String> {
            self.0.get(key).cloned()
        }
    }

    #[tokio::test]
    async fn unset_secret_is_absent_so_callers_default_missing() {
        let (_dir, db) = test_db().await;
        let flags = load_present(&db.pool).await;
        assert!(!flags.contains_key("github_token"));
        assert!(
            !is_present(&flags, "github_token"),
            "a secret with no row reads as missing"
        );
    }

    #[tokio::test]
    async fn set_then_load_roundtrips_and_upserts() {
        let (_dir, db) = test_db().await;
        set_present(&db.pool, "github_token", true).await.unwrap();
        assert!(is_present(&load_present(&db.pool).await, "github_token"));

        set_present(&db.pool, "github_token", false).await.unwrap();
        assert!(!is_present(&load_present(&db.pool).await, "github_token"));
    }

    #[tokio::test]
    async fn set_present_surfaces_a_dead_pool_error() {
        let (_dir, db) = test_db().await;
        db.pool.close().await;
        let err = set_present(&db.pool, "k", true).await.unwrap_err();
        assert!(err.contains("could not persist"), "{err}");
    }

    #[tokio::test]
    async fn load_present_treats_a_dead_pool_as_empty() {
        let (_dir, db) = test_db().await;
        db.pool.close().await;
        assert!(load_present(&db.pool).await.is_empty());
    }

    #[tokio::test]
    async fn backfill_records_keychain_presence_only_for_unknown_keys() {
        let (_dir, db) = test_db().await;
        // `gitlab_token` already has a (false) row; the backfill must not
        // overwrite it from the keychain.
        set_present(&db.pool, "gitlab_token", false).await.unwrap();
        let store = FakeStore(Map::from([
            ("github_token".to_string(), "ghp_x".to_string()),
            ("gitlab_token".to_string(), "glpat_y".to_string()),
        ]));
        backfill_missing(
            &db.pool,
            &["github_token", "gitlab_token", "trello_key"],
            &store,
        )
        .await;

        let flags = load_present(&db.pool).await;
        assert!(
            is_present(&flags, "github_token"),
            "unknown + present → set"
        );
        assert!(
            !is_present(&flags, "gitlab_token"),
            "already-recorded key is left untouched"
        );
        assert!(
            !is_present(&flags, "trello_key"),
            "unknown + absent from keychain → missing"
        );
    }

    #[tokio::test]
    async fn backfill_swallows_a_write_failure() {
        let (_dir, db) = test_db().await;
        db.pool.close().await;
        let store = FakeStore(Map::from([(
            "github_token".to_string(),
            "ghp_x".to_string(),
        )]));
        // The pool is dead: `load_present` reads empty (so the key looks
        // unknown) and the `set_present` write then fails — which backfill
        // logs and swallows rather than propagating. The assertion is simply
        // that it returns without panicking.
        backfill_missing(&db.pool, &["github_token"], &store).await;
    }
}
