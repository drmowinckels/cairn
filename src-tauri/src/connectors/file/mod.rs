//! Local-file connectors (`kind: "file"`). See `docs/PM_CONNECTORS.md`.
//!
//! The zero-network on-ramp: a built-in parser reads a local file and
//! exposes its sections as projects and its lines as tasks, so a plain
//! checklist can have tracked time attributed to it without any account,
//! token, or egress. Three formats are understood — `todotxt`,
//! `markdown` (GitHub `- [ ]` checklists), and `taskpaper`.
//!
//! Each parser is a pure `&str -> Parsed` function (its own submodule)
//! built on the shared [`Builder`], which dedups projects and assigns a
//! stable per-project task id. The connector re-reads the file on every
//! call so an edited checklist is reflected immediately.

mod markdown;
mod taskpaper;
mod todotxt;

use std::collections::HashMap;
use std::path::PathBuf;

use anyhow::Context;
use async_trait::async_trait;

use super::manifest::{ConnectorKind, FileFormat, FileSpec};
use super::{ConnectorManifest, PmConnector, RemoteProject, RemoteProjectRef, RemoteTask};

/// A connector backed by a local file.
pub struct FileConnector {
    manifest: ConnectorManifest,
}

impl FileConnector {
    /// Build from a validated `kind: "file"` manifest.
    pub fn new(manifest: ConnectorManifest) -> Self {
        Self { manifest }
    }

    fn spec(&self) -> &FileSpec {
        match &self.manifest.kind {
            ConnectorKind::File(spec) => spec,
        }
    }

    fn read_and_parse(&self) -> anyhow::Result<Parsed> {
        let spec = self.spec();
        let path = expand_path(&spec.path);
        let contents = std::fs::read_to_string(&path)
            .with_context(|| format!("reading connector file {}", path.display()))?;
        Ok(match spec.format {
            FileFormat::Todotxt => todotxt::parse(&contents),
            FileFormat::Markdown => markdown::parse(&contents),
            FileFormat::Taskpaper => taskpaper::parse(&contents),
        })
    }
}

#[async_trait]
impl PmConnector for FileConnector {
    fn manifest(&self) -> &ConnectorManifest {
        &self.manifest
    }

    async fn list_projects(&self) -> anyhow::Result<Vec<RemoteProject>> {
        Ok(self.read_and_parse()?.projects)
    }

    async fn list_tasks(&self, project: &RemoteProjectRef) -> anyhow::Result<Vec<RemoteTask>> {
        let mut parsed = self.read_and_parse()?;
        Ok(parsed.tasks.remove(&project.id).unwrap_or_default())
    }
}

/// The result of parsing one file: an ordered project list plus that
/// file's tasks bucketed by project id.
pub(super) struct Parsed {
    pub projects: Vec<RemoteProject>,
    pub tasks: HashMap<String, Vec<RemoteTask>>,
}

/// Accumulates projects + tasks while a parser walks a file. Keeps
/// project order, dedups projects by id, and guarantees each task id is
/// unique within its project (a stable hash of the label, suffixed on the
/// rare duplicate-label collision).
pub(super) struct Builder {
    projects: Vec<RemoteProject>,
    tasks: HashMap<String, Vec<RemoteTask>>,
}

impl Builder {
    pub(super) fn new() -> Self {
        Self {
            projects: Vec::new(),
            tasks: HashMap::new(),
        }
    }

    /// Ensure a project exists, returning its id. Idempotent: the first
    /// `name` wins; later calls with the same id reuse the bucket.
    pub(super) fn project(&mut self, id: impl Into<String>, name: impl Into<String>) -> String {
        let id = id.into();
        if !self.tasks.contains_key(&id) {
            self.projects.push(RemoteProject {
                id: id.clone(),
                name: name.into(),
                description: None,
            });
            self.tasks.insert(id.clone(), Vec::new());
        }
        id
    }

    /// Add a task to a project, assigning a stable, project-unique id.
    pub(super) fn task(&mut self, project_id: &str, label: &str, url: Option<String>, done: bool) {
        let bucket = self.tasks.entry(project_id.to_string()).or_default();
        let mut id = task_id(project_id, label);
        let base = id.clone();
        let mut n = 2;
        while bucket.iter().any(|t| t.id == id) {
            id = format!("{base}-{n}");
            n += 1;
        }
        bucket.push(RemoteTask {
            id,
            label: label.to_string(),
            url,
            status: None,
            done,
        });
    }

    pub(super) fn finish(self) -> Parsed {
        Parsed {
            projects: self.projects,
            tasks: self.tasks,
        }
    }
}

/// Expand a leading `~` / `~/` to the user's home directory.
fn expand_path(path: &str) -> PathBuf {
    expand_path_with(path, dirs::home_dir())
}

/// The pure core of [`expand_path`], with the home dir injected so both
/// the resolved and the "no home" fall-through can be tested. Any path
/// without a leading `~`, or a `~` with no resolvable home, is returned
/// unchanged — a bare `~` then fails the subsequent read with a clear
/// file error rather than silently pointing somewhere surprising.
fn expand_path_with(path: &str, home: Option<PathBuf>) -> PathBuf {
    if let Some(rest) = path.strip_prefix("~/") {
        if let Some(home) = home {
            return home.join(rest);
        }
    } else if path == "~" {
        if let Some(home) = home {
            return home;
        }
    }
    PathBuf::from(path)
}

/// A stable id for a task: FNV-1a over `project_id\0label`, hex. Stable
/// across runs and platforms (unlike `DefaultHasher`), so attribution
/// survives a restart as long as the label is unchanged.
pub(super) fn task_id(project_id: &str, label: &str) -> String {
    const OFFSET: u64 = 0xcbf2_9ce4_8422_2325;
    const PRIME: u64 = 0x0000_0100_0000_01b3;
    let mut hash = OFFSET;
    for byte in project_id
        .bytes()
        .chain(std::iter::once(0))
        .chain(label.bytes())
    {
        hash ^= byte as u64;
        hash = hash.wrapping_mul(PRIME);
    }
    format!("{hash:016x}")
}

/// Lowercase a heading/section into a kebab id: alphanumerics kept,
/// every other run collapsed to a single `-`, ends trimmed. Empty input
/// yields `"untitled"` so a project always has a non-empty id.
pub(super) fn slug(text: &str) -> String {
    let mut out = String::new();
    let mut pending_dash = false;
    for ch in text.chars() {
        if ch.is_alphanumeric() {
            if pending_dash && !out.is_empty() {
                out.push('-');
            }
            pending_dash = false;
            out.extend(ch.to_lowercase());
        } else {
            pending_dash = true;
        }
    }
    if out.is_empty() {
        "untitled".to_string()
    } else {
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::temp_dir;

    fn connector_over(format: &str, body: &str) -> (crate::test_support::TempDir, FileConnector) {
        let dir = temp_dir();
        let path = dir.path().join("tasks");
        std::fs::write(&path, body).unwrap();
        let json = format!(
            r#"{{ "manifest": 1, "id": "c", "name": "C", "kind": "file",
                  "capabilities": [],
                  "file": {{ "format": "{format}", "path": "{}" }} }}"#,
            path.display()
        );
        let manifest = ConnectorManifest::from_json(&json).unwrap();
        (dir, FileConnector::new(manifest))
    }

    #[tokio::test]
    async fn each_format_reads_projects_and_tasks_through_the_connector() {
        let cases = [
            ("todotxt", "Buy milk +groceries\n", "groceries"),
            ("markdown", "# Backend\n- [ ] Wire it up\n", "backend"),
            ("taskpaper", "Release:\n- Cut tag\n", "release"),
        ];
        for (format, body, project_id) in cases {
            let (_dir, connector) = connector_over(format, body);
            let projects = connector.list_projects().await.unwrap();
            assert_eq!(projects.len(), 1, "{format}: one project");
            assert_eq!(projects[0].id, project_id, "{format}: project id");

            let tasks = connector
                .list_tasks(&RemoteProjectRef::new(project_id))
                .await
                .unwrap();
            assert_eq!(tasks.len(), 1, "{format}: one task");
        }
    }

    #[tokio::test]
    async fn missing_file_surfaces_a_read_error() {
        let connector = {
            let json = r#"{ "manifest": 1, "id": "c", "name": "C", "kind": "file",
                           "capabilities": [],
                           "file": { "format": "todotxt", "path": "/no/such/file.txt" } }"#;
            FileConnector::new(ConnectorManifest::from_json(json).unwrap())
        };
        let err = connector.list_projects().await.unwrap_err();
        assert!(err.to_string().contains("/no/such/file.txt"));
    }

    #[test]
    fn manifest_is_exposed() {
        let (_dir, connector) = connector_over("todotxt", "");
        assert_eq!(connector.manifest().id, "c");
    }

    #[test]
    fn task_id_is_stable_and_project_scoped() {
        assert_eq!(task_id("p", "Buy milk"), task_id("p", "Buy milk"));
        assert_ne!(task_id("p", "Buy milk"), task_id("q", "Buy milk"));
        assert_ne!(task_id("p", "Buy milk"), task_id("p", "Buy bread"));
        assert_eq!(task_id("p", "x").len(), 16);
    }

    #[test]
    fn builder_dedups_projects_and_uniquifies_duplicate_task_ids() {
        let mut b = Builder::new();
        let p = b.project("groceries", "Groceries");
        b.project("groceries", "Ignored second name");
        b.task(&p, "Milk", None, false);
        b.task(&p, "Milk", None, true);
        let parsed = b.finish();
        assert_eq!(parsed.projects.len(), 1);
        assert_eq!(parsed.projects[0].name, "Groceries");
        let tasks = &parsed.tasks["groceries"];
        assert_eq!(tasks.len(), 2);
        assert_ne!(
            tasks[0].id, tasks[1].id,
            "duplicate labels get distinct ids"
        );
    }

    #[test]
    fn expand_path_resolves_tilde_against_home() {
        let home = PathBuf::from("/home/alice");
        assert_eq!(
            expand_path_with("~/x/y.txt", Some(home.clone())),
            home.join("x/y.txt")
        );
        assert_eq!(expand_path_with("~", Some(home.clone())), home);
        assert_eq!(
            expand_path_with("/abs/path", Some(home)),
            PathBuf::from("/abs/path")
        );
        assert_eq!(
            expand_path_with("rel/path", None),
            PathBuf::from("rel/path")
        );
        // No resolvable home → the tilde is left as-is.
        assert_eq!(expand_path_with("~/x", None), PathBuf::from("~/x"));
        assert_eq!(expand_path_with("~", None), PathBuf::from("~"));
    }

    #[test]
    fn expand_path_uses_the_real_home() {
        // Exercises the thin wrapper that reads `dirs::home_dir()`.
        assert_eq!(
            expand_path("/already/absolute"),
            PathBuf::from("/already/absolute")
        );
    }

    #[test]
    fn slug_collapses_punctuation() {
        assert_eq!(slug("Back end (API)"), "back-end-api");
        assert_eq!(slug("  Spaces  "), "spaces");
        assert_eq!(slug("***"), "untitled");
        assert_eq!(slug("Café"), "café");
    }
}
