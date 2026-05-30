//! Backup, restore, CSV export, and "delete everything" for the
//! local SQLite database.
//!
//! Restore is staged: the imported file is written next to
//! `cairn.sqlite` as `cairn.sqlite.pending`, and the swap happens at
//! the next startup (see [`apply_pending_import`]). This avoids the
//! complexity of closing and reopening the sqlx pool at runtime while
//! still letting users round-trip a backup through a cloud-synced
//! folder.

use std::path::{Path, PathBuf};

use chrono::Utc;
use serde::Serialize;
use sqlx::{Row, SqlitePool};
use tauri::{Manager, State};
use tauri_plugin_opener::OpenerExt;
use tokio::io::AsyncWriteExt;

use crate::AppState;

pub const PENDING_SUFFIX: &str = ".pending";
pub const BACKUP_SUFFIX: &str = ".bak";
pub const DEBUG_SIGNALS_FILE: &str = "debug-signals.ndjson";

/// Names the user is allowed to see under `data_dir` when they click
/// "View what's stored". Issue #24 fixes this set: the live DB and its
/// SQLite sidecars, the staged restore, the rotation backup, and the
/// opt-in raw signal log. Anything else in the directory is intentionally
/// kept off the list — exposing arbitrary files would defeat the purpose
/// of the privacy contract by letting future leakage hide in plain sight.
const LISTABLE_FILES: [&str; 7] = [
    "cairn.sqlite",
    "cairn.sqlite-wal",
    "cairn.sqlite-shm",
    "cairn.sqlite-journal",
    "cairn.sqlite.pending",
    "cairn.sqlite.bak",
    DEBUG_SIGNALS_FILE,
];

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DataFileInfo {
    pub name: String,
    pub size_bytes: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DataPaths {
    pub data_dir: PathBuf,
    pub db_path: PathBuf,
    pub pending_import: Option<PathBuf>,
}

pub fn db_path(data_dir: &Path) -> PathBuf {
    data_dir.join("cairn.sqlite")
}

pub fn pending_import_path(data_dir: &Path) -> PathBuf {
    data_dir.join(format!("cairn.sqlite{PENDING_SUFFIX}"))
}

pub fn backup_path(data_dir: &Path) -> PathBuf {
    data_dir.join(format!("cairn.sqlite{BACKUP_SUFFIX}"))
}

/// At startup, if a staged import exists, replace the live DB with it
/// (saving the previous one to `cairn.sqlite.bak`). Idempotent.
pub fn apply_pending_import(data_dir: &Path) -> std::io::Result<()> {
    let pending = pending_import_path(data_dir);
    if !pending.exists() {
        return Ok(());
    }
    let live = db_path(data_dir);
    let backup = backup_path(data_dir);
    if live.exists() {
        if backup.exists() {
            std::fs::remove_file(&backup)?;
        }
        std::fs::rename(&live, &backup)?;
    }
    std::fs::rename(&pending, &live)?;
    log::info!("backup: applied pending import → {live:?} (previous saved to {backup:?})");
    Ok(())
}

// ── Plain-function cores (no Tauri types) ─────────────────────────────

/// Take a consistent SQLite snapshot of `pool` to `dest`. `VACUUM
/// INTO` is the SQLite-blessed primitive — it handles WAL and
/// in-flight transactions correctly, which a raw file copy does not.
pub async fn vacuum_into(pool: &SqlitePool, dest: &Path) -> Result<(), String> {
    if let Some(parent) = dest.parent() {
        if !parent.as_os_str().is_empty() {
            tokio::fs::create_dir_all(parent).await.map_err(err)?;
        }
    }
    sqlx::query("VACUUM INTO ?1")
        .bind(dest.to_string_lossy().to_string())
        .execute(pool)
        .await
        .map_err(err)?;
    Ok(())
}

/// Copy a user-selected SQLite file into the data dir as
/// `cairn.sqlite.pending`. The swap happens on next launch.
pub async fn stage_import_at(data_dir: &Path, src: &Path) -> Result<PathBuf, String> {
    if !src.exists() {
        return Err(format!("source file does not exist: {src:?}"));
    }
    validate_sqlite_header(src).await?;
    tokio::fs::create_dir_all(data_dir).await.map_err(err)?;
    let dest = pending_import_path(data_dir);
    if dest.exists() {
        tokio::fs::remove_file(&dest).await.map_err(err)?;
    }
    tokio::fs::copy(src, &dest).await.map_err(err)?;
    Ok(dest)
}

/// Long-format CSV: one row per entry. Tabular tools (pandas / dplyr /
/// Excel) and invoice plugins (see issue #1) consume this directly.
pub async fn export_csv_to(pool: &SqlitePool, dest: &Path) -> Result<(), String> {
    if let Some(parent) = dest.parent() {
        if !parent.as_os_str().is_empty() {
            tokio::fs::create_dir_all(parent).await.map_err(err)?;
        }
    }

    let rows = sqlx::query(
        r#"
        SELECT e.id,
               e.started_at,
               e.ended_at,
               c.name AS client,
               p.name AS project,
               t.name AS task,
               e.description,
               e.source
          FROM entries e
          LEFT JOIN projects p ON p.id = e.project_id
          LEFT JOIN clients  c ON c.id = p.client_id
          LEFT JOIN tasks    t ON t.id = e.task_id
         ORDER BY e.started_at ASC
        "#,
    )
    .fetch_all(pool)
    .await
    .map_err(err)?;

    let mut file = tokio::fs::File::create(dest).await.map_err(err)?;
    file.write_all(b"entry_id,started_at,ended_at,client,project,task,description,source\n")
        .await
        .map_err(err)?;

    for row in rows {
        let id: String = row.get("id");
        let started: String = row.get("started_at");
        let ended: Option<String> = row.get("ended_at");
        let client: Option<String> = row.get("client");
        let project: Option<String> = row.get("project");
        let task: Option<String> = row.get("task");
        let description: String = row.get("description");
        let source: String = row.get("source");
        let line = format!(
            "{},{},{},{},{},{},{},{}\n",
            csv_escape(&id),
            csv_escape(&started),
            csv_escape(ended.as_deref().unwrap_or("")),
            csv_escape(client.as_deref().unwrap_or("")),
            csv_escape(project.as_deref().unwrap_or("")),
            csv_escape(task.as_deref().unwrap_or("")),
            csv_escape(&description),
            csv_escape(&source),
        );
        file.write_all(line.as_bytes()).await.map_err(err)?;
    }
    file.flush().await.map_err(err)?;
    Ok(())
}

/// Inspect `data_dir` and return metadata (no content reads) for every
/// known-listable file that currently exists, in the canonical order
/// declared by `LISTABLE_FILES`. Issue #24. Missing files are simply
/// omitted so the UI doesn't have to filter zero-sized placeholders.
pub fn list_data_files_in(data_dir: &Path) -> Vec<DataFileInfo> {
    LISTABLE_FILES
        .iter()
        .filter_map(|name| {
            let path = data_dir.join(name);
            let meta = std::fs::metadata(&path).ok()?;
            if !meta.is_file() {
                return None;
            }
            Some(DataFileInfo {
                name: (*name).to_string(),
                size_bytes: meta.len(),
            })
        })
        .collect()
}

// ── Tauri command wrappers ────────────────────────────────────────────

#[tauri::command]
pub async fn data_paths(app: tauri::AppHandle) -> Result<DataPaths, String> {
    let data_dir = app.path().app_data_dir().map_err(err)?;
    let pending = pending_import_path(&data_dir);
    Ok(DataPaths {
        data_dir: data_dir.clone(),
        db_path: db_path(&data_dir),
        pending_import: pending.exists().then_some(pending),
    })
}

#[tauri::command]
pub async fn export_backup(state: State<'_, AppState>, dest: String) -> Result<String, String> {
    let dest = PathBuf::from(dest);
    vacuum_into(&state.db.pool, &dest).await?;
    Ok(dest.to_string_lossy().to_string())
}

#[tauri::command]
pub async fn stage_import(app: tauri::AppHandle, src: String) -> Result<String, String> {
    let data_dir = app.path().app_data_dir().map_err(err)?;
    let dest = stage_import_at(&data_dir, &PathBuf::from(src)).await?;
    Ok(dest.to_string_lossy().to_string())
}

#[tauri::command]
pub async fn cancel_pending_import(app: tauri::AppHandle) -> Result<(), String> {
    let data_dir = app.path().app_data_dir().map_err(err)?;
    let pending = pending_import_path(&data_dir);
    if pending.exists() {
        tokio::fs::remove_file(&pending).await.map_err(err)?;
    }
    Ok(())
}

#[tauri::command]
pub async fn export_csv(state: State<'_, AppState>, dest: String) -> Result<String, String> {
    let dest = PathBuf::from(dest);
    export_csv_to(&state.db.pool, &dest).await?;
    Ok(dest.to_string_lossy().to_string())
}

#[tauri::command]
pub async fn delete_everything(app: tauri::AppHandle) -> Result<(), String> {
    let state = app.state::<AppState>();
    reset_all_data(state.inner()).await?;
    log::info!("backup: reset all data in place");
    Ok(())
}

/// Wipe every user record and return the app to a fresh-install state,
/// IN PLACE on the live pool — no file delete, no exit, no restart.
///
/// `app.exit(0)` tore the app down ("delete crashed it"); `app.restart()`
/// races the single-instance socket on relaunch and aborts in
/// `did_finish_launching`. Wiping rows keeps the tray + popover alive and
/// the pool valid, so this is the safe reset path. Split out from the
/// `#[tauri::command]` (which needs a Wry `AppHandle`) so it is testable
/// against a mock-runtime `AppState`.
pub(crate) async fn reset_all_data(state: &AppState) -> Result<(), String> {
    // 1. Purge calendar-URL bearer secrets from the OS keychain *first* —
    //    once the `calendar_sources` rows are gone we can no longer
    //    enumerate which `cairn-calendar/<id>` entries to drop, and they'd
    //    orphan holding the full subscription URL + token.
    purge_calendar_secrets(&state.db.pool).await;

    // 2. Wipe every user table.
    wipe_user_tables(&state.db.pool).await?;

    // 3. Re-arm onboarding (the marker row is UPDATEd, never deleted —
    //    every onboarding command targets `WHERE singleton = 1`).
    sqlx::query("UPDATE app_state SET completed_at = NULL WHERE singleton = 1")
        .execute(&state.db.pool)
        .await
        .map_err(err)?;

    // 4. Re-seed default clients/projects for fresh-install parity.
    crate::db::seed_if_empty(&state.db.pool)
        .await
        .map_err(err)?;

    // 5. Reload the in-memory caches so the running session reflects the
    //    wiped + reseeded DB rather than stale rules/exclusions/snoozes.
    let fresh_exclusions = crate::signals::exclusions::ExclusionMatcher::load(&state.db.pool).await;
    if let Ok(mut guard) = state.exclusions.write() {
        *guard = fresh_exclusions;
    }
    if let Ok(fresh_rules) = crate::signals::fanout::load_engine_rules(&state.db.pool).await {
        if let Ok(mut guard) = state.rules_cache.write() {
            *guard = fresh_rules;
        }
    }
    if let Ok(mut snoozer) = state.snoozer.lock() {
        *snoozer = crate::rules::Snoozer::default();
    }

    // 6. Remove on-disk user-data copies that live beside the DB: a staged
    //    restore, the rotation backup, and the debug capture log. The live
    //    DB stays — its rows were wiped in place above.
    for path in [
        pending_import_path(&state.data_dir),
        backup_path(&state.data_dir),
        state.data_dir.join(DEBUG_SIGNALS_FILE),
    ] {
        if path.exists() {
            let _ = std::fs::remove_file(&path);
        }
    }
    Ok(())
}

/// Delete every row from the user tables, leaving the schema, the
/// migration ledger, and the `app_state` onboarding marker intact.
/// Foreign-key enforcement is disabled for the duration so deletion
/// order is irrelevant; the PRAGMA is connection-scoped, so every
/// statement runs on a single acquired connection.
async fn wipe_user_tables(pool: &SqlitePool) -> Result<(), String> {
    let names: Vec<String> = sqlx::query_scalar(
        "SELECT name FROM sqlite_master \
         WHERE type = 'table' \
           AND name NOT LIKE 'sqlite_%' \
           AND name NOT IN ('_sqlx_migrations', 'app_state')",
    )
    .fetch_all(pool)
    .await
    .map_err(err)?;

    let mut conn = pool.acquire().await.map_err(err)?;
    sqlx::query("PRAGMA foreign_keys = OFF")
        .execute(&mut *conn)
        .await
        .map_err(err)?;
    for table in &names {
        // Names come from sqlite_master, never user input; DELETE can't
        // bind an identifier, so interpolation is the only option.
        sqlx::query(&format!("DELETE FROM \"{table}\""))
            .execute(&mut *conn)
            .await
            .map_err(err)?;
    }
    sqlx::query("PRAGMA foreign_keys = ON")
        .execute(&mut *conn)
        .await
        .map_err(err)?;
    Ok(())
}

async fn purge_calendar_secrets(pool: &SqlitePool) {
    let rows = match sqlx::query("SELECT id FROM calendar_sources WHERE kind = 'url'")
        .fetch_all(pool)
        .await
    {
        Ok(r) => r,
        Err(e) => {
            log::warn!("delete_everything: could not enumerate calendar_sources: {e}");
            return;
        }
    };
    for row in rows {
        let id: String = row.get("id");
        if let Err(e) = crate::signals::calendar::secrets::remove(&id) {
            log::warn!("delete_everything: could not remove keychain entry {id}: {e}");
        }
    }
}

#[tauri::command]
pub async fn suggested_backup_name() -> String {
    format!("cairn-{}.sqlite", Utc::now().format("%Y-%m-%d-%H%M%S"))
}

#[tauri::command]
pub async fn suggested_csv_name() -> String {
    format!("cairn-entries-{}.csv", Utc::now().format("%Y-%m-%d"))
}

#[tauri::command]
pub async fn list_data_files(app: tauri::AppHandle) -> Result<Vec<DataFileInfo>, String> {
    let data_dir = app.path().app_data_dir().map_err(err)?;
    Ok(list_data_files_in(&data_dir))
}

#[tauri::command]
pub async fn reveal_data_folder(app: tauri::AppHandle) -> Result<(), String> {
    let data_dir = app.path().app_data_dir().map_err(err)?;
    // Reveal the live SQLite file when it exists so the platform file
    // manager highlights it; fall back to the directory itself for a
    // freshly-installed user with no DB yet.
    let target = {
        let live = db_path(&data_dir);
        if live.exists() {
            live
        } else {
            data_dir
        }
    };
    app.opener().reveal_item_in_dir(&target).map_err(err)?;
    Ok(())
}

// ── Helpers ───────────────────────────────────────────────────────────

async fn validate_sqlite_header(path: &Path) -> Result<(), String> {
    let mut file = tokio::fs::File::open(path).await.map_err(err)?;
    let mut header = [0u8; 16];
    use tokio::io::AsyncReadExt;
    file.read_exact(&mut header).await.map_err(err)?;
    if &header != b"SQLite format 3\0" {
        return Err("file is not a SQLite database".into());
    }
    Ok(())
}

fn csv_escape(s: &str) -> String {
    if s.contains(',') || s.contains('"') || s.contains('\n') {
        let escaped = s.replace('"', "\"\"");
        format!("\"{escaped}\"")
    } else {
        s.to_string()
    }
}

fn err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Db;
    use chrono::Utc;

    #[test]
    fn csv_escapes_commas_and_quotes() {
        assert_eq!(csv_escape("plain"), "plain");
        assert_eq!(csv_escape("has,comma"), "\"has,comma\"");
        assert_eq!(csv_escape("has\"quote"), "\"has\"\"quote\"");
        assert_eq!(csv_escape("line\nbreak"), "\"line\nbreak\"");
    }

    #[tokio::test]
    async fn validate_rejects_non_sqlite() {
        let tmp = tempfile::NamedTempFile::new().unwrap();
        tokio::fs::write(tmp.path(), b"not a database at all")
            .await
            .unwrap();
        assert!(validate_sqlite_header(tmp.path()).await.is_err());
    }

    #[tokio::test]
    async fn validate_accepts_real_sqlite_header() {
        let tmp = tempfile::NamedTempFile::new().unwrap();
        let mut header = Vec::from(b"SQLite format 3\0".as_slice());
        header.extend(vec![0u8; 100]);
        tokio::fs::write(tmp.path(), &header).await.unwrap();
        assert!(validate_sqlite_header(tmp.path()).await.is_ok());
    }

    #[test]
    fn apply_pending_swaps_files_and_keeps_backup() {
        let dir = tempfile::tempdir().unwrap();
        let live = db_path(dir.path());
        let pending = pending_import_path(dir.path());
        let backup = backup_path(dir.path());

        std::fs::write(&live, b"OLD").unwrap();
        std::fs::write(&pending, b"NEW").unwrap();

        apply_pending_import(dir.path()).unwrap();

        assert_eq!(std::fs::read(&live).unwrap(), b"NEW");
        assert_eq!(std::fs::read(&backup).unwrap(), b"OLD");
        assert!(!pending.exists());
    }

    #[test]
    fn apply_pending_is_noop_when_nothing_staged() {
        let dir = tempfile::tempdir().unwrap();
        let live = db_path(dir.path());
        std::fs::write(&live, b"OLD").unwrap();
        apply_pending_import(dir.path()).unwrap();
        assert_eq!(std::fs::read(&live).unwrap(), b"OLD");
        assert!(!backup_path(dir.path()).exists());
    }

    #[test]
    fn list_data_files_empty_dir_yields_empty_vec() {
        let dir = tempfile::tempdir().unwrap();
        assert!(list_data_files_in(dir.path()).is_empty());
    }

    #[test]
    fn list_data_files_returns_known_files_with_sizes_in_canonical_order() {
        let dir = tempfile::tempdir().unwrap();
        // Drop a subset: live db (3 bytes), wal (5 bytes), debug-signals (7 bytes).
        std::fs::write(dir.path().join("cairn.sqlite"), b"abc").unwrap();
        std::fs::write(dir.path().join("cairn.sqlite-wal"), b"abcde").unwrap();
        std::fs::write(dir.path().join(DEBUG_SIGNALS_FILE), b"abcdefg").unwrap();
        // An unrelated file should never appear — privacy contract.
        std::fs::write(dir.path().join("README.txt"), b"x").unwrap();

        let listed = list_data_files_in(dir.path());
        let names: Vec<&str> = listed.iter().map(|f| f.name.as_str()).collect();
        assert_eq!(
            names,
            vec!["cairn.sqlite", "cairn.sqlite-wal", DEBUG_SIGNALS_FILE]
        );

        let sizes: Vec<u64> = listed.iter().map(|f| f.size_bytes).collect();
        assert_eq!(sizes, vec![3, 5, 7]);
    }

    #[test]
    fn list_data_files_ignores_directories_with_matching_name() {
        let dir = tempfile::tempdir().unwrap();
        // A directory named like a tracked file must not be listed.
        std::fs::create_dir(dir.path().join("cairn.sqlite")).unwrap();
        assert!(list_data_files_in(dir.path()).is_empty());
    }

    #[test]
    fn list_data_files_skips_unrelated_files_only_tracking_the_canonical_set() {
        let dir = tempfile::tempdir().unwrap();
        // Files outside the canonical set.
        std::fs::write(dir.path().join("cairn.log"), b"x").unwrap();
        std::fs::write(dir.path().join("cairn.sqlite.bak.old"), b"x").unwrap();
        std::fs::write(dir.path().join("secret.env"), b"x").unwrap();
        assert!(list_data_files_in(dir.path()).is_empty());
    }

    #[test]
    fn list_data_files_includes_pending_and_bak() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(pending_import_path(dir.path()), b"NEW").unwrap();
        std::fs::write(backup_path(dir.path()), b"OLD-").unwrap();
        let listed = list_data_files_in(dir.path());
        let names: Vec<&str> = listed.iter().map(|f| f.name.as_str()).collect();
        assert!(names.contains(&"cairn.sqlite.pending"));
        assert!(names.contains(&"cairn.sqlite.bak"));
    }

    #[cfg(not(target_os = "windows"))]
    #[tokio::test]
    async fn reset_all_data_wipes_in_place_reseeds_and_rearms_onboarding() {
        use tauri::Manager;
        let (_dir, app, _db) = crate::test_support::mock_app_with_db().await;
        let state = app.state::<AppState>();
        let pool = &state.db.pool;

        insert_entry(pool, "to be deleted").await;
        sqlx::query("INSERT INTO exclusions (id, kind, value) VALUES ('e1', 'app', 'Secret')")
            .execute(pool)
            .await
            .unwrap();
        sqlx::query(
            "UPDATE app_state SET completed_at = '2026-01-01T00:00:00Z' WHERE singleton = 1",
        )
        .execute(pool)
        .await
        .unwrap();

        let entries: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM entries")
            .fetch_one(pool)
            .await
            .unwrap();
        assert_eq!(entries, 1, "precondition: an entry exists");

        // A stale rotation backup beside the DB must be removed too.
        let bak = backup_path(&state.data_dir);
        std::fs::write(&bak, b"old data").unwrap();

        reset_all_data(state.inner()).await.unwrap();

        assert!(!bak.exists(), "rotation backup should be deleted");

        // User rows wiped.
        for table in ["entries", "exclusions"] {
            let n: i64 = sqlx::query_scalar(&format!("SELECT COUNT(*) FROM {table}"))
                .fetch_one(pool)
                .await
                .unwrap();
            assert_eq!(n, 0, "{table} should be empty after reset");
        }
        // Onboarding re-armed.
        let completed: Option<String> =
            sqlx::query_scalar("SELECT completed_at FROM app_state WHERE singleton = 1")
                .fetch_one(pool)
                .await
                .unwrap();
        assert!(completed.is_none(), "onboarding must be re-armed");
        // Defaults reseeded (fresh-install parity).
        let projects: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM projects")
            .fetch_one(pool)
            .await
            .unwrap();
        assert!(projects > 0, "default projects should be reseeded");
        // Pool still usable — no exit/close/restart.
        let one: i64 = sqlx::query_scalar("SELECT 1")
            .fetch_one(pool)
            .await
            .unwrap();
        assert_eq!(one, 1);
    }

    async fn insert_entry(pool: &SqlitePool, description: &str) -> String {
        let now = Utc::now().to_rfc3339();
        let id = uuid::Uuid::new_v4().to_string();
        sqlx::query(
            r#"INSERT INTO entries (id, project_id, task_id, description, started_at, ended_at, source, rule_id, created_at, updated_at)
               VALUES (?1, 'cairn', NULL, ?2, ?3, NULL, 'manual', NULL, ?3, ?3)"#,
        )
        .bind(&id)
        .bind(description)
        .bind(&now)
        .execute(pool)
        .await
        .unwrap();
        id
    }

    async fn insert_entry_with_task(
        pool: &SqlitePool,
        description: &str,
        task_name: &str,
    ) -> String {
        let now = Utc::now().to_rfc3339();
        let task_id = uuid::Uuid::new_v4().to_string();
        sqlx::query(
            r#"INSERT INTO tasks (id, project_id, name, archived, created_at, updated_at)
               VALUES (?1, 'cairn', ?2, 0, ?3, ?3)"#,
        )
        .bind(&task_id)
        .bind(task_name)
        .bind(&now)
        .execute(pool)
        .await
        .unwrap();
        let id = uuid::Uuid::new_v4().to_string();
        sqlx::query(
            r#"INSERT INTO entries (id, project_id, task_id, description, started_at, ended_at, source, rule_id, created_at, updated_at)
               VALUES (?1, 'cairn', ?2, ?3, ?4, NULL, 'manual', NULL, ?4, ?4)"#,
        )
        .bind(&id)
        .bind(&task_id)
        .bind(description)
        .bind(&now)
        .execute(pool)
        .await
        .unwrap();
        id
    }

    #[tokio::test]
    async fn csv_has_one_row_per_entry_with_client_project_task_description() {
        let dir = tempfile::tempdir().unwrap();
        let db = Db::open(&db_path(dir.path())).await.unwrap();
        insert_entry(&db.pool, "lone description").await;
        insert_entry_with_task(&db.pool, "with-task description", "Bug fixing").await;

        let csv_path = dir.path().join("out.csv");
        export_csv_to(&db.pool, &csv_path).await.unwrap();

        let csv = tokio::fs::read_to_string(&csv_path).await.unwrap();
        let lines: Vec<&str> = csv.lines().collect();
        assert_eq!(
            lines[0],
            "entry_id,started_at,ended_at,client,project,task,description,source"
        );
        // Header + one row per entry. No tag fan-out anymore.
        assert_eq!(lines.len(), 3);

        let with_task = lines
            .iter()
            .find(|l| l.contains("with-task description"))
            .unwrap();
        assert!(with_task.contains(",Bug fixing,"), "{with_task}");

        let lone = lines
            .iter()
            .find(|l| l.contains("lone description"))
            .unwrap();
        // Task field is empty when entry has no task_id.
        assert!(lone.contains(",,lone description,"), "{lone}");
    }

    #[tokio::test]
    async fn export_stage_swap_reopen_round_trips_entries() {
        // Source machine
        let src_dir = tempfile::tempdir().unwrap();
        let src_db = Db::open(&db_path(src_dir.path())).await.unwrap();
        let entry_id = insert_entry(&src_db.pool, "round-trip subject").await;
        let backup_file = src_dir.path().join("backup.sqlite");
        vacuum_into(&src_db.pool, &backup_file).await.unwrap();

        // Destination machine — starts fresh, no overlap with src dir.
        let dst_dir = tempfile::tempdir().unwrap();
        // Pre-populate dst with its own DB to prove the swap really
        // replaces it (and rotates the old one to .bak).
        let dst_db = Db::open(&db_path(dst_dir.path())).await.unwrap();
        insert_entry(&dst_db.pool, "to be replaced").await;
        dst_db.pool.close().await;

        let staged = stage_import_at(dst_dir.path(), &backup_file).await.unwrap();
        assert!(staged.exists());
        apply_pending_import(dst_dir.path()).unwrap();

        let reopened = Db::open(&db_path(dst_dir.path())).await.unwrap();
        let description: Option<String> =
            sqlx::query("SELECT description FROM entries WHERE id = ?1")
                .bind(&entry_id)
                .fetch_optional(&reopened.pool)
                .await
                .unwrap()
                .map(|r| r.get("description"));
        assert_eq!(description.as_deref(), Some("round-trip subject"));

        // The replaced entry shouldn't survive; the pre-swap DB is now .bak.
        let stale: Option<String> =
            sqlx::query("SELECT description FROM entries WHERE description = 'to be replaced'")
                .fetch_optional(&reopened.pool)
                .await
                .unwrap()
                .map(|r| r.get("description"));
        assert!(stale.is_none());
        assert!(backup_path(dst_dir.path()).exists());
    }
}
