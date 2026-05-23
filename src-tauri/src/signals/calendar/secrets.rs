//! OS keychain access for calendar URL secrets.
//!
//! We treat ICS subscription URLs as bearer credentials — anyone with
//! the URL can read the calendar — so we never put them in SQLite. They
//! live in the OS keychain (macOS Keychain / Windows Credential Manager
//! / Secret Service on Linux), keyed by the calendar source `id`.

const SERVICE: &str = "cairn-calendar";

#[derive(Debug, thiserror::Error)]
pub enum SecretError {
    #[error("keychain: {0}")]
    Keychain(#[from] keyring::Error),
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
