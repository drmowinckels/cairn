//! Automatic backup snapshots (data-resilience).
//!
//! Time tracking is work data; losing it is damaging. The manual
//! "Export all data…" loop in [`crate::backup`] protects nothing if the
//! user forgets to run it. This module writes point-in-time, consistent
//! `VACUUM INTO` snapshots to a user-chosen folder on a cadence and keeps
//! the most recent `keep`.
//!
//! The folder is expected to be one the OS already syncs (iCloud Drive,
//! Google Drive, Dropbox, Syncthing, …), so resilience comes for free
//! without Cairn ever talking to those services — the privacy contract is
//! unchanged. Crucially we write **snapshots**, never the live WAL
//! database, so a sync folder only ever sees whole, self-consistent files
//! and the multi-writer SQLite-corruption hazard never arises.
//!
//! The pure core (filename, parse, prune, due, normalize) is unit-tested
//! in isolation; the scheduler and `run_backup` are thin IO wrappers over
//! it plus [`crate::backup::vacuum_into`].

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use chrono::{DateTime, NaiveDateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::{Row, SqlitePool};
use tauri::State;
use tokio::sync::Mutex;
use tokio::time::{interval, MissedTickBehavior};

use crate::AppState;

/// Snapshot filename prefix. Distinct from the manual-export / rotation
/// names so auto snapshots are recognizable and prunable on their own.
const BACKUP_PREFIX: &str = "cairn-auto-";
const BACKUP_EXT: &str = ".sqlite";
/// Timestamp layout embedded in the filename. Fixed-width, so plain
/// lexicographic ordering of filenames is also chronological order.
const TIME_FMT: &str = "%Y-%m-%d-%H%M%S";

const DEFAULT_INTERVAL_HOURS: u32 = 24;
const DEFAULT_KEEP: u32 = 14;
/// Interval bounds: at least hourly, at most monthly.
const MIN_INTERVAL_HOURS: u32 = 1;
const MAX_INTERVAL_HOURS: u32 = 24 * 30;
/// Retention bounds: always keep at least one; cap to a sane ceiling.
const MIN_KEEP: u32 = 1;
const MAX_KEEP: u32 = 365;
/// How often the scheduler wakes to check whether a backup is due. The
/// interval gate (hours) is the real cadence; this just bounds latency
/// between "due" and "taken".
const SCHEDULER_TICK_SECS: u64 = 300;

/// User-facing auto-backup configuration. Persisted on the singleton
/// `app_state` row so the backend scheduler reads it without the webview.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutoBackupSettings {
    /// Master switch. Off by default — Cairn backs up nothing until the
    /// user opts in and picks a folder.
    pub enabled: bool,
    /// Destination folder (typically OS-synced). `None` = not configured.
    pub dir: Option<String>,
    /// Hours between snapshots.
    pub interval_hours: u32,
    /// How many of the most recent snapshots to retain.
    pub keep: u32,
}

impl Default for AutoBackupSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            dir: None,
            interval_hours: DEFAULT_INTERVAL_HOURS,
            keep: DEFAULT_KEEP,
        }
    }
}

/// Read-only view of what's actually on disk in the configured folder,
/// for the Settings UI ("Last backup …, N kept").
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AutoBackupStatus {
    pub last_backup_at: Option<String>,
    pub count: usize,
}

// ── Pure core ─────────────────────────────────────────────────────────

/// Snapshot filename for `now`, e.g. `cairn-auto-2026-06-03-141502.sqlite`.
pub fn backup_filename(now: DateTime<Utc>) -> String {
    format!("{BACKUP_PREFIX}{}{BACKUP_EXT}", now.format(TIME_FMT))
}

/// Whether `name` is one of our auto-snapshot files.
pub fn is_backup_file(name: &str) -> bool {
    name.starts_with(BACKUP_PREFIX)
        && name.ends_with(BACKUP_EXT)
        && parse_backup_time(name).is_some()
}

/// Recover the snapshot timestamp encoded in a filename, if it is one of
/// ours and well-formed.
pub fn parse_backup_time(name: &str) -> Option<DateTime<Utc>> {
    let stamp = name.strip_prefix(BACKUP_PREFIX)?.strip_suffix(BACKUP_EXT)?;
    NaiveDateTime::parse_from_str(stamp, TIME_FMT)
        .ok()
        .map(|naive| naive.and_utc())
}

/// Clamp a requested interval into the supported range.
pub fn clamp_interval(hours: u32) -> u32 {
    hours.clamp(MIN_INTERVAL_HOURS, MAX_INTERVAL_HOURS)
}

/// Clamp a requested retention count into the supported range.
pub fn clamp_keep(keep: u32) -> u32 {
    keep.clamp(MIN_KEEP, MAX_KEEP)
}

/// Apply defaults + clamping to raw, possibly-NULL persisted values.
/// A blank/whitespace `dir` is treated as unset.
pub fn normalize(
    enabled: bool,
    dir: Option<String>,
    interval_hours: Option<u32>,
    keep: Option<u32>,
) -> AutoBackupSettings {
    let dir = dir.map(|d| d.trim().to_string()).filter(|d| !d.is_empty());
    AutoBackupSettings {
        enabled,
        dir,
        interval_hours: clamp_interval(interval_hours.unwrap_or(DEFAULT_INTERVAL_HOURS)),
        keep: clamp_keep(keep.unwrap_or(DEFAULT_KEEP)),
    }
}

/// The most recent snapshot timestamp among `names`, ignoring anything
/// that isn't one of ours.
pub fn newest_backup_time(names: &[String]) -> Option<DateTime<Utc>> {
    names.iter().filter_map(|n| parse_backup_time(n)).max()
}

/// Given the snapshot filenames present and a retention count, return the
/// names that should be deleted (everything older than the newest `keep`).
/// Non-snapshot names are never returned.
pub fn prune_targets(names: &[String], keep: usize) -> Vec<String> {
    let mut snapshots: Vec<&String> = names.iter().filter(|n| is_backup_file(n)).collect();
    // Fixed-width timestamp ⇒ lexicographic desc == newest first.
    snapshots.sort_by(|a, b| b.cmp(a));
    snapshots.into_iter().skip(keep).cloned().collect()
}

/// Whether a fresh snapshot is due: always when none exists yet, else
/// once `interval_hours` have elapsed since the newest one.
pub fn is_due(now: DateTime<Utc>, newest: Option<DateTime<Utc>>, interval_hours: u32) -> bool {
    match newest {
        None => true,
        Some(last) => now - last >= chrono::Duration::hours(i64::from(interval_hours)),
    }
}

// ── IO ────────────────────────────────────────────────────────────────

/// Filenames of the auto-snapshots currently in `dir` (empty if the
/// folder is missing or unreadable — treated as "nothing backed up yet").
async fn list_backup_names(dir: &Path) -> Vec<String> {
    let mut names = Vec::new();
    let mut rd = match tokio::fs::read_dir(dir).await {
        Ok(rd) => rd,
        Err(_) => return names,
    };
    while let Ok(Some(entry)) = rd.next_entry().await {
        if let Some(name) = entry.file_name().to_str() {
            if is_backup_file(name) {
                names.push(name.to_string());
            }
        }
    }
    names
}

/// Write a consistent snapshot of `pool` into `dir` stamped at `now`,
/// then prune older snapshots down to `keep`. Returns the snapshot path.
pub async fn run_backup(
    pool: &SqlitePool,
    dir: &Path,
    keep: usize,
    now: DateTime<Utc>,
) -> Result<PathBuf, String> {
    tokio::fs::create_dir_all(dir)
        .await
        .map_err(|e| e.to_string())?;
    let dest = dir.join(backup_filename(now));
    crate::backup::vacuum_into(pool, &dest).await?;

    for name in prune_targets(&list_backup_names(dir).await, keep) {
        if let Err(e) = tokio::fs::remove_file(dir.join(&name)).await {
            // Pruning is best-effort: a stuck delete must not fail the
            // backup that already succeeded.
            log::warn!("auto-backup: could not prune {name}: {e}");
        }
    }
    Ok(dest)
}

/// Inspect the configured folder for the UI status line.
async fn status_in(dir: &Path) -> AutoBackupStatus {
    let names = list_backup_names(dir).await;
    AutoBackupStatus {
        last_backup_at: newest_backup_time(&names).map(|t| t.to_rfc3339()),
        count: names.len(),
    }
}

// ── Settings persistence (singleton app_state row) ────────────────────

pub async fn load_settings(pool: &SqlitePool) -> AutoBackupSettings {
    let row = sqlx::query(
        "SELECT auto_backup_enabled, auto_backup_dir, \
                auto_backup_interval_hours, auto_backup_keep \
           FROM app_state WHERE singleton = 1",
    )
    .fetch_optional(pool)
    .await
    .ok()
    .flatten();
    match row {
        None => AutoBackupSettings::default(),
        Some(r) => normalize(
            r.get::<i64, _>("auto_backup_enabled") != 0,
            r.get::<Option<String>, _>("auto_backup_dir"),
            r.get::<Option<i64>, _>("auto_backup_interval_hours")
                .map(|v| v.clamp(0, i64::from(u32::MAX)) as u32),
            r.get::<Option<i64>, _>("auto_backup_keep")
                .map(|v| v.clamp(0, i64::from(u32::MAX)) as u32),
        ),
    }
}

pub async fn save_settings(pool: &SqlitePool, settings: &AutoBackupSettings) -> Result<(), String> {
    sqlx::query(
        "UPDATE app_state SET auto_backup_enabled = ?1, auto_backup_dir = ?2, \
                auto_backup_interval_hours = ?3, auto_backup_keep = ?4 \
          WHERE singleton = 1",
    )
    .bind(i64::from(settings.enabled))
    .bind(settings.dir.as_deref())
    .bind(i64::from(settings.interval_hours))
    .bind(i64::from(settings.keep))
    .execute(pool)
    .await
    .map_err(|e| e.to_string())?;
    Ok(())
}

// ── Scheduler ─────────────────────────────────────────────────────────

/// Background loop: every [`SCHEDULER_TICK_SECS`], take a snapshot if one
/// is due. The first tick fires immediately, so an overdue (or first-ever)
/// backup is taken shortly after launch. Serialized against manual
/// `backup_now` via `lock`.
pub async fn run_scheduler(pool: SqlitePool, lock: Arc<Mutex<()>>) {
    let mut ticker = interval(Duration::from_secs(SCHEDULER_TICK_SECS));
    ticker.set_missed_tick_behavior(MissedTickBehavior::Delay);
    loop {
        ticker.tick().await;
        run_tick_logging(&pool, &lock, Utc::now()).await;
    }
}

/// Run one tick and swallow (logging) any error — a transient failure
/// (folder unmounted, disk full) must not kill the scheduler loop. Split
/// from the infinite loop so the error handling is testable.
async fn run_tick_logging(pool: &SqlitePool, lock: &Mutex<()>, now: DateTime<Utc>) {
    if let Err(e) = tick(pool, lock, now).await {
        log::warn!("auto-backup: scheduled tick failed: {e}");
    }
}

/// One scheduler evaluation. Split out (taking an explicit `now`) so the
/// due/skip/run decision is testable against a real pool + temp folder.
/// Returns the snapshot path when one was taken.
pub async fn tick(
    pool: &SqlitePool,
    lock: &Mutex<()>,
    now: DateTime<Utc>,
) -> Result<Option<PathBuf>, String> {
    let settings = load_settings(pool).await;
    let Some(dir) = settings.dir.as_deref() else {
        return Ok(None);
    };
    if !settings.enabled {
        return Ok(None);
    }
    let dir = PathBuf::from(dir);
    if !is_due(
        now,
        newest_backup_time(&list_backup_names(&dir).await),
        settings.interval_hours,
    ) {
        return Ok(None);
    }
    let _guard = lock.lock().await;
    let path = run_backup(pool, &dir, settings.keep as usize, now).await?;
    log::info!("auto-backup: wrote {path:?}");
    Ok(Some(path))
}

// ── IPC ───────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn get_auto_backup_settings(
    state: State<'_, AppState>,
) -> Result<AutoBackupSettings, String> {
    Ok(load_settings(&state.db.pool).await)
}

#[tauri::command]
pub async fn auto_backup_status(state: State<'_, AppState>) -> Result<AutoBackupStatus, String> {
    let settings = load_settings(&state.db.pool).await;
    match settings.dir {
        Some(dir) => Ok(status_in(&PathBuf::from(dir)).await),
        None => Ok(AutoBackupStatus {
            last_backup_at: None,
            count: 0,
        }),
    }
}

/// Persist new settings (normalized + clamped) and, if backups are now
/// enabled with a folder and one is due, take an initial snapshot so the
/// user gets immediate confirmation rather than waiting for the next tick.
/// Returns the normalized settings actually stored.
#[tauri::command]
pub async fn set_auto_backup_settings(
    state: State<'_, AppState>,
    settings: AutoBackupSettings,
) -> Result<AutoBackupSettings, String> {
    let normalized = normalize(
        settings.enabled,
        settings.dir,
        Some(settings.interval_hours),
        Some(settings.keep),
    );
    save_settings(&state.db.pool, &normalized).await?;

    if normalized.enabled {
        if let Some(dir) = normalized.dir.as_deref() {
            let dir = PathBuf::from(dir);
            let due = is_due(
                Utc::now(),
                newest_backup_time(&list_backup_names(&dir).await),
                normalized.interval_hours,
            );
            if due {
                let _guard = state.auto_backup_lock.lock().await;
                if let Err(e) =
                    run_backup(&state.db.pool, &dir, normalized.keep as usize, Utc::now()).await
                {
                    log::warn!("auto-backup: initial snapshot failed: {e}");
                }
            }
        }
    }
    Ok(normalized)
}

/// Force a snapshot now, regardless of the interval. Errors if no folder
/// is configured. Returns the snapshot path.
#[tauri::command]
pub async fn backup_now(state: State<'_, AppState>) -> Result<String, String> {
    let settings = load_settings(&state.db.pool).await;
    let dir = settings
        .dir
        .ok_or_else(|| "no automatic-backup folder is configured".to_string())?;
    let _guard = state.auto_backup_lock.lock().await;
    let path = run_backup(
        &state.db.pool,
        &PathBuf::from(dir),
        settings.keep as usize,
        Utc::now(),
    )
    .await?;
    Ok(path.to_string_lossy().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Db;

    fn dt(s: &str) -> DateTime<Utc> {
        DateTime::parse_from_rfc3339(s).unwrap().with_timezone(&Utc)
    }

    #[test]
    fn filename_round_trips_through_parse() {
        let now = dt("2026-06-03T14:15:02Z");
        let name = backup_filename(now);
        assert_eq!(name, "cairn-auto-2026-06-03-141502.sqlite");
        assert!(is_backup_file(&name));
        assert_eq!(parse_backup_time(&name), Some(now));
    }

    #[test]
    fn non_snapshot_names_are_rejected() {
        for name in [
            "cairn.sqlite",
            "cairn.sqlite.bak",
            "cairn-2026-06-03.sqlite",
            "cairn-auto-not-a-date.sqlite",
            "cairn-auto-2026-06-03-141502.txt",
            "random.txt",
        ] {
            assert!(!is_backup_file(name), "{name} must not be a snapshot");
            assert!(parse_backup_time(name).is_none(), "{name}");
        }
    }

    #[test]
    fn clamp_bounds_interval_and_keep() {
        assert_eq!(clamp_interval(0), MIN_INTERVAL_HOURS);
        assert_eq!(clamp_interval(12), 12);
        assert_eq!(clamp_interval(99_999), MAX_INTERVAL_HOURS);
        assert_eq!(clamp_keep(0), MIN_KEEP);
        assert_eq!(clamp_keep(14), 14);
        assert_eq!(clamp_keep(99_999), MAX_KEEP);
    }

    #[test]
    fn normalize_applies_defaults_and_trims_blank_dir() {
        let s = normalize(true, Some("  ".to_string()), None, None);
        assert!(s.enabled);
        assert_eq!(s.dir, None, "blank dir is treated as unset");
        assert_eq!(s.interval_hours, DEFAULT_INTERVAL_HOURS);
        assert_eq!(s.keep, DEFAULT_KEEP);

        let s2 = normalize(false, Some(" /sync/cairn ".to_string()), Some(0), Some(0));
        assert_eq!(s2.dir.as_deref(), Some("/sync/cairn"), "dir is trimmed");
        assert_eq!(s2.interval_hours, MIN_INTERVAL_HOURS);
        assert_eq!(s2.keep, MIN_KEEP);
    }

    #[test]
    fn newest_backup_time_picks_the_latest_snapshot() {
        let names = vec![
            "cairn-auto-2026-06-01-090000.sqlite".to_string(),
            "cairn-auto-2026-06-03-090000.sqlite".to_string(),
            "cairn-auto-2026-06-02-090000.sqlite".to_string(),
            "not-a-backup.sqlite".to_string(),
        ];
        assert_eq!(newest_backup_time(&names), Some(dt("2026-06-03T09:00:00Z")),);
        assert_eq!(newest_backup_time(&[]), None);
    }

    #[test]
    fn prune_targets_keeps_newest_and_ignores_foreign_files() {
        let names = vec![
            "cairn-auto-2026-06-01-090000.sqlite".to_string(),
            "cairn-auto-2026-06-02-090000.sqlite".to_string(),
            "cairn-auto-2026-06-03-090000.sqlite".to_string(),
            "cairn.sqlite".to_string(), // never a prune target
        ];
        let mut doomed = prune_targets(&names, 2);
        doomed.sort();
        assert_eq!(
            doomed,
            vec!["cairn-auto-2026-06-01-090000.sqlite".to_string()]
        );
        // keep >= snapshot count ⇒ nothing pruned.
        assert!(prune_targets(&names, 3).is_empty());
        assert!(prune_targets(&names, 99).is_empty());
        // keep 0 would prune all snapshots (callers clamp keep ≥ 1).
        assert_eq!(prune_targets(&names, 0).len(), 3);
    }

    #[test]
    fn is_due_when_none_or_interval_elapsed() {
        let now = dt("2026-06-03T12:00:00Z");
        assert!(is_due(now, None, 24), "first-ever backup is always due");
        assert!(is_due(now, Some(dt("2026-06-02T11:00:00Z")), 24), "25h ago");
        assert!(
            !is_due(now, Some(dt("2026-06-03T06:00:00Z")), 24),
            "only 6h ago"
        );
        assert!(
            is_due(now, Some(dt("2026-06-02T12:00:00Z")), 24),
            "exactly 24h ago is due"
        );
    }

    #[tokio::test]
    async fn run_backup_writes_snapshot_and_prunes_to_keep() {
        let src = tempfile::tempdir().unwrap();
        let db = Db::open(&crate::backup::db_path(src.path())).await.unwrap();
        let out = tempfile::tempdir().unwrap();

        let t1 = dt("2026-06-01T09:00:00Z");
        let t2 = dt("2026-06-02T09:00:00Z");
        let t3 = dt("2026-06-03T09:00:00Z");
        run_backup(&db.pool, out.path(), 2, t1).await.unwrap();
        run_backup(&db.pool, out.path(), 2, t2).await.unwrap();
        let third = run_backup(&db.pool, out.path(), 2, t3).await.unwrap();

        assert!(third.exists());
        let mut names = list_backup_names(out.path()).await;
        names.sort();
        assert_eq!(
            names,
            vec![
                "cairn-auto-2026-06-02-090000.sqlite".to_string(),
                "cairn-auto-2026-06-03-090000.sqlite".to_string(),
            ],
            "oldest snapshot pruned, newest two kept",
        );
    }

    #[tokio::test]
    async fn settings_round_trip_through_the_db() {
        let dir = tempfile::tempdir().unwrap();
        let db = Db::open(&crate::backup::db_path(dir.path())).await.unwrap();

        // Defaults before anything is written.
        assert_eq!(load_settings(&db.pool).await, AutoBackupSettings::default());

        let want = AutoBackupSettings {
            enabled: true,
            dir: Some("/sync/cairn".to_string()),
            interval_hours: 12,
            keep: 30,
        };
        save_settings(&db.pool, &want).await.unwrap();
        assert_eq!(load_settings(&db.pool).await, want);
    }

    #[tokio::test]
    async fn tick_skips_when_disabled_or_unconfigured_and_runs_when_due() {
        let dir = tempfile::tempdir().unwrap();
        let db = Db::open(&crate::backup::db_path(dir.path())).await.unwrap();
        let out = tempfile::tempdir().unwrap();
        let lock = Mutex::new(());
        let now = dt("2026-06-03T12:00:00Z");

        // Unconfigured (no dir) → no-op.
        assert_eq!(tick(&db.pool, &lock, now).await.unwrap(), None);

        // Configured but disabled → no-op.
        save_settings(
            &db.pool,
            &AutoBackupSettings {
                enabled: false,
                dir: Some(out.path().to_string_lossy().to_string()),
                interval_hours: 24,
                keep: 14,
            },
        )
        .await
        .unwrap();
        assert_eq!(tick(&db.pool, &lock, now).await.unwrap(), None);

        // Enabled + due (no snapshot yet) → writes one.
        save_settings(
            &db.pool,
            &AutoBackupSettings {
                enabled: true,
                dir: Some(out.path().to_string_lossy().to_string()),
                interval_hours: 24,
                keep: 14,
            },
        )
        .await
        .unwrap();
        let path = tick(&db.pool, &lock, now).await.unwrap();
        assert!(path.is_some(), "a due backup must be taken");
        assert_eq!(list_backup_names(out.path()).await.len(), 1);

        // Not due yet (1h later, 24h interval) → no second snapshot.
        let soon = dt("2026-06-03T13:00:00Z");
        assert_eq!(tick(&db.pool, &lock, soon).await.unwrap(), None);
        assert_eq!(list_backup_names(out.path()).await.len(), 1);
    }

    #[tokio::test]
    async fn status_in_reports_latest_and_count() {
        let out = tempfile::tempdir().unwrap();
        // Empty folder.
        let empty = status_in(out.path()).await;
        assert_eq!(empty.count, 0);
        assert_eq!(empty.last_backup_at, None);

        for name in [
            "cairn-auto-2026-06-01-090000.sqlite",
            "cairn-auto-2026-06-03-090000.sqlite",
            "unrelated.txt",
        ] {
            tokio::fs::write(out.path().join(name), b"x").await.unwrap();
        }
        let s = status_in(out.path()).await;
        assert_eq!(s.count, 2, "only snapshots counted");
        assert_eq!(
            s.last_backup_at.as_deref(),
            Some("2026-06-03T09:00:00+00:00")
        );
    }

    #[tokio::test]
    async fn run_tick_logging_swallows_ok_and_err() {
        let dir = tempfile::tempdir().unwrap();
        let db = Db::open(&crate::backup::db_path(dir.path())).await.unwrap();
        let lock = Mutex::new(());
        let now = dt("2026-06-03T12:00:00Z");

        // Ok path: nothing configured → tick returns Ok(None).
        run_tick_logging(&db.pool, &lock, now).await;

        // Err path: enabled with a folder that can't be created (nested
        // under a regular file), so run_backup errors and the loop logs
        // rather than propagating.
        let blocker = dir.path().join("blocker");
        std::fs::write(&blocker, b"x").unwrap();
        let unusable = blocker.join("nope");
        save_settings(
            &db.pool,
            &AutoBackupSettings {
                enabled: true,
                dir: Some(unusable.to_string_lossy().to_string()),
                interval_hours: 24,
                keep: 14,
            },
        )
        .await
        .unwrap();
        run_tick_logging(&db.pool, &lock, now).await;
    }

    #[tokio::test]
    async fn scheduler_runs_an_immediate_tick_then_aborts_cleanly() {
        // interval(..)'s first tick fires immediately, so spawning the
        // scheduler exercises the loop body once; nothing is configured,
        // so that tick is a no-op. Then we abort the infinite loop.
        let dir = tempfile::tempdir().unwrap();
        let db = Db::open(&crate::backup::db_path(dir.path())).await.unwrap();
        let handle = tokio::spawn(run_scheduler(db.pool.clone(), Arc::new(Mutex::new(()))));
        tokio::time::sleep(Duration::from_millis(50)).await;
        handle.abort();
        let _ = handle.await;
    }

    // Tauri's MockRuntime (mock_app_with_db) is unavailable on Windows.
    #[cfg(not(target_os = "windows"))]
    #[tokio::test]
    async fn commands_round_trip_settings_and_take_initial_snapshot() {
        use tauri::Manager;
        let (_dir, app, _db) = crate::test_support::mock_app_with_db().await;
        let out = tempfile::tempdir().unwrap();
        let dir_str = out.path().to_string_lossy().to_string();

        // Enabling with a folder normalizes (blank-trim + clamp) and takes
        // an immediate snapshot so the user gets instant confirmation.
        let saved = set_auto_backup_settings(
            app.state::<crate::AppState>(),
            AutoBackupSettings {
                enabled: true,
                dir: Some(format!("  {dir_str}  ")),
                interval_hours: 0,
                keep: 0,
            },
        )
        .await
        .unwrap();
        assert!(saved.enabled);
        assert_eq!(saved.dir.as_deref(), Some(dir_str.as_str()));
        assert_eq!(saved.interval_hours, MIN_INTERVAL_HOURS);
        assert_eq!(saved.keep, MIN_KEEP);

        // get reflects what was persisted.
        assert_eq!(
            get_auto_backup_settings(app.state::<crate::AppState>())
                .await
                .unwrap(),
            saved,
        );

        // The initial snapshot is on disk.
        let status = auto_backup_status(app.state::<crate::AppState>())
            .await
            .unwrap();
        assert_eq!(status.count, 1);
        assert!(status.last_backup_at.is_some());
    }

    #[cfg(not(target_os = "windows"))]
    #[tokio::test]
    async fn backup_now_errors_without_folder_then_writes_with_one() {
        use tauri::Manager;
        let (_dir, app, _db) = crate::test_support::mock_app_with_db().await;

        // No folder yet: status reports nothing and a forced backup errors.
        let empty = auto_backup_status(app.state::<crate::AppState>())
            .await
            .unwrap();
        assert_eq!(empty.count, 0);
        assert_eq!(empty.last_backup_at, None);
        let err = backup_now(app.state::<crate::AppState>())
            .await
            .unwrap_err();
        assert!(err.contains("no automatic-backup folder"), "{err}");

        // Configure a folder but leave backups disabled — `backup_now`
        // ignores the enabled flag, and the disabled `set` skips the
        // initial snapshot, so the only file comes from the forced backup.
        let out = tempfile::tempdir().unwrap();
        set_auto_backup_settings(
            app.state::<crate::AppState>(),
            AutoBackupSettings {
                enabled: false,
                dir: Some(out.path().to_string_lossy().to_string()),
                interval_hours: 24,
                keep: 14,
            },
        )
        .await
        .unwrap();
        assert!(list_backup_names(out.path()).await.is_empty());

        let path = backup_now(app.state::<crate::AppState>()).await.unwrap();
        assert!(std::path::Path::new(&path).exists());
        assert_eq!(list_backup_names(out.path()).await.len(), 1);
    }
}
