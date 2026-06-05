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
            Err(_) => return host,
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("json") {
                continue;
            }
            match build_from_path(&path) {
                Ok(connector) => host.register(connector),
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
fn build_from_path(path: &Path) -> anyhow::Result<Box<dyn PmConnector>> {
    let json = std::fs::read_to_string(path)?;
    let manifest = ConnectorManifest::from_json(&json)?;
    Ok(build(manifest))
}

/// Map a validated manifest to its interpreter.
fn build(manifest: ConnectorManifest) -> Box<dyn PmConnector> {
    match &manifest.kind {
        ConnectorKind::File(_) => Box::new(file::FileConnector::new(manifest)),
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
        format!(
            r#"{{ "manifest": 1, "id": "{id}", "name": "{id}", "kind": "file",
                  "capabilities": [],
                  "file": {{ "format": "todotxt", "path": "{}" }} }}"#,
            todo_path.display()
        )
    }

    #[test]
    fn load_missing_dir_is_empty() {
        let host = ConnectorHost::load(Path::new("/no/such/connectors/dir"));
        assert!(host.is_empty());
    }

    #[tokio::test]
    async fn load_builds_file_connectors_and_skips_bad_manifests() {
        let dir = temp_dir();
        let todo = dir.path().join("todo.txt");
        write_file(dir.path(), "todo.txt", "Buy milk +groceries\n");

        write_file(dir.path(), "good.json", &manifest_for("good", &todo));
        // An http manifest is recognized-but-unsupported → skipped.
        write_file(
            dir.path(),
            "http.json",
            r#"{ "manifest": 1, "id": "h", "name": "H", "kind": "http", "capabilities": ["network"] }"#,
        );
        // Garbage → skipped.
        write_file(dir.path(), "junk.json", "{ not json");
        // Non-json files ignored entirely.
        write_file(dir.path(), "notes.txt", "ignore me");

        let host = ConnectorHost::load(dir.path());
        assert_eq!(host.len(), 1, "only the valid file manifest is registered");

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
