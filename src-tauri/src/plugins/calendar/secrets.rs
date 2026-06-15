//! OS keychain access for calendar URL secrets.
//!
//! We treat ICS subscription URLs as bearer credentials — anyone with
//! the URL can read the calendar — so we never put them in SQLite. They
//! live in the OS keychain (macOS Keychain / Windows Credential Manager
//! / Secret Service on Linux), keyed by the calendar source `id`.
//!
//! When the OS keychain is unavailable — most commonly a headless Linux
//! box with no running Secret Service daemon — we fall back to an
//! encrypted file in the app data dir ([`EncryptedFileStore`]). This is a
//! **documented downgrade**: the file is XChaCha20-Poly1305-encrypted
//! with a key derived from a machine identifier, so it is not portable
//! and not readable by another machine, but a local attacker who can read
//! your files *and* run code as you could recover the URLs. The OS
//! keychain remains the default whenever it is available. See
//! `docs/PRIVACY.md`.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use chacha20poly1305::aead::Aead;
use chacha20poly1305::{KeyInit, XChaCha20Poly1305, XNonce};

const SERVICE: &str = "cairn-calendar";

/// File name for the encrypted-file fallback, under the app data dir.
const FALLBACK_FILE: &str = "calendar-secrets.enc";

/// Domain-separation context for the machine-key derivation. Bumping the
/// suffix would invalidate every existing fallback file (forcing re-entry
/// of the URLs), so treat it as a format version.
const KEY_CONTEXT: &str = "cairn-calendar-secrets fallback key v1";

#[derive(Debug, thiserror::Error)]
pub enum SecretError {
    #[error("keychain: {0}")]
    Keychain(#[from] keyring::Error),
    #[error("encrypted secrets file: {0}")]
    Io(#[from] std::io::Error),
    #[error("could not (de)serialise the encrypted secrets file: {0}")]
    Serde(#[from] serde_json::Error),
    /// Decryption failed: the file is truncated, tampered with, or was
    /// written under a different machine key. The error intentionally
    /// carries no plaintext.
    #[error("encrypted secrets file is corrupt or was written on a different machine")]
    Decrypt,
    #[error("could not determine a machine identifier for the fallback key: {0}")]
    MachineId(String),
}

#[derive(Debug, thiserror::Error)]
pub enum RedactError {
    /// The raw URL is rejected — its content is intentionally **not**
    /// included in the error message so the secret can't escape via an
    /// error log or an error string written to SQLite.
    #[error("could not parse URL")]
    Unparseable,
    #[error("URL has no host")]
    NoHost,
}

/// The keychain operations the registry needs, behind a trait so an
/// in-memory fake can stand in for the OS keychain in tests — and so the
/// registry can cache reads without coupling to `keyring` directly.
pub trait Secrets: Send + Sync {
    fn load(&self, id: &str) -> Result<Option<String>, SecretError>;
    fn store(&self, id: &str, secret: &str) -> Result<(), SecretError>;
    fn remove(&self, id: &str) -> Result<(), SecretError>;
}

/// Production [`Secrets`] backed by the OS keychain.
pub struct Keychain;

impl Secrets for Keychain {
    fn load(&self, id: &str) -> Result<Option<String>, SecretError> {
        load(id)
    }
    fn store(&self, id: &str, secret: &str) -> Result<(), SecretError> {
        store(id, secret)
    }
    fn remove(&self, id: &str) -> Result<(), SecretError> {
        remove(id)
    }
}

/// Choose the secret backend for this launch: the OS keychain when it is
/// reachable, otherwise the encrypted-file fallback in `data_dir`. The
/// decision is made once at startup because keychain availability does
/// not change within a session, and mixing backends mid-session would
/// strand secrets written to the other one.
pub fn open(data_dir: &Path) -> Arc<dyn Secrets> {
    select_backend(
        keychain_available(),
        derive_machine_key(),
        data_dir.join(FALLBACK_FILE),
    )
}

/// Pure backend selection, split from [`open`] so every arm is
/// unit-testable without depending on the host's keychain or machine id.
fn select_backend(
    keychain_ok: bool,
    fallback_key: Result<[u8; 32], SecretError>,
    fallback_path: PathBuf,
) -> Arc<dyn Secrets> {
    if keychain_ok {
        return Arc::new(Keychain);
    }
    match fallback_key {
        Ok(key) => {
            log::warn!(
                "calendar: OS keychain unavailable; calendar URL secrets will be kept in an \
                 encrypted file in the data dir. This is a documented downgrade (see \
                 docs/PRIVACY.md): the key is derived from this machine's id, so the file is \
                 not portable, but a local attacker who can read your files and run code as you \
                 could recover the URLs."
            );
            Arc::new(EncryptedFileStore::with_key(fallback_path, key))
        }
        Err(e) => {
            log::error!(
                "calendar: OS keychain unavailable and the encrypted-file fallback could not \
                 initialise ({e}); calendar URL secrets will not persist this session"
            );
            Arc::new(Keychain)
        }
    }
}

/// Probe whether the OS keychain backend is usable. A missing entry means
/// the backend works but is empty (available); a platform/storage error
/// means it is not reachable (e.g. no Secret Service daemon).
fn keychain_available() -> bool {
    keyring::Entry::new(SERVICE, "__cairn_availability_probe__")
        .map(|entry| classify_probe(entry.get_password()))
        .unwrap_or(false)
}

/// Classify a keychain probe read: a platform or storage-access error
/// means the backend is unreachable; anything else — a returned value or
/// a plain missing entry — means it works.
fn classify_probe(probe: Result<String, keyring::Error>) -> bool {
    !matches!(
        probe,
        Err(keyring::Error::PlatformFailure(_)) | Err(keyring::Error::NoStorageAccess(_))
    )
}

/// Encrypted-file fallback for the OS keychain. Stores the whole id→URL
/// map as a single XChaCha20-Poly1305 blob (`24-byte nonce || ciphertext`)
/// rewritten atomically on every mutation. The data set is tiny (a handful
/// of calendar URLs), so a full rewrite per change is fine.
pub struct EncryptedFileStore {
    path: PathBuf,
    cipher: XChaCha20Poly1305,
    /// Serialises the read-modify-write in `store`/`remove` so two
    /// concurrent mutations can't lose an update or race the rename.
    write_lock: std::sync::Mutex<()>,
}

impl EncryptedFileStore {
    /// Build a store with an explicit 32-byte key. [`open`] derives the key
    /// from the machine id; tests pass a fixed key for determinism.
    pub fn with_key(path: PathBuf, key: [u8; 32]) -> Self {
        Self {
            cipher: XChaCha20Poly1305::new((&key).into()),
            path,
            write_lock: std::sync::Mutex::new(()),
        }
    }

    fn read_map(&self) -> Result<HashMap<String, String>, SecretError> {
        let blob = match std::fs::read(&self.path) {
            Ok(b) => b,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(HashMap::new()),
            Err(e) => return Err(SecretError::Io(e)),
        };
        if blob.len() < 24 {
            return Err(SecretError::Decrypt);
        }
        let (nonce, ciphertext) = blob.split_at(24);
        let plaintext = self
            .cipher
            .decrypt(XNonce::from_slice(nonce), ciphertext)
            .map_err(|_| SecretError::Decrypt)?;
        // A decrypted-but-unparseable payload only arises from tampering or
        // a key mismatch; treat it as corruption rather than surfacing a
        // serde error, whose Display could echo decrypted secret bytes.
        serde_json::from_slice(&plaintext).map_err(|_| SecretError::Decrypt)
    }

    fn write_map(&self, map: &HashMap<String, String>) -> Result<(), SecretError> {
        let plaintext = serde_json::to_vec(map)?;
        let mut nonce = [0u8; 24];
        getrandom::getrandom(&mut nonce)
            .map_err(|e| SecretError::Io(std::io::Error::other(format!("getrandom: {e}"))))?;
        let ciphertext = self
            .cipher
            .encrypt(XNonce::from_slice(&nonce), plaintext.as_slice())
            .map_err(|_| SecretError::Decrypt)?;
        let mut blob = Vec::with_capacity(24 + ciphertext.len());
        blob.extend_from_slice(&nonce);
        blob.extend_from_slice(&ciphertext);
        write_private_atomic(&self.path, &blob)
    }
}

impl Secrets for EncryptedFileStore {
    fn load(&self, id: &str) -> Result<Option<String>, SecretError> {
        Ok(self.read_map()?.get(id).cloned())
    }

    fn store(&self, id: &str, secret: &str) -> Result<(), SecretError> {
        let _guard = self
            .write_lock
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let mut map = self.read_map()?;
        map.insert(id.to_string(), secret.to_string());
        self.write_map(&map)
    }

    fn remove(&self, id: &str) -> Result<(), SecretError> {
        let _guard = self
            .write_lock
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let mut map = self.read_map()?;
        if map.remove(id).is_some() {
            self.write_map(&map)?;
        }
        Ok(())
    }
}

/// Derive a 32-byte key from a stable machine identifier. The id itself
/// is low-entropy and predictable, so this is obfuscation tied to the
/// host, not a secret — see the module downgrade note.
fn derive_machine_key() -> Result<[u8; 32], SecretError> {
    let id = machine_uid::get().map_err(|e| SecretError::MachineId(e.to_string()))?;
    Ok(blake3::derive_key(KEY_CONTEXT, id.as_bytes()))
}

/// Write `bytes` to `path` atomically (temp file + rename). The temp file
/// is created owner-only from the outset on Unix — so the encrypted blob is
/// never briefly world-readable under the process umask — and its name is
/// unique per process+call so concurrent writers can't clobber each other's
/// temp or race the rename. A crash mid-write leaves only a stale `.tmp`.
fn write_private_atomic(path: &Path, bytes: &[u8]) -> Result<(), SecretError> {
    static COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let seq = COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let tmp = path.with_extension(format!("enc.{}.{seq}.tmp", std::process::id()));
    write_owner_only(&tmp, bytes)?;
    std::fs::rename(&tmp, path)?;
    Ok(())
}

/// Create `path` (truncating) and write `bytes`, with `0600` permissions
/// applied at creation time on Unix.
fn write_owner_only(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        use std::io::Write;
        use std::os::unix::fs::OpenOptionsExt;
        let mut f = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(path)?;
        f.write_all(bytes)
    }
    #[cfg(not(unix))]
    {
        std::fs::write(path, bytes)
    }
}

pub fn store(id: &str, secret: &str) -> Result<(), SecretError> {
    let entry = keyring::Entry::new(SERVICE, id)?;
    entry.set_password(secret)?;
    Ok(())
}

pub fn load(id: &str) -> Result<Option<String>, SecretError> {
    let entry = keyring::Entry::new(SERVICE, id)?;
    match entry.get_password() {
        Ok(v) => Ok(Some(v)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(SecretError::Keychain(e)),
    }
}

pub fn remove(id: &str) -> Result<(), SecretError> {
    let entry = keyring::Entry::new(SERVICE, id)?;
    match entry.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(SecretError::Keychain(e)),
    }
}

/// Display-safe representation of a calendar subscription URL: keeps
/// the scheme + host so the user can recognise which provider they
/// registered, drops the path and query entirely because any segment
/// of an ICS URL may contain the bearer token.
///
/// Returns `Err` for URLs that don't parse or don't have a host —
/// callers must surface that error and refuse to register the source.
/// We never fall back to returning the raw input, because the caller
/// writes the result into SQLite as `calendar_sources.location` and
/// the raw input may contain the secret bearer token. Defeating the
/// keychain↔SQLite boundary here would invalidate the privacy
/// contract in `docs/PRIVACY.md`.
pub fn redact_url(url: &str) -> Result<String, RedactError> {
    let parsed = url::Url::parse(url).map_err(|_| RedactError::Unparseable)?;
    let host = parsed.host_str().ok_or(RedactError::NoHost)?;
    Ok(format!("{}://{}/…", parsed.scheme(), host))
}

#[cfg(test)]
mod tests {
    use super::*;

    // Roundtrip the `Keychain` impl through the real keychain. Gated to
    // Linux. Since #40 the Linux backend is the D-Bus Secret Service, which
    // has no daemon on a headless CI runner — so skip when the backend is
    // unreachable rather than fail. The encrypted-file fallback that such
    // hosts actually use is covered exhaustively below.
    #[cfg(target_os = "linux")]
    #[test]
    fn keychain_roundtrips_store_load_remove() {
        if !keychain_available() {
            eprintln!("secret service unavailable; skipping real-keychain roundtrip");
            return;
        }
        let kc = Keychain;
        let id = "cairn-test-calendar-secret-roundtrip";

        kc.store(id, "https://example.com/secret/cal.ics").unwrap();
        assert_eq!(
            kc.load(id).unwrap().as_deref(),
            Some("https://example.com/secret/cal.ics")
        );

        kc.remove(id).unwrap();
        assert!(
            kc.load(id).unwrap().is_none(),
            "removed secret reads as None"
        );

        // Removing an already-absent secret is idempotent, not an error.
        kc.remove(id).unwrap();
    }

    fn fixed_key() -> [u8; 32] {
        [7u8; 32]
    }

    fn store_in(dir: &Path) -> EncryptedFileStore {
        EncryptedFileStore::with_key(dir.join(FALLBACK_FILE), fixed_key())
    }

    #[test]
    fn encrypted_file_roundtrips_store_load_remove() {
        let dir = tempfile::tempdir().unwrap();
        let s = store_in(dir.path());

        assert!(s.load("a").unwrap().is_none(), "absent id reads as None");

        s.store("a", "https://example.com/a.ics").unwrap();
        s.store("b", "https://example.com/b.ics").unwrap();
        assert_eq!(
            s.load("a").unwrap().as_deref(),
            Some("https://example.com/a.ics")
        );
        assert_eq!(
            s.load("b").unwrap().as_deref(),
            Some("https://example.com/b.ics")
        );

        s.remove("a").unwrap();
        assert!(s.load("a").unwrap().is_none());
        assert_eq!(
            s.load("b").unwrap().as_deref(),
            Some("https://example.com/b.ics"),
            "removing one id leaves the others intact"
        );

        // Removing an absent id is idempotent (no write, no error).
        s.remove("a").unwrap();
    }

    #[test]
    fn encrypted_file_persists_across_instances() {
        let dir = tempfile::tempdir().unwrap();
        store_in(dir.path())
            .store("x", "https://example.com/x.ics")
            .unwrap();
        // A fresh store over the same file + key (as a relaunch would build)
        // reads the secret back.
        let reopened = store_in(dir.path());
        assert_eq!(
            reopened.load("x").unwrap().as_deref(),
            Some("https://example.com/x.ics")
        );
    }

    #[test]
    fn encrypted_file_concurrent_stores_do_not_lose_updates() {
        use std::sync::Arc;
        let dir = tempfile::tempdir().unwrap();
        let store = Arc::new(store_in(dir.path()));
        let handles: Vec<_> = (0..8)
            .map(|i| {
                let s = Arc::clone(&store);
                std::thread::spawn(move || {
                    s.store(&format!("id-{i}"), &format!("https://example.com/{i}.ics"))
                        .unwrap();
                })
            })
            .collect();
        for h in handles {
            h.join().unwrap();
        }
        for i in 0..8 {
            assert_eq!(
                store.load(&format!("id-{i}")).unwrap().as_deref(),
                Some(format!("https://example.com/{i}.ics").as_str()),
                "every concurrent write must survive (no lost update)"
            );
        }
    }

    #[test]
    fn encrypted_file_wrong_key_cannot_decrypt() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(FALLBACK_FILE);
        EncryptedFileStore::with_key(path.clone(), [1u8; 32])
            .store("x", "https://example.com/x.ics")
            .unwrap();
        let other = EncryptedFileStore::with_key(path, [2u8; 32]);
        assert!(matches!(other.load("x"), Err(SecretError::Decrypt)));
    }

    #[test]
    fn encrypted_file_detects_tampering() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(FALLBACK_FILE);
        store_in(dir.path())
            .store("x", "https://example.com/x.ics")
            .unwrap();
        let mut bytes = std::fs::read(&path).unwrap();
        let last = bytes.len() - 1;
        bytes[last] ^= 0xff;
        std::fs::write(&path, &bytes).unwrap();
        assert!(matches!(
            store_in(dir.path()).load("x"),
            Err(SecretError::Decrypt)
        ));
    }

    #[test]
    fn encrypted_file_too_short_is_decrypt_error() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join(FALLBACK_FILE), b"short").unwrap();
        assert!(matches!(
            store_in(dir.path()).load("x"),
            Err(SecretError::Decrypt)
        ));
    }

    #[test]
    fn encrypted_file_read_io_error_surfaces() {
        let dir = tempfile::tempdir().unwrap();
        // A directory where the file should be makes `fs::read` fail with a
        // non-NotFound error, exercising the IO arm of `read_map`.
        std::fs::create_dir(dir.path().join(FALLBACK_FILE)).unwrap();
        assert!(matches!(
            store_in(dir.path()).load("x"),
            Err(SecretError::Io(_))
        ));
    }

    #[test]
    fn encrypted_file_valid_aead_but_bad_json_is_corruption() {
        // Craft a blob that decrypts cleanly (same key the store reads with)
        // but whose plaintext is not JSON — only possible because the test
        // owns the key. It must surface as content-free corruption, never a
        // serde error whose message could echo the decrypted bytes.
        let dir = tempfile::tempdir().unwrap();
        let cipher = XChaCha20Poly1305::new((&fixed_key()).into());
        let nonce = [9u8; 24];
        let ct = cipher
            .encrypt(XNonce::from_slice(&nonce), b"not json".as_slice())
            .unwrap();
        let mut blob = nonce.to_vec();
        blob.extend_from_slice(&ct);
        std::fs::write(dir.path().join(FALLBACK_FILE), &blob).unwrap();
        assert!(matches!(
            store_in(dir.path()).load("x"),
            Err(SecretError::Decrypt)
        ));
    }

    #[test]
    fn encrypted_file_does_not_store_plaintext() {
        let dir = tempfile::tempdir().unwrap();
        const TOKEN: &str = "SECRET-TOKEN-zzz";
        store_in(dir.path())
            .store(
                "x",
                &format!("https://calendar.google.com/ical/{TOKEN}/basic.ics"),
            )
            .unwrap();
        let bytes = std::fs::read(dir.path().join(FALLBACK_FILE)).unwrap();
        let hay = String::from_utf8_lossy(&bytes);
        assert!(!hay.contains(TOKEN), "token must not appear in cleartext");
        assert!(!hay.contains("calendar.google.com"));
    }

    #[cfg(unix)]
    #[test]
    fn encrypted_file_is_owner_only() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        store_in(dir.path())
            .store("x", "https://example.com/x.ics")
            .unwrap();
        let mode = std::fs::metadata(dir.path().join(FALLBACK_FILE))
            .unwrap()
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(mode, 0o600, "fallback file must be owner read/write only");
    }

    #[test]
    fn derive_machine_key_is_stable_and_nonzero() {
        let a = derive_machine_key().expect("a machine id is available in the test env");
        let b = derive_machine_key().unwrap();
        assert_eq!(a, b, "derivation is deterministic for a given machine");
        assert_ne!(a, [0u8; 32]);
    }

    #[test]
    fn select_backend_uses_keychain_when_available() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(FALLBACK_FILE);
        // Available keychain: do not even construct the file store.
        let _backend = select_backend(true, Ok([0u8; 32]), path.clone());
        assert!(
            !path.exists(),
            "keychain branch must not touch the fallback file"
        );
    }

    #[test]
    fn select_backend_falls_back_to_file_when_keychain_unavailable() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(FALLBACK_FILE);
        let backend = select_backend(false, Ok(fixed_key()), path.clone());
        backend.store("x", "https://example.com/x.ics").unwrap();
        assert!(path.exists(), "fallback must write the encrypted file");
        assert_eq!(
            backend.load("x").unwrap().as_deref(),
            Some("https://example.com/x.ics")
        );
    }

    #[test]
    fn select_backend_returns_keychain_when_fallback_key_fails() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(FALLBACK_FILE);
        let _backend = select_backend(
            false,
            Err(SecretError::MachineId("no id".into())),
            path.clone(),
        );
        assert!(!path.exists(), "a failed fallback must not write a file");
    }

    #[test]
    fn classify_probe_distinguishes_available_from_unreachable() {
        assert!(
            classify_probe(Ok("value".into())),
            "a value means available"
        );
        assert!(
            classify_probe(Err(keyring::Error::NoEntry)),
            "a missing entry still means the backend works"
        );
        assert!(
            !classify_probe(Err(keyring::Error::PlatformFailure(Box::new(
                std::io::Error::other("dbus down")
            )))),
            "a platform failure means unreachable"
        );
        assert!(
            !classify_probe(Err(keyring::Error::NoStorageAccess(Box::new(
                std::io::Error::other("locked")
            )))),
            "no storage access means unreachable"
        );
    }

    #[test]
    fn open_selects_a_usable_backend() {
        // Drives the real probe + open() wiring; whichever backend the host
        // offers, construction must not panic. No store/load is issued so
        // the host keychain is never written.
        let dir = tempfile::tempdir().unwrap();
        let _backend = open(dir.path());
    }

    #[test]
    fn redacts_google_calendar_url() {
        let raw = "https://calendar.google.com/calendar/ical/abc123/private-token-xyz/basic.ics";
        let r = redact_url(raw).unwrap();
        assert_eq!(r, "https://calendar.google.com/…");
        assert!(!r.contains("private-token-xyz"));
        assert!(!r.contains("abc123"));
    }

    #[test]
    fn redacts_outlook_published_url() {
        let raw = "https://outlook.live.com/owa/calendar/0000/abc/cid-xyz/calendar.ics";
        let r = redact_url(raw).unwrap();
        assert_eq!(r, "https://outlook.live.com/…");
        assert!(!r.contains("cid-xyz"));
    }

    #[test]
    fn redacts_icloud_webcal_url() {
        let raw = "webcal://p10-caldav.icloud.com/published/2/AbcXyzToken";
        let r = redact_url(raw).unwrap();
        assert_eq!(r, "webcal://p10-caldav.icloud.com/…");
        assert!(!r.contains("AbcXyzToken"));
    }

    #[test]
    fn rejects_invalid_url() {
        assert!(matches!(
            redact_url("not a url"),
            Err(RedactError::Unparseable)
        ));
    }

    /// Regression test for the second-pass security review finding:
    /// previously `redact_url` fell back to returning the raw URL when
    /// `Url::parse` failed, and the result was written to SQLite as
    /// `calendar_sources.location`. For any URL that fails strict
    /// parsing but carries a secret bearer token, the secret would
    /// leak from the keychain into SQLite. Now `redact_url` must
    /// return `Err`, and the error string must not echo the secret.
    #[test]
    fn malformed_secret_bearing_urls_never_round_trip() {
        const SENTINEL: &str = "SUPER-SECRET-DO-NOT-LEAK-9c3a";
        let cases = [
            format!("https://cal.home.lan:99999/dav/{SENTINEL}/calendar.ics"),
            format!("https://[/cal/{SENTINEL}/basic.ics"),
            format!("calendar.google.com/calendar/ical/{SENTINEL}/basic.ics"),
            format!("not a url {SENTINEL}"),
        ];
        for raw in cases {
            let err = redact_url(&raw).expect_err("malformed URL must be rejected");
            let msg = format!("{err}");
            assert!(
                !msg.contains(SENTINEL),
                "error message leaked the URL secret: {msg}",
            );
        }
    }
}
