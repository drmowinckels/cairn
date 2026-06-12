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

pub mod builtin;
pub mod cache;
pub mod file;
pub mod http;
pub mod manifest;
pub mod params;
pub mod secret_state;
pub mod state;

use std::collections::BTreeMap;
use std::path::Path;

use serde::{Deserialize, Serialize};

pub use manifest::{ConnectorKind, ConnectorManifest, ParamSpec, SecretRef};

/// A connector's stored configuration params, keyed by the manifest's declared
/// param key (e.g. `owner` → `ggsegverse`). Passed to a connector's reads so the
/// declarative interpreter can substitute them into request templates and pick
/// request variants. Origin-agnostic: a connector that declares no params simply
/// receives an empty map. See [`ParamSpec`] and `docs/PM_CONNECTORS.md`.
pub type ConnectorParams = BTreeMap<String, String>;

/// A project as seen in the remote planner. `Deserialize` so it round-trips
/// through the offline [`cache`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteProject {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
}

/// A task as seen in the remote planner. `done` collapses the planner's
/// notion of completion to a bool; `status` keeps the raw label when one
/// exists. `Deserialize` so it round-trips through the offline [`cache`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteTask {
    pub id: String,
    pub label: String,
    pub url: Option<String>,
    pub status: Option<String>,
    pub done: bool,
}

/// Marker error meaning the connector's remote could not be contacted at all
/// (no network, DNS failure, connection refused, timeout, dropped response) —
/// as opposed to a remote that *answered* with an error status or unparseable
/// body. Carried in an [`anyhow::Error`] chain by the fetcher; the offline
/// cache falls back to a stale snapshot only for this case, so a rejected
/// token or a garbled response surfaces the real error instead of silently
/// serving stale data. See `is_unreachable`.
#[derive(Debug, thiserror::Error)]
#[error("the connector's remote could not be reached")]
pub struct Unreachable;

/// Whether `err` (or any cause in its chain) is an [`Unreachable`].
pub fn is_unreachable(err: &anyhow::Error) -> bool {
    err.chain().any(|cause| cause.is::<Unreachable>())
}

/// A connector read paired with its freshness, returned to the UI. `stale`
/// means the live read failed and these items came from the offline
/// [`cache`]; `fetched_at` is when the cached snapshot (or this read) was
/// taken (RFC 3339), or `None` for a fresh read with no clock involved.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CachedList<T> {
    pub items: Vec<T>,
    pub stale: bool,
    pub fetched_at: Option<String>,
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

/// Whether one of a connector's secrets is present, for the settings UI. The
/// token itself never crosses this boundary — only its state does. (A
/// connector that needs no secret has an empty `secrets` list, so there is no
/// "not required" state per secret.)
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SecretState {
    /// A token is required but none is stored yet.
    Missing,
    /// A token is stored in the keychain.
    Set,
}

/// One secret a connector needs, with its current presence — what the
/// settings card renders a field for. The token never crosses this boundary,
/// only whether it is `Set`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SecretView {
    /// The keychain key, passed back to set/clear this specific secret.
    pub key: String,
    /// Human label for the field (e.g. "API token", or a Trello param name).
    pub label: String,
    /// `Set` if a token is stored, else `Missing`. Never `NotRequired` — a
    /// connector with no secrets simply has an empty `secrets` list.
    pub state: SecretState,
}

/// One configuration param a connector declares, with its stored value — what
/// the settings card renders an editable field for. Unlike a secret, the value
/// is not sensitive, so it round-trips: shown back so the user can see and edit
/// it. An empty `value` means unset.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ParamView {
    /// The manifest's param key, passed back to set/clear this param.
    pub key: String,
    /// Human label for the field (e.g. "GitHub user or organisation").
    pub label: String,
    /// Optional placeholder hint for the input.
    pub placeholder: Option<String>,
    /// The stored value, or the empty string when unset.
    pub value: String,
}

/// A connector manifest plus the state of each secret it needs — what
/// `list_connectors` hands the settings card so it can render a "needs token"
/// affordance per secret without any token leaving the backend. An empty
/// `secrets` means the connector needs none (a local file, or `auth: none`);
/// an empty `params` means it declares no configuration fields.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ConnectorView {
    #[serde(flatten)]
    pub manifest: ConnectorManifest,
    pub secrets: Vec<SecretView>,
    /// The connector's declared configuration params, each with its stored
    /// value. Editable in the settings card; unlike secrets, values round-trip.
    pub params: Vec<ParamView>,
    /// Whether the user has this connector enabled. A disabled connector is
    /// listed (with its toggle) but makes no requests — browsing is refused.
    pub enabled: bool,
}

/// Resolve a [`SecretView`] per secret a connector declares (key + label),
/// reading presence from the DB-backed flags ([`secret_state`]) — NOT the
/// keychain, which would re-prompt for access on every macOS dev rebuild.
/// Pure over the flags map so it is unit-tested without any store.
pub fn secret_views(
    refs: &[SecretRef<'_>],
    present: &std::collections::HashMap<String, bool>,
) -> Vec<SecretView> {
    refs.iter()
        .map(|r| SecretView {
            key: r.key.to_string(),
            label: r.label.to_string(),
            state: if secret_state::is_present(present, r.key) {
                SecretState::Set
            } else {
                SecretState::Missing
            },
        })
        .collect()
}

/// Resolve a [`ParamView`] per param a connector declares, filling each with its
/// stored value (or the empty string when unset). Pure over the stored map so it
/// is unit-tested without a store.
pub fn param_views(specs: &[ParamSpec], stored: &ConnectorParams) -> Vec<ParamView> {
    specs
        .iter()
        .map(|spec| ParamView {
            key: spec.key.clone(),
            label: spec.label.clone(),
            placeholder: spec.placeholder.clone(),
            value: stored.get(&spec.key).cloned().unwrap_or_default(),
        })
        .collect()
}

/// Validate then store a connector's token. Rejects a connector that takes
/// no token (a local file, or `auth.type == none`) and an empty/whitespace
/// token, which would persist a useless credential. The token is trimmed
/// before storing. Pure over the writer so it is unit-tested with a fake.
pub fn store_secret(
    secret_key: Option<&str>,
    token: &str,
    writer: &dyn http::SecretWriter,
) -> Result<(), String> {
    let key = secret_key.ok_or("this connector does not take a token")?;
    let token = token.trim();
    if token.is_empty() {
        return Err("token must not be empty".to_string());
    }
    writer.set(key, token)
}

/// Remove a connector's stored token. Rejects a connector that takes none.
/// Pure over the writer so it is unit-tested with a fake.
pub fn remove_secret(
    secret_key: Option<&str>,
    writer: &dyn http::SecretWriter,
) -> Result<(), String> {
    let key = secret_key.ok_or("this connector does not take a token")?;
    writer.clear(key)
}

/// What the rest of Cairn talks to, regardless of how a connector is
/// implemented (built-in, local file, or the declarative interpreter).
/// Async because real connectors do network I/O; the file connector
/// simply doesn't await anything.
#[async_trait::async_trait]
pub trait PmConnector: Send + Sync {
    /// Identity + declared capabilities, for the settings UI.
    fn manifest(&self) -> &ConnectorManifest;

    /// Every project the connector can see. `params` are the connector's stored
    /// configuration values (e.g. the GitHub `owner`); a connector that declares
    /// none ignores the map.
    async fn list_projects(&self, params: &ConnectorParams) -> anyhow::Result<Vec<RemoteProject>>;

    /// Every task in one project. `params` as for [`list_projects`].
    ///
    /// [`list_projects`]: PmConnector::list_projects
    async fn list_tasks(
        &self,
        project: &RemoteProjectRef,
        params: &ConnectorParams,
    ) -> anyhow::Result<Vec<RemoteTask>>;
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

    /// Build a host from every `*.json` manifest in `dir`, plus the
    /// compiled-in [`builtin`] connectors. User manifests load first and
    /// win on an id clash, so a user can override a builtin by dropping a
    /// same-id file. A missing dir is the normal "no user connectors"
    /// state — the builtins still load. A single unparseable or unsupported
    /// user manifest is logged and skipped; one bad file must not hide the
    /// others.
    pub fn load(dir: &Path) -> Self {
        let mut host = Self::new();
        match std::fs::read_dir(dir) {
            Ok(entries) => {
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
            }
            // An absent dir is the normal "no user connectors" state;
            // anything else (not a dir, permission denied) is a
            // misconfiguration worth surfacing rather than hiding.
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => {
                log::warn!("connector dir {dir:?} unreadable: {e}");
            }
            Err(_) => {}
        }
        host.register_manifests(builtin::ALL);
        host
    }

    /// Parse + register each raw JSON manifest, skipping any that fails to
    /// parse (id-clash dedup is handled by [`register`]). Used for the
    /// compiled-in builtins; a parse failure there is a build-time authoring
    /// bug, so it is logged at `error` rather than silently dropped.
    ///
    /// [`register`]: Self::register
    fn register_manifests(&mut self, manifests: &[&str]) {
        for json in manifests {
            match ConnectorManifest::from_json(json) {
                Ok(manifest) => self.register(build(manifest)),
                Err(e) => log::error!("bundled connector manifest is invalid: {e}"),
            }
        }
    }

    /// Register a connector unless one with the same id is already present —
    /// first registration wins. This is the single place the host's id-
    /// uniqueness invariant is enforced, so every source (user dir files,
    /// then builtins) gets it: a user manifest loaded first shadows a same-id
    /// builtin, and a duplicate id never registers twice.
    pub fn register(&mut self, connector: Box<dyn PmConnector>) {
        let id = &connector.manifest().id;
        if self.get(id).is_some() {
            log::debug!("connector '{id}' already registered; skipping duplicate");
            return;
        }
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

/// Map a validated manifest to its interpreter: the local-file connector
/// or the declarative HTTP connector (production reqwest fetcher + keychain
/// secret store).
fn build(manifest: ConnectorManifest) -> Box<dyn PmConnector> {
    match &manifest.kind {
        ConnectorKind::File(_) => Box::new(file::FileConnector::new(manifest)),
        ConnectorKind::Http(_) => Box::new(http::DeclarativeConnector::new(
            manifest,
            http::ReqwestFetcher::new(),
            http::KeychainStore::new(),
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::connectors::http::{SecretStore, SecretWriter};
    use crate::test_support::{temp_dir, FakeKeychain};
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
    fn load_missing_dir_yields_only_builtins() {
        // No user dir means no user connectors, but the compiled-in
        // builtins still load — they ship with the app, not the data dir.
        let host = ConnectorHost::load(Path::new("/no/such/connectors/dir"));
        assert_eq!(host.len(), builtin::ALL.len());
        assert!(host.get("github-projects").is_some());
    }

    #[test]
    fn load_path_that_is_a_file_yields_only_builtins() {
        // A non-directory (here: a regular file) is a misconfiguration,
        // not the expected "absent dir" — it logs and falls back to just
        // the builtins rather than erroring out.
        let dir = temp_dir();
        let not_a_dir = dir.path().join("connectors");
        write_file(dir.path(), "connectors", "i am a file, not a dir");
        let host = ConnectorHost::load(&not_a_dir);
        assert_eq!(host.len(), builtin::ALL.len());
        assert!(host.get("github-projects").is_some());
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
        // Two user connectors + the compiled-in builtins.
        assert_eq!(host.len(), 2 + builtin::ALL.len());
        assert!(host.get("remote").is_some(), "http connector is runnable");
        assert!(host.get("github-projects").is_some(), "builtins load too");

        let connector = host.get("good").expect("registered by id");
        let projects = connector
            .list_projects(&ConnectorParams::new())
            .await
            .unwrap();
        assert_eq!(projects.len(), 1);
        assert_eq!(projects[0].name, "groceries");

        assert!(host.get("missing").is_none());
    }

    #[test]
    fn builtins_all_parse_and_ship_github_projects() {
        for json in builtin::ALL {
            ConnectorManifest::from_json(json)
                .expect("every bundled manifest must parse — a failure is an authoring bug");
        }
        let gh = ConnectorManifest::from_json(builtin::GITHUB_PROJECTS).unwrap();
        assert_eq!(gh.id, "github-projects");
        assert_eq!(gh.secret_key(), Some("github_token"));
        let spec = gh
            .kind
            .as_http()
            .expect("github-projects is an http connector");
        assert_eq!(spec.base_url, "https://api.github.com");
    }

    #[test]
    fn register_manifests_skips_an_unparseable_builtin() {
        let mut host = ConnectorHost::new();
        host.register_manifests(&["{ not json"]);
        assert!(host.is_empty(), "an invalid bundled manifest is dropped");
    }

    #[test]
    fn a_user_manifest_overrides_a_same_id_builtin() {
        let dir = temp_dir();
        let todo = dir.path().join("todo.txt");
        write_file(dir.path(), "todo.txt", "Task +github-projects\n");
        // A user file claiming the builtin's id wins — it loads first, so
        // the builtin is skipped on the id clash.
        write_file(
            dir.path(),
            "mine.json",
            &manifest_for("github-projects", &todo),
        );

        let host = ConnectorHost::load(dir.path());
        let gh = host.get("github-projects").expect("present");
        assert!(
            gh.manifest().kind.as_file().is_some(),
            "the user's file connector replaced the bundled http one"
        );
        assert_eq!(host.len(), builtin::ALL.len(), "no duplicate id registered");
    }

    #[test]
    fn register_skips_a_duplicate_id_first_wins() {
        let dir = temp_dir();
        let todo = dir.path().join("todo.txt");
        write_file(dir.path(), "todo.txt", "Task +dup\n");
        // Two user files claiming the same id register only once.
        write_file(dir.path(), "a.json", &manifest_for("dup", &todo));
        write_file(dir.path(), "b.json", &manifest_for("dup", &todo));

        let host = ConnectorHost::load(dir.path());
        assert_eq!(
            host.len(),
            1 + builtin::ALL.len(),
            "a duplicate id is registered once, not twice"
        );
        assert!(host.get("dup").is_some());
    }

    #[test]
    fn every_bundled_manifest_file_is_listed_in_all() {
        // Guard against adding a `manifests/*.json` and forgetting to wire it
        // into `builtin::ALL` (which is what actually gets registered).
        let dir = concat!(env!("CARGO_MANIFEST_DIR"), "/src/connectors/manifests");
        let registered: Vec<String> = builtin::ALL
            .iter()
            .map(|json| ConnectorManifest::from_json(json).unwrap().id)
            .collect();
        let json_files = std::fs::read_dir(dir)
            .unwrap()
            .flatten()
            .map(|entry| entry.path())
            .filter(|path| path.extension().and_then(|e| e.to_str()) == Some("json"));
        for path in json_files {
            let json = std::fs::read_to_string(&path).unwrap();
            let id = ConnectorManifest::from_json(&json).unwrap().id;
            assert!(
                registered.contains(&id),
                "manifest file {path:?} (id {id:?}) is not in builtin::ALL"
            );
        }
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

    #[test]
    fn secret_views_reflect_need_and_presence_per_secret() {
        use std::collections::HashMap;
        // No declared secrets → empty (the connector needs none).
        assert!(secret_views(&[], &HashMap::new()).is_empty());

        let refs = [
            SecretRef {
                key: "trello_key",
                label: "key",
            },
            SecretRef {
                key: "trello_token",
                label: "token",
            },
        ];
        // Presence comes from the DB-backed flags, not the keychain: the key
        // is recorded present, the token is not.
        let present = HashMap::from([("trello_key".to_string(), true)]);
        let views = secret_views(&refs, &present);
        assert_eq!(views.len(), 2);
        assert_eq!(views[0].key, "trello_key");
        assert_eq!(views[0].label, "key");
        assert_eq!(views[0].state, SecretState::Set);
        // The second is declared but not yet stored.
        assert_eq!(views[1].key, "trello_token");
        assert_eq!(views[1].state, SecretState::Missing);
    }

    #[test]
    fn param_views_fill_each_declared_param_with_its_stored_value() {
        use manifest::ParamSpec;
        // No declared params → empty.
        assert!(param_views(&[], &ConnectorParams::new()).is_empty());

        let specs = [
            ParamSpec {
                key: "owner".to_string(),
                label: "Owner".to_string(),
                placeholder: Some("e.g. ggsegverse".to_string()),
            },
            ParamSpec {
                key: "repo".to_string(),
                label: "Repo".to_string(),
                placeholder: None,
            },
        ];
        // Only `owner` is stored; `repo` falls back to the empty string.
        let stored = ConnectorParams::from([("owner".to_string(), "ggsegverse".to_string())]);
        let views = param_views(&specs, &stored);
        assert_eq!(views.len(), 2);
        assert_eq!(views[0].key, "owner");
        assert_eq!(views[0].label, "Owner");
        assert_eq!(views[0].placeholder.as_deref(), Some("e.g. ggsegverse"));
        assert_eq!(views[0].value, "ggsegverse");
        assert_eq!(views[1].key, "repo");
        assert_eq!(views[1].value, "", "an unset param reads as empty");
    }

    #[test]
    fn store_secret_writes_a_trimmed_token() {
        let kc = FakeKeychain::default();
        store_secret(Some("github_token"), "  ghp_x  ", &kc).unwrap();
        assert_eq!(kc.token("github_token").as_deref(), Some("ghp_x"));
    }

    #[test]
    fn store_secret_rejects_a_tokenless_connector() {
        let kc = FakeKeychain::default();
        assert!(store_secret(None, "ghp_x", &kc).is_err());
    }

    #[test]
    fn store_secret_rejects_an_empty_token() {
        let kc = FakeKeychain::default();
        assert!(store_secret(Some("github_token"), "   ", &kc).is_err());
        assert_eq!(kc.token("github_token"), None, "nothing is stored");
    }

    #[test]
    fn remove_secret_clears_and_rejects_tokenless() {
        let kc = FakeKeychain::default();
        kc.set("github_token", "ghp_x").unwrap();
        remove_secret(Some("github_token"), &kc).unwrap();
        assert_eq!(kc.token("github_token"), None);
        assert!(remove_secret(None, &kc).is_err());
    }
}
