//! HTTP fetcher for ICS subscription URLs.
//!
//! Sends only:
//!
//! ```text
//! GET <user-supplied URL>
//! If-None-Match: <stored ETag, if any>
//! If-Modified-Since: <stored Last-Modified, if any>
//! User-Agent: cairn/0.x
//! ```
//!
//! Never sends cookies, never follows redirects across hosts, never
//! retries with backoff (the polling loop already retries on the next
//! tick). The returned 304-or-payload + cache headers are persisted by
//! the registry.

use std::time::Duration;

use anyhow::{Context, Result};
use reqwest::header::{
    HeaderMap, HeaderValue, ETAG, IF_MODIFIED_SINCE, IF_NONE_MATCH, LAST_MODIFIED, USER_AGENT,
};
use reqwest::redirect::Policy;
use reqwest::StatusCode;

/// Categorize a reqwest error into a short, URL-free reason string.
/// This is critical: `reqwest::Error`'s `Display` impl appends
/// `" for url ({url})"` whenever the error carries a URL, and *every*
/// error from `send()` does (see reqwest's `if_no_url`). If we ever
/// leak the raw error into `record_sync_err` we leak the full
/// subscription URL — including its bearer-token path segment — into
/// SQLite, defeating the keychain-only design. Tests guard this.
fn classify(e: &reqwest::Error) -> &'static str {
    if e.is_timeout() {
        "timeout"
    } else if e.is_connect() {
        "connect failed"
    } else if e.is_redirect() {
        "too many redirects"
    } else if e.is_decode() {
        "decode failed"
    } else if e.is_body() {
        "body read failed"
    } else if e.is_status() {
        "non-success status"
    } else if e.is_request() {
        "request failed"
    } else {
        "network error"
    }
}

#[derive(Debug, Clone)]
pub struct FetchOk {
    pub body: String,
    pub etag: Option<String>,
    pub last_modified: Option<String>,
}

#[derive(Debug, Clone)]
pub enum FetchOutcome {
    /// Server returned new content.
    Changed(FetchOk),
    /// Server returned 304 Not Modified.
    Unchanged,
}

pub struct Fetcher {
    client: reqwest::Client,
}

impl Fetcher {
    pub fn new() -> Result<Self> {
        let client = reqwest::Client::builder()
            .user_agent(concat!("cairn/", env!("CARGO_PKG_VERSION")))
            .redirect(Policy::limited(5))
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(30))
            .build()
            .context("build reqwest client")?;
        Ok(Self { client })
    }

    /// Replace a `webcal://` scheme with `https://` — iCloud and others
    /// publish webcal URLs that are otherwise the same as HTTPS.
    pub fn normalize_url(raw: &str) -> String {
        if let Some(rest) = raw.strip_prefix("webcal://") {
            format!("https://{rest}")
        } else if let Some(rest) = raw.strip_prefix("webcals://") {
            format!("https://{rest}")
        } else {
            raw.to_string()
        }
    }

    pub async fn fetch(
        &self,
        url: &str,
        etag: Option<&str>,
        last_modified: Option<&str>,
    ) -> Result<FetchOutcome> {
        let url = Self::normalize_url(url);
        let mut headers = HeaderMap::new();
        headers.insert(USER_AGENT, HeaderValue::from_static("cairn"));
        if let Some(e) = etag {
            if let Ok(v) = HeaderValue::from_str(e) {
                headers.insert(IF_NONE_MATCH, v);
            }
        }
        if let Some(lm) = last_modified {
            if let Ok(v) = HeaderValue::from_str(lm) {
                headers.insert(IF_MODIFIED_SINCE, v);
            }
        }

        let resp = match self.client.get(&url).headers(headers).send().await {
            Ok(r) => r,
            Err(e) => anyhow::bail!("calendar fetch: {}", classify(&e)),
        };

        if resp.status() == StatusCode::NOT_MODIFIED {
            return Ok(FetchOutcome::Unchanged);
        }
        if !resp.status().is_success() {
            anyhow::bail!("calendar fetch returned HTTP {}", resp.status());
        }

        let new_etag = resp
            .headers()
            .get(ETAG)
            .and_then(|v| v.to_str().ok())
            .map(|s| s.to_string());
        let new_last_modified = resp
            .headers()
            .get(LAST_MODIFIED)
            .and_then(|v| v.to_str().ok())
            .map(|s| s.to_string());

        let body = match resp.text().await {
            Ok(b) => b,
            Err(e) => anyhow::bail!("calendar fetch: {}", classify(&e)),
        };
        Ok(FetchOutcome::Changed(FetchOk {
            body,
            etag: new_etag,
            last_modified: new_last_modified,
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_webcal() {
        assert_eq!(
            Fetcher::normalize_url("webcal://p10-caldav.icloud.com/published/2/AbcXyz"),
            "https://p10-caldav.icloud.com/published/2/AbcXyz"
        );
        assert_eq!(
            Fetcher::normalize_url("webcals://example.com/x.ics"),
            "https://example.com/x.ics"
        );
        assert_eq!(
            Fetcher::normalize_url("https://example.com/x.ics"),
            "https://example.com/x.ics"
        );
    }

    /// Regression test for the secret-URL-leak finding from the
    /// 2026-05-23 security review. A reqwest error always carries the
    /// request URL (via `if_no_url`), and `Display` for it appends
    /// ` for url ({url})`. Calling sites must classify the error
    /// rather than format-debug it — otherwise the secret bearer
    /// token in the URL path lands in `calendar_sources.last_error`.
    #[tokio::test]
    async fn fetch_error_never_contains_url_secret() {
        let fetcher = Fetcher::new().expect("build fetcher");
        // Reserved TEST-NET-1 address from RFC 5737, guaranteed to
        // fail to connect quickly. The token segment is what we never
        // want to see surface in any user-visible string.
        const SECRET: &str = "SUPER-SECRET-DO-NOT-LEAK-9c3a";
        let url = format!("https://192.0.2.1/calendar/ical/{SECRET}/basic.ics");

        let err = fetcher
            .fetch(&url, None, None)
            .await
            .expect_err("connection to TEST-NET-1 must fail");

        let chain = format!("{err:#}");
        assert!(
            !chain.contains(SECRET),
            "error chain leaked URL secret: {chain}",
        );
        assert!(
            !chain.contains("192.0.2.1"),
            "error chain leaked target host: {chain}",
        );
    }
}
