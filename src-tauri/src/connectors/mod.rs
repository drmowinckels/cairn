//! Project-management connectors (#110). See `docs/PM_CONNECTORS.md`.
//!
//! Cairn does not build a planner — it connects to the one you already
//! use, pulls your task list in, and lets you attribute tracked time to
//! those tasks. A connector reads projects + tasks from a remote (or, in
//! this slice, a local file); the planner owns intent, Cairn owns
//! actuals.
//!
//! Two layers:
//!   - the [`PmConnector`] trait — the internal contract the rest of
//!     Cairn talks to; and
//!   - concrete implementations. Slice 1 ships exactly one: the local
//!     [`file`] connector (`kind: "file"`), which is zero-network and
//!     proves the trait + host + parsing spine. The declarative HTTP
//!     interpreter (`kind: "http"`) lands in a later slice.
//!
//! Read-only v1: a connector only ever *reads* (`list_projects` /
//! `list_tasks`). Nothing leaves the machine, so there is no exfiltration
//! surface beyond a future HTTP connector's auth token reaching its own
//! API. `push_time` is a separate, later, per-connector write grant.

pub mod file;
pub mod http;
pub mod manifest;

use std::path::Path;

use serde::Serialize;

pub use manifest::{ConnectorKind, ConnectorManifest};

/// A project as seen in the remote planner.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteProject {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
}

/// A task as seen in the remote planner. `done` collapses the planner's
/// notion of completion to a bool; `status` keeps the raw label when one
/// exists.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteTask {
    pub id: String,
    pub label: String,
    pub url: Option<String>,
    pub status: Option<String>,
    pub done: bool,
}

/// A thin reference to a remote project — all `list_tasks` needs to know.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct RemoteProjectRef {
    pub id: String,
}

impl RemoteProjectRef {
    pub fn new(id: impl Into<String>) -> Self {
        Self { id: id.into() }
    }
}

impl From<&RemoteProject> for RemoteProjectRef {
    fn from(p: &RemoteProject) -> Self {
        Self { id: p.id.clone() }
    }
}

/// What the rest of Cairn talks to, regardless of how a connector is
/// implemented (built-in, local file, or the declarative interpreter).
/// Async because real connectors do network I/O; the file connector
/// simply doesn't await anything.
#[async_trait::async_trait]
pub trait PmConnector: Send + Sync {
    /// Identity + declared capabilities, for the settings UI.
    fn manifest(&self) -> &ConnectorManifest;

    /// Every project the connector can see.
    async fn list_projects(&self) -> anyhow::Result<Vec<RemoteProject>>;

    /// Every task in one project.
    async fn list_tasks(&self, project: &RemoteProjectRef) -> anyhow::Result<Vec<RemoteTask>>;
}

/// Registry of the connectors available this session. Sibling to the
/// signal-source plugin host (`plugins::SignalSourceHost`): same
/// "register, list for the settings UI" shape, but connectors are not
/// signal sources — they don't feed the rules engine — so they get their
/// own registry. Per-connector enable/disable + the Settings card land
/// with the UI slice.
#[derive(Default)]
pub struct ConnectorHost {
    connectors: Vec<Box<dyn PmConnector>>,
}

impl ConnectorHost {
    pub fn new() -> Self {
        Self::default()
    }

    /// Build a host from every `*.json` manifest in `dir`. A missing
    /// directory yields an empty host (no connectors configured is the
    /// default state). A single unparseable or unsupported manifest is
    /// logged and skipped — one bad file must not hide the others.
    pub fn load(dir: &Path) -> Self {
        let mut host = Self::new();
        let entries = match std::fs::read_dir(dir) {
            Ok(entries) => entries,
            Err(e) => {
                // An absent dir is the normal "no connectors configured"
                // state; anything else (not a dir, permission denied) is a
                // misconfiguration worth surfacing rather than hiding.
                if e.kind() != std::io::ErrorKind::NotFound {
                    log::warn!("connector dir {dir:?} unreadable: {e}");
                }
                return host;
            }
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("json") {
                continue;
            }
            match build_from_path(&path) {
                Ok(Some(connector)) => host.register(connector),
                Ok(None) => {} // recognized but not yet runnable; build() logged it
                Err(e) => log::warn!("connector manifest {path:?} skipped: {e}"),
            }
        }
        host
    }

    pub fn register(&mut self, connector: Box<dyn PmConnector>) {
        self.connectors.push(connector);
    }

    /// The manifest of every registered connector, for the settings UI.
    pub fn manifests(&self) -> Vec<ConnectorManifest> {
        self.connectors
            .iter()
            .map(|c| c.manifest().clone())
            .collect()
    }

    /// Look up a connector by manifest id.
    pub fn get(&self, id: &str) -> Option<&dyn PmConnector> {
        self.connectors
            .iter()
            .find(|c| c.manifest().id == id)
            .map(|c| c.as_ref())
    }

    pub fn len(&self) -> usize {
        self.connectors.len()
    }

    pub fn is_empty(&self) -> bool {
        self.connectors.is_empty()
    }
}

/// Read + validate a manifest file and build the connector it describes.
/// `Ok(None)` means the manifest is valid but its kind has no runtime
/// interpreter in this build yet (the declarative HTTP interpreter lands
/// in a later slice).
fn build_from_path(path: &Path) -> anyhow::Result<Option<Box<dyn PmConnector>>> {
    let json = std::fs::read_to_string(path)?;
    let manifest = ConnectorManifest::from_json(&json)?;
    Ok(build(manifest))
}

/// Map a validated manifest to its interpreter, or `None` when it can't
/// be constructed (only the http client build can fail, and rarely).
fn build(manifest: ConnectorManifest) -> Option<Box<dyn PmConnector>> {
    match &manifest.kind {
        ConnectorKind::File(_) => Some(Box::new(file::FileConnector::new(manifest))),
        ConnectorKind::Http(_) => build_http(manifest),
    }
}

/// Construct the declarative HTTP connector with the production reqwest
/// fetcher + keychain secret store. `None` (logged) if the http client
/// can't be built.
fn build_http(manifest: ConnectorManifest) -> Option<Box<dyn PmConnector>> {
    match http::ReqwestFetcher::new() {
        Ok(fetcher) => Some(Box::new(http::DeclarativeConnector::new(
            manifest,
            fetcher,
            http::KeychainStore::new(),
        ))),
        Err(e) => {
            // Defensive: reqwest only fails to build on a catastrophic TLS
            // backend init, never in a working environment — skip rather
            // than crash startup.
            log::warn!(
                "connector '{}' skipped: could not build http client: {e}",
                manifest.id
            );
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::temp_dir;
    use std::io::Write;

    fn write_file(dir: &Path, name: &str, contents: &str) {
        let mut f = std::fs::File::create(dir.join(name)).unwrap();
        f.write_all(contents.as_bytes()).unwrap();
    }

    fn manifest_for(id: &str, todo_path: &Path) -> String {
        let path_json = serde_json::to_string(&todo_path.to_string_lossy()).unwrap();
        format!(
            r#"{{ "manifest": 1, "id": "{id}", "name": "{id}", "kind": "file",
                  "capabilities": [],
                  "file": {{ "format": "todotxt", "path": {path_json} }} }}"#,
        )
    }

    #[test]
    fn load_missing_dir_is_empty() {
        let host = ConnectorHost::load(Path::new("/no/such/connectors/dir"));
        assert!(host.is_empty());
    }

    #[test]
    fn load_path_that_is_a_file_is_empty() {
        // A non-directory (here: a regular file) is a misconfiguration,
        // not the expected "absent dir" — it logs and yields an empty host
        // rather than erroring out.
        let dir = temp_dir();
        let not_a_dir = dir.path().join("connectors");
        write_file(dir.path(), "connectors", "i am a file, not a dir");
        assert!(ConnectorHost::load(&not_a_dir).is_empty());
    }

    #[tokio::test]
    async fn load_builds_file_connectors_and_skips_bad_manifests() {
        let dir = temp_dir();
        let todo = dir.path().join("todo.txt");
        write_file(dir.path(), "todo.txt", "Buy milk +groceries\n");

        write_file(dir.path(), "good.json", &manifest_for("good", &todo));
        // A valid http manifest builds a runnable declarative connector.
        write_file(
            dir.path(),
            "http.json",
            r#"{
              "manifest": 1, "id": "remote", "name": "Remote", "kind": "http",
              "capabilities": ["network"],
              "auth": { "type": "none" },
              "baseUrl": "https://api.example.com",
              "operations": {
                "listProjects": { "request": { "method": "GET", "path": "/p" },
                                  "response": { "items": "", "map": {} } },
                "listTasks": { "request": { "method": "GET", "path": "/t" },
                               "response": { "items": "", "map": {} } }
              }
            }"#,
        );
        // An invalid manifest → skipped via Err.
        write_file(dir.path(), "junk.json", "{ not json");
        // Non-json files ignored entirely.
        write_file(dir.path(), "notes.txt", "ignore me");

        let host = ConnectorHost::load(dir.path());
        assert_eq!(host.len(), 2, "the file and http connectors both register");
        assert!(host.get("remote").is_some(), "http connector is runnable");

        let connector = host.get("good").expect("registered by id");
        let projects = connector.list_projects().await.unwrap();
        assert_eq!(projects.len(), 1);
        assert_eq!(projects[0].name, "groceries");

        assert!(host.get("missing").is_none());
    }

    #[test]
    fn remote_project_ref_from_project() {
        let p = RemoteProject {
            id: "p1".into(),
            name: "P".into(),
            description: None,
        };
        assert_eq!(RemoteProjectRef::from(&p), RemoteProjectRef::new("p1"));
    }
}
