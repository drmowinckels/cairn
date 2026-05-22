//! Frontmost window collector. Platform-specific implementations.

#[derive(Debug, Clone)]
pub struct FrontWindow {
    pub app_name: String,
    pub title: Option<String>,
}

#[cfg(target_os = "macos")]
pub fn current() -> Option<FrontWindow> {
    use objc2::rc::autoreleasepool;
    use objc2_app_kit::NSWorkspace;

    autoreleasepool(|_| {
        let workspace = NSWorkspace::sharedWorkspace();
        let app = workspace.frontmostApplication()?;
        let name = app.localizedName()?;
        Some(FrontWindow {
            app_name: name.to_string(),
            title: None,
        })
    })
}

#[cfg(not(target_os = "macos"))]
pub fn current() -> Option<FrontWindow> {
    None
}
