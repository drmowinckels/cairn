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
//! This module ships ahead of that wiring: `build()` still skips http
//! connectors until the reqwest fetcher + keychain store land, so the
//! interpreter is not yet referenced by `build()`. `#![allow(dead_code)]`
//! keeps `-D warnings` happy until then; the next slice removes it.
#![allow(dead_code)]

mod extract;
mod request;
mod template;

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

/// A connector that runs a JSON manifest through the fixed interpreter.
pub struct DeclarativeConnector<F, S> {
    manifest: ConnectorManifest,
    base: Url,
    fetcher: F,
    secrets: S,
}

impl<F: HttpFetcher, S: SecretStore> DeclarativeConnector<F, S> {
    /// Build from a validated `kind: "http"` manifest. Errors if the
    /// manifest isn't http (a programming error — `build()` only routes
    /// http manifests here) or its base URL doesn't parse.
    pub fn new(manifest: ConnectorManifest, fetcher: F, secrets: S) -> Result<Self> {
        let base = manifest
            .kind
            .as_http()
            .ok_or_else(|| anyhow!("not an http connector"))
            .and_then(|spec| {
                Url::parse(&spec.base_url).map_err(|e| anyhow!("bad base url: {e}"))
            })?;
        Ok(Self {
            manifest,
            base,
            fetcher,
            secrets,
        })
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
        let token = spec
            .auth
            .secret_key()
            .and_then(|key| self.secrets.token(key));

        let mut collected: Vec<Value> = Vec::new();
        let mut cursor = String::new();
        let mut offset: u32 = 0;

        for page in 0..MAX_PAGES {
            ctx.set("cursor", cursor.clone());
            ctx.set("offset", offset.to_string());

            let req = request::build(&self.base, op, ctx, &spec.auth, token.as_deref())?;
            let resp = self.fetcher.fetch(&req).await?;
            if !(200..300).contains(&resp.status) {
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
                    cursor = extract::dotted(&body, cursor_path)
                        .and_then(extract::as_string)
                        .unwrap_or_default();
                    has_more && !cursor.is_empty()
                }
                Some(Pagination::Offset { limit, .. }) => {
                    offset = offset.saturating_add(*limit);
                    page_len as u32 >= *limit
                }
            };
            if !more {
                return Ok(collected);
            }
            if page + 1 == MAX_PAGES {
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
        DeclarativeConnector::new(manifest, fetcher, secrets).unwrap()
    }

    const TODOIST: &str = r#"{
        "manifest": 1, "id": "todoist", "name": "Todoist", "kind": "http",
        "capabilities": ["network", "secrets"],
        "auth": { "type": "bearer", "secret": "todoist_token" },
        "baseUrl": "https://api.todoist.com/rest/v2",
        "operations": {
            "listProjects": {
                "request": { "method": "GET", "path": "/projects" },
                "response": { "items": "", "map": { "id": "id", "name": "name" } }
            },
            "listTasks": {
                "request": {
                    "method": "GET", "path": "/tasks",
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
        assert_eq!(fetcher.last().url, "https://api.todoist.com/projects");
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

    #[tokio::test]
    async fn non_2xx_status_errors() {
        let c = connector(
            TODOIST,
            FakeFetcher {
                pages: Mutex::new(VecDeque::from([HttpResponse {
                    status: 401,
                    body: String::new(),
                }])),
                seen: Mutex::new(Vec::new()),
            },
            todoist_secrets(),
        );
        let err = c.list_projects().await.unwrap_err();
        assert!(err.to_string().contains("401"));
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

    const OFFSET: &str = r#"{
        "manifest": 1, "id": "off", "name": "Off", "kind": "http",
        "capabilities": ["network"],
        "auth": { "type": "none" },
        "baseUrl": "https://api.example.com",
        "operations": {
            "listProjects": {
                "request": { "method": "GET", "path": "/p", "query": { "offset": "{{offset}}" } },
                "response": { "items": "", "map": { "id": "id", "name": "n" } },
                "pagination": { "type": "offset", "limit": 2, "param": "offset" }
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
    async fn fetcher_running_out_of_responses_errors() {
        // OFFSET has no auth, so the request builds and the fetcher (empty)
        // is reached, exercising its exhaustion path.
        let c = connector(OFFSET, FakeFetcher::with(&[]), no_secrets());
        let err = c.list_projects().await.unwrap_err();
        assert!(err.to_string().contains("ran out"));
    }

    #[tokio::test]
    async fn new_rejects_a_non_http_manifest() {
        let file_json = r#"{ "manifest": 1, "id": "f", "name": "F", "kind": "file",
            "capabilities": [], "file": { "format": "todotxt", "path": "/x" } }"#;
        let manifest = ConnectorManifest::from_json(file_json).unwrap();
        let err = DeclarativeConnector::new(manifest, FakeFetcher::with(&[]), no_secrets())
            .err()
            .unwrap();
        assert!(err.to_string().contains("not an http connector"));
    }
}
