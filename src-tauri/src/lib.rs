mod backup;
mod db;
mod ipc;
mod popover;
mod prompt_scheduler;
mod rounding;
mod rules;
mod shutdown;
mod signals;
mod tray;
mod update;

#[cfg(test)]
mod test_support;

use std::sync::atomic::AtomicBool;
use std::sync::{Arc, RwLock};

use tauri::{Manager, WindowEvent};
use tauri_plugin_autostart::MacosLauncher;
use tauri_plugin_log::{Target, TargetKind};
use tauri_plugin_updater::UpdaterExt;

pub use db::Db;

use update::{build_update_info, UpdateInfo};

/// Opt-in update check (#45). Thin shim around `app.updater().check()` —
/// the testable mapping lives in `update::build_update_info`. Returns the
/// newer version's info, or `None` when up to date. The error string is
/// deliberately generic: the frontend treats any failure as "no update"
/// and never surfaces the endpoint or transport details.
///
/// Lives here, in the coverage-ignored Tauri-wiring file, because
/// `updater().check()` needs the real updater runtime + network and has
/// no mockable surface to unit-test against.
#[tauri::command]
async fn check_for_update(app: tauri::AppHandle) -> Result<Option<UpdateInfo>, String> {
    let updater = app
        .updater()
        .map_err(|_| "update checker unavailable".to_string())?;

    match updater.check().await {
        Ok(Some(update)) => Ok(Some(build_update_info(
            &update.version,
            &update.current_version,
            update.body.clone(),
        ))),
        Ok(None) => Ok(None),
        Err(_) => Err("update check failed".to_string()),
    }
}

use rules::{Rule as EngineRule, Snoozer};
use signals::browser_extension::BrowserExtensionState;
use signals::calendar::CalendarRegistry;
use signals::capture::SignalCapture;
use signals::exclusions::ExclusionMatcher;
use signals::git_watcher::GitWatcherStatus;
use signals::stream::{IdleResume, SnapshotStream};

pub struct AppState {
    pub db: Db,
    pub pinned: AtomicBool,
    pub calendar: Arc<CalendarRegistry>,
    pub stream: Arc<SnapshotStream>,
    /// Debug "Capture raw signals" handle. Always created off; the
    /// toggle is in-memory only and never persisted across launches.
    /// See `signals::capture` and `docs/PRIVACY.md`.
    pub capture: SignalCapture,
    /// Absolute path to the resolved app data dir. The capture IPC
    /// uses this to write `debug-signals.ndjson` so the writer
    /// doesn't need to re-resolve via `AppHandle::path()` on every
    /// start. Cloned at boot from `app.path().app_data_dir()`.
    pub data_dir: std::path::PathBuf,
    /// Live exclusion-list snapshot. The snapshot-stream driver
    /// consults this on every `Window` event to drop signals from
    /// excluded apps / window titles before they reach the rules
    /// engine. Mutators (`save_exclusion` / `delete_exclusion` IPC)
    /// reload it after a write.
    pub exclusions: Arc<RwLock<ExclusionMatcher>>,
    /// Serializes `(DB write, exclusions reload)` pairs so two
    /// concurrent `save_exclusion` / `delete_exclusion` IPC calls
    /// can't interleave such that the in-memory matcher ends up
    /// reflecting a stale DB snapshot. tokio Mutex (not std) so
    /// the await across the lock + DB roundtrip is non-blocking.
    pub exclusions_mutator: tokio::sync::Mutex<()>,
    /// Per-rule + global snooze map. The fanout's matcher consults
    /// this on every snapshot publish; snooze IPC mutators write to
    /// it. `std::sync::Mutex` because every critical section is a
    /// bounded `HashMap` operation with no `.await` inside.
    pub snoozer: Arc<std::sync::Mutex<Snoozer>>,
    /// Cache of rules in their engine shape (parsed `when`/`then`).
    /// Replaces the per-snapshot DB query + JSON parse on the
    /// fanout's hot path (issue #55). Mutator IPCs
    /// (`save_rule` / `delete_rule`) reload it after a write.
    pub rules_cache: Arc<RwLock<Vec<EngineRule>>>,
    /// Same pattern as `exclusions_mutator`: serializes
    /// `(DB write, rules reload)` pairs.
    pub rules_mutator: tokio::sync::Mutex<()>,
    /// The git watcher's discovery roots + watched repo count. Seeded
    /// at boot and rewritten by `set_git_discovery_roots` when the user
    /// edits their roots (issue #34 / #7). Behind a `Mutex` because the
    /// configurator IPC mutates it while `get_git_watcher_status` reads
    /// it; every critical section is a cheap clone/replace with no
    /// `.await` inside.
    pub git_watcher_status: std::sync::Mutex<GitWatcherStatus>,
    /// Abort handle for the live git-watcher task.
    /// `set_git_discovery_roots` aborts the running watcher and spawns a
    /// fresh one over the new roots, swapping the handle here.
    pub git_watcher_handle: std::sync::Mutex<Option<tokio::task::JoinHandle<()>>>,
    /// Serializes `set_git_discovery_roots` so two overlapping calls
    /// (double-click Save, or Save racing a `reset_all_data` re-arm)
    /// can't interleave the discover → abort → respawn → persist
    /// sequence and leak an un-abortable watcher. Same pattern as
    /// `rules_mutator` / `exclusions_mutator`.
    pub git_roots_mutator: tokio::sync::Mutex<()>,
    /// Most recent idle-resume event, stored so the idle prompt window
    /// (#93) can fetch it on mount via `pending_idle` — covering the
    /// cold-start race where the window's webview isn't yet listening
    /// when the event is emitted. Cleared by `dismiss_idle`.
    pub last_idle: std::sync::Mutex<Option<IdleResume>>,
    /// Browser-extension liveness ledger (#34, #35). Heartbeats land
    /// here on every push from the local-IPC socket collector in
    /// `signals::browser`; the IPC handler `browser_extension_status`
    /// reads from it for Settings → Integrations.
    pub browser_extension: Arc<BrowserExtensionState>,
}

/// Ensure the app data directory exists, mapping any I/O failure to a
/// startup-fatal message. Extracted from the Tauri `.setup()` closure
/// (which has no mockable surface) so the success and failure arms can
/// be unit-tested directly.
fn ensure_data_dir(data_dir: &std::path::Path) -> Result<(), String> {
    std::fs::create_dir_all(data_dir).map_err(|e| {
        format!(
            "could not create the app data directory {}; Cairn cannot start: {e}",
            data_dir.display()
        )
    })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let log_level = if cfg!(debug_assertions) {
        log::LevelFilter::Debug
    } else {
        log::LevelFilter::Info
    };

    let mut log_targets = vec![Target::new(TargetKind::LogDir {
        file_name: Some("cairn".to_string()),
    })];
    if cfg!(debug_assertions) {
        log_targets.push(Target::new(TargetKind::Stdout));
        log_targets.push(Target::new(TargetKind::Stderr));
    }

    let logger = tauri_plugin_log::Builder::new()
        .targets(log_targets)
        .level(log_level)
        .max_file_size(1024 * 1024)
        .rotation_strategy(tauri_plugin_log::RotationStrategy::KeepSome(5))
        .build();

    tauri::Builder::default()
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "popover" {
                    // The close button hides the window rather than quitting;
                    // the tray icon (and ⌃⌥T) toggle it back. As a persistent
                    // window (#100) it no longer auto-hides on focus loss.
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        // Persist + restore the popover's position and size across
        // launches (#100). The idle window is centered on demand, so it
        // is excluded from state management.
        .plugin(
            tauri_plugin_window_state::Builder::default()
                // Only geometry — NOT visibility. The default flags
                // include VISIBLE, which would auto-show the tray-toggled
                // popover on every launch if it was open at quit.
                .with_state_flags(
                    tauri_plugin_window_state::StateFlags::SIZE
                        | tauri_plugin_window_state::StateFlags::POSITION,
                )
                .with_denylist(&["idle"])
                .build(),
        )
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            popover::toggle(app);
        }))
        .plugin(logger)
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_positioner::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            None,
        ))
        // Opt-in update checker (#45). Registering the plugin is inert on
        // its own — Cairn only performs a network check when the user has
        // turned on "Check for updates" in Settings, and the frontend is
        // what calls `update::check_for_update`. No check fires at launch
        // otherwise. See docs/PRIVACY.md.
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            ipc::list_clients,
            ipc::save_client,
            ipc::delete_client,
            ipc::list_projects,
            ipc::save_project,
            ipc::delete_project,
            ipc::project_budget_status,
            ipc::list_tasks,
            ipc::save_task,
            ipc::delete_task,
            ipc::list_today,
            ipc::list_week,
            ipc::report_summary,
            ipc::list_rules,
            ipc::save_rule,
            ipc::delete_rule,
            ipc::reorder_rules,
            ipc::list_exclusions,
            ipc::save_exclusion,
            ipc::delete_exclusion,
            ipc::current_running,
            ipc::start_entry,
            ipc::stop_entry,
            ipc::create_entry,
            ipc::update_entry,
            ipc::delete_entry,
            ipc::resolve_idle,
            ipc::pending_idle,
            ipc::dismiss_idle,
            ipc::idle_seconds,
            ipc::hide_popover,
            ipc::set_pinned,
            ipc::set_popover_size,
            ipc::list_calendar_sources,
            ipc::add_calendar_source,
            ipc::update_calendar_source,
            ipc::remove_calendar_source,
            ipc::refresh_calendar_source,
            ipc::current_calendar_events,
            ipc::upcoming_calendar_events,
            ipc::calendar_sync_status,
            ipc::current_snapshot,
            ipc::diagnostics,
            ipc::set_tray_title,
            ipc::update_tray_menu,
            ipc::get_git_watcher_status,
            ipc::get_git_discovery_roots,
            ipc::set_git_discovery_roots,
            ipc::browser_extension_status,
            ipc::start_signal_capture,
            ipc::stop_signal_capture,
            ipc::signal_capture_status,
            ipc::get_onboarding_state,
            ipc::complete_onboarding,
            ipc::reset_onboarding,
            ipc::dry_run_rules,
            ipc::snooze_rule,
            ipc::snooze_all,
            ipc::unsnooze_all,
            ipc::list_snoozes,
            backup::data_paths,
            backup::export_backup,
            backup::stage_import,
            backup::cancel_pending_import,
            backup::export_csv,
            backup::delete_everything,
            backup::suggested_backup_name,
            backup::suggested_csv_name,
            backup::list_data_files,
            backup::reveal_data_folder,
            check_for_update,
        ])
        .setup(|app| {
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            let data_dir = app.path().app_data_dir().map_err(|e| {
                format!("could not resolve the app data directory; Cairn cannot start: {e}")
            })?;
            ensure_data_dir(&data_dir)?;

            if let Err(e) = backup::apply_pending_import(&data_dir) {
                log::warn!("backup: could not apply pending import: {e}");
            }

            // "Capture raw signals" never persists across launches.
            // If a previous crashed Cairn left an ndjson file behind,
            // delete it now so the on-disk state matches the UI's
            // sticky-off contract (`signals::capture::cleanup_stale`
            // logs a warning when it removes one).
            if let Err(e) = tauri::async_runtime::block_on(async {
                signals::capture::cleanup_stale(&data_dir).await
            }) {
                log::warn!("capture: stale-file cleanup failed: {e}");
            }

            let db = tauri::async_runtime::block_on(async {
                db::Db::open(&backup::db_path(&data_dir)).await
            })
            .map_err(|e| format!("could not open the database; Cairn cannot start: {e}"))?;

            let calendar = Arc::new(CalendarRegistry::new(db.pool.clone()).map_err(|e| {
                format!("could not initialise the calendar registry; Cairn cannot start: {e}")
            })?);
            tauri::async_runtime::spawn(calendar.clone().run_scheduler());

            // Load the exclusion list once at startup; mutator IPC
            // handlers replace the contents under the same `Arc`.
            let exclusions =
                tauri::async_runtime::block_on(async { ExclusionMatcher::load(&db.pool).await });
            let exclusions = Arc::new(RwLock::new(exclusions));

            // Git watcher: discover repos under the user's
            // discovery roots so the snapshot stream gets a list of
            // repo paths to use for `derive_ide_folder`'s
            // longest-prefix fallback. Then start the actual
            // file-watcher task on each `.git/HEAD`.
            // Use the user's persisted discovery roots if they've
            // configured any (Settings → Integrations → Configure
            // roots…); otherwise fall back to the conventional dev
            // folders. Persisted roots are stored tilde-form and
            // expanded back to absolute paths here.
            let configured_roots =
                tauri::async_runtime::block_on(ipc::load_discovery_roots(&db.pool));
            let discovery_roots = if configured_roots.is_empty() {
                signals::git_watcher::default_discovery_roots()
            } else {
                signals::git_watcher::expand_roots(&configured_roots)
            };
            let discovered_repos = signals::git_watcher::discover_repos(&discovery_roots);
            let git_watcher_status =
                signals::git_watcher::build_status(&discovery_roots, &discovered_repos);

            // `spawn_full`, `spawn_default_sources`, and
            // `spawn_watcher_task` call `tokio::spawn` internally, but
            // the Tauri `setup` hook runs on the main thread *outside*
            // the async runtime — so a bare call panics with "there is
            // no reactor running". Enter the runtime via `block_on`;
            // the spawned driver/collector tasks live on Tauri's
            // runtime for the app's lifetime, and `block_on` returns as
            // soon as they're spawned.
            let stream = Arc::new(tauri::async_runtime::block_on(async {
                let stream = signals::stream::spawn_full(
                    calendar.clone(),
                    exclusions.clone(),
                    signals::stream::DEFAULT_DEBOUNCE,
                    std::time::Duration::from_secs(signals::stream::DEFAULT_IDLE_THRESHOLD_SECS),
                    discovered_repos.clone(),
                );
                signals::stream::spawn_default_sources(&stream);
                stream
            }));

            // Spawn the git watcher *after* the stream so the
            // initial Git events flow into the stream's sender. Same
            // runtime-context requirement as above. The async block
            // yields the task's JoinHandle (itself a future) on
            // purpose — we keep it so `set_git_discovery_roots` can
            // abort + respawn — so silence `async_yields_async` here.
            #[allow(clippy::async_yields_async)]
            let git_watcher_handle = tauri::async_runtime::block_on(async {
                signals::git_watcher::spawn_watcher_task(stream.event_sender(), discovered_repos)
            });

            // Browser-signal IPC socket (M7 #35). Listens on
            // `<data_dir>/ipc/sock` (Unix; owner-only `chmod 0700`
            // parent + `chmod 0600` socket) or `\\.\pipe\cairn`
            // (Windows; `reject_remote_clients(true)`) for pushes
            // from a small browser extension. Heartbeats are
            // recorded on `browser_extension_state` so the
            // Settings → Integrations card reflects connectivity;
            // a focused, non-incognito, non-excluded message produces
            // a `SignalEvent::Browser` that feeds the snapshot
            // stream's `browser_domain` field. A bind failure is
            // logged but never fatal — Cairn still runs without the
            // browser collector.
            let browser_extension_state = Arc::new(BrowserExtensionState::new());
            {
                let event_tx = stream.event_sender();
                let exclusions_for_browser = exclusions.clone();
                let state_for_browser = browser_extension_state.clone();
                let data_dir_for_browser = data_dir.clone();
                tauri::async_runtime::spawn(async move {
                    if let Err(e) = signals::browser::spawn_listener(
                        data_dir_for_browser,
                        event_tx,
                        exclusions_for_browser,
                        state_for_browser,
                    )
                    .await
                    {
                        log::warn!(
                            "browser: socket listener failed to bind: {e}; \
                             browser_domain will stay None"
                        );
                    }
                });
            }

            // Rules cache: load once, refreshed by `save_rule` /
            // `delete_rule` IPC mutators. The fanout reads this on
            // every snapshot publish; per-tick DB queries used to
            // dominate the hot path (issue #55). A startup-load
            // failure here is unlikely (we just opened the pool)
            // but if it happens we boot with an empty cache — the
            // first save_rule mutator will repopulate.
            let rules_cache = tauri::async_runtime::block_on(async {
                signals::fanout::load_engine_rules(&db.pool)
                    .await
                    .unwrap_or_else(|e| {
                        log::warn!("rules: startup load failed: {e}; starting with empty cache");
                        Vec::new()
                    })
            });
            let rules_cache = Arc::new(RwLock::new(rules_cache));

            // Tauri fan-out: every published snapshot is evaluated
            // against the rules-cache snapshot and emitted as
            // `signal:snapshot` / `signal:match` to the popover
            // window. The snoozer gates the matcher so dismissed-
            // banner rules stay quiet. Exits on driver shutdown.
            let fanout_rx = stream.subscribe();
            let fanout_rules = rules_cache.clone();
            let fanout_handle = app.handle().clone();
            let snoozer_for_fanout = Arc::new(std::sync::Mutex::new(Snoozer::new()));
            let snoozer_for_state = snoozer_for_fanout.clone();
            let exclusions_for_fanout = exclusions.clone();
            tauri::async_runtime::spawn(async move {
                signals::fanout::run(
                    fanout_rx,
                    fanout_rules,
                    snoozer_for_fanout,
                    exclusions_for_fanout,
                    fanout_handle,
                )
                .await;
            });

            // Idle-resume fan-out: re-emits each `Idle → Active`
            // transition as `signal:idle-resume` to the popover so
            // the Today view's modal can render.
            let idle_rx = stream.subscribe_idle_resume();
            let idle_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                signals::fanout::run_idle_resume(idle_rx, idle_handle).await;
            });

            // Calendar auto-stop: closes Strict-rule-driven entries
            // whose bound calendar event has ended, unless the user
            // manually edited the entry in between. See M1 #10.
            let autostop_pool = db.pool.clone();
            let autostop_calendar = calendar.clone();
            let autostop_rules = rules_cache.clone();
            tauri::async_runtime::spawn(async move {
                signals::calendar_autostop::run(autostop_pool, autostop_calendar, autostop_rules)
                    .await;
            });

            app.manage(AppState {
                db,
                pinned: AtomicBool::new(false),
                calendar,
                stream,
                capture: SignalCapture::new(),
                data_dir: data_dir.clone(),
                exclusions,
                exclusions_mutator: tokio::sync::Mutex::new(()),
                snoozer: snoozer_for_state,
                rules_cache,
                rules_mutator: tokio::sync::Mutex::new(()),
                git_watcher_status: std::sync::Mutex::new(git_watcher_status),
                git_watcher_handle: std::sync::Mutex::new(Some(git_watcher_handle)),
                git_roots_mutator: tokio::sync::Mutex::new(()),
                last_idle: std::sync::Mutex::new(None),
                browser_extension: browser_extension_state,
            });

            tray::setup(app.handle())?;
            popover::register_shortcut(app.handle());
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(|app_handle, event| {
            // Drain the SQLite pool before the Tokio runtime drops
            // — otherwise in-flight writes get aborted mid-
            // transaction and the most recent entry can be silently
            // lost. The helper lives in `shutdown.rs` so the
            // contract has tests (this closure can't be unit-
            // tested in a mock_app rig).
            if let tauri::RunEvent::ExitRequested { .. } = &event {
                tauri::async_runtime::block_on(shutdown::drain_db_pool(app_handle));
            }
            // macOS: clicking the dock icon when the window is hidden (the
            // close button hides rather than quits) reshows it — the normal
            // app-window expectation now that we ship OS decorations.
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen { .. } = &event {
                if let Some(win) = app_handle.get_webview_window("popover") {
                    let _ = win.show();
                    let _ = win.set_focus();
                }
            }
        });
}

#[cfg(test)]
mod tests {
    use super::ensure_data_dir;

    #[test]
    fn ensure_data_dir_creates_missing_nested_path() {
        let tmp = tempfile::tempdir().unwrap();
        let nested = tmp.path().join("a").join("b").join("cairn");
        assert!(!nested.exists());
        ensure_data_dir(&nested).expect("creating a fresh nested dir succeeds");
        assert!(nested.is_dir());
    }

    #[test]
    fn ensure_data_dir_is_idempotent_for_existing_dir() {
        let tmp = tempfile::tempdir().unwrap();
        ensure_data_dir(tmp.path()).expect("an already-existing dir is fine");
        assert!(tmp.path().is_dir());
    }

    #[test]
    fn ensure_data_dir_errors_when_path_is_a_file() {
        let tmp = tempfile::tempdir().unwrap();
        let file = tmp.path().join("not-a-dir");
        std::fs::write(&file, b"x").unwrap();
        let err = ensure_data_dir(&file).expect_err("create_dir_all over a file must fail");
        assert!(
            err.contains("could not create the app data directory")
                && err.contains("Cairn cannot start"),
            "error must carry the startup-fatal message, got: {err}"
        );
    }
}
