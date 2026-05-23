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
use tokio::io::AsyncWriteExt;

use crate::AppState;

pub const PENDING_SUFFIX: &str = ".pending";
pub const BACKUP_SUFFIX: &str = ".bak";
const SQLITE_SIDECARS: [&str; 3] = ["-journal", "-wal", "-shm"];

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

/// Long-format CSV: one row per (entry, tag) pair. Entries with no
/// tags get a single row with an empty `tag` field. This is the
/// shape tools like pandas / dplyr expect — splitting tags into
/// rows keeps the project column scalar and the tag column tidy.
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
               p.name AS project,
               e.task,
               e.source,
               t.name AS tag
          FROM entries e
          LEFT JOIN projects   p  ON p.id  = e.project_id
          LEFT JOIN entry_tags et ON et.entry_id = e.id
          LEFT JOIN tags       t  ON t.id  = et.tag_id
         ORDER BY e.started_at ASC, t.name ASC
        "#,
    )
    .fetch_all(pool)
    .await
    .map_err(err)?;

    let mut file = tokio::fs::File::create(dest).await.map_err(err)?;
    file.write_all(b"entry_id,started_at,ended_at,project,task,source,tag\n")
        .await
        .map_err(err)?;

    for row in rows {
        let id: String = row.get("id");
        let started: String = row.get("started_at");
        let ended: Option<String> = row.get("ended_at");
        let project: Option<String> = row.get("project");
        let task: String = row.get("task");
        let source: String = row.get("source");
        let tag: Option<String> = row.get("tag");
        let line = format!(
            "{},{},{},{},{},{},{}\n",
            csv_escape(&id),
            csv_escape(&started),
            csv_escape(ended.as_deref().unwrap_or("")),
            csv_escape(project.as_deref().unwrap_or("")),
            csv_escape(&task),
            csv_escape(&source),
            csv_escape(tag.as_deref().unwrap_or("")),
        );
        file.write_all(line.as_bytes()).await.map_err(err)?;
    }
    file.flush().await.map_err(err)?;
    Ok(())
}

/// Delete the live DB plus any sidecars, staged import, and backup.
/// The pool is dropped first by the caller.
pub fn nuke_data_files(data_dir: &Path) -> std::io::Result<()> {
    let live = db_path(data_dir);
    let candidates = std::iter::once(live.clone())
        .chain(SQLITE_SIDECARS.iter().map(|s| with_suffix(&live, s)))
        .chain(std::iter::once(pending_import_path(data_dir)))
        .chain(std::iter::once(backup_path(data_dir)));
    for path in candidates {
        if path.exists() {
            std::fs::remove_file(&path)?;
        }
    }
    Ok(())
}

fn with_suffix(path: &Path, suffix: &str) -> PathBuf {
    let mut s = path.as_os_str().to_owned();
    s.push(suffix);
    PathBuf::from(s)
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
    // Close the pool so no fd's keep the files alive on Windows.
    {
        let state = app.state::<AppState>();
        state.db.pool.close().await;
    }
    let data_dir = app.path().app_data_dir().map_err(err)?;
    nuke_data_files(&data_dir).map_err(err)?;
    log::info!("backup: deleted everything in {data_dir:?}; exiting");
    app.exit(0);
    Ok(())
}

#[tauri::command]
pub async fn suggested_backup_name() -> String {
    format!("cairn-{}.sqlite", Utc::now().format("%Y-%m-%d-%H%M%S"))
}

#[tauri::command]
pub async fn suggested_csv_name() -> String {
    format!("cairn-entries-{}.csv", Utc::now().format("%Y-%m-%d"))
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
    fn nuke_removes_db_and_sidecars() {
        let dir = tempfile::tempdir().unwrap();
        let live = db_path(dir.path());
        for path in [
            live.clone(),
            with_suffix(&live, "-wal"),
            with_suffix(&live, "-shm"),
            with_suffix(&live, "-journal"),
            pending_import_path(dir.path()),
            backup_path(dir.path()),
        ] {
            std::fs::write(&path, b"x").unwrap();
        }
        nuke_data_files(dir.path()).unwrap();
        assert!(!live.exists());
        assert!(!with_suffix(&live, "-wal").exists());
        assert!(!with_suffix(&live, "-shm").exists());
        assert!(!with_suffix(&live, "-journal").exists());
        assert!(!pending_import_path(dir.path()).exists());
        assert!(!backup_path(dir.path()).exists());
    }

    async fn insert_entry(pool: &SqlitePool, task: &str, tags: &[&str]) -> String {
        let now = Utc::now().to_rfc3339();
        let id = uuid::Uuid::new_v4().to_string();
        sqlx::query(
            r#"INSERT INTO entries (id, project_id, task, started_at, ended_at, source, rule_id, created_at, updated_at)
               VALUES (?1, 'cairn', ?2, ?3, NULL, 'manual', NULL, ?3, ?3)"#,
        )
        .bind(&id)
        .bind(task)
        .bind(&now)
        .execute(pool)
        .await
        .unwrap();
        for tag in tags {
            let tag_id = uuid::Uuid::new_v4().to_string();
            sqlx::query("INSERT INTO tags (id, name) VALUES (?1, ?2)")
                .bind(&tag_id)
                .bind(tag)
                .execute(pool)
                .await
                .unwrap();
            sqlx::query("INSERT INTO entry_tags (entry_id, tag_id) VALUES (?1, ?2)")
                .bind(&id)
                .bind(&tag_id)
                .execute(pool)
                .await
                .unwrap();
        }
        id
    }

    #[tokio::test]
    async fn csv_is_long_format_one_row_per_tag() {
        let dir = tempfile::tempdir().unwrap();
        let db = Db::open(&db_path(dir.path())).await.unwrap();
        insert_entry(&db.pool, "two-tag task", &["api", "design"]).await;
        insert_entry(&db.pool, "lone task", &[]).await;

        let csv_path = dir.path().join("out.csv");
        export_csv_to(&db.pool, &csv_path).await.unwrap();

        let csv = tokio::fs::read_to_string(&csv_path).await.unwrap();
        let lines: Vec<&str> = csv.lines().collect();
        assert_eq!(
            lines[0],
            "entry_id,started_at,ended_at,project,task,source,tag"
        );
        // Header + 2 rows for the two-tag task + 1 row for the lone task
        assert_eq!(lines.len(), 4);

        let two_tag_rows: Vec<&&str> = lines
            .iter()
            .filter(|l| l.contains("two-tag task"))
            .collect();
        assert_eq!(two_tag_rows.len(), 2);
        assert!(two_tag_rows.iter().any(|l| l.ends_with(",api")));
        assert!(two_tag_rows.iter().any(|l| l.ends_with(",design")));

        let lone_rows: Vec<&&str> = lines.iter().filter(|l| l.contains("lone task")).collect();
        assert_eq!(lone_rows.len(), 1);
        assert!(lone_rows[0].ends_with(",")); // empty tag column
    }

    #[tokio::test]
    async fn export_stage_swap_reopen_round_trips_entries() {
        // Source machine
        let src_dir = tempfile::tempdir().unwrap();
        let src_db = Db::open(&db_path(src_dir.path())).await.unwrap();
        let entry_id = insert_entry(&src_db.pool, "round-trip subject", &["sync"]).await;
        let backup_file = src_dir.path().join("backup.sqlite");
        vacuum_into(&src_db.pool, &backup_file).await.unwrap();

        // Destination machine — starts fresh, no overlap with src dir.
        let dst_dir = tempfile::tempdir().unwrap();
        // Pre-populate dst with its own DB to prove the swap really
        // replaces it (and rotates the old one to .bak).
        let dst_db = Db::open(&db_path(dst_dir.path())).await.unwrap();
        insert_entry(&dst_db.pool, "to be replaced", &[]).await;
        dst_db.pool.close().await;

        let staged = stage_import_at(dst_dir.path(), &backup_file).await.unwrap();
        assert!(staged.exists());
        apply_pending_import(dst_dir.path()).unwrap();

        let reopened = Db::open(&db_path(dst_dir.path())).await.unwrap();
        let task: Option<String> = sqlx::query("SELECT task FROM entries WHERE id = ?1")
            .bind(&entry_id)
            .fetch_optional(&reopened.pool)
            .await
            .unwrap()
            .map(|r| r.get("task"));
        assert_eq!(task.as_deref(), Some("round-trip subject"));

        // The replaced entry shouldn't survive; the pre-swap DB is now .bak.
        let stale: Option<String> =
            sqlx::query("SELECT task FROM entries WHERE task = 'to be replaced'")
                .fetch_optional(&reopened.pool)
                .await
                .unwrap()
                .map(|r| r.get("task"));
        assert!(stale.is_none());
        assert!(backup_path(dst_dir.path()).exists());
    }
}
