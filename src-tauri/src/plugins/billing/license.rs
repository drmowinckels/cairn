//! Offline Pro-license verification (#109). No network, ever: the app
//! ships a baked-in Ed25519 public key and verifies a pasted license
//! against it locally. Keys are sold outside the app (Lemon Squeezy);
//! an order webhook drives a stateless signing worker that holds the
//! private key — the app only ever sees the public half.
//!
//! # License format
//!
//! `base64url(payload_json) + "." + base64url(signature)` where the
//! signature is Ed25519 over the *raw payload JSON bytes* (the exact
//! bytes that were base64url-encoded, not the re-serialized struct).
//! The payload is `{"email": …, "orderId": …, "product": …}`.
//!
//! # Key provisioning
//!
//! The verifying key is baked in at compile time from the
//! `CAIRN_LICENSE_PUBKEY` env var (base64 of the 32-byte Ed25519 public
//! key). Wiring it into the release workflow as a secret is part of the
//! storefront go-live (#109) — it is NOT set anywhere yet, so today
//! every build (dev and release) is keyless: every license is rejected
//! with a clear "this build has no license key" message, and the UI can
//! tell the difference via `has_key`.

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use serde::{Deserialize, Serialize};

/// Compile-time baked-in public key (base64, 32 bytes). `None` in
/// builds where the release secret wasn't set.
const BAKED_IN_PUBKEY_B64: Option<&str> = option_env!("CAIRN_LICENSE_PUBKEY");

/// The audience a license must be issued for. Signing-worker payloads
/// carry the same literal.
pub const PRODUCT: &str = "cairn-pro";

/// What a valid license attests to. Serialized back to the UI so the
/// billing card can show "Licensed to <email>".
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LicenseInfo {
    pub email: String,
    pub order_id: String,
    pub product: String,
}

pub struct LicenseVerifier {
    key: Option<VerifyingKey>,
}

impl LicenseVerifier {
    /// Verifier for the baked-in production key. Keyless when the build
    /// didn't set `CAIRN_LICENSE_PUBKEY` or the value doesn't decode to
    /// a valid Ed25519 point (logged — a release build with a corrupt
    /// key should be loud, not silently unlicensable).
    pub fn from_build() -> &'static Self {
        static VERIFIER: std::sync::OnceLock<LicenseVerifier> = std::sync::OnceLock::new();
        // Cached: the key decode (and the loud corrupt-key log) happens
        // once per process, not once per billing IPC call.
        VERIFIER.get_or_init(|| Self::with_key(baked_key(BAKED_IN_PUBKEY_B64)))
    }

    /// Verifier for a specific key — tests and the keyless case.
    pub fn with_key(key: Option<VerifyingKey>) -> Self {
        Self { key }
    }

    /// Whether this build can validate licenses at all.
    pub fn has_key(&self) -> bool {
        self.key.is_some()
    }

    /// Check a pasted license string. Returns the attested identity on
    /// success; every failure mode gets a distinct, user-showable
    /// message. Never logs the license itself.
    pub fn verify(&self, license: &str) -> Result<LicenseInfo, String> {
        let key = self
            .key
            .as_ref()
            .ok_or("this build has no license key configured")?;
        let license = license.trim();
        let (payload_b64, sig_b64) = license
            .split_once('.')
            .ok_or("not a license key (expected two dot-separated parts)")?;
        let payload = URL_SAFE_NO_PAD
            .decode(payload_b64)
            .map_err(|_| "license payload is not valid base64")?;
        let sig_bytes = URL_SAFE_NO_PAD
            .decode(sig_b64)
            .map_err(|_| "license signature is not valid base64")?;
        let sig_bytes: [u8; 64] = sig_bytes
            .try_into()
            .map_err(|_| "license signature has the wrong length")?;
        let signature = Signature::from_bytes(&sig_bytes);
        key.verify(&payload, &signature)
            .map_err(|_| "license signature does not match — check for a copy-paste error")?;
        let info: LicenseInfo = serde_json::from_slice(&payload)
            .map_err(|_| "license payload is malformed".to_string())?;
        // Audience check: if the signing key ever signs tokens for another
        // product, those tokens must not unlock Cairn Pro.
        if info.product != PRODUCT {
            return Err(format!(
                "license is for a different product ({})",
                info.product
            ));
        }
        Ok(info)
    }
}

/// Resolve the compile-time key value into a usable verifying key.
/// `None` in / `None` out for keyless builds; a present-but-corrupt
/// value logs loudly (a release build with a broken key must not be
/// silently unlicensable) and yields `None`.
fn baked_key(raw: Option<&str>) -> Option<VerifyingKey> {
    raw.and_then(|b64| match decode_key(b64) {
        Ok(k) => Some(k),
        Err(e) => {
            log::error!("baked-in license public key is invalid: {e}");
            None
        }
    })
}

fn decode_key(b64: &str) -> Result<VerifyingKey, String> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(b64.trim())
        .map_err(|e| format!("not base64: {e}"))?;
    let bytes: [u8; 32] = bytes.try_into().map_err(|_| "not 32 bytes".to_string())?;
    VerifyingKey::from_bytes(&bytes).map_err(|e| format!("not a valid Ed25519 key: {e}"))
}

#[cfg(test)]
pub(crate) mod test_keys {
    use ed25519_dalek::{Signer, SigningKey};

    use super::*;

    /// Deterministic fixture keypair — test-only, never a real secret.
    pub fn fixture_signing_key() -> SigningKey {
        SigningKey::from_bytes(&[7u8; 32])
    }

    pub fn fixture_verifier() -> LicenseVerifier {
        LicenseVerifier::with_key(Some(fixture_signing_key().verifying_key()))
    }

    /// Produce a license string the fixture verifier accepts — the same
    /// format the production signing worker emits.
    pub fn sign_license(email: &str, order_id: &str, product: &str) -> String {
        let payload = serde_json::to_vec(&LicenseInfo {
            email: email.into(),
            order_id: order_id.into(),
            product: product.into(),
        })
        .unwrap();
        let sig = fixture_signing_key().sign(&payload);
        format!(
            "{}.{}",
            URL_SAFE_NO_PAD.encode(&payload),
            URL_SAFE_NO_PAD.encode(sig.to_bytes())
        )
    }
}

#[cfg(test)]
mod tests {
    use super::test_keys::*;
    use super::*;

    #[test]
    fn accepts_a_correctly_signed_license() {
        let license = sign_license("dev@example.com", "ord_1", "cairn-pro");
        let info = fixture_verifier().verify(&license).unwrap();
        assert_eq!(
            info,
            LicenseInfo {
                email: "dev@example.com".into(),
                order_id: "ord_1".into(),
                product: "cairn-pro".into(),
            }
        );
    }

    #[test]
    fn accepts_surrounding_whitespace_from_a_paste() {
        let license = format!("  {}\n", sign_license("dev@example.com", "o", "cairn-pro"));
        assert!(fixture_verifier().verify(&license).is_ok());
    }

    #[test]
    fn rejects_everything_without_a_key() {
        let v = LicenseVerifier::with_key(None);
        assert!(!v.has_key());
        let license = sign_license("dev@example.com", "o", "p");
        let err = v.verify(&license).unwrap_err();
        assert!(err.contains("no license key"), "{err}");
    }

    #[test]
    fn rejects_a_tampered_payload() {
        let license = sign_license("dev@example.com", "o", "p");
        let (_, sig) = license.split_once('.').unwrap();
        let forged_payload =
            URL_SAFE_NO_PAD.encode(br#"{"email":"evil@example.com","orderId":"o","product":"p"}"#);
        let err = fixture_verifier()
            .verify(&format!("{forged_payload}.{sig}"))
            .unwrap_err();
        assert!(err.contains("does not match"), "{err}");
    }

    #[test]
    fn rejects_malformed_inputs_with_distinct_messages() {
        let v = fixture_verifier();
        assert!(v.verify("no-dot-here").unwrap_err().contains("two dot"));
        assert!(v
            .verify("!!!.AAAA")
            .unwrap_err()
            .contains("payload is not valid base64"));
        assert!(v
            .verify("AAAA.!!!")
            .unwrap_err()
            .contains("signature is not valid base64"));
        assert!(v.verify("AAAA.AAAA").unwrap_err().contains("wrong length"));
    }

    #[test]
    fn rejects_a_validly_signed_license_for_another_product() {
        let license = sign_license("dev@example.com", "o", "other-app");
        let err = fixture_verifier().verify(&license).unwrap_err();
        assert!(err.contains("different product"), "{err}");
        assert!(err.contains("other-app"), "names the audience: {err}");
    }

    #[test]
    fn rejects_a_valid_signature_over_garbage_json() {
        use ed25519_dalek::Signer;
        let payload = b"not json at all";
        let sig = fixture_signing_key().sign(payload);
        let license = format!(
            "{}.{}",
            URL_SAFE_NO_PAD.encode(payload),
            URL_SAFE_NO_PAD.encode(sig.to_bytes())
        );
        let err = fixture_verifier().verify(&license).unwrap_err();
        assert!(err.contains("malformed"), "{err}");
    }

    #[test]
    fn decode_key_rejects_bad_inputs_and_accepts_the_fixture_key() {
        assert!(decode_key("!!!").unwrap_err().contains("not base64"));
        assert!(decode_key("AAAA").unwrap_err().contains("not 32 bytes"));
        let good = base64::engine::general_purpose::STANDARD
            .encode(fixture_signing_key().verifying_key().to_bytes());
        assert!(decode_key(&good).is_ok());
    }

    #[test]
    fn from_build_is_keyless_in_dev_builds() {
        // CAIRN_LICENSE_PUBKEY is not set for dev/test builds, so the
        // production constructor yields a keyless verifier.
        assert!(!LicenseVerifier::from_build().has_key());
    }

    #[test]
    fn baked_key_covers_absent_corrupt_and_valid_values() {
        assert!(baked_key(None).is_none());
        assert!(
            baked_key(Some("not base64 at all")).is_none(),
            "a corrupt baked-in key degrades to keyless"
        );
        let good = base64::engine::general_purpose::STANDARD
            .encode(fixture_signing_key().verifying_key().to_bytes());
        assert!(baked_key(Some(&good)).is_some());
    }
}
