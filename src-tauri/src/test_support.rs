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
use tauri::test::{mock_builder, mock_context, noop_assets, MockRuntime};
#[cfg(not(target_os = "windows"))]
use tauri::{App, Manager};

pub use tempfile::TempDir;

use crate::rules::{Condition, Op, Rule, RuleAction, SignalSnapshot};
use crate::Db;
// AppState is only used by the cfg-gated mock_app rig — keep the
// import gated the same way so Windows doesn't see it as unused.
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
/// Returns the `TempDir` (keep it alive — dropping it deletes the on-
/// disk state files), the `App<MockRuntime>` (call `.handle()` for the
/// `AppHandle<MockRuntime>`), and a clone of the `Db`.
///
/// Not compiled on Windows — see `Cargo.toml`'s target-gated
/// `tauri = { features = ["test"] }` dev-dep for the rationale.
#[cfg(not(target_os = "windows"))]
pub async fn mock_app_with_db() -> (TempDir, App<MockRuntime>, Db) {
    let (dir, db) = test_db().await;
    let app = mock_builder()
        .build(mock_context(noop_assets()))
        .expect("mock_app builds");
    app.manage(AppState { db: db.clone() });
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
        calendar_event: None,
    }
}

pub fn snapshot_for_cairn() -> SignalSnapshot {
    SignalSnapshot {
        ide_folder: Some("~/code/cairn".into()),
        git_branch: Some("feat/rules-ui".into()),
        window_title: Some("rules.rs — cairn".into()),
        app_name: Some("Zed".into()),
        browser_domain: None,
        calendar_event: None,
    }
}

pub fn make_rule(id: &str, name: &str) -> Rule {
    Rule {
        id: id.into(),
        name: name.into(),
        enabled: true,
        priority: 0,
        when: vec![],
        then: RuleAction {
            project: None,
            tags: vec![],
            tags_from_calendar: false,
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
        when: vec![Condition::IdeFolder {
            op: Op::Contains,
            value: value.into(),
            any: false,
        }],
        then: RuleAction {
            project: Some(project.into()),
            tags: vec![],
            tags_from_calendar: false,
        },
    }
}
