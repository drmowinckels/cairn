//! Browser signal-source plugin (#37).
//!
//! Lives under `plugins/` — not `signals/` — because browser is an
//! **optional** signal source behind the plugin boundary; see
//! `docs/PLUGINS.md`. Core's always-on collectors (window · git · idle)
//! stay in `signals/`. Unlike calendar, browser is fully local: it only
//! receives the active-tab domain over a per-user loopback socket
//! (`listener`), maps it to a [`BrowserContext`] (`parser`), and feeds
//! the rules engine through the same `SignalEvent::Browser` channel every
//! other source uses. Nothing leaves the machine.
//!
//! Privacy (see `docs/PRIVACY.md`):
//! - Only `domain` survives the collector boundary; tab `path`/`title`
//!   are dropped at the `parser` and never persisted or matched.
//! - Incognito and unfocused pushes are dropped, and the user's
//!   exclusion list is applied **before** any event reaches the engine.
//! - The extension-liveness ledger (`BrowserExtensionState`) is shared
//!   with the Settings → Integrations IPC and stays in `signals/`.
//!
//! The browser extension itself (Safari/Firefox/Chrome) ships separately
//! and is out of scope for this slice — see the #37 follow-ups.
//!
//! ## Where the socket lives (#250)
//!
//! On **macOS** the socket binds inside the shared **App Group container**
//! (`~/Library/Group Containers/<APP_GROUP_ID>/ipc/sock`) rather than the
//! app data dir. The Safari Web Extension's handler runs under the App
//! Sandbox, which blocks `connect(2)` to a Unix socket outside its
//! container (proven in `browser-extension/safari/spike/SPIKE.md`); the
//! group container is the one filesystem location both the non-sandboxed
//! main app and the sandboxed extension can reach. On **Linux/Windows**
//! there is no such constraint and no Safari wrapper, so the socket stays
//! under the data dir / fixed pipe. See [`browser_socket_base`].

use std::path::{Path, PathBuf};

mod listener;
mod parser;
mod plugin;

pub use parser::BrowserContext;
pub use plugin::BrowserPlugin;

/// The macOS App Group shared by the main app and the Safari Web Extension
/// (#250). The socket lives in this group's container so the sandboxed
/// Safari handler can reach it. The Chrome/Firefox native host
/// (`browser-extension/native-host/src/main.rs`) hard-codes the **same**
/// id and must stay in lockstep — changing one without the other silently
/// breaks the macOS browser signal.
pub const APP_GROUP_ID: &str = "group.io.drmowinckels.cairn";

/// The App Group container directory under `home`:
/// `<home>/Library/Group Containers/<APP_GROUP_ID>`. Pure.
fn app_group_container(home: &Path) -> PathBuf {
    home.join("Library")
        .join("Group Containers")
        .join(APP_GROUP_ID)
}

/// Pure socket-base policy, factored out of [`browser_socket_base`] so
/// every arm is unit-testable on the (Linux-only) coverage runner
/// regardless of the host OS.
///
/// `use_app_group` is true only on macOS. When the group container is
/// requested but `$HOME` is absent (should never happen for a GUI app) we
/// fall back to `data_dir` so the listener still binds *somewhere* instead
/// of panicking — Safari won't reach it, but the app doesn't crash.
fn resolve_socket_base(use_app_group: bool, home: Option<&Path>, data_dir: &Path) -> PathBuf {
    match (use_app_group, home) {
        (true, Some(home)) => app_group_container(home),
        _ => data_dir.to_path_buf(),
    }
}

/// Resolve the directory the browser IPC socket binds under (the socket
/// itself is `<base>/ipc/sock`).
///
/// - **macOS:** the App Group container ([`APP_GROUP_ID`]) so the
///   sandboxed Safari Web Extension handler can reach it (#250).
/// - **Linux / Windows:** the app data dir, unchanged.
///
/// `cfg!` (not `#[cfg]`) keeps the whole body compiled — and therefore
/// covered — on the Linux coverage runner; the OS only flips the
/// `use_app_group` value.
pub fn browser_socket_base(data_dir: &Path) -> PathBuf {
    let use_app_group = cfg!(target_os = "macos");
    let home = std::env::var_os("HOME").map(PathBuf::from);
    resolve_socket_base(use_app_group, home.as_deref(), data_dir)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn app_group_container_is_under_group_containers() {
        assert_eq!(
            app_group_container(Path::new("/Users/test")),
            Path::new("/Users/test/Library/Group Containers/group.io.drmowinckels.cairn"),
        );
    }

    #[test]
    fn resolve_socket_base_uses_group_container_on_macos_with_home() {
        let base = resolve_socket_base(true, Some(Path::new("/Users/test")), Path::new("/data"));
        assert_eq!(
            base,
            Path::new("/Users/test/Library/Group Containers/group.io.drmowinckels.cairn"),
        );
    }

    #[test]
    fn resolve_socket_base_falls_back_to_data_dir_on_macos_without_home() {
        // macOS but no $HOME — bind under the data dir rather than panic.
        assert_eq!(
            resolve_socket_base(true, None, Path::new("/data")),
            Path::new("/data"),
        );
    }

    #[test]
    fn resolve_socket_base_is_the_data_dir_off_macos() {
        // Off macOS the group container is never used, with or without HOME.
        assert_eq!(
            resolve_socket_base(false, Some(Path::new("/Users/test")), Path::new("/data")),
            Path::new("/data"),
        );
        assert_eq!(
            resolve_socket_base(false, None, Path::new("/data")),
            Path::new("/data"),
        );
    }

    #[test]
    fn browser_socket_base_delegates_with_the_platform_flag() {
        // Branch-free (so it's fully covered on the Linux coverage runner):
        // pin that the public resolver is exactly the pure policy applied
        // with this platform's `cfg!` flag and the live `$HOME`.
        let data_dir = Path::new("/data");
        let home = std::env::var_os("HOME").map(PathBuf::from);
        let expected = resolve_socket_base(cfg!(target_os = "macos"), home.as_deref(), data_dir);
        assert_eq!(browser_socket_base(data_dir), expected);
    }
}
