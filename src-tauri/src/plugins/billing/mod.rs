//! Billing feature plugin (#109): the Pro gate. This slice owns the
//! plugin's enabled state (via the shared `plugin_state` table) and the
//! locally-verified license (`license` module). Rates, profitability,
//! and invoicing land in later slices — always in billing-owned tables,
//! never in core's.
//!
//! Fully local: the plugin makes no network calls. See `docs/PRIVACY.md`.

pub mod license;

use serde::Serialize;
use sqlx::{Row, SqlitePool};

use license::{LicenseInfo, LicenseVerifier};

pub const PLUGIN_ID: &str = "billing";

/// Everything the billing card needs in one round trip.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BillingStatus {
    /// The plugin toggle (persisted in `plugin_state`; default off).
    pub enabled: bool,
    /// Whether this build carries a license public key at all — false
    /// in dev builds, where the card explains licensing isn't live yet.
    pub key_configured: bool,
    /// `Some` when a stored license verifies against the baked-in key.
    pub license: Option<LicenseInfo>,
}

/// Load the stored license string, if any.
pub async fn load_license(pool: &SqlitePool) -> Result<Option<String>, String> {
    let row = sqlx::query("SELECT license FROM billing_license WHERE singleton = 1")
        .fetch_optional(pool)
        .await
        .map_err(|e| e.to_string())?;
    Ok(row.map(|r| r.get("license")))
}

/// Store (or replace) the license string. Callers verify BEFORE storing
/// — an invalid key must never be persisted just to fail again on every
/// status read.
pub async fn store_license(pool: &SqlitePool, license: &str) -> Result<(), String> {
    sqlx::query(
        "INSERT INTO billing_license (singleton, license, stored_at) \
         VALUES (1, ?1, datetime('now')) \
         ON CONFLICT(singleton) DO UPDATE SET license = ?1, stored_at = datetime('now')",
    )
    .bind(license)
    .execute(pool)
    .await
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub async fn clear_license(pool: &SqlitePool) -> Result<(), String> {
    sqlx::query("DELETE FROM billing_license WHERE singleton = 1")
        .execute(pool)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Assemble the card's status: plugin flag + license check. A stored
/// license that no longer verifies (key rotation, corruption) reads as
/// unlicensed rather than erroring — the user just re-enters the key.
pub async fn status(
    pool: &SqlitePool,
    verifier: &LicenseVerifier,
) -> Result<BillingStatus, String> {
    let flags = crate::plugins::store::load_enabled(pool).await;
    let enabled = crate::plugins::feature_enabled(&flags, PLUGIN_ID);
    let license = match load_license(pool).await? {
        Some(stored) => verifier.verify(&stored).ok(),
        None => None,
    };
    Ok(BillingStatus {
        enabled,
        key_configured: verifier.has_key(),
        license,
    })
}

#[cfg(test)]
mod tests {
    use super::license::test_keys::{fixture_verifier, sign_license};
    use super::*;
    use crate::test_support::test_db;

    #[tokio::test]
    async fn license_round_trips_store_load_clear() {
        let (_dir, db) = test_db().await;
        assert_eq!(load_license(&db.pool).await.unwrap(), None);

        store_license(&db.pool, "first").await.unwrap();
        assert_eq!(
            load_license(&db.pool).await.unwrap().as_deref(),
            Some("first")
        );

        // Replacing overwrites the single row rather than adding one.
        store_license(&db.pool, "second").await.unwrap();
        assert_eq!(
            load_license(&db.pool).await.unwrap().as_deref(),
            Some("second")
        );

        clear_license(&db.pool).await.unwrap();
        assert_eq!(load_license(&db.pool).await.unwrap(), None);
    }

    #[tokio::test]
    async fn status_defaults_off_unlicensed() {
        let (_dir, db) = test_db().await;
        let s = status(&db.pool, &fixture_verifier()).await.unwrap();
        assert!(!s.enabled, "billing must default off");
        assert!(s.key_configured);
        assert!(s.license.is_none());
    }

    #[tokio::test]
    async fn status_reflects_flag_and_valid_license() {
        let (_dir, db) = test_db().await;
        crate::plugins::store::set_enabled(&db.pool, PLUGIN_ID, true)
            .await
            .unwrap();
        store_license(
            &db.pool,
            &sign_license("dev@example.com", "o1", "cairn-pro"),
        )
        .await
        .unwrap();
        let s = status(&db.pool, &fixture_verifier()).await.unwrap();
        assert!(s.enabled);
        assert_eq!(s.license.unwrap().email, "dev@example.com");
    }

    #[tokio::test]
    async fn status_treats_an_unverifiable_stored_license_as_unlicensed() {
        let (_dir, db) = test_db().await;
        store_license(&db.pool, "garbage-from-an-old-key")
            .await
            .unwrap();
        let s = status(&db.pool, &fixture_verifier()).await.unwrap();
        assert!(s.license.is_none());

        // Keyless build: even a well-formed stored license reads unlicensed.
        store_license(&db.pool, &sign_license("dev@example.com", "o", "p"))
            .await
            .unwrap();
        let keyless = LicenseVerifier::with_key(None);
        let s = status(&db.pool, &keyless).await.unwrap();
        assert!(!s.key_configured);
        assert!(s.license.is_none());
    }
}
