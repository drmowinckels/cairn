//! The declarative HTTP interpreter (`kind: "http"`). See
//! `docs/PM_CONNECTORS.md`. A fixed, audited interpreter that *reads* a
//! validated [`HttpSpec`] and runs it — the community ships data
//! (manifests), not code.
//!
//! The two impure edges are **injected** so the whole interpreter is unit
//! tested without a network or keychain:
//!   - [`HttpFetcher`] performs the actual request (a reqwest-backed impl
//!     wires in with the network slice; tests use a fake).
//!   - [`SecretStore`] resolves a connector's token from the OS keychain
//!     (tests use an in-memory map).
//!
//! `connectors::build` constructs a [`DeclarativeConnector`] with the
//! production [`ReqwestFetcher`] + [`KeychainStore`] for every `kind:
//! "http"` manifest, so http connectors run like any other.

mod extract;
mod fetcher;
mod request;
mod secrets;
mod template;

pub use fetcher::ReqwestFetcher;
pub use secrets::KeychainStore;

use std::collections::BTreeMap;

use anyhow::{anyhow, bail, Result};
use async_trait::async_trait;
use serde_json::Value;
use url::Url;

use super::manifest::{HttpMethod, HttpSpec, Pagination, OP_LIST_PROJECTS, OP_LIST_TASKS};
use super::{ConnectorManifest, PmConnector, RemoteProject, RemoteProjectRef, RemoteTask};
use template::Context;

/// Hard caps the interpreter enforces regardless of the manifest, so a
/// pathological pagination config can't loop or accumulate forever.
const MAX_PAGES: usize = 50;
const MAX_ITEMS: usize = 5_000;

/// A request the interpreter has fully prepared: everything a fetcher
/// needs, with templates filled, host re-checked, and auth applied.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PreparedRequest {
    pub method: HttpMethod,
    pub url: String,
    pub headers: BTreeMap<String, String>,
    pub body: Option<String>,
}

/// A fetcher's response. `body` is the raw JSON text.
#[derive(Debug, Clone)]
pub struct HttpResponse {
    pub status: u16,
    pub body: String,
}

/// Performs a prepared request. The real impl (network slice) wraps
/// reqwest with the interpreter's limits (timeout, response-size cap,
/// https-only, no off-host redirect); tests use a fake.
#[async_trait]
pub trait HttpFetcher: Send + Sync {
    async fn fetch(&self, request: &PreparedRequest) -> Result<HttpResponse>;
}

/// Resolves a connector's token by its keychain key. The real impl reads
/// the OS keychain; tests use an in-memory map.
pub trait SecretStore: Send + Sync {
    fn token(&self, key: &str) -> Option<String>;
}

/// Writes a connector's token to (or clears it from) the keychain. Split
/// from [`SecretStore`] because the interpreter only ever *reads*; the
/// settings command that stores a user's token is the sole writer. Both
/// methods return a token-free message on failure so a secret can't leak
/// through an error string the UI then renders.
pub trait SecretWriter: Send + Sync {
    fn set(&self, key: &str, token: &str) -> Result<(), String>;
    fn clear(&self, key: &str) -> Result<(), String>;
}

/// A connector that runs a JSON manifest through the fixed interpreter.
pub struct DeclarativeConnector<F, S> {
    manifest: ConnectorManifest,
    base: Url,
    fetcher: F,
    secrets: S,
}

impl<F: HttpFetcher, S: SecretStore> DeclarativeConnector<F, S> {
    /// Build from a **validated** `kind: "http"` manifest. The two
    /// `expect`s are invariants `from_json` + `validate_http` already
    /// guarantee (the kind is http; the base is a parseable https URL),
    /// and `build()` only routes http manifests here — same documented-
    /// infallibility as `FileConnector`'s spec access.
    pub fn new(manifest: ConnectorManifest, fetcher: F, secrets: S) -> Self {
        let base = Url::parse(
            &manifest
                .kind
                .as_http()
                .expect("declarative connector holds an http manifest")
                .base_url,
        )
        .expect("validated http manifest has a parseable https base url");
        Self {
            manifest,
            base,
            fetcher,
            secrets,
        }
    }

    fn spec(&self) -> &HttpSpec {
        self.manifest
            .kind
            .as_http()
            .expect("declarative connector holds an http manifest")
    }

    /// Run one operation to completion (following pagination, capped) and
    /// return the raw items.
    async fn collect(&self, op_name: &str, ctx: &mut Context) -> Result<Vec<Value>> {
        let spec = self.spec();
        let op = spec
            .operations
            .get(op_name)
            .ok_or_else(|| anyhow!("connector has no {op_name:?} operation"))?;
        // Resolve every keychain secret this auth declares (one for the
        // single-credential variants, several for `Multi`). A missing one is
        // simply absent from the map; `request::build` surfaces it as
        // "needs a token" when the auth tries to apply it.
        let secrets: request::Secrets = spec
            .auth
            .secret_keys()
            .into_iter()
            .filter_map(|key| self.secrets.token(key).map(|tok| (key.to_string(), tok)))
            .collect();

        let mut collected: Vec<Value> = Vec::new();
        let mut cursor = String::new();
        let mut offset: u32 = 0;
        let mut page_number: u32 = 1;

        for page_index in 0..MAX_PAGES {
            ctx.set("cursor", cursor.clone());
            ctx.set("page", page_number.to_string());
            // `cursorLiteral` is the cursor as a JSON/GraphQL value — `null`
            // on the first page, else a quoted+escaped string — for GraphQL
            // bodies where `after:""` is rejected (GitHub) but `after:null`
            // and `after:"<cursor>"` are accepted. Built via serde so the
            // string is correctly escaped; the body's `Escape::Json` fill then
            // nests it inside the query string. (#193)
            let cursor_literal = if cursor.is_empty() {
                serde_json::Value::Null
            } else {
                serde_json::Value::String(cursor.clone())
            };
            ctx.set("cursorLiteral", cursor_literal.to_string());
            ctx.set("offset", offset.to_string());

            let req = request::build(&self.base, op, ctx, &spec.auth, &secrets)?;
            let resp = self.fetcher.fetch(&req).await?;
            if !(200..300).contains(&resp.status) {
                // The remote answered — so these are NOT `Unreachable` and
                // must surface, not fall back to stale cache. A rejected token
                // gets an actionable message pointing at the fix.
                if resp.status == 401 || resp.status == 403 {
                    bail!(
                        "the connector rejected the token (HTTP {}); update it in Settings → Connectors",
                        resp.status
                    );
                }
                bail!("connector request failed with HTTP {}", resp.status);
            }
            let body: Value = serde_json::from_str(&resp.body)
                .map_err(|e| anyhow!("connector response was not JSON: {e}"))?;
            let page_items = extract::items(&body, &op.response.items)?;
            let page_len = page_items.len();

            for item in page_items {
                collected.push(item.clone());
                if collected.len() >= MAX_ITEMS {
                    log::warn!(
                        "connector '{}' hit the {MAX_ITEMS}-item cap; results truncated",
                        self.manifest.id
                    );
                    return Ok(collected);
                }
            }

            let more = match &op.pagination {
                None => false,
                Some(Pagination::Cursor {
                    cursor_path,
                    has_more_path,
                }) => {
                    let has_more = extract::truthy(extract::dotted(&body, has_more_path));
                    let next = extract::dotted(&body, cursor_path)
                        .and_then(extract::as_string)
                        .unwrap_or_default();
                    // Stop on no forward progress (empty or repeated cursor)
                    // so a server that never clears `has_more` can't spin.
                    let advanced = !next.is_empty() && next != cursor;
                    cursor = next;
                    has_more && advanced
                }
                Some(Pagination::Offset { limit }) => {
                    offset = offset.saturating_add(*limit);
                    page_len as u32 >= *limit
                }
                Some(Pagination::Page { size }) => {
                    page_number = page_number.saturating_add(1);
                    page_len as u32 >= *size
                }
            };
            if !more {
                return Ok(collected);
            }
            if page_index + 1 == MAX_PAGES {
                log::warn!(
                    "connector '{}' hit the {MAX_PAGES}-page cap; results truncated",
                    self.manifest.id
                );
            }
        }
        Ok(collected)
    }
}

#[async_trait]
impl<F: HttpFetcher, S: SecretStore> PmConnector for DeclarativeConnector<F, S> {
    fn manifest(&self) -> &ConnectorManifest {
        &self.manifest
    }

    async fn list_projects(&self) -> Result<Vec<RemoteProject>> {
        let mut ctx = Context::new();
        let items = self.collect(OP_LIST_PROJECTS, &mut ctx).await?;
        let map = &self.spec().operations[OP_LIST_PROJECTS].response.map;
        items.iter().map(|item| map_project(item, map)).collect()
    }

    async fn list_tasks(&self, project: &RemoteProjectRef) -> Result<Vec<RemoteTask>> {
        let mut ctx = Context::new();
        ctx.set("project.id", project.id.clone());
        let items = self.collect(OP_LIST_TASKS, &mut ctx).await?;
        let map = &self.spec().operations[OP_LIST_TASKS].response.map;
        items.iter().map(|item| map_task(item, map)).collect()
    }
}

fn map_project(item: &Value, map: &BTreeMap<String, String>) -> Result<RemoteProject> {
    Ok(RemoteProject {
        id: required_field(item, map, "id")?,
        name: required_field(item, map, "name")?,
        description: optional_field(item, map, "description"),
    })
}

fn map_task(item: &Value, map: &BTreeMap<String, String>) -> Result<RemoteTask> {
    Ok(RemoteTask {
        id: required_field(item, map, "id")?,
        label: required_field(item, map, "label")?,
        url: optional_field(item, map, "url"),
        status: optional_field(item, map, "status"),
        done: extract::truthy(map.get("done").and_then(|path| extract::dotted(item, path))),
    })
}

fn required_field(item: &Value, map: &BTreeMap<String, String>, field: &str) -> Result<String> {
    let path = map
        .get(field)
        .ok_or_else(|| anyhow!("response map is missing the required {field:?} field"))?;
    extract::dotted(item, path)
        .and_then(extract::as_string)
        .ok_or_else(|| {
            anyhow!("response field {field:?} (path {path:?}) is missing or not a scalar")
        })
}

fn optional_field(item: &Value, map: &BTreeMap<String, String>, field: &str) -> Option<String> {
    map.get(field)
        .and_then(|path| extract::dotted(item, path))
        .and_then(extract::as_string)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::connectors::manifest::ConnectorManifest;
    use std::collections::VecDeque;
    use std::sync::Mutex;

    /// A fetcher that returns queued responses and records what it saw.
    struct FakeFetcher {
        pages: Mutex<VecDeque<HttpResponse>>,
        seen: Mutex<Vec<PreparedRequest>>,
    }

    impl FakeFetcher {
        fn with(bodies: &[&str]) -> Self {
            let pages = bodies
                .iter()
                .map(|b| HttpResponse {
                    status: 200,
                    body: (*b).to_string(),
                })
                .collect();
            Self {
                pages: Mutex::new(pages),
                seen: Mutex::new(Vec::new()),
            }
        }
        fn last(&self) -> PreparedRequest {
            self.seen.lock().unwrap().last().cloned().unwrap()
        }
    }

    #[async_trait]
    impl HttpFetcher for FakeFetcher {
        async fn fetch(&self, request: &PreparedRequest) -> Result<HttpResponse> {
            self.seen.lock().unwrap().push(request.clone());
            self.pages
                .lock()
                .unwrap()
                .pop_front()
                .ok_or_else(|| anyhow!("fake fetcher ran out of responses"))
        }
    }

    /// A fetcher that always returns the same full page (for cap tests).
    struct InfiniteFetcher {
        body: String,
        calls: Mutex<usize>,
    }
    #[async_trait]
    impl HttpFetcher for InfiniteFetcher {
        async fn fetch(&self, _request: &PreparedRequest) -> Result<HttpResponse> {
            *self.calls.lock().unwrap() += 1;
            Ok(HttpResponse {
                status: 200,
                body: self.body.clone(),
            })
        }
    }

    struct FakeSecrets(BTreeMap<String, String>);
    impl SecretStore for FakeSecrets {
        fn token(&self, key: &str) -> Option<String> {
            self.0.get(key).cloned()
        }
    }
    fn no_secrets() -> FakeSecrets {
        FakeSecrets(BTreeMap::new())
    }

    fn connector<F: HttpFetcher>(
        json: &str,
        fetcher: F,
        secrets: FakeSecrets,
    ) -> DeclarativeConnector<F, FakeSecrets> {
        let manifest = ConnectorManifest::from_json(json).unwrap();
        DeclarativeConnector::new(manifest, fetcher, secrets)
    }

    const TODOIST: &str = r#"{
        "manifest": 1, "id": "todoist", "name": "Todoist", "kind": "http",
        "capabilities": ["network", "secrets"],
        "auth": { "type": "bearer", "secret": "todoist_token" },
        "baseUrl": "https://api.todoist.com",
        "operations": {
            "listProjects": {
                "request": { "method": "GET", "path": "/rest/v2/projects" },
                "response": { "items": "", "map": { "id": "id", "name": "name" } }
            },
            "listTasks": {
                "request": {
                    "method": "GET", "path": "/rest/v2/tasks",
                    "query": { "project_id": "{{project.id}}" }
                },
                "response": {
                    "items": "",
                    "map": { "id": "id", "label": "content", "url": "url", "done": "is_completed" }
                }
            }
        }
    }"#;

    fn todoist_secrets() -> FakeSecrets {
        FakeSecrets(BTreeMap::from([("todoist_token".into(), "tok".into())]))
    }

    #[tokio::test]
    async fn lists_projects_and_applies_bearer_auth() {
        let fetcher =
            FakeFetcher::with(&[r#"[{"id":"p1","name":"Inbox"},{"id":"p2","name":"Work"}]"#]);
        let c = connector(TODOIST, fetcher, todoist_secrets());
        assert_eq!(c.manifest().id, "todoist");
        let projects = c.list_projects().await.unwrap();
        assert_eq!(projects.len(), 2);
        assert_eq!(projects[0].id, "p1");
        assert_eq!(projects[1].name, "Work");

        let DeclarativeConnector { fetcher, .. } = &c;
        assert_eq!(fetcher.last().headers["Authorization"], "Bearer tok");
        assert_eq!(
            fetcher.last().url,
            "https://api.todoist.com/rest/v2/projects"
        );
    }

    #[tokio::test]
    async fn lists_tasks_maps_done_and_passes_project_id() {
        let fetcher = FakeFetcher::with(&[
            r#"[{"id":"t1","content":"A","url":"u","is_completed":false},
                {"id":"t2","content":"B","is_completed":true}]"#,
        ]);
        let c = connector(TODOIST, fetcher, todoist_secrets());
        let tasks = c.list_tasks(&RemoteProjectRef::new("p1")).await.unwrap();
        assert_eq!(tasks.len(), 2);
        assert_eq!(tasks[0].label, "A");
        assert_eq!(tasks[0].url.as_deref(), Some("u"));
        assert!(!tasks[0].done);
        assert!(tasks[1].done);
        assert_eq!(tasks[1].url, None);

        let DeclarativeConnector { fetcher, .. } = &c;
        assert!(
            fetcher.last().url.contains("project_id=p1"),
            "{}",
            fetcher.last().url
        );
    }

    #[tokio::test]
    async fn missing_token_for_authed_connector_errors() {
        let fetcher = FakeFetcher::with(&[r#"[]"#]);
        let c = connector(TODOIST, fetcher, no_secrets());
        let err = c.list_projects().await.unwrap_err();
        assert!(err.to_string().contains("token"));
    }

    fn connector_returning_status(status: u16) -> DeclarativeConnector<FakeFetcher, FakeSecrets> {
        connector(
            TODOIST,
            FakeFetcher {
                pages: Mutex::new(VecDeque::from([HttpResponse {
                    status,
                    body: String::new(),
                }])),
                seen: Mutex::new(Vec::new()),
            },
            todoist_secrets(),
        )
    }

    #[tokio::test]
    async fn rejected_token_status_gives_an_actionable_non_unreachable_error() {
        for status in [401, 403] {
            let err = connector_returning_status(status)
                .list_projects()
                .await
                .unwrap_err();
            assert!(err.to_string().contains("rejected the token"), "{err}");
            assert!(err.to_string().contains("Settings"), "{err}");
            // The remote answered — it is not a connectivity failure, so the
            // offline cache must NOT treat it as a reason to serve stale data.
            assert!(
                !crate::connectors::is_unreachable(&err),
                "a {status} is a remote answer, not Unreachable"
            );
        }
    }

    #[tokio::test]
    async fn other_non_2xx_status_errors_generically_and_is_not_unreachable() {
        let err = connector_returning_status(500)
            .list_projects()
            .await
            .unwrap_err();
        assert!(err.to_string().contains("HTTP 500"), "{err}");
        assert!(!crate::connectors::is_unreachable(&err));
    }

    #[tokio::test]
    async fn non_json_response_errors() {
        let c = connector(TODOIST, FakeFetcher::with(&["not json"]), todoist_secrets());
        assert!(c.list_projects().await.is_err());
    }

    #[tokio::test]
    async fn missing_required_map_field_errors() {
        // Response has no `name` for the project map's required "name".
        let c = connector(
            TODOIST,
            FakeFetcher::with(&[r#"[{"id":"p1"}]"#]),
            todoist_secrets(),
        );
        let err = c.list_projects().await.unwrap_err();
        assert!(err.to_string().contains("name"));
    }

    const GRAPHQL_CURSOR: &str = r#"{
        "manifest": 1, "id": "gh", "name": "GH", "kind": "http",
        "capabilities": ["network", "secrets"],
        "auth": { "type": "bearer", "secret": "gh" },
        "baseUrl": "https://api.github.com",
        "operations": {
            "listProjects": {
                "request": { "method": "GET", "path": "/p" },
                "response": { "items": "data.nodes", "map": { "id": "id", "name": "title" } }
            },
            "listTasks": {
                "request": { "method": "GET", "path": "/t", "query": { "after": "{{cursor}}" } },
                "response": { "items": "data.nodes", "map": { "id": "id", "label": "title" } },
                "pagination": { "type": "cursor", "cursorPath": "data.page.end", "hasMorePath": "data.page.more" }
            }
        }
    }"#;

    #[tokio::test]
    async fn follows_cursor_pagination_until_exhausted() {
        let gh_secrets = FakeSecrets(BTreeMap::from([("gh".into(), "t".into())]));
        let fetcher = FakeFetcher::with(&[
            r#"{"data":{"nodes":[{"id":"1","title":"a"}],"page":{"end":"C2","more":true}}}"#,
            r#"{"data":{"nodes":[{"id":"2","title":"b"}],"page":{"end":"","more":false}}}"#,
        ]);
        let c = connector(GRAPHQL_CURSOR, fetcher, gh_secrets);
        let tasks = c.list_tasks(&RemoteProjectRef::new("x")).await.unwrap();
        assert_eq!(tasks.len(), 2, "both pages collected");

        let DeclarativeConnector { fetcher, .. } = &c;
        let seen = fetcher.seen.lock().unwrap();
        assert_eq!(seen.len(), 2);
        assert!(
            seen[0].url.contains("after="),
            "first page has empty cursor"
        );
        assert!(
            seen[1].url.contains("after=C2"),
            "second page uses the cursor"
        );
    }

    const GRAPHQL_BODY_CURSOR: &str = r#"{
        "manifest": 1, "id": "ghb", "name": "GHB", "kind": "http",
        "capabilities": ["network", "secrets"],
        "auth": { "type": "bearer", "secret": "gh" },
        "baseUrl": "https://api.github.com",
        "operations": {
            "listProjects": {
                "request": { "method": "GET", "path": "/p" },
                "response": { "items": "data.nodes", "map": { "id": "id", "name": "title" } }
            },
            "listTasks": {
                "request": { "method": "POST", "path": "/graphql",
                    "body": "{\"query\":\"items(after:{{cursorLiteral}})\"}" },
                "response": { "items": "data.nodes", "map": { "id": "id", "label": "title" } },
                "pagination": { "type": "cursor", "cursorPath": "data.page.end", "hasMorePath": "data.page.more" }
            }
        }
    }"#;

    #[tokio::test]
    async fn cursor_literal_is_null_then_a_quoted_string_in_a_graphql_body() {
        // GitHub GraphQL rejects `after:""`, so the first page must send
        // `after:null` and later pages `after:"<endCursor>"` (#193).
        let gh = FakeSecrets(BTreeMap::from([("gh".into(), "t".into())]));
        let fetcher = FakeFetcher::with(&[
            r#"{"data":{"nodes":[{"id":"1","title":"a"}],"page":{"end":"C2","more":true}}}"#,
            r#"{"data":{"nodes":[{"id":"2","title":"b"}],"page":{"end":"","more":false}}}"#,
        ]);
        let c = connector(GRAPHQL_BODY_CURSOR, fetcher, gh);
        let tasks = c.list_tasks(&RemoteProjectRef::new("x")).await.unwrap();
        assert_eq!(tasks.len(), 2, "both pages collected");

        let DeclarativeConnector { fetcher, .. } = &c;
        let seen = fetcher.seen.lock().unwrap();
        let page1 = seen[0].body.as_deref().unwrap();
        let page2 = seen[1].body.as_deref().unwrap();
        assert!(
            page1.contains("after:null"),
            "page 1 omits the cursor: {page1}"
        );
        // The endCursor is a quoted GraphQL string, JSON-escaped in the body.
        assert!(
            page2.contains(r#"after:\"C2\""#),
            "page 2 quotes the cursor: {page2}"
        );
    }

    #[tokio::test]
    async fn stops_when_has_more_is_true_but_the_cursor_is_empty() {
        // A malformed server (hasNextPage:true but a null/empty endCursor)
        // must not loop: only ONE response is seeded, so a second fetch would
        // error "ran out of responses". The no-forward-progress guard stops it.
        let gh = FakeSecrets(BTreeMap::from([("gh".into(), "t".into())]));
        let fetcher = FakeFetcher::with(&[
            r#"{"data":{"nodes":[{"id":"1","title":"a"}],"page":{"end":"","more":true}}}"#,
        ]);
        let c = connector(GRAPHQL_BODY_CURSOR, fetcher, gh);
        let tasks = c.list_tasks(&RemoteProjectRef::new("x")).await.unwrap();
        assert_eq!(tasks.len(), 1, "stopped after the single page");
    }

    const OFFSET: &str = r#"{
        "manifest": 1, "id": "off", "name": "Off", "kind": "http",
        "capabilities": ["network"],
        "auth": { "type": "none" },
        "baseUrl": "https://api.example.com",
        "operations": {
            "listProjects": {
                "request": { "method": "GET", "path": "/p", "query": { "offset": "{{offset}}" } },
                "response": { "items": "", "map": { "id": "id", "name": "n" } },
                "pagination": { "type": "offset", "limit": 2 }
            },
            "listTasks": {
                "request": { "method": "GET", "path": "/t" },
                "response": { "items": "", "map": { "id": "id", "label": "n" } }
            }
        }
    }"#;

    #[tokio::test]
    async fn follows_offset_pagination_until_a_short_page() {
        let fetcher = FakeFetcher::with(&[
            r#"[{"id":"1","n":"a"},{"id":"2","n":"b"}]"#, // full page (== limit) → continue
            r#"[{"id":"3","n":"c"}]"#,                    // short page → stop
        ]);
        let c = connector(OFFSET, fetcher, no_secrets());
        let projects = c.list_projects().await.unwrap();
        assert_eq!(projects.len(), 3);

        let DeclarativeConnector { fetcher, .. } = &c;
        let seen = fetcher.seen.lock().unwrap();
        assert!(seen[0].url.contains("offset=0"));
        assert!(seen[1].url.contains("offset=2"));
    }

    const PAGE: &str = r#"{
        "manifest": 1, "id": "pg", "name": "Pg", "kind": "http",
        "capabilities": ["network"],
        "auth": { "type": "none" },
        "baseUrl": "https://gitlab.example.com",
        "operations": {
            "listProjects": {
                "request": { "method": "GET", "path": "/p", "query": { "per_page": "2", "page": "{{page}}" } },
                "response": { "items": "", "map": { "id": "id", "name": "n" } },
                "pagination": { "type": "page", "size": 2 }
            },
            "listTasks": {
                "request": { "method": "GET", "path": "/t" },
                "response": { "items": "", "map": { "id": "id", "label": "n" } }
            }
        }
    }"#;

    #[tokio::test]
    async fn follows_page_number_pagination_until_a_short_page() {
        let fetcher = FakeFetcher::with(&[
            r#"[{"id":"1","n":"a"},{"id":"2","n":"b"}]"#, // full page (== size) → continue
            r#"[{"id":"3","n":"c"}]"#,                    // short page → stop
        ]);
        let c = connector(PAGE, fetcher, no_secrets());
        let projects = c.list_projects().await.unwrap();
        assert_eq!(projects.len(), 3);

        let DeclarativeConnector { fetcher, .. } = &c;
        let seen = fetcher.seen.lock().unwrap();
        assert_eq!(seen.len(), 2, "stopped on the short second page");
        // `{{page}}` is 1-indexed (GitLab's first page is 1, not 0).
        assert!(seen[0].url.contains("page=1"), "{}", seen[0].url);
        assert!(seen[1].url.contains("page=2"), "{}", seen[1].url);
    }

    #[tokio::test]
    async fn caps_pages_for_a_runaway_offset_config() {
        // A fetcher that always returns a full page; the loop must stop at
        // MAX_PAGES rather than spin forever.
        let fetcher = InfiniteFetcher {
            body: r#"[{"id":"1","n":"a"},{"id":"2","n":"b"}]"#.to_string(),
            calls: Mutex::new(0),
        };
        let c = connector(OFFSET, fetcher, no_secrets());
        let projects = c.list_projects().await.unwrap();
        assert_eq!(projects.len(), MAX_PAGES * 2);
        let DeclarativeConnector { fetcher, .. } = &c;
        assert_eq!(*fetcher.calls.lock().unwrap(), MAX_PAGES);
    }

    #[tokio::test]
    async fn caps_total_items_within_a_page() {
        // One page with more than MAX_ITEMS items → truncated to MAX_ITEMS.
        let mut items = String::from("[");
        for i in 0..(MAX_ITEMS + 10) {
            if i > 0 {
                items.push(',');
            }
            items.push_str(&format!(r#"{{"id":"{i}","n":"x"}}"#));
        }
        items.push(']');
        let c = connector(OFFSET, FakeFetcher::with(&[&items]), no_secrets());
        let projects = c.list_projects().await.unwrap();
        assert_eq!(projects.len(), MAX_ITEMS);
    }

    #[tokio::test]
    async fn cursor_pagination_stops_when_the_cursor_does_not_advance() {
        let gh_secrets = FakeSecrets(BTreeMap::from([("gh".into(), "t".into())]));
        // The server keeps has_more=true but returns the same cursor — the
        // no-progress guard must stop rather than spin to MAX_PAGES.
        let body =
            r#"{"data":{"nodes":[{"id":"1","title":"a"}],"page":{"end":"STUCK","more":true}}}"#;
        let c = connector(
            GRAPHQL_CURSOR,
            FakeFetcher::with(&[body, body, body]),
            gh_secrets,
        );
        let tasks = c.list_tasks(&RemoteProjectRef::new("x")).await.unwrap();
        assert_eq!(tasks.len(), 2, "two pages before the cursor repeats");
        let DeclarativeConnector { fetcher, .. } = &c;
        assert_eq!(fetcher.seen.lock().unwrap().len(), 2);
    }

    #[tokio::test]
    async fn fetcher_running_out_of_responses_errors() {
        // OFFSET has no auth, so the request builds and the fetcher (empty)
        // is reached, exercising its exhaustion path.
        let c = connector(OFFSET, FakeFetcher::with(&[]), no_secrets());
        let err = c.list_projects().await.unwrap_err();
        assert!(err.to_string().contains("ran out"));
    }

    fn github_secrets() -> FakeSecrets {
        FakeSecrets(BTreeMap::from([("github_token".into(), "ghp_x".into())]))
    }

    #[tokio::test]
    async fn bundled_github_projects_maps_a_graphql_project_list() {
        let body = r#"{"data":{"viewer":{"projectsV2":{"nodes":[
            {"id":"PVT_1","title":"Roadmap"},
            {"id":"PVT_2","title":"Bugs"}
        ]}}}}"#;
        let c = connector(
            crate::connectors::builtin::GITHUB_PROJECTS,
            FakeFetcher::with(&[body]),
            github_secrets(),
        );
        let projects = c.list_projects().await.unwrap();
        assert_eq!(projects.len(), 2);
        assert_eq!(projects[0].id, "PVT_1");
        assert_eq!(projects[1].name, "Bugs");

        let DeclarativeConnector { fetcher, .. } = &c;
        let req = fetcher.last();
        assert_eq!(req.method, HttpMethod::Post);
        assert_eq!(req.url, "https://api.github.com/graphql");
        assert_eq!(req.headers["Authorization"], "Bearer ghp_x");
    }

    #[tokio::test]
    async fn bundled_github_projects_walks_pages_via_pageinfo() {
        // Verifies the bundled manifest's real cursorPath/hasMorePath against
        // GitHub's `pageInfo { hasNextPage endCursor }` shape (#193).
        let fetcher = FakeFetcher::with(&[
            r#"{"data":{"viewer":{"projectsV2":{
                "pageInfo":{"hasNextPage":true,"endCursor":"CUR2"},
                "nodes":[{"id":"PVT_1","title":"Roadmap"}]}}}}"#,
            r#"{"data":{"viewer":{"projectsV2":{
                "pageInfo":{"hasNextPage":false,"endCursor":null},
                "nodes":[{"id":"PVT_2","title":"Bugs"}]}}}}"#,
        ]);
        let c = connector(
            crate::connectors::builtin::GITHUB_PROJECTS,
            fetcher,
            github_secrets(),
        );
        let projects = c.list_projects().await.unwrap();
        assert_eq!(projects.len(), 2, "both pages collected");

        let DeclarativeConnector { fetcher, .. } = &c;
        let seen = fetcher.seen.lock().unwrap();
        assert_eq!(seen.len(), 2);
        assert!(seen[0].body.as_deref().unwrap().contains("after:null"));
        assert!(seen[1]
            .body
            .as_deref()
            .unwrap()
            .contains(r#"after:\"CUR2\""#));
    }

    #[tokio::test]
    async fn bundled_github_projects_maps_mixed_issue_draft_and_pr_items() {
        // A ProjectV2's items can be Issues, draft issues, or PRs. The query
        // spreads all three, so every node yields a `content.title`; if the
        // manifest only covered `... on Issue`, a single draft/PR card would
        // make `label` (required) missing and fail the whole list.
        let body = r#"{"data":{"node":{"items":{"nodes":[
            {"id":"i1","content":{"title":"Fix bug","url":"https://github.com/o/r/issues/1"}},
            {"id":"i2","content":{"title":"Draft idea"}},
            {"id":"i3","content":{"title":"Open PR","url":"https://github.com/o/r/pull/2"}}
        ]}}}}"#;
        let c = connector(
            crate::connectors::builtin::GITHUB_PROJECTS,
            FakeFetcher::with(&[body]),
            github_secrets(),
        );
        let tasks = c.list_tasks(&RemoteProjectRef::new("PVT_1")).await.unwrap();
        assert_eq!(
            tasks.len(),
            3,
            "all three union members map, none fail-fast"
        );
        assert_eq!(tasks[0].label, "Fix bug");
        assert_eq!(
            tasks[0].url.as_deref(),
            Some("https://github.com/o/r/issues/1")
        );
        assert_eq!(tasks[1].label, "Draft idea");
        assert_eq!(tasks[1].url, None, "a draft issue has no url");
        assert_eq!(tasks[2].label, "Open PR");

        // The project node id was substituted into the GraphQL body.
        let DeclarativeConnector { fetcher, .. } = &c;
        assert!(fetcher.last().body.as_deref().unwrap().contains("PVT_1"));
    }

    fn trello_secrets() -> FakeSecrets {
        FakeSecrets(BTreeMap::from([
            ("trello_key".into(), "APPKEY".into()),
            ("trello_token".into(), "USERTOK".into()),
        ]))
    }

    #[tokio::test]
    async fn bundled_trello_lists_boards_and_cards_with_both_secrets() {
        let boards = r#"[{"id":"b1","name":"Acme"}]"#;
        let cards = r#"[
            {"id":"c1","name":"Open card","url":"https://trello.com/c/aaa","dueComplete":false},
            {"id":"c2","name":"Done card","url":"https://trello.com/c/bbb","dueComplete":true}
        ]"#;
        let c = connector(
            crate::connectors::builtin::TRELLO,
            FakeFetcher::with(&[boards, cards]),
            trello_secrets(),
        );

        let projects = c.list_projects().await.unwrap();
        assert_eq!(projects.len(), 1);
        assert_eq!(projects[0].id, "b1");
        assert_eq!(projects[0].name, "Acme");
        {
            // Both credentials are applied as query params, on the boards path.
            let DeclarativeConnector { fetcher, .. } = &c;
            let url = fetcher.last().url;
            assert!(url.contains("key=APPKEY"), "{url}");
            assert!(url.contains("token=USERTOK"), "{url}");
            assert!(
                url.starts_with("https://api.trello.com/1/members/me/boards?"),
                "{url}"
            );
        }

        let tasks = c.list_tasks(&RemoteProjectRef::new("b1")).await.unwrap();
        assert_eq!(tasks.len(), 2);
        assert!(!tasks[0].done, "an incomplete card is not done");
        assert!(tasks[1].done, "dueComplete maps to done");
        assert_eq!(tasks[1].url.as_deref(), Some("https://trello.com/c/bbb"));

        let DeclarativeConnector { fetcher, .. } = &c;
        let cards_url = fetcher.last().url;
        assert!(
            cards_url.starts_with("https://api.trello.com/1/boards/b1/cards?"),
            "{cards_url}"
        );
        // Lock the single-page contract the docs promise (#110).
        assert!(cards_url.contains("limit=1000"), "{cards_url}");
        assert!(cards_url.contains("filter=visible"), "{cards_url}");
    }

    fn gitlab_secrets() -> FakeSecrets {
        FakeSecrets(BTreeMap::from([("gitlab_token".into(), "glpat".into())]))
    }

    #[tokio::test]
    async fn bundled_gitlab_maps_numeric_ids_and_closed_at() {
        // GitLab REST returns numeric ids; `as_string` coerces them. `done`
        // maps from `closed_at` (null when open → not done).
        let projects = r#"[{"id":42,"name_with_namespace":"acme / web","description":null}]"#;
        let issues = r#"[
            {"id":7,"title":"Open issue","web_url":"https://gitlab.com/acme/web/-/issues/1","state":"opened","closed_at":null},
            {"id":8,"title":"Done issue","web_url":"https://gitlab.com/acme/web/-/issues/2","state":"closed","closed_at":"2026-01-02T00:00:00Z"}
        ]"#;
        let c = connector(
            crate::connectors::builtin::GITLAB,
            FakeFetcher::with(&[projects, issues]),
            gitlab_secrets(),
        );

        let projects = c.list_projects().await.unwrap();
        assert_eq!(projects.len(), 1);
        assert_eq!(projects[0].id, "42", "a numeric id is stringified");
        assert_eq!(projects[0].name, "acme / web");
        {
            // Anchor on the base+path prefix (not a mid-string `contains`): the
            // `/api/v4` prefix must survive `Url::join`. The path-dropped wrong
            // URL ("https://gitlab.com/projects…") fails this.
            let DeclarativeConnector { fetcher, .. } = &c;
            assert!(
                fetcher
                    .last()
                    .url
                    .starts_with("https://gitlab.com/api/v4/projects?"),
                "{}",
                fetcher.last().url
            );
        }

        let tasks = c
            .list_tasks(&RemoteProjectRef::new(projects[0].id.clone()))
            .await
            .unwrap();
        assert_eq!(tasks.len(), 2);
        assert!(
            !tasks[0].done,
            "an open issue (closed_at: null) is not done"
        );
        assert!(tasks[1].done, "a closed issue (closed_at set) is done");
        assert_eq!(
            tasks[1].url.as_deref(),
            Some("https://gitlab.com/acme/web/-/issues/2")
        );

        // The numeric project id is substituted into the path and the
        // `/api/v4` base prefix is preserved.
        let DeclarativeConnector { fetcher, .. } = &c;
        assert!(
            fetcher
                .last()
                .url
                .starts_with("https://gitlab.com/api/v4/projects/42/issues?"),
            "{}",
            fetcher.last().url
        );
    }

    const MULTI_AUTH: &str = r#"{
        "manifest": 1, "id": "ml", "name": "ML", "kind": "http",
        "capabilities": ["network", "secrets"],
        "auth": { "type": "multi", "secrets": [
            { "in": "query", "name": "key", "secret": "trello_key" },
            { "in": "query", "name": "token", "secret": "trello_token" }
        ] },
        "baseUrl": "https://api.trello.com",
        "operations": {
            "listProjects": {
                "request": { "method": "GET", "path": "/p" },
                "response": { "items": "", "map": { "id": "id", "name": "name" } }
            },
            "listTasks": {
                "request": { "method": "GET", "path": "/t" },
                "response": { "items": "", "map": { "id": "id", "label": "name" } }
            }
        }
    }"#;

    #[tokio::test]
    async fn multi_auth_resolves_and_applies_both_secrets() {
        let secrets = FakeSecrets(BTreeMap::from([
            ("trello_key".into(), "APPKEY".into()),
            ("trello_token".into(), "USERTOK".into()),
        ]));
        let c = connector(
            MULTI_AUTH,
            FakeFetcher::with(&[r#"[{"id":"1","name":"Board"}]"#]),
            secrets,
        );
        let projects = c.list_projects().await.unwrap();
        assert_eq!(projects.len(), 1);

        let DeclarativeConnector { fetcher, .. } = &c;
        let url = fetcher.last().url;
        assert!(url.contains("key=APPKEY"), "{url}");
        assert!(url.contains("token=USERTOK"), "{url}");
    }
}
