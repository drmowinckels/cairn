//! OS-keychain [`SecretStore`] for connector tokens. A connector's auth
//! token is keyed by the manifest's `secret` name (e.g. `"todoist_token"`)
//! and lives in the OS keychain, never in SQLite or a manifest — same
//! boundary as the calendar plugin's URL secrets.

use super::SecretStore;

const SERVICE: &str = "cairn-connector";

/// Map a keychain lookup to a token: a hit yields it, an absent entry is
/// `None`, and any other keychain failure is logged (URL-free) and
/// treated as absent so the connector reports "needs a token" rather than
/// crashing.
fn classify_lookup(result: Result<String, keyring::Error>) -> Option<String> {
    match result {
        Ok(token) => Some(token),
        Err(keyring::Error::NoEntry) => None,
        Err(e) => {
            log::warn!("connector keychain lookup failed: {e}");
            None
        }
    }
}

/// Reads connector tokens from the OS keychain.
pub struct KeychainStore;

impl KeychainStore {
    pub fn new() -> Self {
        Self
    }
}

impl SecretStore for KeychainStore {
    fn token(&self, key: &str) -> Option<String> {
        classify_lookup(keyring::Entry::new(SERVICE, key).and_then(|entry| entry.get_password()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classify_maps_each_lookup_outcome() {
        assert_eq!(
            classify_lookup(Ok("tok".to_string())),
            Some("tok".to_string())
        );
        assert_eq!(classify_lookup(Err(keyring::Error::NoEntry)), None);
        assert_eq!(
            classify_lookup(Err(keyring::Error::PlatformFailure(Box::new(
                std::io::Error::other("boom")
            )))),
            None
        );
    }

    // Roundtrip through the real keychain. Gated to Linux, where the
    // `linux-native` backend is the kernel keyutils keyring (works
    // headless in CI); macOS/Windows keychains aren't reliably available
    // in a headless runner. Coverage is collected on Linux, so this
    // exercises the `token()` keychain path there.
    #[cfg(target_os = "linux")]
    #[test]
    fn token_roundtrips_through_the_keychain() {
        let key = "cairn-test-connector-token-roundtrip";
        let entry = keyring::Entry::new(SERVICE, key).unwrap();
        entry.set_password("s3cret").unwrap();

        let store = KeychainStore::new();
        assert_eq!(store.token(key).as_deref(), Some("s3cret"));

        entry.delete_credential().unwrap();
        assert_eq!(store.token(key), None, "absent entry reads as None");
    }
}
