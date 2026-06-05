//! Shared fixtures for unit + integration tests.
//!
//! Two roles:
//!
//! - `temp_dir()` — a scratch dir whose lifetime is bound to the test.
//!   A panicking test still gets the dir reaped by `tempfile`'s drop
//!   guard.
//! - `test_db()` / `mock_app_with_db()` — the integration-test rig.
//!   Both are thin wrappers around [`Db::open`]; the rig only owns the
//!   `TempDir` lifetime and the optional `mock_app` wrap. Keeping the
//!   builders in one place means every test goes through the same
//!   migration + seed path the runtime uses.
//!
//! The `mock_app_*` variant wraps the db in a `tauri::test::mock_app()`
//! so tests can drive code paths that need an `AppHandle` (event
//! emission, plugin wiring, `tauri::State` lookup, IPC dispatch).

#![cfg(test)]
#![allow(dead_code)]

use std::path::Path;

#[cfg(not(target_os = "windows"))]
use std::sync::atomic::AtomicBool;
#[cfg(not(target_os = "windows"))]
use std::sync::Arc;

#[cfg(not(target_os = "windows"))]
use tauri::test::{mock_builder, mock_context, noop_assets, MockRuntime};
#[cfg(not(target_os = "windows"))]
use tauri::{App, Manager};

pub use tempfile::TempDir;

use crate::rules::{Condition, Confidence, Op, Rule, RuleAction, SignalSnapshot};
use crate::Db;
// `CalendarRegistry` and `AppState` are only used by the cfg-gated
// mock_app rig — keep their imports gated the same way so Windows
// doesn't see them as unused.
#[cfg(not(target_os = "windows"))]
use crate::plugins::calendar::CalendarRegistry;
#[cfg(not(target_os = "windows"))]
use crate::AppState;

pub fn temp_dir() -> TempDir {
    tempfile::Builder::new()
        .prefix("cairn-test-")
        .tempdir()
        .expect("tempdir creation")
}

/// Open a fresh `Db` in a temp directory. Runs migrations + the
/// default seed (same code path as the runtime). The `TempDir` is
/// returned so the caller keeps it alive for the test's lifetime —
/// dropping it deletes the on-disk database.
pub async fn test_db() -> (TempDir, Db) {
    let dir = temp_dir();
    let db = Db::open(&dir.path().join("cairn.sqlite"))
        .await
        .expect("db open + migrate + seed");
    (dir, db)
}

/// Open a fresh `Db` at the given path. Use when a test needs a
/// stable filesystem location (e.g. backup / restore tests).
pub async fn test_db_at(path: &Path) -> Db {
    Db::open(path).await.expect("db open + migrate + seed")
}

/// Wrap a `Db` in a `tauri::test::mock_app()` so tests can drive code
/// paths that need an `AppHandle`: event emission, `tauri::State`
/// lookup, plugin wiring, IPC dispatch.
///
/// Id of the connector seeded into every `mock_app_with_db`, so the
/// PM-connector IPC commands have something to list. See
/// [`seed_connector_fixture`].
pub const FIXTURE_CONNECTOR_ID: &str = "sample-tasks";
/// A project id present in the seeded connector's todo file.
pub const FIXTURE_CONNECTOR_PROJECT_ID: &str = "cairn";

/// Seed a single local-file connector under `<data_dir>/connectors/` and
/// return a host loaded from it. Gives the connector IPC commands a known
/// connector to drive in tests without a network or keychain. Harmless to
/// tests that don't touch connectors — they simply never list it.
#[cfg(not(target_os = "windows"))]
fn seed_connector_fixture(data_dir: &std::path::Path) -> crate::connectors::ConnectorHost {
    let dir = data_dir.join("connectors");
    std::fs::create_dir_all(&dir).expect("create connectors dir");
    let todo = dir.join("sample.todo.txt");
    std::fs::write(
        &todo,
        "Write spec +cairn\nx Ship it +cairn\nBuy milk +groceries\n",
    )
    .expect("write fixture todo");
    let path_json = serde_json::to_string(&todo.to_string_lossy()).unwrap();
    let manifest = format!(
        r#"{{ "manifest": 1, "id": "{FIXTURE_CONNECTOR_ID}", "name": "Sample tasks",
              "kind": "file", "capabilities": [],
              "file": {{ "format": "todotxt", "path": {path_json} }} }}"#,
    );
    std::fs::write(dir.join("sample.json"), manifest).expect("write fixture manifest");
    crate::connectors::ConnectorHost::load(&dir)
}

/// Returns the `TempDir` (keep it alive — dropping it deletes the on-
/// disk state files), the `App<MockRuntime>` (call `.handle()` for the
/// `AppHandle<MockRuntime>`), and a clone of the `Db`.
///
/// Not compiled on Windows — see `Cargo.toml`'s target-gated
/// `tauri = { features = ["test"] }` dev-dep for the rationale.
#[cfg(not(target_os = "windows"))]
pub async fn mock_app_with_db() -> (TempDir, App<MockRuntime>, Db) {
    use std::sync::RwLock;

    let (dir, db) = test_db().await;
    let calendar =
        Arc::new(CalendarRegistry::new(db.pool.clone()).expect("calendar registry builds"));
    let exclusions = Arc::new(RwLock::new(
        crate::signals::exclusions::ExclusionMatcher::load(&db.pool).await,
    ));
    let stream = Arc::new(crate::signals::stream::spawn(
        exclusions.clone(),
        std::time::Duration::from_millis(50),
    ));
    let mut host = crate::plugins::SignalSourceHost::new();
    host.register(Box::new(crate::plugins::calendar::CalendarPlugin::new(
        calendar.clone(),
    )));
    let plugin_flags = crate::plugins::store::load_enabled(&db.pool).await;
    host.start_with(&plugin_flags, stream.event_sender());
    let plugin_host = Arc::new(tokio::sync::Mutex::new(host));
    let app = mock_builder()
        .build(mock_context(noop_assets()))
        .expect("mock_app builds");
    let rules_cache = Arc::new(RwLock::new(
        crate::signals::fanout::load_engine_rules(&db.pool)
            .await
            .expect("load_engine_rules: fresh test db"),
    ));
    let data_dir = dir.path().to_path_buf();
    let connector_host = Arc::new(seed_connector_fixture(&data_dir));
    app.manage(AppState {
        db: db.clone(),
        pinned: AtomicBool::new(false),
        calendar,
        stream,
        plugin_host,
        connector_host,
        capture: crate::signals::capture::SignalCapture::new(),
        data_dir,
        exclusions,
        exclusions_mutator: tokio::sync::Mutex::new(()),
        snoozer: Arc::new(std::sync::Mutex::new(crate::rules::Snoozer::new())),
        rules_cache,
        rules_mutator: tokio::sync::Mutex::new(()),
        git_watcher_status: std::sync::Mutex::new(crate::signals::git_watcher::build_status(
            &[],
            &[],
        )),
        git_watcher_handle: std::sync::Mutex::new(None),
        git_roots_mutator: tokio::sync::Mutex::new(()),
        last_idle: std::sync::Mutex::new(None),
        browser_extension: Arc::new(
            crate::signals::browser_extension::BrowserExtensionState::new(),
        ),
        auto_backup_lock: Arc::new(tokio::sync::Mutex::new(())),
    });
    (dir, app, db)
}

// -----------------------------------------------------------------
// Builders for the rules engine. Free functions instead of `Default`
// impls because each call site usually overrides one or two fields —
// `make_rule().with_condition(...)` reads better than mutating a
// `Default::default()` literal field-by-field.
// -----------------------------------------------------------------

pub fn make_snapshot() -> SignalSnapshot {
    SignalSnapshot {
        ide_folder: None,
        git_branch: None,
        window_title: None,
        app_name: None,
        browser_domain: None,
        calendar: vec![],
    }
}

pub fn snapshot_for_cairn() -> SignalSnapshot {
    SignalSnapshot {
        ide_folder: Some("~/code/cairn".into()),
        git_branch: Some("feat/rules-ui".into()),
        window_title: Some("rules.rs — cairn".into()),
        app_name: Some("Zed".into()),
        browser_domain: None,
        calendar: vec![],
    }
}

pub fn make_rule(id: &str, name: &str) -> Rule {
    Rule {
        id: id.into(),
        name: name.into(),
        enabled: true,
        priority: 0,
        confidence: Confidence::Suggestive,
        ambiguity_behavior: crate::rules::AmbiguityBehavior::Prompt,
        when: vec![],
        then: RuleAction {
            project: None,
            tags: vec![],
            tags_from_calendar: false,
            description_template: None,
        },
    }
}

/// Convenience: a single-condition rule matching IDE folder substring.
pub fn ide_folder_rule(id: &str, project: &str, value: &str) -> Rule {
    Rule {
        id: id.into(),
        name: format!("ide={value}"),
        enabled: true,
        priority: 0,
        confidence: Confidence::Suggestive,
        ambiguity_behavior: crate::rules::AmbiguityBehavior::Prompt,
        when: vec![Condition::IdeFolder {
            op: Op::Contains,
            value: value.into(),
            any: false,
        }],
        then: RuleAction {
            project: Some(project.into()),
            tags: vec![],
            tags_from_calendar: false,
            description_template: None,
        },
    }
}
