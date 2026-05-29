//! Browser-signal IPC socket: receives active-tab updates from a
//! local browser extension and folds them into the snapshot stream.
//!
//! See `docs/PRIVACY.md` "Browser integration" + issue #35.
//!
//! ## Wire format
//!
//! Newline-delimited JSON, one [`BrowserMessage`] per line:
//!
//! ```json
//! {"domain":"github.com","path":"/cairn","title":"Cairn repo",
//!  "incognito":false,"focused":true,"browserLabel":"Chrome 120"}
//! ```
//!
//! All fields except `domain` are optional. Missing `focused` defaults
//! to `true` (the extension typically only sends on focus changes;
//! older extensions that don't carry the flag are treated as foreground).
//! Missing `incognito` defaults to `false`.
//!
//! ## Privacy gates
//!
//! Per the spec, two classes of message MUST be dropped before they
//! reach the snapshot stream:
//!
//! - **Incognito / private** windows. The extension marks these with
//!   `incognito: true`; we never derive a domain from them.
//! - **Unfocused** updates. The extension may send a final "we lost
//!   focus" message; that's heartbeat-only, no domain projects.
//!
//! After those drop, the [`ExclusionMatcher`] is consulted: a domain
//! matching the user's exclusion list never reaches the stream.
//!
//! ## Socket lifecycle
//!
//! - **Unix**: `<data_dir>/sock`, owned `chmod 0600` after bind. A
//!   stale file from a crashed previous run is unlinked before bind.
//! - **Windows**: `\\.\pipe\cairn`, `reject_remote_clients(true)`.
//!   Proper DACL restriction to the current user is a follow-up
//!   (#35 v2): `reject_remote_clients` already prevents network
//!   access, and the default DACL on a Windows pipe is owner+SYSTEM
//!   on this session.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use chrono::Utc;
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::sync::mpsc;

use super::browser_extension::BrowserExtensionState;
use super::exclusions::ExclusionMatcher;
use super::stream::SignalEvent;

/// Filename of the Unix domain socket inside `data_dir`. The pipe
/// name on Windows is the constant [`WINDOWS_PIPE_NAME`].
pub const SOCKET_FILENAME: &str = "sock";

#[cfg(windows)]
pub const WINDOWS_PIPE_NAME: &str = r"\\.\pipe\cairn";

/// Resolve the socket path inside `data_dir`. Exported so the
/// integration tests and the Windows path can share the same name.
pub fn socket_path(data_dir: &Path) -> PathBuf {
    data_dir.join(SOCKET_FILENAME)
}

/// One frame the browser extension sends across the socket.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BrowserMessage {
    pub domain: String,
    #[serde(default)]
    pub path: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub incognito: bool,
    #[serde(default = "default_true")]
    pub focused: bool,
    /// Friendly name for the Settings → Integrations card (e.g.
    /// "Chrome 120"). Optional; absent for extensions that don't
    /// identify themselves.
    #[serde(default)]
    pub browser_label: Option<String>,
}

fn default_true() -> bool {
    true
}

/// The slice of a [`BrowserMessage`] that flows downstream. Only
/// `domain` reaches the rules engine; `path` and `title` are
/// intentionally dropped at this boundary so they can't be persisted
/// or matched against.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BrowserContext {
    pub domain: String,
}

/// Decide whether an incoming message contributes a
/// [`BrowserContext`]. Returns `None` for messages we must drop
/// (incognito, unfocused, empty domain) per `docs/PRIVACY.md`.
/// Pure — no IO, no locks. The exclusion-list filter is applied by
/// the listen loop because it needs the live `ExclusionMatcher`.
pub fn project_message(msg: &BrowserMessage) -> Option<BrowserContext> {
    if msg.incognito {
        return None;
    }
    if !msg.focused {
        return None;
    }
    let domain = msg.domain.trim();
    if domain.is_empty() {
        return None;
    }
    Some(BrowserContext {
        domain: domain.to_string(),
    })
}

/// Final-stage gate: project the message through the privacy
/// pipeline + exclusion matcher and (separately) heartbeat the
/// Integrations card. Returns the context to forward to the stream,
/// or `None` if the message must be dropped.
///
/// Exported so the unit tests can exercise the full pipeline without
/// spinning up a real socket.
pub fn handle_message(
    msg: &BrowserMessage,
    exclusions: &Arc<std::sync::RwLock<ExclusionMatcher>>,
    extension_state: &BrowserExtensionState,
) -> Option<BrowserContext> {
    // Heartbeat fires for EVERY message — including incognito /
    // unfocused — so the Integrations card reflects "the extension
    // is alive" regardless of whether the user is currently producing
    // privacy-sensitive signals.
    extension_state.record_heartbeat(msg.browser_label.clone(), Utc::now());

    let ctx = project_message(msg)?;
    let excluded = match exclusions.read() {
        Ok(guard) => guard.matches_domain(&ctx.domain),
        Err(_) => {
            // Lock poisoned (writer panicked). Fail closed: drop the
            // signal. Mirrors `apply_event`'s policy for window
            // events. The next `save_exclusion` mutator will replace
            // the inner state under a fresh guard.
            log::warn!("browser: exclusions read lock poisoned; dropping browser signal");
            return None;
        }
    };
    if excluded {
        return None;
    }
    Some(ctx)
}

// -----------------------------------------------------------------
// Socket listener
// -----------------------------------------------------------------

/// Spawn the browser-signal listener. Returns `Ok(())` after the
/// listener task has been spawned (the bind + listen loop runs to
/// completion of `event_tx`; dropping it signals shutdown).
///
/// On Unix: binds a `UnixListener` at `socket_path`. If a stale
/// socket file exists from a previous run, it's unlinked first.
/// `chmod 0600` is applied so only the current user can connect.
///
/// On Windows: binds a Named Pipe at `WINDOWS_PIPE_NAME` with
/// `reject_remote_clients(true)`. The first instance is bound up
/// front so a second Cairn process fails fast instead of forking
/// a second listener.
pub async fn spawn_listener(
    data_dir: PathBuf,
    event_tx: mpsc::Sender<SignalEvent>,
    exclusions: Arc<std::sync::RwLock<ExclusionMatcher>>,
    extension_state: Arc<BrowserExtensionState>,
) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        spawn_unix(data_dir, event_tx, exclusions, extension_state).await
    }
    #[cfg(windows)]
    {
        let _ = data_dir; // unused — pipe name is constant
        spawn_windows(event_tx, exclusions, extension_state).await
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = (data_dir, event_tx, exclusions, extension_state);
        log::warn!(
            "browser: socket listener not implemented for this platform; \
             browser_domain will stay None"
        );
        Ok(())
    }
}

#[cfg(unix)]
async fn spawn_unix(
    data_dir: PathBuf,
    event_tx: mpsc::Sender<SignalEvent>,
    exclusions: Arc<std::sync::RwLock<ExclusionMatcher>>,
    extension_state: Arc<BrowserExtensionState>,
) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    use tokio::net::UnixListener;

    let path = socket_path(&data_dir);
    // Stale socket from a previous run — `bind` would fail with
    // "address in use" otherwise.
    if path.exists() {
        let _ = std::fs::remove_file(&path);
    }
    let listener = UnixListener::bind(&path)?;
    // Tighten permissions: owner read+write only. The default umask
    // would typically allow group + world read, which leaks the
    // socket's existence to anyone with shell access on the box.
    if let Err(e) = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)) {
        log::warn!("browser: chmod 0600 on socket failed: {e}");
    }

    tokio::spawn(async move {
        loop {
            match listener.accept().await {
                Ok((stream, _)) => {
                    let event_tx = event_tx.clone();
                    let exclusions = exclusions.clone();
                    let extension_state = extension_state.clone();
                    tokio::spawn(async move {
                        handle_unix_conn(stream, event_tx, exclusions, extension_state).await;
                    });
                }
                Err(e) => {
                    // EAGAIN / EINTR are transient; anything else
                    // usually means the listener is being torn down.
                    // Log + bail.
                    log::warn!("browser: accept error: {e}");
                    break;
                }
            }
        }
        // Best-effort cleanup on shutdown.
        let _ = std::fs::remove_file(&path);
    });
    Ok(())
}

#[cfg(unix)]
async fn handle_unix_conn(
    stream: tokio::net::UnixStream,
    event_tx: mpsc::Sender<SignalEvent>,
    exclusions: Arc<std::sync::RwLock<ExclusionMatcher>>,
    extension_state: Arc<BrowserExtensionState>,
) {
    let reader = BufReader::new(stream);
    let mut lines = reader.lines();
    loop {
        match lines.next_line().await {
            Ok(Some(line)) => {
                process_line(&line, &event_tx, &exclusions, &extension_state).await;
            }
            Ok(None) => break, // client closed
            Err(e) => {
                log::debug!("browser: read error: {e}");
                break;
            }
        }
    }
}

#[cfg(windows)]
async fn spawn_windows(
    event_tx: mpsc::Sender<SignalEvent>,
    exclusions: Arc<std::sync::RwLock<ExclusionMatcher>>,
    extension_state: Arc<BrowserExtensionState>,
) -> std::io::Result<()> {
    use tokio::net::windows::named_pipe::ServerOptions;
    // Bind the first instance up-front so a second Cairn process
    // gets ERROR_PIPE_BUSY instead of silently spawning a second
    // listener that the extension would never reach.
    let mut server = ServerOptions::new()
        .first_pipe_instance(true)
        .reject_remote_clients(true)
        .create(WINDOWS_PIPE_NAME)?;

    tokio::spawn(async move {
        loop {
            if let Err(e) = server.connect().await {
                log::warn!("browser: named-pipe connect error: {e}");
                break;
            }
            // Hand off the connected instance and rebind a fresh
            // listener for the next client. This mirrors the
            // `UnixListener::accept` loop.
            let connected = server;
            server = match ServerOptions::new()
                .reject_remote_clients(true)
                .create(WINDOWS_PIPE_NAME)
            {
                Ok(s) => s,
                Err(e) => {
                    log::warn!("browser: rebind named pipe failed: {e}");
                    break;
                }
            };
            let event_tx = event_tx.clone();
            let exclusions = exclusions.clone();
            let extension_state = extension_state.clone();
            tokio::spawn(async move {
                handle_windows_conn(connected, event_tx, exclusions, extension_state).await;
            });
        }
    });
    Ok(())
}

#[cfg(windows)]
async fn handle_windows_conn(
    stream: tokio::net::windows::named_pipe::NamedPipeServer,
    event_tx: mpsc::Sender<SignalEvent>,
    exclusions: Arc<std::sync::RwLock<ExclusionMatcher>>,
    extension_state: Arc<BrowserExtensionState>,
) {
    let reader = BufReader::new(stream);
    let mut lines = reader.lines();
    loop {
        match lines.next_line().await {
            Ok(Some(line)) => {
                process_line(&line, &event_tx, &exclusions, &extension_state).await;
            }
            Ok(None) => break,
            Err(e) => {
                log::debug!("browser: read error: {e}");
                break;
            }
        }
    }
}

#[cfg(any(unix, windows))]
async fn process_line(
    line: &str,
    event_tx: &mpsc::Sender<SignalEvent>,
    exclusions: &Arc<std::sync::RwLock<ExclusionMatcher>>,
    extension_state: &BrowserExtensionState,
) {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return;
    }
    let msg: BrowserMessage = match serde_json::from_str(trimmed) {
        Ok(m) => m,
        Err(e) => {
            // Don't echo the raw line — it can carry user URL data
            // that PRIVACY.md forbids putting in logs.
            log::debug!("browser: malformed JSON ({e}); dropping line");
            return;
        }
    };
    let Some(ctx) = handle_message(&msg, exclusions, extension_state) else {
        return;
    };
    let _ = event_tx.send(SignalEvent::Browser(Some(ctx))).await;
}

// -----------------------------------------------------------------
// Tests
// -----------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn msg_with_domain(domain: &str) -> BrowserMessage {
        BrowserMessage {
            domain: domain.into(),
            path: String::new(),
            title: String::new(),
            incognito: false,
            focused: true,
            browser_label: None,
        }
    }

    // ---- project_message (privacy gates) ---------------------------

    #[test]
    fn project_message_projects_a_focused_normal_window() {
        let m = msg_with_domain("github.com");
        assert_eq!(
            project_message(&m),
            Some(BrowserContext {
                domain: "github.com".into()
            })
        );
    }

    #[test]
    fn project_message_drops_incognito() {
        let mut m = msg_with_domain("github.com");
        m.incognito = true;
        assert!(project_message(&m).is_none());
    }

    #[test]
    fn project_message_drops_unfocused() {
        let mut m = msg_with_domain("github.com");
        m.focused = false;
        assert!(project_message(&m).is_none());
    }

    #[test]
    fn project_message_drops_empty_domain() {
        let m = msg_with_domain("");
        assert!(project_message(&m).is_none());
        let m_ws = msg_with_domain("   ");
        assert!(project_message(&m_ws).is_none());
    }

    #[test]
    fn project_message_trims_surrounding_whitespace() {
        let m = msg_with_domain("  github.com  ");
        let ctx = project_message(&m).unwrap();
        assert_eq!(ctx.domain, "github.com");
    }

    // ---- BrowserMessage serde defaults -----------------------------

    #[test]
    fn browser_message_missing_focused_defaults_to_true() {
        // Older extensions that don't carry the focus flag are
        // treated as foreground (the alternative — defaulting to
        // false — would drop every message they send).
        let raw = r#"{"domain":"github.com"}"#;
        let m: BrowserMessage = serde_json::from_str(raw).unwrap();
        assert!(m.focused);
        assert!(!m.incognito);
        assert_eq!(m.browser_label, None);
    }

    #[test]
    fn browser_message_camel_case_browser_label() {
        // The JS-side field is `browserLabel` (camelCase); serde
        // must accept that, not `browser_label`.
        let raw = r#"{"domain":"x.com","browserLabel":"Chrome 120"}"#;
        let m: BrowserMessage = serde_json::from_str(raw).unwrap();
        assert_eq!(m.browser_label.as_deref(), Some("Chrome 120"));
    }

    // ---- handle_message (with exclusions + heartbeat) --------------

    fn matcher_with_excluded_domain(domain: &str) -> Arc<std::sync::RwLock<ExclusionMatcher>> {
        Arc::new(std::sync::RwLock::new(ExclusionMatcher::for_test(
            &[],
            &[],
            &[domain],
        )))
    }

    #[test]
    fn handle_message_records_heartbeat_even_for_dropped_messages() {
        // The extension is alive whenever it sends ANYTHING, even
        // an incognito ping. The Integrations card reflects that.
        let state = BrowserExtensionState::new();
        let mut m = msg_with_domain("github.com");
        m.incognito = true;
        m.browser_label = Some("Chrome 120".into());
        let exc = Arc::new(std::sync::RwLock::new(ExclusionMatcher::default()));
        assert!(handle_message(&m, &exc, &state).is_none());
        let st = state.snapshot(Utc::now());
        assert!(st.connected);
        assert_eq!(st.browser_label.as_deref(), Some("Chrome 120"));
    }

    #[test]
    fn handle_message_drops_excluded_domain() {
        let exc = matcher_with_excluded_domain("github.com");
        let state = BrowserExtensionState::new();
        let m = msg_with_domain("github.com");
        assert!(handle_message(&m, &exc, &state).is_none());
    }

    #[test]
    fn handle_message_passes_non_excluded_domain_through() {
        let exc = matcher_with_excluded_domain("github.com");
        let state = BrowserExtensionState::new();
        let m = msg_with_domain("example.com");
        let ctx = handle_message(&m, &exc, &state).unwrap();
        assert_eq!(ctx.domain, "example.com");
    }

    #[test]
    fn handle_message_drops_on_poisoned_exclusions_lock() {
        // RAII helper that panics inside `read()`-the-poison check.
        // We poison by spawning a thread that takes the write lock
        // and panics — same trick as `dry_run_recovers_from_poisoned`.
        let exc = Arc::new(std::sync::RwLock::new(ExclusionMatcher::default()));
        let exc_clone = exc.clone();
        let _ = std::thread::spawn(move || {
            let _g = exc_clone.write().unwrap();
            panic!("intentional poison for test");
        })
        .join();
        assert!(exc.read().is_err(), "lock must be poisoned for the test");

        let state = BrowserExtensionState::new();
        let m = msg_with_domain("github.com");
        assert!(handle_message(&m, &exc, &state).is_none());
    }

    // ---- Unix socket roundtrip -------------------------------------
    //
    // Spawn `spawn_listener`, connect a client, send a JSON line,
    // observe the SignalEvent::Browser on the receiver.

    #[cfg(unix)]
    #[tokio::test]
    async fn unix_socket_roundtrip_emits_browser_event() {
        use tokio::io::AsyncWriteExt;
        use tokio::net::UnixStream;
        use tokio::time::{timeout, Duration};

        let dir = tempfile::tempdir().unwrap();
        let data_dir = dir.path().to_path_buf();
        let (tx, mut rx) = mpsc::channel::<SignalEvent>(8);
        let exclusions = Arc::new(std::sync::RwLock::new(ExclusionMatcher::default()));
        let state = Arc::new(BrowserExtensionState::new());

        spawn_listener(data_dir.clone(), tx, exclusions, state)
            .await
            .expect("listener should bind");

        let path = socket_path(&data_dir);
        // Tiny wait so the accept loop is ready.
        for _ in 0..20 {
            if path.exists() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        let mut client = UnixStream::connect(&path).await.expect("connect");
        let line = r#"{"domain":"github.com","focused":true,"incognito":false}
"#;
        client.write_all(line.as_bytes()).await.unwrap();

        let ev = timeout(Duration::from_secs(2), rx.recv())
            .await
            .expect("receive within timeout")
            .expect("channel still open");
        match ev {
            SignalEvent::Browser(Some(ctx)) => assert_eq!(ctx.domain, "github.com"),
            other => panic!("expected Browser(Some), got {other:?}"),
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn unix_socket_unlinks_stale_file_before_bind() {
        let dir = tempfile::tempdir().unwrap();
        let data_dir = dir.path().to_path_buf();
        // Drop a stale file at the socket path to simulate a crashed
        // previous run. `bind` would otherwise fail with EADDRINUSE.
        let path = socket_path(&data_dir);
        std::fs::write(&path, "stale").unwrap();

        let (tx, _rx) = mpsc::channel::<SignalEvent>(8);
        let exclusions = Arc::new(std::sync::RwLock::new(ExclusionMatcher::default()));
        let state = Arc::new(BrowserExtensionState::new());

        spawn_listener(data_dir, tx, exclusions, state)
            .await
            .expect("listener should bind despite stale file");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn unix_socket_chmod_is_0600() {
        use std::os::unix::fs::PermissionsExt;
        use tokio::time::Duration;

        let dir = tempfile::tempdir().unwrap();
        let data_dir = dir.path().to_path_buf();
        let (tx, _rx) = mpsc::channel::<SignalEvent>(8);
        let exclusions = Arc::new(std::sync::RwLock::new(ExclusionMatcher::default()));
        let state = Arc::new(BrowserExtensionState::new());

        spawn_listener(data_dir.clone(), tx, exclusions, state)
            .await
            .unwrap();
        let path = socket_path(&data_dir);
        // Wait briefly for the file to exist + chmod to apply.
        for _ in 0..30 {
            if path.exists() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        let meta = std::fs::metadata(&path).expect("socket file present");
        let mode = meta.permissions().mode() & 0o777;
        assert_eq!(mode, 0o600, "expected 0600, got {mode:o}");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn unix_socket_drops_incognito_messages() {
        use tokio::io::AsyncWriteExt;
        use tokio::net::UnixStream;
        use tokio::time::{timeout, Duration};

        let dir = tempfile::tempdir().unwrap();
        let data_dir = dir.path().to_path_buf();
        let (tx, mut rx) = mpsc::channel::<SignalEvent>(8);
        let exclusions = Arc::new(std::sync::RwLock::new(ExclusionMatcher::default()));
        let state = Arc::new(BrowserExtensionState::new());

        spawn_listener(data_dir.clone(), tx, exclusions, state.clone())
            .await
            .unwrap();
        let path = socket_path(&data_dir);
        for _ in 0..20 {
            if path.exists() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        let mut client = UnixStream::connect(&path).await.unwrap();
        // Incognito → must NOT produce a SignalEvent.
        let line = r#"{"domain":"github.com","incognito":true,"focused":true}
"#;
        client.write_all(line.as_bytes()).await.unwrap();

        let received = timeout(Duration::from_millis(200), rx.recv()).await;
        assert!(
            received.is_err(),
            "no SignalEvent should arrive for an incognito message"
        );
        // ...but the heartbeat IS recorded (the extension is alive).
        let st = state.snapshot(Utc::now());
        assert!(st.connected);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn unix_socket_drops_malformed_json_silently() {
        use tokio::io::AsyncWriteExt;
        use tokio::net::UnixStream;
        use tokio::time::{timeout, Duration};

        let dir = tempfile::tempdir().unwrap();
        let data_dir = dir.path().to_path_buf();
        let (tx, mut rx) = mpsc::channel::<SignalEvent>(8);
        let exclusions = Arc::new(std::sync::RwLock::new(ExclusionMatcher::default()));
        let state = Arc::new(BrowserExtensionState::new());

        spawn_listener(data_dir.clone(), tx, exclusions, state)
            .await
            .unwrap();
        let path = socket_path(&data_dir);
        for _ in 0..20 {
            if path.exists() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        let mut client = UnixStream::connect(&path).await.unwrap();
        // Junk + a well-formed line afterwards on the same connection.
        client
            .write_all(b"{not json\n{\"domain\":\"good.example\",\"focused\":true}\n")
            .await
            .unwrap();

        let ev = timeout(Duration::from_secs(2), rx.recv())
            .await
            .expect("good message arrives despite junk")
            .unwrap();
        match ev {
            SignalEvent::Browser(Some(ctx)) => assert_eq!(ctx.domain, "good.example"),
            other => panic!("expected Browser(Some), got {other:?}"),
        }
    }
}
