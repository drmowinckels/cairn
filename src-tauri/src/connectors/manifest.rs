//! Connector manifest model + validation. See `docs/PM_CONNECTORS.md`.
//!
//! A manifest is *data* describing how to reach a project-management
//! tool. This module is the single boundary where untrusted manifest
//! JSON becomes a typed, validated value — everything downstream works
//! on [`ConnectorManifest`], never on raw JSON, which is what keeps the
//! "data, not code" safety story enforceable.
//!
//! Slice 1 implements only `kind: "file"` (local files, zero network /
//! secrets). `kind: "http"` (the declarative HTTP interpreter) is a
//! recognized-but-unsupported kind for now: a manifest declaring it
//! parses far enough to be rejected with a clear message, so importing
//! one fails loudly instead of silently doing nothing.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::plugins::Capability;

/// The only manifest schema version this build understands.
pub const SUPPORTED_VERSION: u32 = 1;

/// A validated connector manifest. Construct via [`ConnectorManifest::from_json`];
/// the fields are guaranteed to satisfy the invariants documented there.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ConnectorManifest {
    /// Stable machine id, kebab-case (`^[a-z0-9-]+$`).
    pub id: String,
    /// Human label shown in Settings → Connectors.
    pub name: String,
    /// Declared capabilities, surfaced as badges. A file connector
    /// declares none (it is fully local).
    pub capabilities: Vec<Capability>,
    /// The interpreter + its kind-specific configuration.
    pub kind: ConnectorKind,
}

/// Which interpreter runs the connector, plus that interpreter's config.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ConnectorKind {
    /// A local file read by a built-in parser. Zero network / secrets.
    File(FileSpec),
    /// A remote PM read by the declarative HTTP interpreter.
    Http(HttpSpec),
}

impl ConnectorKind {
    /// The file config when this is a `file` connector, else `None`.
    pub fn as_file(&self) -> Option<&FileSpec> {
        match self {
            ConnectorKind::File(spec) => Some(spec),
            ConnectorKind::Http(_) => None,
        }
    }

    /// The HTTP config when this is an `http` connector, else `None`.
    pub fn as_http(&self) -> Option<&HttpSpec> {
        match self {
            ConnectorKind::Http(spec) => Some(spec),
            ConnectorKind::File(_) => None,
        }
    }
}

/// Configuration for a `kind: "file"` connector.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FileSpec {
    pub format: FileFormat,
    /// Path to the file. A leading `~` is expanded to the home dir when
    /// the connector reads it (see `connectors::file`).
    pub path: String,
}

/// Local-file formats the built-in parser understands.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FileFormat {
    Todotxt,
    Markdown,
    Taskpaper,
}

/// Operation name for "list the connector's projects".
pub const OP_LIST_PROJECTS: &str = "listProjects";
/// Operation name for "list a project's tasks".
pub const OP_LIST_TASKS: &str = "listTasks";

/// Configuration for a `kind: "http"` connector — the declarative HTTP
/// interpreter's manifest. Built + validated by [`ConnectorManifest::from_json`];
/// the interpreter (a later slice) only ever sees a validated value.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct HttpSpec {
    pub auth: Auth,
    /// `https://` base. Every request is built relative to this — the
    /// single host a connector ever contacts (enforced again at request
    /// time). Validated to start with `https://`.
    pub base_url: String,
    /// Named operations. Guaranteed to contain [`OP_LIST_PROJECTS`] and
    /// [`OP_LIST_TASKS`]; extra entries are permitted but unused in v1.
    pub operations: BTreeMap<String, Operation>,
}

/// How the interpreter authenticates. Declarative — the token itself is
/// never here; it lives in the OS keychain under `secret`, and the
/// interpreter applies it per the variant. There is deliberately no
/// templated-token form (see `docs/PM_CONNECTORS.md`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum Auth {
    /// No authentication.
    None,
    /// `Authorization: Bearer <token>`.
    Bearer { secret: String },
    /// `<name>: <token>`.
    Header { name: String, secret: String },
    /// Adds `?<name>=<token>`.
    Query { name: String, secret: String },
    /// `Authorization: Basic base64(<username>:<token>)`.
    Basic { username: String, secret: String },
}

impl Auth {
    /// The keychain key holding this connector's token, or `None` when no
    /// secret is involved (`Auth::None`).
    pub fn secret_key(&self) -> Option<&str> {
        match self {
            Auth::None => None,
            Auth::Bearer { secret }
            | Auth::Header { secret, .. }
            | Auth::Query { secret, .. }
            | Auth::Basic { secret, .. } => Some(secret),
        }
    }
}

/// One operation: a request template + how to read its response.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Operation {
    pub request: RequestSpec,
    pub response: ResponseSpec,
    #[serde(default)]
    pub pagination: Option<Pagination>,
}

/// HTTP method. v1 reads only; `POST` is for GraphQL queries.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "UPPERCASE")]
pub enum HttpMethod {
    Get,
    Post,
}

/// A request template. `path`, `query`, `headers`, and `body` are filled
/// by value substitution (see the interpreter); the maps are ordered so
/// request building is deterministic.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RequestSpec {
    pub method: HttpMethod,
    /// Appended to `baseUrl`. Validated to start with `/` so a manifest
    /// can never template a request onto a different host.
    pub path: String,
    #[serde(default)]
    pub query: BTreeMap<String, String>,
    #[serde(default)]
    pub headers: BTreeMap<String, String>,
    #[serde(default)]
    pub body: Option<String>,
}

/// How to project a response into Cairn's shape.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ResponseSpec {
    /// Dotted path to the array of items. `""` means the body is itself
    /// the array.
    pub items: String,
    /// Each output field → a dotted path into one item.
    pub map: BTreeMap<String, String>,
}

/// How to follow pages. The interpreter loops, capped.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Pagination {
    #[serde(rename_all = "camelCase")]
    Cursor {
        cursor_path: String,
        has_more_path: String,
    },
    Offset {
        limit: u32,
        param: String,
    },
}

/// Why a manifest was rejected. Library-level, so callers (the host's
/// directory load, the future import command) can surface a precise
/// reason without string-matching.
#[derive(Debug, thiserror::Error)]
pub enum ManifestError {
    #[error("manifest is not valid JSON: {0}")]
    Json(#[from] serde_json::Error),
    #[error("unsupported manifest version {0} (this build understands {SUPPORTED_VERSION})")]
    Version(u32),
    #[error("connector id {0:?} must be non-empty and kebab-case ([a-z0-9-])")]
    Id(String),
    #[error("connector name must not be empty")]
    Name,
    #[error("connector is missing its {section:?} section")]
    MissingSection { section: &'static str },
    #[error("file connectors are fully local and must declare no capabilities (got {0:?})")]
    FileCapabilities(Vec<Capability>),
    #[error("http connector baseUrl must be https:// (got {0:?})")]
    InsecureBaseUrl(String),
    #[error("http connector is missing the {0:?} operation")]
    MissingOperation(&'static str),
    #[error("http operation {op:?} path must start with '/' (got {path:?})")]
    OperationPath { op: String, path: String },
    #[error("http connector must declare the \"network\" capability")]
    MissingNetworkCapability,
    #[error("http connector with authentication must declare the \"secrets\" capability")]
    MissingSecretsCapability,
    #[error("connector kind {0:?} is not supported in this version yet")]
    UnsupportedKind(String),
}

/// The wire shape of a manifest: flat top-level fields plus one sibling
/// object named after the kind (`file`). Parsed leniently, then validated
/// into a [`ConnectorManifest`] so every error is specific.
#[derive(Deserialize)]
struct RawManifest {
    manifest: u32,
    #[serde(default)]
    id: String,
    #[serde(default)]
    name: String,
    kind: String,
    #[serde(default)]
    capabilities: Vec<Capability>,
    #[serde(default)]
    file: Option<FileSpec>,
    #[serde(default)]
    auth: Option<Auth>,
    #[serde(default, rename = "baseUrl")]
    base_url: Option<String>,
    #[serde(default)]
    operations: Option<BTreeMap<String, Operation>>,
}

impl ConnectorManifest {
    /// Parse and validate a manifest from JSON.
    ///
    /// Enforces: schema version, non-empty kebab-case id, non-empty name,
    /// and the kind-specific shape — a `file` connector needs a `file`
    /// section and declares no capabilities; an `http` connector needs
    /// `auth` / `baseUrl` / `operations` and must satisfy [`validate_http`].
    /// An unknown `kind` is rejected.
    pub fn from_json(json: &str) -> Result<Self, ManifestError> {
        let raw: RawManifest = serde_json::from_str(json)?;

        if raw.manifest != SUPPORTED_VERSION {
            return Err(ManifestError::Version(raw.manifest));
        }
        if !is_valid_id(&raw.id) {
            return Err(ManifestError::Id(raw.id));
        }
        if raw.name.trim().is_empty() {
            return Err(ManifestError::Name);
        }

        let kind = match raw.kind.as_str() {
            "file" => {
                if !raw.capabilities.is_empty() {
                    return Err(ManifestError::FileCapabilities(raw.capabilities));
                }
                let spec = raw
                    .file
                    .ok_or(ManifestError::MissingSection { section: "file" })?;
                ConnectorKind::File(spec)
            }
            "http" => {
                let auth = raw
                    .auth
                    .ok_or(ManifestError::MissingSection { section: "auth" })?;
                let base_url = raw
                    .base_url
                    .ok_or(ManifestError::MissingSection { section: "baseUrl" })?;
                let operations = raw.operations.ok_or(ManifestError::MissingSection {
                    section: "operations",
                })?;
                validate_http(&base_url, &auth, &operations, &raw.capabilities)?;
                ConnectorKind::Http(HttpSpec {
                    auth,
                    base_url,
                    operations,
                })
            }
            other => return Err(ManifestError::UnsupportedKind(other.to_string())),
        };

        Ok(ConnectorManifest {
            id: raw.id,
            name: raw.name,
            capabilities: raw.capabilities,
            kind,
        })
    }
}

/// Validate a `kind: "http"` connector's parts. Enforces the egress and
/// honesty guarantees from `docs/PM_CONNECTORS.md` at the manifest
/// boundary: https-only base, both required operations present, every
/// request path relative (so it can't escape `baseUrl`'s host), and that
/// the connector declares the capabilities it actually uses.
fn validate_http(
    base_url: &str,
    auth: &Auth,
    operations: &BTreeMap<String, Operation>,
    capabilities: &[Capability],
) -> Result<(), ManifestError> {
    if !base_url.starts_with("https://") {
        return Err(ManifestError::InsecureBaseUrl(base_url.to_string()));
    }
    for required in [OP_LIST_PROJECTS, OP_LIST_TASKS] {
        if !operations.contains_key(required) {
            return Err(ManifestError::MissingOperation(required));
        }
    }
    for (op, operation) in operations {
        if !operation.request.path.starts_with('/') {
            return Err(ManifestError::OperationPath {
                op: op.clone(),
                path: operation.request.path.clone(),
            });
        }
    }
    if !capabilities.contains(&Capability::Network) {
        return Err(ManifestError::MissingNetworkCapability);
    }
    if auth.secret_key().is_some() && !capabilities.contains(&Capability::Secrets) {
        return Err(ManifestError::MissingSecretsCapability);
    }
    Ok(())
}

/// `^[a-z0-9-]+$` without pulling in a regex engine.
fn is_valid_id(id: &str) -> bool {
    !id.is_empty()
        && id
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

#[cfg(test)]
mod tests {
    use super::*;

    const FILE_JSON: &str = r#"{
        "manifest": 1,
        "id": "my-todo",
        "name": "Project TODO",
        "kind": "file",
        "capabilities": [],
        "file": { "format": "todotxt", "path": "~/code/cairn/TODO.txt" }
    }"#;

    #[test]
    fn parses_a_valid_file_manifest() {
        let m = ConnectorManifest::from_json(FILE_JSON).unwrap();
        assert_eq!(m.id, "my-todo");
        assert_eq!(m.name, "Project TODO");
        assert!(m.capabilities.is_empty());
        assert!(
            m.kind.as_file().is_some(),
            "a file manifest exposes its file spec"
        );
        assert!(m.kind.as_http().is_none(), "a file kind is not http");
        assert_eq!(
            m.kind,
            ConnectorKind::File(FileSpec {
                format: FileFormat::Todotxt,
                path: "~/code/cairn/TODO.txt".to_string(),
            })
        );
    }

    #[test]
    fn each_file_format_parses() {
        for (token, want) in [
            ("todotxt", FileFormat::Todotxt),
            ("markdown", FileFormat::Markdown),
            ("taskpaper", FileFormat::Taskpaper),
        ] {
            let json = FILE_JSON.replace("todotxt", token);
            let m = ConnectorManifest::from_json(&json).unwrap();
            assert_eq!(
                m.kind,
                ConnectorKind::File(FileSpec {
                    format: want,
                    path: "~/code/cairn/TODO.txt".to_string()
                })
            );
        }
    }

    #[test]
    fn rejects_invalid_json() {
        let err = ConnectorManifest::from_json("{ not json").unwrap_err();
        assert!(matches!(err, ManifestError::Json(_)));
    }

    #[test]
    fn rejects_wrong_version() {
        let json = FILE_JSON.replace("\"manifest\": 1", "\"manifest\": 2");
        let err = ConnectorManifest::from_json(&json).unwrap_err();
        assert!(matches!(err, ManifestError::Version(2)));
    }

    #[test]
    fn rejects_non_kebab_id() {
        for bad in ["", "My_Todo", "todo list", "Café"] {
            let json = FILE_JSON.replace("\"id\": \"my-todo\"", &format!("\"id\": \"{bad}\""));
            let err = ConnectorManifest::from_json(&json).unwrap_err();
            assert!(
                matches!(err, ManifestError::Id(_)),
                "{bad:?} should be rejected"
            );
        }
    }

    #[test]
    fn rejects_empty_name() {
        let json = FILE_JSON.replace("\"name\": \"Project TODO\"", "\"name\": \"   \"");
        let err = ConnectorManifest::from_json(&json).unwrap_err();
        assert!(matches!(err, ManifestError::Name));
    }

    #[test]
    fn file_connector_must_declare_no_capabilities() {
        let json = FILE_JSON.replace("\"capabilities\": []", "\"capabilities\": [\"network\"]");
        let err = ConnectorManifest::from_json(&json).unwrap_err();
        assert!(matches!(err, ManifestError::FileCapabilities(_)));
    }

    #[test]
    fn file_connector_without_file_section_is_rejected() {
        let json = r#"{
            "manifest": 1, "id": "x", "name": "X", "kind": "file", "capabilities": []
        }"#;
        let err = ConnectorManifest::from_json(json).unwrap_err();
        assert!(matches!(
            err,
            ManifestError::MissingSection { section: "file" }
        ));
    }

    #[test]
    fn unknown_kind_is_rejected() {
        let json = FILE_JSON.replace("\"kind\": \"file\"", "\"kind\": \"smoke-signals\"");
        let err = ConnectorManifest::from_json(&json).unwrap_err();
        assert!(matches!(err, ManifestError::UnsupportedKind(_)));
    }

    const HTTP_JSON: &str = r#"{
        "manifest": 1,
        "id": "todoist",
        "name": "Todoist",
        "kind": "http",
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
                    "method": "GET",
                    "path": "/tasks",
                    "query": { "project_id": "{{project.id}}" }
                },
                "response": {
                    "items": "",
                    "map": { "id": "id", "label": "content", "done": "is_completed" }
                },
                "pagination": { "type": "offset", "limit": 100, "param": "offset" }
            }
        }
    }"#;

    #[test]
    fn secret_key_for_each_auth_variant() {
        assert_eq!(Auth::None.secret_key(), None);
        assert_eq!(Auth::Bearer { secret: "b".into() }.secret_key(), Some("b"));
        assert_eq!(
            Auth::Header {
                name: "X-Api-Key".into(),
                secret: "h".into()
            }
            .secret_key(),
            Some("h")
        );
        assert_eq!(
            Auth::Query {
                name: "token".into(),
                secret: "q".into()
            }
            .secret_key(),
            Some("q")
        );
        assert_eq!(
            Auth::Basic {
                username: "u".into(),
                secret: "p".into()
            }
            .secret_key(),
            Some("p")
        );
    }

    #[test]
    fn parses_a_valid_http_manifest() {
        let m = ConnectorManifest::from_json(HTTP_JSON).unwrap();
        assert_eq!(m.id, "todoist");
        assert!(m.kind.as_file().is_none(), "an http kind is not file");
        let s = m.kind.as_http().expect("http kind");
        assert_eq!(s.base_url, "https://api.todoist.com/rest/v2");
        assert_eq!(s.auth.secret_key(), Some("todoist_token"));
        assert!(s.operations.contains_key("listProjects"));
        let tasks = &s.operations["listTasks"];
        assert_eq!(tasks.request.method, HttpMethod::Get);
        assert_eq!(tasks.request.query["project_id"], "{{project.id}}");
        assert_eq!(tasks.response.map["label"], "content");
        assert_eq!(
            tasks.pagination,
            Some(Pagination::Offset {
                limit: 100,
                param: "offset".to_string()
            })
        );
    }

    #[test]
    fn http_without_a_required_section_is_rejected() {
        for (section, key) in [
            ("auth", "\"auth\""),
            ("baseUrl", "\"baseUrl\""),
            ("operations", "\"operations\""),
        ] {
            // Blank the section's key so it deserializes as absent.
            let json = HTTP_JSON.replacen(key, "\"_omitted\"", 1);
            let err = ConnectorManifest::from_json(&json).unwrap_err();
            assert!(
                matches!(err, ManifestError::MissingSection { section: s } if s == section),
                "omitting {section} should be MissingSection, got {err:?}"
            );
        }
    }

    #[test]
    fn http_baseurl_must_be_https() {
        let json = HTTP_JSON.replace("https://api.todoist.com", "http://api.todoist.com");
        let err = ConnectorManifest::from_json(&json).unwrap_err();
        assert!(matches!(err, ManifestError::InsecureBaseUrl(_)));
    }

    #[test]
    fn http_requires_both_list_operations() {
        let json = HTTP_JSON.replace("\"listProjects\"", "\"listSomethingElse\"");
        let err = ConnectorManifest::from_json(&json).unwrap_err();
        assert!(matches!(
            err,
            ManifestError::MissingOperation("listProjects")
        ));
    }

    #[test]
    fn http_operation_paths_must_be_relative() {
        // A full URL as a path would let a manifest reach another host.
        let json = HTTP_JSON.replace("\"/tasks\"", "\"https://evil.example/tasks\"");
        let err = ConnectorManifest::from_json(&json).unwrap_err();
        assert!(matches!(err, ManifestError::OperationPath { .. }));
    }

    #[test]
    fn http_must_declare_network() {
        let json = HTTP_JSON.replace("[\"network\", \"secrets\"]", "[\"secrets\"]");
        let err = ConnectorManifest::from_json(&json).unwrap_err();
        assert!(matches!(err, ManifestError::MissingNetworkCapability));
    }

    #[test]
    fn http_with_auth_must_declare_secrets() {
        let json = HTTP_JSON.replace("[\"network\", \"secrets\"]", "[\"network\"]");
        let err = ConnectorManifest::from_json(&json).unwrap_err();
        assert!(matches!(err, ManifestError::MissingSecretsCapability));
    }

    #[test]
    fn parses_cursor_pagination() {
        let json = HTTP_JSON.replace(
            "{ \"type\": \"offset\", \"limit\": 100, \"param\": \"offset\" }",
            "{ \"type\": \"cursor\", \"cursorPath\": \"meta.next\", \"hasMorePath\": \"meta.more\" }",
        );
        let m = ConnectorManifest::from_json(&json).unwrap();
        let s = m.kind.as_http().expect("http kind");
        assert_eq!(
            s.operations["listTasks"].pagination,
            Some(Pagination::Cursor {
                cursor_path: "meta.next".to_string(),
                has_more_path: "meta.more".to_string(),
            })
        );
    }

    #[test]
    fn http_with_no_auth_does_not_require_secrets() {
        let json = HTTP_JSON
            .replace("[\"network\", \"secrets\"]", "[\"network\"]")
            .replace(
                "{ \"type\": \"bearer\", \"secret\": \"todoist_token\" }",
                "{ \"type\": \"none\" }",
            );
        let m = ConnectorManifest::from_json(&json).unwrap();
        let s = m.kind.as_http().expect("http kind");
        assert_eq!(s.auth, Auth::None);
        assert_eq!(s.auth.secret_key(), None);
    }
}
