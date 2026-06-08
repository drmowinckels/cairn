//! OS-keychain [`SecretStore`] for connector tokens. A connector's auth
//! token is keyed by the manifest's `secret` name (e.g. `"todoist_token"`)
//! and lives in the OS keychain, never in SQLite or a manifest — same
//! boundary as the calendar plugin's URL secrets.

use super::{SecretStore, SecretWriter};

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

/// Map a keychain write/delete outcome to a token-free message. The full
/// error is logged, but the message handed upward names only the failed
/// operation — never the token or the key — so a secret can't ride out on
/// an error string the UI then renders.
fn classify_write(op: &'static str, result: Result<(), keyring::Error>) -> Result<(), String> {
    result.map_err(|e| {
        log::warn!("connector keychain {op} failed: {e}");
        format!("could not {op} the connector token in the keychain")
    })
}

/// Reads + writes connector tokens in the OS keychain.
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

impl SecretWriter for KeychainStore {
    fn set(&self, key: &str, token: &str) -> Result<(), String> {
        classify_write(
            "save",
            keyring::Entry::new(SERVICE, key).and_then(|entry| entry.set_password(token)),
        )
    }

    fn clear(&self, key: &str) -> Result<(), String> {
        match keyring::Entry::new(SERVICE, key).and_then(|entry| entry.delete_credential()) {
            // Clearing an already-absent token is the desired end state.
            Err(keyring::Error::NoEntry) => Ok(()),
            other => classify_write("clear", other),
        }
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

    #[test]
    fn classify_write_passes_success_and_scrubs_failures() {
        assert_eq!(classify_write("save", Ok(())), Ok(()));
        let err = classify_write(
            "save",
            Err(keyring::Error::PlatformFailure(Box::new(
                std::io::Error::other("boom"),
            ))),
        )
        .unwrap_err();
        assert_eq!(err, "could not save the connector token in the keychain");
        assert!(
            !err.contains("boom"),
            "the underlying error text must not leak into the message"
        );
    }

    // Roundtrip through the real keychain. Gated to Linux, where the
    // `linux-native` backend is the kernel keyutils keyring (works
    // headless in CI); macOS/Windows keychains aren't reliably available
    // in a headless runner. Coverage is collected on Linux, so this
    // exercises the keychain read + write paths there.
    #[cfg(target_os = "linux")]
    #[test]
    fn token_roundtrips_through_the_keychain() {
        let key = "cairn-test-connector-token-roundtrip";
        let store = KeychainStore::new();

        store.set(key, "s3cret").unwrap();
        assert_eq!(store.token(key).as_deref(), Some("s3cret"));

        store.clear(key).unwrap();
        assert_eq!(store.token(key), None, "cleared entry reads as None");

        // Clearing an already-absent token is idempotent, not an error.
        store.clear(key).unwrap();
    }
}
