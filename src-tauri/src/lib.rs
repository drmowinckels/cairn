mod backup;
mod db;
mod ipc;
mod popover;
mod rules;
mod signals;
mod tray;

#[cfg(test)]
mod test_support;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, RwLock};

use tauri::{Manager, WindowEvent};
use tauri_plugin_autostart::MacosLauncher;
use tauri_plugin_log::{Target, TargetKind};

pub use db::Db;

use signals::calendar::CalendarRegistry;
use signals::exclusions::ExclusionMatcher;
use signals::stream::SnapshotStream;

pub struct AppState {
    pub db: Db,
    pub pinned: AtomicBool,
    pub calendar: Arc<CalendarRegistry>,
    pub stream: Arc<SnapshotStream>,
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
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
            if let WindowEvent::Focused(false) = event {
                if window.label() == "popover" {
                    let pinned = window
                        .app_handle()
                        .try_state::<AppState>()
                        .map(|s| s.pinned.load(Ordering::Relaxed))
                        .unwrap_or(false);
                    if !pinned {
                        let _ = window.hide();
                    }
                }
            }
        })
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
        .invoke_handler(tauri::generate_handler![
            ipc::list_clients,
            ipc::save_client,
            ipc::delete_client,
            ipc::list_projects,
            ipc::save_project,
            ipc::delete_project,
            ipc::list_tasks,
            ipc::save_task,
            ipc::delete_task,
            ipc::list_today,
            ipc::list_week,
            ipc::list_rules,
            ipc::save_rule,
            ipc::delete_rule,
            ipc::list_exclusions,
            ipc::save_exclusion,
            ipc::delete_exclusion,
            ipc::current_running,
            ipc::start_entry,
            ipc::stop_entry,
            ipc::update_entry,
            ipc::delete_entry,
            ipc::resolve_idle,
            ipc::hide_popover,
            ipc::set_pinned,
            ipc::set_popover_size,
            ipc::list_calendar_sources,
            ipc::add_calendar_source,
            ipc::update_calendar_source,
            ipc::remove_calendar_source,
            ipc::refresh_calendar_source,
            ipc::current_calendar_events,
            ipc::calendar_sync_status,
            ipc::current_snapshot,
            backup::data_paths,
            backup::export_backup,
            backup::stage_import,
            backup::cancel_pending_import,
            backup::export_csv,
            backup::delete_everything,
            backup::suggested_backup_name,
            backup::suggested_csv_name,
        ])
        .setup(|app| {
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            let data_dir = app.path().app_data_dir().expect("app_data_dir resolves");
            std::fs::create_dir_all(&data_dir).ok();

            if let Err(e) = backup::apply_pending_import(&data_dir) {
                log::warn!("backup: could not apply pending import: {e}");
            }

            let db = tauri::async_runtime::block_on(async {
                db::Db::open(&backup::db_path(&data_dir)).await
            })
            .expect("open SQLite database");

            let calendar =
                Arc::new(CalendarRegistry::new(db.pool.clone()).expect("init calendar registry"));
            tauri::async_runtime::spawn(calendar.clone().run_scheduler());

            // Load the exclusion list once at startup; mutator IPC
            // handlers replace the contents under the same `Arc`.
            let exclusions =
                tauri::async_runtime::block_on(async { ExclusionMatcher::load(&db.pool).await });
            let exclusions = Arc::new(RwLock::new(exclusions));

            let stream = Arc::new(signals::stream::spawn(
                calendar.clone(),
                exclusions.clone(),
                signals::stream::DEFAULT_DEBOUNCE,
            ));
            signals::stream::spawn_default_sources(&stream);

            // Tauri fan-out: every published snapshot is evaluated
            // against the rules in the DB and emitted as
            // `signal:snapshot` / `signal:match` to the popover
            // window. Exits on driver shutdown.
            let fanout_rx = stream.subscribe();
            let fanout_pool = db.pool.clone();
            let fanout_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                signals::fanout::run(fanout_rx, fanout_pool, fanout_handle).await;
            });

            // Idle-resume fan-out: re-emits each `Idle → Active`
            // transition as `signal:idle-resume` to the popover so
            // the Today view's modal can render.
            let idle_rx = stream.subscribe_idle_resume();
            let idle_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                signals::fanout::run_idle_resume(idle_rx, idle_handle).await;
            });

            app.manage(AppState {
                db,
                pinned: AtomicBool::new(false),
                calendar,
                stream,
                exclusions,
                exclusions_mutator: tokio::sync::Mutex::new(()),
            });

            tray::setup(app.handle())?;
            popover::register_shortcut(app.handle());
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
