//! Building a concrete [`PreparedRequest`] from an operation template +
//! context + token. Re-checks the resolved host (defense in depth — the
//! manifest was validated on-host, but a templated value could in
//! principle change the path) and applies the declared auth.

use std::collections::BTreeMap;

use anyhow::{anyhow, bail, Result};
use base64::Engine;
use url::Url;

use super::super::manifest::{Auth, Operation, RequestSpec, SecretLocation};
use super::template::{fill, Context, Escape};
use super::PreparedRequest;

/// Resolved keychain secrets for this request, keyed by the auth's `secret`
/// key. The interpreter fills this from the connector's [`SecretStore`].
pub(super) type Secrets = BTreeMap<String, String>;

/// The request to run for `op`: the first variant whose `when` param is set
/// (non-empty) in `ctx`, else the operation's base request. Variants only swap
/// the request body — `response` + `pagination` are shared — so selection is a
/// pure lookup with no effect on how the response is read.
fn select_request<'a>(op: &'a Operation, ctx: &Context) -> &'a RequestSpec {
    op.variants
        .iter()
        .find(|v| ctx.get(&v.when).is_some_and(|value| !value.is_empty()))
        .map(|v| &v.request)
        .unwrap_or(&op.request)
}

/// Build the request for one operation. `base` is the connector's
/// (validated) base URL; `secrets` holds the resolved keychain tokens keyed
/// by their `secret` key. When `op` declares request variants, the one whose
/// `when` param is set in `ctx` is used instead of the base request.
pub(super) fn build(
    base: &Url,
    op: &Operation,
    ctx: &Context,
    auth: &Auth,
    secrets: &Secrets,
) -> Result<PreparedRequest> {
    let spec = select_request(op, ctx);

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

    apply_auth(auth, secrets, &mut url, &mut headers)?;

    Ok(PreparedRequest {
        method: spec.method,
        url: url.to_string(),
        headers,
        body,
    })
}

fn apply_auth(
    auth: &Auth,
    secrets: &Secrets,
    url: &mut Url,
    headers: &mut BTreeMap<String, String>,
) -> Result<()> {
    match auth {
        Auth::None => {}
        Auth::Bearer { secret } => {
            headers.insert(
                "Authorization".into(),
                format!("Bearer {}", require(secrets, secret)?),
            );
        }
        Auth::Header { name, secret } => {
            headers.insert(name.clone(), require(secrets, secret)?.to_string());
        }
        Auth::Query { name, secret } => {
            url.query_pairs_mut()
                .append_pair(name, require(secrets, secret)?);
        }
        Auth::Basic { username, secret } => {
            let creds = base64::engine::general_purpose::STANDARD
                .encode(format!("{username}:{}", require(secrets, secret)?));
            headers.insert("Authorization".into(), format!("Basic {creds}"));
        }
        Auth::Multi { secrets: params } => {
            for p in params {
                let token = require(secrets, &p.secret)?;
                match p.location {
                    SecretLocation::Query => {
                        url.query_pairs_mut().append_pair(&p.name, token);
                    }
                    SecretLocation::Header => {
                        headers.insert(p.name.clone(), token.to_string());
                    }
                }
            }
        }
    }
    Ok(())
}

fn require<'a>(secrets: &'a Secrets, key: &str) -> Result<&'a str> {
    let token = secrets
        .get(key)
        .map(String::as_str)
        .ok_or_else(|| anyhow!("connector needs a token but none is stored"))?;
    // The token is user-entered into the keychain, not remote-controlled,
    // but reject control bytes here so the interpreter — not a downstream
    // HTTP client — is the thing that prevents header injection.
    if token.bytes().any(|b| b < 0x20 || b == 0x7f) {
        bail!("connector token contains a control character");
    }
    Ok(token)
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
            variants: Vec::new(),
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

    fn no_secrets() -> Secrets {
        Secrets::new()
    }

    fn secret(key: &str, token: &str) -> Secrets {
        Secrets::from([(key.to_string(), token.to_string())])
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
            &no_secrets(),
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
            &secret("k", "tok"),
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
            &secret("k", "tok"),
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
            &secret("k", "a b"),
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
            &secret("k", "pass"),
        )
        .unwrap();
        // base64("user:pass") == "dXNlcjpwYXNz"
        assert_eq!(prepared.headers["Authorization"], "Basic dXNlcjpwYXNz");
    }

    #[test]
    fn multi_auth_applies_each_secret_to_its_query_or_header() {
        use super::super::super::manifest::SecretParam;
        let auth = Auth::Multi {
            secrets: vec![
                SecretParam {
                    location: SecretLocation::Query,
                    name: "key".into(),
                    secret: "app".into(),
                },
                SecretParam {
                    location: SecretLocation::Header,
                    name: "X-Token".into(),
                    secret: "tok".into(),
                },
            ],
        };
        let resolved = Secrets::from([
            ("app".into(), "APPKEY".into()),
            ("tok".into(), "T0K".into()),
        ]);
        let prepared = build(
            &base(),
            &op(req(HttpMethod::Get, "/boards")),
            &Context::new(),
            &auth,
            &resolved,
        )
        .unwrap();
        assert!(prepared.url.contains("key=APPKEY"), "{}", prepared.url);
        assert_eq!(prepared.headers["X-Token"], "T0K");
    }

    #[test]
    fn multi_auth_errors_when_a_declared_secret_is_missing() {
        use super::super::super::manifest::SecretParam;
        let auth = Auth::Multi {
            secrets: vec![SecretParam {
                location: SecretLocation::Query,
                name: "key".into(),
                secret: "app".into(),
            }],
        };
        let err = build(
            &base(),
            &op(req(HttpMethod::Get, "/b")),
            &Context::new(),
            &auth,
            &no_secrets(),
        )
        .unwrap_err();
        assert!(err.to_string().contains("token"), "{err}");
    }

    #[test]
    fn auth_without_a_token_errors() {
        let err = build(
            &base(),
            &op(req(HttpMethod::Get, "/me")),
            &Context::new(),
            &Auth::Bearer { secret: "k".into() },
            &no_secrets(),
        )
        .unwrap_err();
        assert!(err.to_string().contains("token"));
    }

    #[test]
    fn a_token_with_control_chars_is_rejected() {
        let err = build(
            &base(),
            &op(req(HttpMethod::Get, "/me")),
            &Context::new(),
            &Auth::Bearer { secret: "k".into() },
            &secret("k", "tok\nen"),
        )
        .unwrap_err();
        assert!(err.to_string().contains("control"));
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
            &no_secrets(),
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
        let prepared = build(
            &base(),
            &op(request),
            &Context::new(),
            &Auth::None,
            &no_secrets(),
        )
        .unwrap();
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
            &no_secrets(),
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
            &no_secrets(),
        )
        .unwrap();
        assert!(
            prepared.url.starts_with("https://api.example.com/"),
            "{}",
            prepared.url
        );
        assert!(!prepared.url.contains("evil.example/x"));
    }

    fn op_with_owner_variant() -> Operation {
        use super::super::super::manifest::Variant;
        Operation {
            request: req(HttpMethod::Get, "/base"),
            response: ResponseSpec {
                items: String::new(),
                map: BTreeMap::new(),
            },
            pagination: None,
            variants: vec![Variant {
                when: "owner".to_string(),
                request: req(HttpMethod::Get, "/org/{{owner}}"),
            }],
        }
    }

    #[test]
    fn build_uses_the_base_request_when_the_when_param_is_unset() {
        let op = op_with_owner_variant();
        let prepared = build(&base(), &op, &Context::new(), &Auth::None, &no_secrets()).unwrap();
        assert!(prepared.url.ends_with("/base"), "{}", prepared.url);
    }

    #[test]
    fn build_selects_the_variant_and_substitutes_its_value_when_the_param_is_set() {
        let op = op_with_owner_variant();
        let mut ctx = Context::new();
        ctx.set("owner", "ggsegverse");
        let prepared = build(&base(), &op, &ctx, &Auth::None, &no_secrets()).unwrap();
        assert!(
            prepared.url.ends_with("/org/ggsegverse"),
            "the variant request is used with the owner filled: {}",
            prepared.url
        );
    }

    #[test]
    fn build_falls_back_to_base_when_the_when_param_is_empty() {
        // An explicitly-empty value is "unset" — the base request, not the
        // variant, so a blank GitHub owner queries `viewer`.
        let op = op_with_owner_variant();
        let mut ctx = Context::new();
        ctx.set("owner", "");
        let prepared = build(&base(), &op, &ctx, &Auth::None, &no_secrets()).unwrap();
        assert!(prepared.url.ends_with("/base"), "{}", prepared.url);
    }
}
