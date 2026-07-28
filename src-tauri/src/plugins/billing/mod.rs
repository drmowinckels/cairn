//! Billing feature plugin (#109): the Pro gate. Owns the plugin's enabled
//! state (via the shared `plugin_state` table) and the Lemon Squeezy
//! license activation stored in `billing_license`. Rates, profitability,
//! and invoicing land in later slices — always in billing-owned tables,
//! never in core's.
//!
//! **Networked.** Unlike core, this plugin verifies licenses against Lemon
//! Squeezy (activate / validate / deactivate — see [`lemonsqueezy`]). It
//! declares the `Network` capability and the UI surfaces the check. A
//! licensing call carries only the license key + device instance id, never
//! any tracked time data. See `docs/PRIVACY.md`.

pub mod business;
pub mod invoice_html;
pub mod invoices;
pub mod lemonsqueezy;
pub mod profitability;
pub mod rates;

use serde::Serialize;
use sqlx::{Row, SqlitePool};

use lemonsqueezy::{LicenseApi, LicenseError, LicenseFacts};

pub const PLUGIN_ID: &str = "billing";

fn err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

/// Everything the billing card needs in one round trip.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BillingStatus {
    /// The plugin toggle (persisted in `plugin_state`; default off).
    pub enabled: bool,
    /// The activated license, if any — read from local storage, no
    /// network. `None` means the user hasn't activated a key on this
    /// device.
    pub license: Option<LicenseView>,
}

/// The stored activation as the UI sees it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LicenseView {
    /// Lemon Squeezy's `license_key.status`: `active` / `inactive` /
    /// `expired` / `disabled`.
    pub status: String,
    /// `true` iff `status == "active"` — the single flag Pro features gate on.
    pub active: bool,
    pub customer_email: Option<String>,
    pub product_name: Option<String>,
    pub expires_at: Option<String>,
    pub last_validated_at: String,
}

struct Stored {
    license_key: String,
    instance_id: String,
    status: String,
    customer_email: Option<String>,
    product_name: Option<String>,
    expires_at: Option<String>,
    last_validated_at: String,
}

impl Stored {
    fn view(&self) -> LicenseView {
        LicenseView {
            active: self.status == "active",
            status: self.status.clone(),
            customer_email: self.customer_email.clone(),
            product_name: self.product_name.clone(),
            expires_at: self.expires_at.clone(),
            last_validated_at: self.last_validated_at.clone(),
        }
    }
}

async fn load_stored(pool: &SqlitePool) -> Result<Option<Stored>, String> {
    let row = sqlx::query(
        "SELECT license_key, instance_id, status, customer_email, product_name, \
                expires_at, last_validated_at \
           FROM billing_license WHERE singleton = 1",
    )
    .fetch_optional(pool)
    .await
    .map_err(err)?;
    Ok(row.map(|r| Stored {
        license_key: r.get("license_key"),
        instance_id: r.get("instance_id"),
        status: r.get("status"),
        customer_email: r.get("customer_email"),
        product_name: r.get("product_name"),
        expires_at: r.get("expires_at"),
        last_validated_at: r.get("last_validated_at"),
    }))
}

/// Persist a fresh activation, replacing any prior row (resets
/// `activated_at`).
async fn save_activation(
    pool: &SqlitePool,
    license_key: &str,
    facts: &LicenseFacts,
) -> Result<(), String> {
    sqlx::query(
        "INSERT INTO billing_license \
           (singleton, license_key, instance_id, status, customer_email, \
            product_name, expires_at, activated_at, last_validated_at) \
         VALUES (1, ?1, ?2, ?3, ?4, ?5, ?6, datetime('now'), datetime('now')) \
         ON CONFLICT(singleton) DO UPDATE SET \
           license_key = excluded.license_key, instance_id = excluded.instance_id, \
           status = excluded.status, customer_email = excluded.customer_email, \
           product_name = excluded.product_name, expires_at = excluded.expires_at, \
           activated_at = excluded.activated_at, last_validated_at = excluded.last_validated_at",
    )
    .bind(license_key)
    .bind(&facts.instance_id)
    .bind(&facts.status)
    .bind(&facts.customer_email)
    .bind(&facts.product_name)
    .bind(&facts.expires_at)
    .execute(pool)
    .await
    .map_err(err)?;
    Ok(())
}

/// Update the stored row from a re-validation, keeping the original
/// `activated_at`.
async fn update_from_validate(pool: &SqlitePool, facts: &LicenseFacts) -> Result<(), String> {
    sqlx::query(
        "UPDATE billing_license SET status = ?1, customer_email = ?2, \
                product_name = ?3, expires_at = ?4, last_validated_at = datetime('now') \
          WHERE singleton = 1",
    )
    .bind(&facts.status)
    .bind(&facts.customer_email)
    .bind(&facts.product_name)
    .bind(&facts.expires_at)
    .execute(pool)
    .await
    .map_err(err)?;
    Ok(())
}

/// Mark the stored license as no longer active (Lemon Squeezy said the key
/// lapsed) without discarding it, so the card can explain the state.
async fn mark_inactive(pool: &SqlitePool) -> Result<(), String> {
    sqlx::query(
        "UPDATE billing_license SET status = 'inactive', \
                last_validated_at = datetime('now') WHERE singleton = 1",
    )
    .execute(pool)
    .await
    .map_err(err)?;
    Ok(())
}

async fn clear_stored(pool: &SqlitePool) -> Result<(), String> {
    sqlx::query("DELETE FROM billing_license WHERE singleton = 1")
        .execute(pool)
        .await
        .map_err(err)?;
    Ok(())
}

/// The card's state: the plugin flag + the locally-stored activation. Reads
/// no network — the UI stays instant and works offline; `refresh` is what
/// checks in with Lemon Squeezy.
pub async fn status(pool: &SqlitePool) -> Result<BillingStatus, String> {
    let flags = crate::plugins::store::load_enabled(pool).await;
    let enabled = crate::plugins::feature_enabled(&flags, PLUGIN_ID);
    let license = load_stored(pool).await?.map(|s| s.view());
    Ok(BillingStatus { enabled, license })
}

/// Pro-feature gate for **reads**: the plugin must be switched on. A
/// lapsed-but-enabled user still gets here, so their configured rates
/// stay visible — data is never held hostage.
pub async fn require_enabled(pool: &SqlitePool) -> Result<(), String> {
    if status(pool).await?.enabled {
        Ok(())
    } else {
        Err("the billing plugin is off".into())
    }
}

/// Pro-feature gate for **writes**: enabled *and* an active license. Every
/// future Pro command (rates, profitability, invoices) gates through here,
/// so the "you need active Pro to change billing" rule lives in one place.
/// Reads the stored status with no network — a paying user offline still
/// passes on their last-known-active license.
pub async fn require_pro(pool: &SqlitePool) -> Result<(), String> {
    let s = status(pool).await?;
    if !s.enabled {
        return Err("the billing plugin is off".into());
    }
    match s.license {
        Some(l) if l.active => Ok(()),
        _ => Err("Cairn Pro isn't active — activate a license to make billing changes".into()),
    }
}

/// Activate a pasted key on this device via Lemon Squeezy, then store it.
/// A rejected key (invalid / over device limit / wrong product) returns
/// its reason and stores nothing.
pub async fn activate(
    pool: &SqlitePool,
    api: &dyn LicenseApi,
    license_key: &str,
) -> Result<BillingStatus, String> {
    let key = license_key.trim();
    if key.is_empty() {
        return Err("enter a license key".into());
    }
    let facts = api.activate(key).await.map_err(err)?;
    save_activation(pool, key, &facts).await?;
    status(pool).await
}

/// Re-check the stored license against Lemon Squeezy (the "direct" check).
/// A lapsed key is recorded as inactive (kept, so the user sees why); an
/// unreachable Lemon Squeezy leaves the last-known state and surfaces the
/// error so a dropped connection never locks a paying user out.
pub async fn refresh(pool: &SqlitePool, api: &dyn LicenseApi) -> Result<BillingStatus, String> {
    let Some(stored) = load_stored(pool).await? else {
        return status(pool).await;
    };
    match api.validate(&stored.license_key, &stored.instance_id).await {
        Ok(facts) => update_from_validate(pool, &facts).await?,
        Err(LicenseError::Rejected(_)) => mark_inactive(pool).await?,
        Err(LicenseError::Unreachable(msg)) => return Err(msg),
    }
    status(pool).await
}

/// Release this device's slot with Lemon Squeezy and clear local state. An
/// unreachable Lemon Squeezy is a hard error (we keep local state rather
/// than orphaning the device slot); a rejection (the instance is already
/// gone) still clears locally.
pub async fn deactivate(pool: &SqlitePool, api: &dyn LicenseApi) -> Result<BillingStatus, String> {
    if let Some(stored) = load_stored(pool).await? {
        match api
            .deactivate(&stored.license_key, &stored.instance_id)
            .await
        {
            Ok(()) | Err(LicenseError::Rejected(_)) => {}
            Err(LicenseError::Unreachable(msg)) => {
                return Err(format!(
                    "couldn't release this device with Lemon Squeezy: {msg}"
                ));
            }
        }
        clear_stored(pool).await?;
    }
    status(pool).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::test_db;
    use async_trait::async_trait;
    use std::sync::Mutex;

    fn facts(status: &str) -> LicenseFacts {
        LicenseFacts {
            status: status.into(),
            instance_id: "inst-1".into(),
            customer_email: Some("dev@example.com".into()),
            product_name: Some("Cairn Pro".into()),
            expires_at: None,
        }
    }

    /// Scripted LicenseApi: each method returns the queued result and
    /// records the call, so tests assert both behaviour and the exact
    /// Lemon Squeezy interaction.
    #[derive(Default)]
    struct MockApi {
        activate: Mutex<Option<Result<LicenseFacts, LicenseError>>>,
        validate: Mutex<Option<Result<LicenseFacts, LicenseError>>>,
        deactivate: Mutex<Option<Result<(), LicenseError>>>,
        calls: Mutex<Vec<String>>,
    }

    impl MockApi {
        fn take<T>(slot: &Mutex<Option<T>>) -> T {
            slot.lock().unwrap().take().expect("unexpected API call")
        }
    }

    #[async_trait]
    impl LicenseApi for MockApi {
        async fn activate(&self, key: &str) -> Result<LicenseFacts, LicenseError> {
            self.calls.lock().unwrap().push(format!("activate:{key}"));
            Self::take(&self.activate)
        }
        async fn validate(&self, key: &str, inst: &str) -> Result<LicenseFacts, LicenseError> {
            self.calls
                .lock()
                .unwrap()
                .push(format!("validate:{key}:{inst}"));
            Self::take(&self.validate)
        }
        async fn deactivate(&self, key: &str, inst: &str) -> Result<(), LicenseError> {
            self.calls
                .lock()
                .unwrap()
                .push(format!("deactivate:{key}:{inst}"));
            Self::take(&self.deactivate)
        }
    }

    #[tokio::test]
    async fn status_defaults_off_and_unlicensed() {
        let (_dir, db) = test_db().await;
        let s = status(&db.pool).await.unwrap();
        assert!(!s.enabled, "billing must default off");
        assert!(s.license.is_none());
    }

    #[tokio::test]
    async fn activate_stores_and_reflects_a_valid_license() {
        let (_dir, db) = test_db().await;
        crate::plugins::store::set_enabled(&db.pool, PLUGIN_ID, true)
            .await
            .unwrap();
        let api = MockApi::default();
        *api.activate.lock().unwrap() = Some(Ok(facts("active")));

        let s = activate(&db.pool, &api, "  KEY-123  ").await.unwrap();
        let lic = s.license.expect("license stored");
        assert!(s.enabled && lic.active);
        assert_eq!(lic.customer_email.as_deref(), Some("dev@example.com"));
        // The key was trimmed before the API call.
        assert_eq!(api.calls.lock().unwrap()[0], "activate:KEY-123");
        // And it survives a fresh, network-free status read.
        assert!(status(&db.pool).await.unwrap().license.unwrap().active);
    }

    #[tokio::test]
    async fn activate_rejects_a_bad_key_without_storing() {
        let (_dir, db) = test_db().await;
        let api = MockApi::default();
        *api.activate.lock().unwrap() =
            Some(Err(LicenseError::Rejected("license key not found".into())));
        let err = activate(&db.pool, &api, "nope").await.unwrap_err();
        assert!(err.contains("not found"), "{err}");
        assert!(status(&db.pool).await.unwrap().license.is_none());
    }

    #[tokio::test]
    async fn activate_rejects_an_empty_key_without_calling_the_api() {
        let (_dir, db) = test_db().await;
        let api = MockApi::default();
        let err = activate(&db.pool, &api, "   ").await.unwrap_err();
        assert!(err.contains("enter a license key"), "{err}");
        assert!(api.calls.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn refresh_updates_status_from_lemon_squeezy() {
        let (_dir, db) = test_db().await;
        let api = MockApi::default();
        *api.activate.lock().unwrap() = Some(Ok(facts("active")));
        activate(&db.pool, &api, "KEY").await.unwrap();

        // A later re-check reports the key expired.
        *api.validate.lock().unwrap() = Some(Ok(facts("expired")));
        let s = refresh(&db.pool, &api).await.unwrap();
        let lic = s.license.unwrap();
        assert_eq!(lic.status, "expired");
        assert!(!lic.active);
        assert_eq!(
            api.calls.lock().unwrap()[1],
            "validate:KEY:inst-1",
            "validate carries the stored key + instance"
        );
    }

    #[tokio::test]
    async fn refresh_marks_inactive_when_lemon_squeezy_rejects() {
        let (_dir, db) = test_db().await;
        let api = MockApi::default();
        *api.activate.lock().unwrap() = Some(Ok(facts("active")));
        activate(&db.pool, &api, "KEY").await.unwrap();

        *api.validate.lock().unwrap() =
            Some(Err(LicenseError::Rejected("license deactivated".into())));
        let s = refresh(&db.pool, &api).await.unwrap();
        let lic = s.license.expect("row kept so the card can explain it");
        assert!(!lic.active);
        assert_eq!(lic.status, "inactive");
    }

    #[tokio::test]
    async fn refresh_keeps_state_and_errors_when_offline() {
        let (_dir, db) = test_db().await;
        let api = MockApi::default();
        *api.activate.lock().unwrap() = Some(Ok(facts("active")));
        activate(&db.pool, &api, "KEY").await.unwrap();

        *api.validate.lock().unwrap() = Some(Err(LicenseError::Unreachable("offline".into())));
        let err = refresh(&db.pool, &api).await.unwrap_err();
        assert!(err.contains("offline"));
        // Last-known "active" is untouched — a dropped connection never
        // locks the user out.
        assert!(status(&db.pool).await.unwrap().license.unwrap().active);
    }

    #[tokio::test]
    async fn refresh_without_a_license_is_a_noop() {
        let (_dir, db) = test_db().await;
        let api = MockApi::default();
        let s = refresh(&db.pool, &api).await.unwrap();
        assert!(s.license.is_none());
        assert!(api.calls.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn deactivate_releases_the_slot_and_clears_local() {
        let (_dir, db) = test_db().await;
        let api = MockApi::default();
        *api.activate.lock().unwrap() = Some(Ok(facts("active")));
        activate(&db.pool, &api, "KEY").await.unwrap();

        *api.deactivate.lock().unwrap() = Some(Ok(()));
        let s = deactivate(&db.pool, &api).await.unwrap();
        assert!(s.license.is_none());
        assert_eq!(api.calls.lock().unwrap()[1], "deactivate:KEY:inst-1");
    }

    #[tokio::test]
    async fn deactivate_clears_locally_even_if_the_instance_is_already_gone() {
        let (_dir, db) = test_db().await;
        let api = MockApi::default();
        *api.activate.lock().unwrap() = Some(Ok(facts("active")));
        activate(&db.pool, &api, "KEY").await.unwrap();

        *api.deactivate.lock().unwrap() =
            Some(Err(LicenseError::Rejected("instance not found".into())));
        let s = deactivate(&db.pool, &api).await.unwrap();
        assert!(s.license.is_none());
    }

    #[tokio::test]
    async fn deactivate_without_a_license_is_a_noop() {
        let (_dir, db) = test_db().await;
        let api = MockApi::default();
        let s = deactivate(&db.pool, &api).await.unwrap();
        assert!(s.license.is_none());
        assert!(
            api.calls.lock().unwrap().is_empty(),
            "no Lemon Squeezy call"
        );
    }

    #[tokio::test]
    async fn deactivate_keeps_local_state_when_offline() {
        let (_dir, db) = test_db().await;
        let api = MockApi::default();
        *api.activate.lock().unwrap() = Some(Ok(facts("active")));
        activate(&db.pool, &api, "KEY").await.unwrap();

        *api.deactivate.lock().unwrap() = Some(Err(LicenseError::Unreachable("offline".into())));
        let err = deactivate(&db.pool, &api).await.unwrap_err();
        assert!(err.contains("couldn't release this device"), "{err}");
        // Not orphaned — the license is still there to retry.
        assert!(status(&db.pool).await.unwrap().license.is_some());
    }

    async fn enable(pool: &SqlitePool) {
        crate::plugins::store::set_enabled(pool, PLUGIN_ID, true)
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn require_enabled_tracks_the_plugin_flag() {
        let (_dir, db) = test_db().await;
        assert!(require_enabled(&db.pool).await.is_err(), "off by default");
        enable(&db.pool).await;
        assert!(require_enabled(&db.pool).await.is_ok());
    }

    #[tokio::test]
    async fn require_pro_needs_enabled_and_an_active_license() {
        let (_dir, db) = test_db().await;
        // Disabled ⇒ blocked on the flag.
        assert!(require_pro(&db.pool)
            .await
            .unwrap_err()
            .contains("plugin is off"));

        // Enabled but no license ⇒ blocked on Pro.
        enable(&db.pool).await;
        assert!(require_pro(&db.pool)
            .await
            .unwrap_err()
            .contains("Cairn Pro isn't active"));

        // Enabled + active license ⇒ passes.
        let api = MockApi::default();
        *api.activate.lock().unwrap() = Some(Ok(facts("active")));
        activate(&db.pool, &api, "KEY").await.unwrap();
        assert!(require_pro(&db.pool).await.is_ok());

        // Reads stay open when the license lapses, writes don't.
        mark_inactive(&db.pool).await.unwrap();
        assert!(require_enabled(&db.pool).await.is_ok());
        assert!(require_pro(&db.pool)
            .await
            .unwrap_err()
            .contains("Cairn Pro isn't active"));
    }
}
