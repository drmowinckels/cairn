//! The reqwest-backed [`HttpFetcher`] — the real network egress for the
//! declarative interpreter. Mirrors the security posture of the calendar
//! fetcher (`plugins/calendar/fetcher.rs`): `https_only`, a host-pinned
//! redirect policy (a redirect to a different host is refused, never
//! followed), connect/read timeouts, and URL-free error classification —
//! the latter matters here because a `query`-auth connector carries its
//! token in the URL, and reqwest's error `Display` would otherwise append
//! the full URL (token and all) to any error string.
//!
//! A response-size cap bounds the accumulated body against a hostile or
//! runaway server, on top of the read timeout. It is checked incrementally
//! per chunk, so a single transport-frame-sized chunk can briefly overshoot
//! before the bail — the accumulator never grows unbounded across chunks.

use std::time::Duration;

use anyhow::{anyhow, bail, Result};
use async_trait::async_trait;
use reqwest::redirect::Policy;

use super::super::manifest::HttpMethod;
use super::{HttpFetcher, HttpResponse, PreparedRequest};

/// Total same-host redirects followed before giving up.
const MAX_REDIRECTS: usize = 5;
/// Hard cap on a response body, independent of the read timeout.
const MAX_RESPONSE_BYTES: usize = 8 * 1024 * 1024;

/// What the redirect policy should do for a single redirect hop.
#[derive(Debug, PartialEq, Eq)]
enum RedirectDecision {
    Follow,
    StopCrossHost,
    StopTooMany,
}

/// Pure decision for one redirect hop. A missing host on either side, or
/// a host change, is refused; same-host is followed up to the cap. Hosts
/// compared case-insensitively. (Same logic as the calendar fetcher; kept
/// local so the two egress paths stay independently auditable.)
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

#[derive(Debug)]
struct CrossHostRedirect;
impl std::fmt::Display for CrossHostRedirect {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("cross-host redirect refused")
    }
}
impl std::error::Error for CrossHostRedirect {}

#[derive(Debug)]
struct TooManyRedirects;
impl std::fmt::Display for TooManyRedirects {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("too many redirects")
    }
}
impl std::error::Error for TooManyRedirects {}

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

/// A short, **URL-free** reason for a reqwest error. Critical: a reqwest
/// error's `Display` appends ` for url ({url})`, and for a `query`-auth
/// connector that URL carries the token — so callers must classify, not
/// format-debug, the error. We keep this deliberately coarse (a refused
/// redirect vs everything else) because the security property is
/// URL-freeness, not fine categorization. Tests guard the no-leak.
fn classify(e: &reqwest::Error) -> &'static str {
    if e.is_redirect() {
        "redirect refused"
    } else {
        "request failed"
    }
}

/// The production [`HttpFetcher`]: a configured reqwest client + a
/// response-size cap.
pub struct ReqwestFetcher {
    client: reqwest::Client,
    max_bytes: usize,
}

impl ReqwestFetcher {
    /// Build the production fetcher. The reqwest client build only fails on
    /// a catastrophic TLS-backend init — infallible in any working runtime
    /// (the "infallible in practice" call other crates `unwrap`), so a
    /// failure is a fatal environment fault, not a per-connector one.
    pub fn new() -> Self {
        Self {
            client: build_client(true).expect("connector http client builds"),
            max_bytes: MAX_RESPONSE_BYTES,
        }
    }

    /// Test-only constructor permitting plaintext HTTP (mockito serves
    /// HTTP only) and a custom byte cap so the size-limit path is cheap
    /// to exercise. Never used outside tests.
    #[cfg(test)]
    fn new_for_test(max_bytes: usize) -> Self {
        Self {
            client: build_client(false).expect("test http client builds"),
            max_bytes,
        }
    }

    async fn read_capped(&self, mut resp: reqwest::Response) -> Result<String> {
        let mut bytes: Vec<u8> = Vec::new();
        loop {
            match resp.chunk().await {
                Ok(Some(chunk)) => {
                    if bytes.len() + chunk.len() > self.max_bytes {
                        bail!("connector response exceeded {} bytes", self.max_bytes);
                    }
                    bytes.extend_from_slice(&chunk);
                }
                Ok(None) => break,
                Err(e) => bail!("connector response: {}", classify(&e)),
            }
        }
        String::from_utf8(bytes).map_err(|_| anyhow!("connector response was not valid UTF-8"))
    }
}

fn build_client(https_only: bool) -> Result<reqwest::Client> {
    use anyhow::Context;
    reqwest::Client::builder()
        .user_agent(concat!("cairn/", env!("CARGO_PKG_VERSION")))
        .redirect(host_pinned_redirect_policy())
        .https_only(https_only)
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(30))
        .build()
        .context("build connector http client")
}

fn has_content_type(headers: &std::collections::BTreeMap<String, String>) -> bool {
    headers
        .keys()
        .any(|k| k.eq_ignore_ascii_case("content-type"))
}

#[async_trait]
impl HttpFetcher for ReqwestFetcher {
    async fn fetch(&self, request: &PreparedRequest) -> Result<HttpResponse> {
        let method = match request.method {
            HttpMethod::Get => reqwest::Method::GET,
            HttpMethod::Post => reqwest::Method::POST,
        };
        let mut builder = self.client.request(method, &request.url);
        for (name, value) in &request.headers {
            builder = builder.header(name, value);
        }
        if let Some(body) = &request.body {
            if !has_content_type(&request.headers) {
                builder = builder.header("Content-Type", "application/json");
            }
            builder = builder.body(body.clone());
        }

        let resp = match builder.send().await {
            Ok(r) => r,
            Err(e) => bail!("connector request: {}", classify(&e)),
        };
        let status = resp.status().as_u16();
        let body = self.read_capped(resp).await?;
        Ok(HttpResponse { status, body })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redirect_same_host_under_cap_follows() {
        assert_eq!(
            redirect_decision(Some("api.example.com"), Some("api.example.com"), 0),
            RedirectDecision::Follow
        );
        assert_eq!(
            redirect_decision(Some("Api.Example.COM"), Some("api.example.com"), 0),
            RedirectDecision::Follow
        );
    }

    #[test]
    fn redirect_cross_host_and_missing_host_stop() {
        assert_eq!(
            redirect_decision(Some("api.example.com"), Some("evil.test"), 0),
            RedirectDecision::StopCrossHost
        );
        assert_eq!(
            redirect_decision(None, Some("api.example.com"), 0),
            RedirectDecision::StopCrossHost
        );
        assert_eq!(
            redirect_decision(Some("a"), None, 0),
            RedirectDecision::StopCrossHost
        );
    }

    #[test]
    fn redirect_over_cap_stops() {
        assert_eq!(
            redirect_decision(Some("a"), Some("a"), MAX_REDIRECTS),
            RedirectDecision::StopTooMany
        );
    }

    #[test]
    fn marker_errors_are_url_free() {
        assert_eq!(CrossHostRedirect.to_string(), "cross-host redirect refused");
        assert_eq!(TooManyRedirects.to_string(), "too many redirects");
    }

    #[test]
    fn has_content_type_is_case_insensitive() {
        let mut h = std::collections::BTreeMap::new();
        assert!(!has_content_type(&h));
        h.insert("content-TYPE".to_string(), "x".to_string());
        assert!(has_content_type(&h));
    }

    fn get(url: &str) -> PreparedRequest {
        PreparedRequest {
            method: HttpMethod::Get,
            url: url.to_string(),
            headers: std::collections::BTreeMap::new(),
            body: None,
        }
    }

    #[tokio::test]
    async fn fetch_returns_status_and_body() {
        let mut server = mockito::Server::new_async().await;
        let m = server
            .mock("GET", "/projects")
            .with_status(200)
            .with_body(r#"[{"id":"1"}]"#)
            .create_async()
            .await;
        let fetcher = ReqwestFetcher::new_for_test(1024);
        let resp = fetcher
            .fetch(&get(&format!("{}/projects", server.url())))
            .await
            .unwrap();
        assert_eq!(resp.status, 200);
        assert_eq!(resp.body, r#"[{"id":"1"}]"#);
        m.assert_async().await;
    }

    #[tokio::test]
    async fn fetch_passes_through_a_non_2xx_status() {
        let mut server = mockito::Server::new_async().await;
        server
            .mock("GET", "/x")
            .with_status(404)
            .with_body("nope")
            .create_async()
            .await;
        let fetcher = ReqwestFetcher::new_for_test(1024);
        let resp = fetcher
            .fetch(&get(&format!("{}/x", server.url())))
            .await
            .unwrap();
        assert_eq!(resp.status, 404);
    }

    #[tokio::test]
    async fn fetch_sends_a_post_body_with_default_content_type() {
        let mut server = mockito::Server::new_async().await;
        let m = server
            .mock("POST", "/graphql")
            .match_header("content-type", "application/json")
            .match_body("{\"q\":1}")
            .with_status(200)
            .with_body("{}")
            .create_async()
            .await;
        let fetcher = ReqwestFetcher::new_for_test(1024);
        let req = PreparedRequest {
            method: HttpMethod::Post,
            url: format!("{}/graphql", server.url()),
            headers: std::collections::BTreeMap::new(),
            body: Some("{\"q\":1}".to_string()),
        };
        let resp = fetcher.fetch(&req).await.unwrap();
        assert_eq!(resp.status, 200);
        m.assert_async().await;
    }

    #[tokio::test]
    async fn fetch_caps_an_oversized_response() {
        let mut server = mockito::Server::new_async().await;
        server
            .mock("GET", "/big")
            .with_status(200)
            .with_body("x".repeat(100))
            .create_async()
            .await;
        let fetcher = ReqwestFetcher::new_for_test(10);
        let err = fetcher
            .fetch(&get(&format!("{}/big", server.url())))
            .await
            .unwrap_err();
        assert!(err.to_string().contains("exceeded"));
    }

    #[tokio::test]
    async fn fetch_refuses_a_cross_host_redirect_without_leaking_the_url() {
        let mut server = mockito::Server::new_async().await;
        let port = server
            .host_with_port()
            .rsplit(':')
            .next()
            .unwrap()
            .to_string();
        const SECRET: &str = "QUERY-TOKEN-DO-NOT-LEAK";
        // 127.0.0.1 (mockito) → localhost is a host_str change → refused.
        let cross = format!("http://localhost:{port}/{SECRET}");
        server
            .mock("GET", "/start")
            .with_status(302)
            .with_header("Location", &cross)
            .create_async()
            .await;
        let fetcher = ReqwestFetcher::new_for_test(1024);
        let err = fetcher
            .fetch(&get(&format!("{}/start", server.url())))
            .await
            .unwrap_err();
        let chain = format!("{err:#}");
        assert!(chain.contains("redirect refused") || chain.contains("redirect"));
        assert!(!chain.contains(SECRET), "leaked the redirect URL: {chain}");
        assert!(!chain.contains("localhost"), "leaked the host: {chain}");
    }

    #[tokio::test]
    async fn fetch_surfaces_a_body_read_error_url_free() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        // A raw server that promises 1000 bytes but sends 5 then drops the
        // connection — reqwest errors mid-body. mockito can't do this (it
        // normalizes Content-Length to the body). The error must be URL-free.
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut sock, _) = listener.accept().await.unwrap();
            let mut buf = [0u8; 1024];
            let _ = sock.read(&mut buf).await;
            let _ = sock
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 1000\r\n\r\nshort")
                .await;
            // Drop the socket → connection closed before the body completes.
        });
        let fetcher = ReqwestFetcher::new_for_test(1_000_000);
        const SECRET: &str = "BODY-READ-SECRET";
        let err = fetcher
            .fetch(&get(&format!("http://{addr}/x?token={SECRET}")))
            .await
            .unwrap_err();
        let chain = format!("{err:#}");
        assert!(chain.contains("connector response"), "{chain}");
        assert!(!chain.contains(SECRET), "leaked the query token: {chain}");
        let _ = server.await;
    }

    #[tokio::test]
    async fn fetch_follows_a_same_host_redirect() {
        let mut server = mockito::Server::new_async().await;
        server
            .mock("GET", "/start")
            .with_status(302)
            .with_header("Location", "/final")
            .create_async()
            .await;
        let target = server
            .mock("GET", "/final")
            .with_status(200)
            .with_body("{}")
            .create_async()
            .await;
        let fetcher = ReqwestFetcher::new_for_test(1024);
        let resp = fetcher
            .fetch(&get(&format!("{}/start", server.url())))
            .await
            .unwrap();
        assert_eq!(resp.status, 200);
        assert_eq!(resp.body, "{}");
        target.assert_async().await;
    }

    #[tokio::test]
    async fn fetch_refuses_when_the_redirect_cap_is_exceeded() {
        let mut server = mockito::Server::new_async().await;
        for i in 0..(MAX_REDIRECTS + 1) {
            let next = format!("/hop{}", i + 1);
            server
                .mock("GET", format!("/hop{i}").as_str())
                .with_status(302)
                .with_header("Location", &next)
                .create_async()
                .await;
        }
        let fetcher = ReqwestFetcher::new_for_test(1024);
        let err = fetcher
            .fetch(&get(&format!("{}/hop0", server.url())))
            .await
            .unwrap_err();
        assert!(err.to_string().contains("redirect"));
    }

    #[tokio::test]
    async fn fetch_rejects_a_non_utf8_body() {
        let mut server = mockito::Server::new_async().await;
        server
            .mock("GET", "/x")
            .with_status(200)
            .with_body(vec![0xff, 0xfe, 0xfd])
            .create_async()
            .await;
        let fetcher = ReqwestFetcher::new_for_test(1024);
        let err = fetcher
            .fetch(&get(&format!("{}/x", server.url())))
            .await
            .unwrap_err();
        assert!(err.to_string().contains("UTF-8"));
    }

    #[tokio::test]
    async fn fetch_error_never_contains_a_query_token() {
        // A connection failure to TEST-NET-1; the token in the query must
        // not surface (production https_only path).
        let fetcher = ReqwestFetcher::new();
        const SECRET: &str = "URL-QUERY-SECRET-9c3a";
        let url = format!("https://192.0.2.1/tasks?token={SECRET}");
        let err = fetcher.fetch(&get(&url)).await.unwrap_err();
        let chain = format!("{err:#}");
        assert!(
            !chain.contains(SECRET),
            "error leaked the query token: {chain}"
        );
        assert!(
            !chain.contains("192.0.2.1"),
            "error leaked the host: {chain}"
        );
    }

    #[tokio::test]
    async fn production_fetcher_refuses_a_plaintext_target() {
        let fetcher = ReqwestFetcher::new();
        const SECRET: &str = "PLAINTEXT-TOKEN";
        let err = fetcher
            .fetch(&get(&format!("http://127.0.0.1/x?token={SECRET}")))
            .await
            .unwrap_err();
        let chain = format!("{err:#}");
        assert!(!chain.contains(SECRET));
        assert!(chain.contains("connector request:"));
    }
}
