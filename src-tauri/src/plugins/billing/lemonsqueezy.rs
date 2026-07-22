//! Lemon Squeezy license verification (#109). Cairn checks a Pro license
//! directly against Lemon Squeezy's public license endpoints — the same
//! approach the sister app Entracte uses — rather than an offline signed
//! token. The license key itself is the credential, so no store API token
//! ships in the app.
//!
//! This is a **networked** capability: it lives behind the billing
//! plugin's `Network` capability and the UI surfaces the check. See
//! `docs/PRIVACY.md` — a licensing check-in carries only the license key
//! and a device instance id, never any tracked time data.

use async_trait::async_trait;
use serde::Deserialize;
use std::time::Duration;

const API_BASE: &str = "https://api.lemonsqueezy.com/v1/licenses";

/// A fixed, non-PII device label. Lemon Squeezy counts activations by the
/// returned instance **id**, not this name, so we deliberately avoid
/// sending the machine's hostname.
pub const INSTANCE_NAME: &str = "Cairn Desktop";

/// Optional compile-time product pin. When set (release builds), a
/// license whose Lemon Squeezy product id doesn't match is rejected, so a
/// key for another product in the same store can't unlock Cairn Pro. When
/// unset (dev), any product the store issues is accepted.
const PRODUCT_ID: Option<&str> = option_env!("CAIRN_LS_PRODUCT_ID");

/// What Lemon Squeezy told us about a license, normalised for storage and
/// display. `status` is Lemon Squeezy's `license_key.status`
/// (`active` / `inactive` / `expired` / `disabled`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LicenseFacts {
    pub status: String,
    pub instance_id: String,
    pub customer_email: Option<String>,
    pub product_name: Option<String>,
    pub expires_at: Option<String>,
}

/// Why a license operation didn't yield a usable license.
#[derive(Debug)]
pub enum LicenseError {
    /// Lemon Squeezy responded and rejected the key (invalid, expired,
    /// over the device limit, or — with a product pin — the wrong
    /// product). Carries a user-facing reason; do not auto-retry.
    Rejected(String),
    /// Couldn't reach or understand Lemon Squeezy (offline, 5xx, malformed
    /// response). Retryable; callers keep any last-known state.
    Unreachable(String),
}

impl std::fmt::Display for LicenseError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            LicenseError::Rejected(m) => write!(f, "{m}"),
            LicenseError::Unreachable(m) => write!(f, "{m}"),
        }
    }
}

/// The Lemon Squeezy license operations Cairn needs. A trait so tests can
/// drive the billing logic with a fake instead of the network (mirrors
/// the connectors' `HttpFetcher` seam).
#[async_trait]
pub trait LicenseApi: Send + Sync {
    /// Activate a key on this device, consuming a device slot. Returns the
    /// new instance id + license facts.
    async fn activate(&self, license_key: &str) -> Result<LicenseFacts, LicenseError>;
    /// Re-check a previously activated key + instance against Lemon
    /// Squeezy. Reflects the *current* status (e.g. an expiry or a refund).
    async fn validate(
        &self,
        license_key: &str,
        instance_id: &str,
    ) -> Result<LicenseFacts, LicenseError>;
    /// Release this device's slot so the key can be moved elsewhere.
    async fn deactivate(&self, license_key: &str, instance_id: &str) -> Result<(), LicenseError>;
}

// ── Lemon Squeezy response shapes ────────────────────────────────────

#[derive(Debug, Deserialize)]
struct KeyBlock {
    status: Option<String>,
    expires_at: Option<String>,
}

#[derive(Debug, Deserialize)]
struct InstanceBlock {
    id: Option<String>,
}

#[derive(Debug, Deserialize)]
struct MetaBlock {
    product_id: Option<serde_json::Value>,
    product_name: Option<String>,
    customer_email: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ActivateResponse {
    activated: bool,
    error: Option<String>,
    license_key: Option<KeyBlock>,
    instance: Option<InstanceBlock>,
    meta: Option<MetaBlock>,
}

#[derive(Debug, Deserialize)]
struct ValidateResponse {
    valid: bool,
    error: Option<String>,
    license_key: Option<KeyBlock>,
    meta: Option<MetaBlock>,
}

#[derive(Debug, Deserialize)]
struct DeactivateResponse {
    deactivated: bool,
    error: Option<String>,
}

/// Stringify a Lemon Squeezy product id, which the API may send as a
/// number or a string.
fn product_id_str(v: &serde_json::Value) -> Option<String> {
    match v {
        serde_json::Value::String(s) => Some(s.clone()),
        serde_json::Value::Number(n) => Some(n.to_string()),
        _ => None,
    }
}

/// Pure pinning check, split from the compile-time constant so both the
/// pass and fail arms are testable: `expected = None` (no pin) accepts
/// anything; a pin accepts only an exact product-id match.
fn verify_product(expected: Option<&str>, meta: &Option<MetaBlock>) -> Result<(), LicenseError> {
    let got = meta
        .as_ref()
        .and_then(|m| m.product_id.as_ref())
        .and_then(product_id_str);
    match expected {
        None => Ok(()),
        Some(e) if got.as_deref() == Some(e) => Ok(()),
        Some(_) => Err(LicenseError::Rejected(
            "this license is for a different product".into(),
        )),
    }
}

fn facts_from(instance_id: String, key: Option<KeyBlock>, meta: Option<MetaBlock>) -> LicenseFacts {
    let (status, expires_at) = key
        .map(|k| (k.status, k.expires_at))
        .unwrap_or((None, None));
    let (product_name, customer_email) = meta
        .map(|m| (m.product_name, m.customer_email))
        .unwrap_or((None, None));
    LicenseFacts {
        status: status.unwrap_or_else(|| "unknown".into()),
        instance_id,
        customer_email,
        product_name,
        expires_at,
    }
}

/// The production, reqwest-backed client.
pub struct LemonSqueezyApi {
    client: reqwest::Client,
    base: String,
}

impl LemonSqueezyApi {
    pub fn new() -> Result<Self, String> {
        Self::with_base(API_BASE.to_string())
    }

    fn with_base(base: String) -> Result<Self, String> {
        let client = reqwest::Client::builder()
            .user_agent(concat!("cairn/", env!("CARGO_PKG_VERSION")))
            .https_only(base.starts_with("https://"))
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(20))
            .build()
            .map_err(|e| format!("build reqwest client: {e}"))?;
        Ok(Self { client, base })
    }

    async fn post_form<T: for<'de> Deserialize<'de>>(
        &self,
        path: &str,
        form: &[(&str, &str)],
    ) -> Result<T, LicenseError> {
        let resp = self
            .client
            .post(format!("{}/{path}", self.base))
            .header("Accept", "application/json")
            .form(form)
            .send()
            .await
            .map_err(|e| LicenseError::Unreachable(format!("couldn't reach Lemon Squeezy: {e}")))?;
        // Lemon Squeezy returns the license verdict as a JSON body on both
        // 200 and 4xx (e.g. a not-found key is 404 with `{error}`); a 5xx
        // is a Lemon Squeezy outage, not a verdict.
        if resp.status().is_server_error() {
            return Err(LicenseError::Unreachable(format!(
                "Lemon Squeezy is unavailable ({})",
                resp.status()
            )));
        }
        let body = resp
            .text()
            .await
            .map_err(|e| LicenseError::Unreachable(format!("couldn't read Lemon Squeezy: {e}")))?;
        serde_json::from_str(&body)
            .map_err(|_| LicenseError::Unreachable("unexpected response from Lemon Squeezy".into()))
    }
}

#[async_trait]
impl LicenseApi for LemonSqueezyApi {
    async fn activate(&self, license_key: &str) -> Result<LicenseFacts, LicenseError> {
        let resp: ActivateResponse = self
            .post_form(
                "activate",
                &[
                    ("license_key", license_key),
                    ("instance_name", INSTANCE_NAME),
                ],
            )
            .await?;
        if !resp.activated {
            return Err(LicenseError::Rejected(resp.error.unwrap_or_else(|| {
                "Lemon Squeezy rejected this license key".into()
            })));
        }
        verify_product(PRODUCT_ID, &resp.meta)?;
        let instance_id = resp.instance.and_then(|i| i.id).ok_or_else(|| {
            LicenseError::Unreachable("Lemon Squeezy returned no instance".into())
        })?;
        Ok(facts_from(instance_id, resp.license_key, resp.meta))
    }

    async fn validate(
        &self,
        license_key: &str,
        instance_id: &str,
    ) -> Result<LicenseFacts, LicenseError> {
        let resp: ValidateResponse = self
            .post_form(
                "validate",
                &[("license_key", license_key), ("instance_id", instance_id)],
            )
            .await?;
        if !resp.valid {
            return Err(LicenseError::Rejected(
                resp.error
                    .unwrap_or_else(|| "this license is no longer valid".into()),
            ));
        }
        verify_product(PRODUCT_ID, &resp.meta)?;
        Ok(facts_from(
            instance_id.to_string(),
            resp.license_key,
            resp.meta,
        ))
    }

    async fn deactivate(&self, license_key: &str, instance_id: &str) -> Result<(), LicenseError> {
        let resp: DeactivateResponse = self
            .post_form(
                "deactivate",
                &[("license_key", license_key), ("instance_id", instance_id)],
            )
            .await?;
        if !resp.deactivated {
            return Err(LicenseError::Rejected(resp.error.unwrap_or_else(|| {
                "Lemon Squeezy could not release this device".into()
            })));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn meta_with_product(id: serde_json::Value) -> Option<MetaBlock> {
        Some(MetaBlock {
            product_id: Some(id),
            product_name: Some("Cairn Pro".into()),
            customer_email: Some("dev@example.com".into()),
        })
    }

    #[test]
    fn product_id_str_handles_string_number_and_other() {
        assert_eq!(
            product_id_str(&serde_json::json!("42")).as_deref(),
            Some("42")
        );
        assert_eq!(
            product_id_str(&serde_json::json!(42)).as_deref(),
            Some("42")
        );
        assert_eq!(product_id_str(&serde_json::json!(null)), None);
    }

    #[test]
    fn verify_product_pins_only_when_configured() {
        // No pin → any product passes.
        assert!(verify_product(None, &meta_with_product(serde_json::json!("7"))).is_ok());
        assert!(verify_product(None, &None).is_ok());
        // Pin → exact match passes (number or string), mismatch/absent fails.
        assert!(verify_product(Some("7"), &meta_with_product(serde_json::json!(7))).is_ok());
        assert!(verify_product(Some("7"), &meta_with_product(serde_json::json!("7"))).is_ok());
        assert!(matches!(
            verify_product(Some("7"), &meta_with_product(serde_json::json!("9"))),
            Err(LicenseError::Rejected(_))
        ));
        assert!(matches!(
            verify_product(Some("7"), &None),
            Err(LicenseError::Rejected(_))
        ));
    }

    #[test]
    fn facts_from_maps_present_and_absent_fields() {
        let full = facts_from(
            "inst".into(),
            Some(KeyBlock {
                status: Some("active".into()),
                expires_at: Some("2027-01-01".into()),
            }),
            meta_with_product(serde_json::json!("7")),
        );
        assert_eq!(full.status, "active");
        assert_eq!(full.expires_at.as_deref(), Some("2027-01-01"));
        assert_eq!(full.product_name.as_deref(), Some("Cairn Pro"));

        // Missing status/key/meta degrade gracefully.
        let bare = facts_from("inst".into(), None, None);
        assert_eq!(bare.status, "unknown");
        assert!(bare.expires_at.is_none() && bare.product_name.is_none());
    }

    #[test]
    fn display_renders_both_error_variants() {
        assert_eq!(LicenseError::Rejected("no".into()).to_string(), "no");
        assert_eq!(LicenseError::Unreachable("off".into()).to_string(), "off");
    }

    async fn api_for(server: &mockito::ServerGuard) -> LemonSqueezyApi {
        LemonSqueezyApi::with_base(server.url()).unwrap()
    }

    #[tokio::test]
    async fn activate_parses_a_successful_response() {
        let mut server = mockito::Server::new_async().await;
        let m = server
            .mock("POST", "/activate")
            .with_status(200)
            .with_body(
                r#"{"activated":true,"error":null,
                    "license_key":{"status":"active","expires_at":null},
                    "instance":{"id":"inst-77"},
                    "meta":{"product_id":7,"product_name":"Cairn Pro","customer_email":"buyer@example.com"}}"#,
            )
            .create_async()
            .await;
        let facts = api_for(&server).await.activate("KEY").await.unwrap();
        m.assert_async().await;
        assert_eq!(facts.instance_id, "inst-77");
        assert_eq!(facts.status, "active");
        assert_eq!(facts.customer_email.as_deref(), Some("buyer@example.com"));
    }

    #[tokio::test]
    async fn activate_rejects_when_lemon_squeezy_says_not_activated() {
        let mut server = mockito::Server::new_async().await;
        server
            .mock("POST", "/activate")
            .with_status(400)
            .with_body(
                r#"{"activated":false,"error":"license_key has reached its activation limit"}"#,
            )
            .create_async()
            .await;
        let err = api_for(&server).await.activate("KEY").await.unwrap_err();
        assert!(matches!(err, LicenseError::Rejected(ref m) if m.contains("activation limit")));
    }

    #[tokio::test]
    async fn activate_treats_a_missing_instance_as_unreachable() {
        let mut server = mockito::Server::new_async().await;
        server
            .mock("POST", "/activate")
            .with_body(r#"{"activated":true,"license_key":{"status":"active"}}"#)
            .create_async()
            .await;
        let err = api_for(&server).await.activate("KEY").await.unwrap_err();
        assert!(matches!(err, LicenseError::Unreachable(_)));
    }

    #[tokio::test]
    async fn validate_maps_valid_and_invalid() {
        let mut server = mockito::Server::new_async().await;
        server
            .mock("POST", "/validate")
            .with_body(r#"{"valid":true,"license_key":{"status":"active"},"meta":{"product_name":"Cairn Pro"}}"#)
            .create_async()
            .await;
        let facts = api_for(&server)
            .await
            .validate("KEY", "inst-1")
            .await
            .unwrap();
        assert_eq!(facts.status, "active");
        assert_eq!(facts.instance_id, "inst-1");

        let mut server2 = mockito::Server::new_async().await;
        server2
            .mock("POST", "/validate")
            .with_body(r#"{"valid":false,"error":"license_key not found"}"#)
            .create_async()
            .await;
        let err = api_for(&server2)
            .await
            .validate("KEY", "inst-1")
            .await
            .unwrap_err();
        assert!(matches!(err, LicenseError::Rejected(ref m) if m.contains("not found")));
    }

    #[tokio::test]
    async fn deactivate_maps_success_and_failure() {
        let mut server = mockito::Server::new_async().await;
        server
            .mock("POST", "/deactivate")
            .with_body(r#"{"deactivated":true}"#)
            .create_async()
            .await;
        assert!(api_for(&server)
            .await
            .deactivate("KEY", "inst-1")
            .await
            .is_ok());

        let mut server2 = mockito::Server::new_async().await;
        server2
            .mock("POST", "/deactivate")
            .with_body(r#"{"deactivated":false,"error":"instance not found"}"#)
            .create_async()
            .await;
        let err = api_for(&server2)
            .await
            .deactivate("KEY", "inst-1")
            .await
            .unwrap_err();
        assert!(matches!(err, LicenseError::Rejected(_)));
    }

    #[tokio::test]
    async fn a_5xx_is_unreachable_not_a_verdict() {
        let mut server = mockito::Server::new_async().await;
        server
            .mock("POST", "/validate")
            .with_status(503)
            .with_body("upstream down")
            .create_async()
            .await;
        let err = api_for(&server)
            .await
            .validate("KEY", "inst")
            .await
            .unwrap_err();
        assert!(matches!(err, LicenseError::Unreachable(ref m) if m.contains("unavailable")));
    }

    #[tokio::test]
    async fn a_malformed_body_is_unreachable() {
        let mut server = mockito::Server::new_async().await;
        server
            .mock("POST", "/activate")
            .with_body("not json")
            .create_async()
            .await;
        let err = api_for(&server).await.activate("KEY").await.unwrap_err();
        assert!(matches!(err, LicenseError::Unreachable(_)));
    }

    #[tokio::test]
    async fn a_connection_failure_is_unreachable() {
        // Point at a closed port: reqwest send() fails before any response.
        let api = LemonSqueezyApi::with_base("http://127.0.0.1:1".into()).unwrap();
        let err = api.activate("KEY").await.unwrap_err();
        assert!(matches!(err, LicenseError::Unreachable(_)));
    }

    #[test]
    fn new_builds_the_production_https_client() {
        // Exercises the public constructor + the https_only(true) branch
        // that the with_base(http://…) test paths never hit.
        assert!(LemonSqueezyApi::new().is_ok());
    }

    #[tokio::test]
    async fn a_truncated_body_is_unreachable() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        // Promise 1000 bytes, send 5, drop — reqwest errors mid-body-read.
        // mockito normalises Content-Length, so drive a raw socket.
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut sock, _) = listener.accept().await.unwrap();
            let mut buf = [0u8; 1024];
            let _ = sock.read(&mut buf).await;
            let _ = sock
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 1000\r\n\r\nshort")
                .await;
        });
        let api = LemonSqueezyApi::with_base(format!("http://{addr}")).unwrap();
        let err = api.validate("KEY", "inst").await.unwrap_err();
        assert!(matches!(err, LicenseError::Unreachable(_)));
        let _ = server.await;
    }
}
