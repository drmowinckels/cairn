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
//! Never sends cookies, never follows redirects across hosts (same-host
//! redirects are followed up to a small cap; see
//! [`host_pinned_redirect_policy`]), never retries with backoff (the
//! polling loop already retries on the next tick). The returned
//! 304-or-payload + cache headers are persisted by the registry.

use std::time::Duration;

use anyhow::{Context, Result};
use reqwest::header::{
    HeaderMap, HeaderValue, ETAG, IF_MODIFIED_SINCE, IF_NONE_MATCH, LAST_MODIFIED, USER_AGENT,
};
use reqwest::redirect::Policy;
use reqwest::StatusCode;

/// Total redirects we will follow before giving up, matching the
/// historical `Policy::limited(5)` cap.
const MAX_REDIRECTS: usize = 5;

/// What the redirect policy should do for a single redirect hop.
#[derive(Debug, PartialEq, Eq)]
enum RedirectDecision {
    /// Same host, still under the cap — follow it.
    Follow,
    /// Destination host differs from the previous hop — refuse.
    StopCrossHost,
    /// Same host but the cap is exhausted — refuse.
    StopTooMany,
}

/// Pure decision for a single redirect hop.
///
/// `prev_host` is the host we are being redirected *from*, `next_host`
/// the host we are being redirected *to*, and `already_followed` the
/// number of redirects already followed on this request. Hosts are
/// compared case-insensitively; a missing host on either side counts
/// as a host change and is refused.
fn redirect_decision(
    prev_host: Option<&str>,
    next_host: Option<&str>,
    already_followed: usize,
) -> RedirectDecision {
    let same_host = match (prev_host, next_host) {
        (Some(a), Some(b)) => a.eq_ignore_ascii_case(b),
        _ => false,
    };
    if !same_host {
        RedirectDecision::StopCrossHost
    } else if already_followed >= MAX_REDIRECTS {
        RedirectDecision::StopTooMany
    } else {
        RedirectDecision::Follow
    }
}

/// URL-free marker error for a refused cross-host redirect.
#[derive(Debug)]
struct CrossHostRedirect;

impl std::fmt::Display for CrossHostRedirect {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("cross-host redirect refused")
    }
}

impl std::error::Error for CrossHostRedirect {}

/// URL-free marker error for exceeding the redirect cap.
#[derive(Debug)]
struct TooManyRedirects;

impl std::fmt::Display for TooManyRedirects {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("too many redirects")
    }
}

impl std::error::Error for TooManyRedirects {}

/// Redirect policy that follows redirects only while the host is
/// unchanged, capping the total at [`MAX_REDIRECTS`]. A cross-host
/// redirect is refused via `attempt.error(..)`, which surfaces through
/// [`classify`] as a redirect error and never carries the URL into a
/// user-visible string.
fn host_pinned_redirect_policy() -> Policy {
    Policy::custom(|attempt| {
        let prev_host = attempt.previous().last().and_then(|u| u.host_str());
        let next_host = attempt.url().host_str();
        let already_followed = attempt.previous().len().saturating_sub(1);
        match redirect_decision(prev_host, next_host, already_followed) {
            RedirectDecision::Follow => attempt.follow(),
            RedirectDecision::StopCrossHost => attempt.error(CrossHostRedirect),
            RedirectDecision::StopTooMany => attempt.error(TooManyRedirects),
        }
    })
}

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
        Ok(Self {
            client: Self::build_client(true)?,
        })
    }

    /// Build the underlying client. `https_only` is always `true` in
    /// production (`new`). reqwest enforces it *after* the custom
    /// redirect policy returns `Follow`, so a same-host HTTPS→HTTP
    /// downgrade hop is refused as a redirect error — closing the
    /// cleartext-credential leak in #155, where the bearer token lives
    /// in the URL path (not an `Authorization` header reqwest would
    /// strip). A plaintext `http://` target is likewise refused before
    /// any request is sent.
    fn build_client(https_only: bool) -> Result<reqwest::Client> {
        reqwest::Client::builder()
            .user_agent(concat!("cairn/", env!("CARGO_PKG_VERSION")))
            .redirect(host_pinned_redirect_policy())
            .https_only(https_only)
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(30))
            .build()
            .context("build reqwest client")
    }

    /// Test-only constructor that permits plaintext HTTP. The
    /// redirect-closure integration tests (#151) drive a real redirect
    /// through `http://127.0.0.1:<port>` because `mockito` serves HTTP
    /// only; with `https_only` on, production would reject those URLs
    /// before any redirect and erase that coverage. Never used outside
    /// tests — production always goes through `new`.
    #[cfg(test)]
    fn new_allowing_http() -> Result<Self> {
        Ok(Self {
            client: Self::build_client(false)?,
        })
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
    fn redirect_same_host_under_cap_follows() {
        assert_eq!(
            redirect_decision(Some("example.com"), Some("example.com"), 0),
            RedirectDecision::Follow
        );
        assert_eq!(
            redirect_decision(Some("example.com"), Some("example.com"), MAX_REDIRECTS - 1),
            RedirectDecision::Follow
        );
    }

    #[test]
    fn redirect_same_host_is_case_insensitive() {
        assert_eq!(
            redirect_decision(Some("Example.COM"), Some("example.com"), 0),
            RedirectDecision::Follow
        );
    }

    #[test]
    fn redirect_cross_host_stops() {
        assert_eq!(
            redirect_decision(Some("example.com"), Some("evil.test"), 0),
            RedirectDecision::StopCrossHost
        );
    }

    #[test]
    fn redirect_missing_host_stops_cross_host() {
        assert_eq!(
            redirect_decision(None, Some("example.com"), 0),
            RedirectDecision::StopCrossHost
        );
        assert_eq!(
            redirect_decision(Some("example.com"), None, 0),
            RedirectDecision::StopCrossHost
        );
        assert_eq!(
            redirect_decision(None, None, 0),
            RedirectDecision::StopCrossHost
        );
    }

    #[test]
    fn redirect_same_host_over_cap_stops() {
        assert_eq!(
            redirect_decision(Some("example.com"), Some("example.com"), MAX_REDIRECTS),
            RedirectDecision::StopTooMany
        );
        assert_eq!(
            redirect_decision(Some("example.com"), Some("example.com"), MAX_REDIRECTS + 1),
            RedirectDecision::StopTooMany
        );
    }

    #[test]
    fn marker_errors_are_url_free() {
        assert_eq!(CrossHostRedirect.to_string(), "cross-host redirect refused");
        assert_eq!(TooManyRedirects.to_string(), "too many redirects");
    }

    /// 127.0.0.1 and localhost resolve to the same address but are
    /// distinct as `Url::host_str` — the literal the cross-host
    /// integration test relies on to provoke `StopCrossHost` without a
    /// second listening socket.
    #[test]
    fn loopback_literal_and_localhost_differ_as_host_str() {
        let a = reqwest::Url::parse("http://127.0.0.1:8080/x").expect("parse loopback url");
        let b = reqwest::Url::parse("http://localhost:8080/x").expect("parse localhost url");
        assert_eq!(a.host_str(), Some("127.0.0.1"));
        assert_eq!(b.host_str(), Some("localhost"));
        assert_ne!(a.host_str(), b.host_str());
    }

    const ICS_BODY: &str = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR\r\n";

    #[tokio::test]
    async fn fetch_follows_same_host_redirect_within_cap() {
        let mut server = mockito::Server::new_async().await;
        let redirect = server
            .mock("GET", "/start.ics")
            .with_status(302)
            .with_header("Location", "/final.ics")
            .create_async()
            .await;
        let target = server
            .mock("GET", "/final.ics")
            .with_status(200)
            .with_body(ICS_BODY)
            .create_async()
            .await;

        let fetcher = Fetcher::new_allowing_http().expect("build http-allowing fetcher");
        let url = format!("{}/start.ics", server.url());
        let outcome = fetcher
            .fetch(&url, None, None)
            .await
            .expect("same-host redirect within cap must succeed");

        assert!(
            matches!(&outcome, FetchOutcome::Changed(ok) if ok.body == ICS_BODY),
            "same-host redirect to a 200 must yield the final body, got {outcome:?}",
        );
        redirect.assert_async().await;
        target.assert_async().await;
    }

    #[tokio::test]
    async fn fetch_refuses_cross_host_redirect() {
        let mut server = mockito::Server::new_async().await;
        // mockito binds to 127.0.0.1; redirecting to localhost on the
        // same port keeps the request routable yet trips the host_str
        // mismatch, so the closure's `StopCrossHost` arm fires without
        // needing a second listener.
        let port = server
            .host_with_port()
            .rsplit(':')
            .next()
            .expect("server host_with_port has a port")
            .to_string();
        const SECRET: &str = "CROSS-HOST-TOKEN-DO-NOT-LEAK";
        let cross_host = format!("http://localhost:{port}/{SECRET}/evil.ics");
        let start = server
            .mock("GET", "/start.ics")
            .with_status(302)
            .with_header("Location", &cross_host)
            .create_async()
            .await;

        let fetcher = Fetcher::new_allowing_http().expect("build http-allowing fetcher");
        let url = format!("{}/start.ics", server.url());
        let err = fetcher
            .fetch(&url, None, None)
            .await
            .expect_err("cross-host redirect must be refused");

        let chain = format!("{err:#}");
        assert!(
            chain.contains("too many redirects"),
            "cross-host refusal must classify as a redirect error: {chain}",
        );
        assert!(
            !chain.contains(SECRET),
            "redirect error leaked the destination secret: {chain}",
        );
        assert!(
            !chain.contains("localhost"),
            "redirect error leaked the destination host: {chain}",
        );
        start.assert_async().await;
    }

    #[tokio::test]
    async fn fetch_refuses_when_redirect_cap_exceeded() {
        let mut server = mockito::Server::new_async().await;
        // A chain of MAX_REDIRECTS + 1 same-host hops: each points to
        // the next, so the closure follows up to the cap and then trips
        // the `StopTooMany` arm.
        let hops = MAX_REDIRECTS + 1;
        let mut mocks = Vec::new();
        for i in 0..hops {
            let next = format!("/hop{}.ics", i + 1);
            mocks.push(
                server
                    .mock("GET", format!("/hop{i}.ics").as_str())
                    .with_status(302)
                    .with_header("Location", &next)
                    .create_async()
                    .await,
            );
        }

        let fetcher = Fetcher::new_allowing_http().expect("build http-allowing fetcher");
        let url = format!("{}/hop0.ics", server.url());
        let err = fetcher
            .fetch(&url, None, None)
            .await
            .expect_err("exceeding the redirect cap must error");

        let chain = format!("{err:#}");
        assert!(
            chain.contains("too many redirects"),
            "over-cap refusal must classify as a redirect error: {chain}",
        );
    }

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

    /// #155: the production constructor pins `https_only(true)`, so a
    /// plaintext `http://` target — e.g. a same-host HTTPS→HTTP
    /// downgrade carrying the bearer token in its path — is refused
    /// before any request leaves the machine, and the refusal is
    /// URL-free (it flows through `classify`, never `Display` on the
    /// reqwest error). The test constructor would *follow* this; `new`
    /// must not.
    #[tokio::test]
    async fn production_fetcher_refuses_http_downgrade_target() {
        let fetcher = Fetcher::new().expect("build fetcher");
        const SECRET: &str = "DOWNGRADE-TOKEN-DO-NOT-LEAK";
        let url = format!("http://127.0.0.1/calendar/{SECRET}/basic.ics");

        let err = fetcher
            .fetch(&url, None, None)
            .await
            .expect_err("https_only must refuse a plaintext http target");

        let chain = format!("{err:#}");
        assert!(
            !chain.contains(SECRET),
            "downgrade refusal leaked URL secret: {chain}",
        );
        assert!(
            chain.contains("calendar fetch:"),
            "downgrade refusal must surface as a classified fetch error: {chain}",
        );
    }

    /// End-to-end ICS path (#40): a fake HTTP server serves a real calendar
    /// payload, the fetcher pulls it, and the parser turns it into a
    /// concrete, currently-active event — the same flow a calendar signal
    /// source runs on every refresh, with no OS calendar API involved. This
    /// is the cross-platform integration test the parity issue calls for.
    #[tokio::test]
    async fn fetch_then_parse_yields_active_event() {
        use crate::plugins::calendar::parser;
        use chrono::{TimeZone, Utc};

        let ics = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Cairn//test//EN\r\n\
                   BEGIN:VEVENT\r\nUID:evt-1@cairn.test\r\nSUMMARY:Standup\r\n\
                   DTSTART:20260615T100000Z\r\nDTEND:20260615T110000Z\r\n\
                   END:VEVENT\r\nEND:VCALENDAR\r\n";

        let mut server = mockito::Server::new_async().await;
        let mock = server
            .mock("GET", "/cal.ics")
            .with_status(200)
            .with_header("content-type", "text/calendar")
            .with_body(ics)
            .create_async()
            .await;

        let fetcher = Fetcher::new_allowing_http().expect("build http-allowing fetcher");
        let url = format!("{}/cal.ics", server.url());
        let outcome = fetcher
            .fetch(&url, None, None)
            .await
            .expect("fetch must succeed");
        mock.assert_async().await;

        // A 200 with a body is always `Changed`. Use `if let` (no
        // never-taken match arm) and an `Option` so every line here runs.
        let now = Utc.with_ymd_and_hms(2026, 6, 15, 10, 30, 0).unwrap();
        let mut parsed = None;
        if let FetchOutcome::Changed(ok) = outcome {
            parsed = Some(parser::parse(&ok.body, now).expect("ics must parse"));
        }
        let events = parsed.expect("a 200 body must be FetchOutcome::Changed");
        assert_eq!(events.len(), 1, "exactly one event expected");
        assert_eq!(events[0].summary, "Standup");
        assert!(
            parser::is_active(&events[0], now),
            "the event must be active at 10:30 UTC"
        );
    }
}
