mod backup;
mod db;
mod ipc;
mod popover;
mod rules;
mod signals;
mod tray;

use tauri::{Manager, WindowEvent};
use tauri_plugin_autostart::MacosLauncher;
use tauri_plugin_log::{Target, TargetKind};

pub use db::Db;

pub struct AppState {
    pub db: Db,
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
                    let _ = window.hide();
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
            ipc::list_projects,
            ipc::list_today,
            ipc::list_rules,
            ipc::current_running,
            ipc::start_entry,
            ipc::stop_entry,
            ipc::hide_popover,
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

            let data_dir = app
                .path()
                .app_data_dir()
                .expect("app_data_dir resolves");
            std::fs::create_dir_all(&data_dir).ok();

            if let Err(e) = backup::apply_pending_import(&data_dir) {
                log::warn!("backup: could not apply pending import: {e}");
            }

            let db = tauri::async_runtime::block_on(async {
                db::Db::open(&backup::db_path(&data_dir)).await
            })
            .expect("open SQLite database");

            app.manage(AppState { db });

            tray::setup(app.handle())?;
            popover::register_shortcut(app.handle());
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
