mod backup;
mod db;
mod ipc;
mod popover;
mod rules;
mod signals;
mod tray;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use tauri::{Manager, WindowEvent};
use tauri_plugin_autostart::MacosLauncher;
use tauri_plugin_log::{Target, TargetKind};

pub use db::Db;

use signals::calendar::CalendarRegistry;

pub struct AppState {
    pub db: Db,
    pub pinned: AtomicBool,
    pub calendar: Arc<CalendarRegistry>,
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

            app.manage(AppState {
                db,
                pinned: AtomicBool::new(false),
                calendar,
            });

            tray::setup(app.handle())?;
            popover::register_shortcut(app.handle());
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
