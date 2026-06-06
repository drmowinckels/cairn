//! Building a concrete [`PreparedRequest`] from an operation template +
//! context + token. Re-checks the resolved host (defense in depth — the
//! manifest was validated on-host, but a templated value could in
//! principle change the path) and applies the declared auth.

use std::collections::BTreeMap;

use anyhow::{anyhow, bail, Result};
use base64::Engine;
use url::Url;

use super::super::manifest::{Auth, Operation};
use super::template::{fill, Context, Escape};
use super::PreparedRequest;

/// Build the request for one operation. `base` is the connector's
/// (validated) base URL; `token` is the resolved keychain secret, if any.
pub(super) fn build(
    base: &Url,
    op: &Operation,
    ctx: &Context,
    auth: &Auth,
    token: Option<&str>,
) -> Result<PreparedRequest> {
    let spec = &op.request;

    let path = fill(&spec.path, ctx, Escape::Url)?;
    let mut url = base
        .join(&path)
        .map_err(|e| anyhow!("connector request path {path:?} is invalid: {e}"))?;
    if url.scheme() != "https" || url.host_str() != base.host_str() {
        bail!("connector request path escaped its host");
    }

    // Guarded: entering `query_pairs_mut` even with nothing to append
    // leaves a bare trailing `?`.
    if !spec.query.is_empty() {
        let mut pairs = url.query_pairs_mut();
        for (key, value_template) in &spec.query {
            // Filled Raw, then the URL serializer percent-encodes the pair.
            let value = fill(value_template, ctx, Escape::Raw)?;
            pairs.append_pair(key, &value);
        }
    }

    let mut headers = BTreeMap::new();
    for (key, value_template) in &spec.headers {
        headers.insert(key.clone(), fill(value_template, ctx, Escape::Raw)?);
    }

    let body = match &spec.body {
        Some(template) => Some(fill(template, ctx, Escape::Json)?),
        None => None,
    };

    apply_auth(auth, token, &mut url, &mut headers)?;

    Ok(PreparedRequest {
        method: spec.method,
        url: url.to_string(),
        headers,
        body,
    })
}

fn apply_auth(
    auth: &Auth,
    token: Option<&str>,
    url: &mut Url,
    headers: &mut BTreeMap<String, String>,
) -> Result<()> {
    match auth {
        Auth::None => {}
        Auth::Bearer { .. } => {
            headers.insert(
                "Authorization".into(),
                format!("Bearer {}", require(token)?),
            );
        }
        Auth::Header { name, .. } => {
            headers.insert(name.clone(), require(token)?.to_string());
        }
        Auth::Query { name, .. } => {
            url.query_pairs_mut().append_pair(name, require(token)?);
        }
        Auth::Basic { username, .. } => {
            let creds = base64::engine::general_purpose::STANDARD
                .encode(format!("{username}:{}", require(token)?));
            headers.insert("Authorization".into(), format!("Basic {creds}"));
        }
    }
    Ok(())
}

fn require(token: Option<&str>) -> Result<&str> {
    token.ok_or_else(|| anyhow!("connector needs a token but none is stored"))
}

#[cfg(test)]
mod tests {
    use super::super::super::manifest::{HttpMethod, RequestSpec, ResponseSpec};
    use super::*;
    use std::collections::BTreeMap;

    fn base() -> Url {
        Url::parse("https://api.example.com/v2").unwrap()
    }

    fn op(request: RequestSpec) -> Operation {
        Operation {
            request,
            response: ResponseSpec {
                items: String::new(),
                map: BTreeMap::new(),
            },
            pagination: None,
        }
    }

    fn req(method: HttpMethod, path: &str) -> RequestSpec {
        RequestSpec {
            method,
            path: path.to_string(),
            query: BTreeMap::new(),
            headers: BTreeMap::new(),
            body: None,
        }
    }

    fn ctx_with_project(id: &str) -> Context {
        let mut c = Context::new();
        c.set("project.id", id.to_string());
        c
    }

    #[test]
    fn builds_url_relative_to_base_and_encodes_the_path_value() {
        let mut request = req(HttpMethod::Get, "/boards/{{project.id}}/cards");
        request.query.insert("fields".into(), "all".into());
        let prepared = build(
            &base(),
            &op(request),
            &ctx_with_project("a/b"),
            &Auth::None,
            None,
        )
        .unwrap();
        assert_eq!(
            prepared.url,
            "https://api.example.com/boards/a%2Fb/cards?fields=all"
        );
        assert_eq!(prepared.method, HttpMethod::Get);
        assert!(prepared.body.is_none());
    }

    #[test]
    fn bearer_auth_sets_authorization_header() {
        let prepared = build(
            &base(),
            &op(req(HttpMethod::Get, "/me")),
            &Context::new(),
            &Auth::Bearer { secret: "k".into() },
            Some("tok"),
        )
        .unwrap();
        assert_eq!(prepared.headers["Authorization"], "Bearer tok");
    }

    #[test]
    fn header_auth_sets_the_named_header() {
        let prepared = build(
            &base(),
            &op(req(HttpMethod::Get, "/me")),
            &Context::new(),
            &Auth::Header {
                name: "X-Api-Key".into(),
                secret: "k".into(),
            },
            Some("tok"),
        )
        .unwrap();
        assert_eq!(prepared.headers["X-Api-Key"], "tok");
    }

    #[test]
    fn query_auth_appends_an_encoded_param() {
        let prepared = build(
            &base(),
            &op(req(HttpMethod::Get, "/boards")),
            &Context::new(),
            &Auth::Query {
                name: "token".into(),
                secret: "k".into(),
            },
            Some("a b"),
        )
        .unwrap();
        assert!(
            prepared.url.ends_with("/boards?token=a+b"),
            "{}",
            prepared.url
        );
    }

    #[test]
    fn basic_auth_base64_encodes_user_and_token() {
        let prepared = build(
            &base(),
            &op(req(HttpMethod::Get, "/me")),
            &Context::new(),
            &Auth::Basic {
                username: "user".into(),
                secret: "k".into(),
            },
            Some("pass"),
        )
        .unwrap();
        // base64("user:pass") == "dXNlcjpwYXNz"
        assert_eq!(prepared.headers["Authorization"], "Basic dXNlcjpwYXNz");
    }

    #[test]
    fn auth_without_a_token_errors() {
        let err = build(
            &base(),
            &op(req(HttpMethod::Get, "/me")),
            &Context::new(),
            &Auth::Bearer { secret: "k".into() },
            None,
        )
        .unwrap_err();
        assert!(err.to_string().contains("token"));
    }

    #[test]
    fn post_body_is_json_filled() {
        let mut request = req(HttpMethod::Post, "/graphql");
        request.body = Some("{\"q\":\"{{project.id}}\"}".into());
        let prepared = build(
            &base(),
            &op(request),
            &ctx_with_project("x\"y"),
            &Auth::None,
            None,
        )
        .unwrap();
        assert_eq!(prepared.body.unwrap(), "{\"q\":\"x\\\"y\"}");
        assert_eq!(prepared.method, HttpMethod::Post);
    }

    #[test]
    fn sets_request_headers() {
        let mut request = req(HttpMethod::Get, "/me");
        request
            .headers
            .insert("Accept".into(), "application/json".into());
        let prepared = build(&base(), &op(request), &Context::new(), &Auth::None, None).unwrap();
        assert_eq!(prepared.headers["Accept"], "application/json");
    }

    #[test]
    fn a_literal_off_host_path_is_rejected() {
        // The manifest layer already rejects these; request-building
        // re-checks as defense in depth.
        let err = build(
            &base(),
            &op(req(HttpMethod::Get, "//evil.example/x")),
            &Context::new(),
            &Auth::None,
            None,
        )
        .unwrap_err();
        assert!(err.to_string().contains("escaped"));
    }

    #[test]
    fn a_templated_value_cannot_escape_the_host() {
        // Even if a malicious remote id tried to inject a host, Url-escaping
        // the path value keeps it a single segment on the same host.
        let prepared = build(
            &base(),
            &op(req(HttpMethod::Get, "/boards/{{project.id}}")),
            &ctx_with_project("//evil.example/x"),
            &Auth::None,
            None,
        )
        .unwrap();
        assert!(
            prepared.url.starts_with("https://api.example.com/"),
            "{}",
            prepared.url
        );
        assert!(!prepared.url.contains("evil.example/x"));
    }
}
