//! The browser signal-source plugin (#37).
//!
//! Wraps the local-IPC [`listener`](super::listener) behind the
//! [`SignalSource`] boundary. Browser qualifies as a plugin because it
//! is **optional** — a door the user consciously opens. Unlike calendar
//! it is **fully local**: it only *receives* the active-tab domain over a
//! per-user loopback socket and never reaches the network or the
//! keychain, so its manifest declares **no** capabilities. The active-tab
//! push comes from a small browser extension shipped separately (the
//! Safari/Firefox/Chrome wrappers are out of scope for this slice — see
//! #37 follow-ups). See `docs/PLUGINS.md` and `docs/PRIVACY.md`.

use std::path::PathBuf;
use std::sync::{Arc, RwLock};

use tokio::sync::mpsc;

use super::listener;
use crate::plugins::{spawn_supervised, PluginManifest, SignalSource, SourceHandle};
use crate::signals::browser_extension::BrowserExtensionState;
use crate::signals::exclusions::ExclusionMatcher;
use crate::signals::stream::SignalEvent;

static MANIFEST: PluginManifest = PluginManifest {
    id: "browser",
    name: "Browser",
    // Fully local: receives over a loopback socket, no egress, no
    // secrets. The opt-in nature is what makes it a plugin, not a
    // capability.
    capabilities: &[],
};

pub struct BrowserPlugin {
    data_dir: PathBuf,
    exclusions: Arc<RwLock<ExclusionMatcher>>,
    extension_state: Arc<BrowserExtensionState>,
}

impl BrowserPlugin {
    pub fn new(
        data_dir: PathBuf,
        exclusions: Arc<RwLock<ExclusionMatcher>>,
        extension_state: Arc<BrowserExtensionState>,
    ) -> Self {
        Self {
            data_dir,
            exclusions,
            extension_state,
        }
    }
}

impl SignalSource for BrowserPlugin {
    fn manifest(&self) -> &PluginManifest {
        &MANIFEST
    }

    fn start(&self, tx: mpsc::Sender<SignalEvent>) -> SourceHandle {
        spawn_supervised(
            MANIFEST.id,
            run_logged(
                self.data_dir.clone(),
                tx,
                self.exclusions.clone(),
                self.extension_state.clone(),
            ),
        )
    }

    fn on_disabled(&self, tx: &mpsc::Sender<SignalEvent>) {
        // The listener was just aborted, so the last domain it pushed is
        // frozen in the driver's `LiveState` with no future event to
        // clear it. Deliver one `Browser(None)` reliably so a disabled
        // source clears `browser_domain` from every future snapshot.
        // `try_send` could drop the clear under a full channel — and
        // nothing would re-send it — so spawn a tiny task that awaits
        // capacity. Ordering holds: any domain the listener already
        // enqueued sits ahead of this `None`, so the driver settles on
        // cleared.
        let tx = tx.clone();
        tokio::spawn(async move {
            let _ = tx.send(SignalEvent::Browser(None)).await;
        });
    }
}

/// Run the listener, logging (not propagating) a bind failure. Bind
/// errors are non-fatal: Cairn still runs without the browser source.
/// The decision is delegated to the sync [`log_bind_result`] so the
/// branch is unit-tested directly and the awaited shell stays a single
/// straight-line statement (avoiding the cargo-llvm-cov
/// closing-brace-after-await artifact).
async fn run_logged(
    data_dir: PathBuf,
    tx: mpsc::Sender<SignalEvent>,
    exclusions: Arc<RwLock<ExclusionMatcher>>,
    extension_state: Arc<BrowserExtensionState>,
) {
    let result = listener::run(data_dir, tx, exclusions, extension_state).await;
    log_bind_result(result);
}

/// Log a listener bind failure (and only a failure). Sync, so both arms
/// are covered without driving a real socket.
fn log_bind_result(result: std::io::Result<()>) {
    if let Err(e) = result {
        log::warn!("browser: socket listener failed to bind: {e}; browser_domain will stay None");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugins::Capability;

    fn plugin_in(data_dir: PathBuf) -> BrowserPlugin {
        BrowserPlugin::new(
            data_dir,
            Arc::new(RwLock::new(ExclusionMatcher::default())),
            Arc::new(BrowserExtensionState::new()),
        )
    }

    #[test]
    fn manifest_is_local_only_with_no_capabilities() {
        let plugin = plugin_in(PathBuf::from("/tmp/cairn-test"));
        let m = plugin.manifest();
        assert_eq!(m.id, "browser");
        assert_eq!(m.name, "Browser");
        assert!(
            m.capabilities.is_empty(),
            "browser is fully local: no network, no secrets"
        );
        // Belt-and-braces: it declares neither capability explicitly.
        assert!(!m.capabilities.contains(&Capability::Network));
        assert!(!m.capabilities.contains(&Capability::Secrets));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn start_binds_socket_and_a_push_becomes_a_browser_event() {
        use tokio::io::AsyncWriteExt;
        use tokio::net::UnixStream;
        use tokio::time::{timeout, Duration};

        let dir = tempfile::tempdir().unwrap();
        let plugin = plugin_in(dir.path().to_path_buf());
        let (tx, mut rx) = mpsc::channel::<SignalEvent>(8);

        let handle = plugin.start(tx);

        let path = super::listener::socket_path(dir.path());
        for _ in 0..50 {
            if path.exists() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        let mut client = UnixStream::connect(&path).await.expect("connect");
        client
            .write_all(b"{\"domain\":\"example.com\",\"focused\":true}\n")
            .await
            .unwrap();

        let ev = timeout(Duration::from_secs(2), rx.recv())
            .await
            .expect("plugin pushes a browser event")
            .expect("channel open");
        match ev {
            SignalEvent::Browser(Some(ctx)) => assert_eq!(ctx.domain, "example.com"),
            other => panic!("expected Browser(Some(example.com)), got {other:?}"),
        }
        handle.stop();
    }

    #[tokio::test]
    async fn on_disabled_pushes_a_clearing_event() {
        let plugin = plugin_in(PathBuf::from("/tmp/cairn-test"));
        let (tx, mut rx) = mpsc::channel::<SignalEvent>(4);

        plugin.on_disabled(&tx);

        let ev = tokio::time::timeout(std::time::Duration::from_secs(1), rx.recv())
            .await
            .expect("on_disabled pushed a clearing event")
            .expect("channel open");
        assert!(
            matches!(ev, SignalEvent::Browser(None)),
            "disabling browser must clear browser_domain, got {ev:?}"
        );
    }

    #[test]
    fn log_bind_result_logs_only_on_error() {
        // Ok → no-op arm; Err → the warn arm. Both run without a socket.
        log_bind_result(Ok(()));
        log_bind_result(Err(std::io::Error::other("simulated bind failure")));
    }

    // Unix-only: the bind is forced to fail by pointing `data_dir` at a
    // file. On Windows the listener binds a fixed named pipe and ignores
    // `data_dir`, so this mechanism doesn't apply — the bind-failure
    // branch is covered platform-agnostically by `log_bind_result`.
    #[cfg(unix)]
    #[tokio::test]
    async fn run_logged_returns_after_logging_a_bind_failure() {
        // A data_dir that is a file makes the bind fail; run_logged must
        // log and return (not hang, not panic).
        let dir = tempfile::tempdir().unwrap();
        let file_path = dir.path().join("not-a-dir");
        std::fs::write(&file_path, b"x").unwrap();
        let (tx, _rx) = mpsc::channel::<SignalEvent>(4);
        let exclusions = Arc::new(RwLock::new(ExclusionMatcher::default()));
        let state = Arc::new(BrowserExtensionState::new());
        // Returns promptly — if the bind error propagated as a panic or
        // the fn hung, this would time out / unwind.
        tokio::time::timeout(
            std::time::Duration::from_secs(2),
            run_logged(file_path, tx, exclusions, state),
        )
        .await
        .expect("run_logged returns after a bind failure");
    }
}
