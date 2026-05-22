use tauri::{
    image::Image,
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle,
};

use crate::popover;

pub fn setup(app: &AppHandle) -> tauri::Result<()> {
    let icon = default_icon(app)?;

    TrayIconBuilder::with_id("cairn-tray")
        .icon(icon)
        .icon_as_template(true)
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                popover::toggle(tray.app_handle());
            }
        })
        .build(app)?;

    Ok(())
}

fn default_icon(app: &AppHandle) -> tauri::Result<Image<'_>> {
    app.default_window_icon()
        .cloned()
        .ok_or_else(|| tauri::Error::AssetNotFound("default tray icon".into()))
}
