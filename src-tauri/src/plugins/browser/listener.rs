//! Local-IPC socket shell for the browser signal source. Binds a
//! per-user, loopback-only socket and folds incoming pushes into the
//! snapshot stream via [`super::parser`]. The parsing/privacy logic is
//! pure and lives next door; this module is the thin IO layer.
//!
//! See `docs/PRIVACY.md` "Browser integration" + issues #35 / #37.
//!
//! ## Socket lifecycle & trust boundary
//!
//! The socket is an **untrusted input boundary**: any local process that
//! can reach the path may write to it. The transport is non-networked by
//! construction and gated to the current user:
//!
//! - **Unix**: `<base>/ipc/sock`, where `base` is the App Group container
//!   on macOS (#250, so the sandboxed Safari handler can reach it) and the
//!   app data dir on Linux — see `super::browser_socket_base`. The parent
//!   `ipc/` directory is `chmod 0700` (owner-only-traverse) so a
//!   concurrent local user can't even reach the path during the
//!   bind-before-chmod window; the socket file itself is `chmod 0600`
//!   after bind. A stale file from a crashed previous run is unlinked
//!   before bind. A Unix-domain socket has no network address, so a
//!   remote/TCP client cannot connect.
//! - **Windows**: `\\.\pipe\cairn`, `reject_remote_clients(true)`. That
//!   blocks network access but does NOT restrict local-other-user access
//!   — the default DACL can include `Everyone`-traverse depending on
//!   session class. A proper DACL via `CreateNamedPipeW` +
//!   `SECURITY_ATTRIBUTES` is tracked as a follow-up (fine for v1: Cairn
//!   is a single-user desktop app).
//!
//! ## Abort semantics (plugin disable)
//!
//! Per-connection handlers run inside a [`tokio::task::JoinSet`] owned by
//! the accept loop. When the plugin host disables the source it aborts
//! the loop future; dropping it drops the `JoinSet`, which aborts every
//! in-flight handler — so a disabled source stops pushing immediately
//! instead of feeding the stream from whatever connections were open.

// `Path` is only referenced by the Unix bind helpers; `PathBuf` is in
// `run`'s signature on every platform.
#[cfg(unix)]
use std::path::Path;
use std::path::PathBuf;
use std::sync::{Arc, RwLock};

use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncReadExt, BufReader};
use tokio::sync::mpsc;

use super::parser::{handle_message, BrowserMessage};
use crate::signals::browser_extension::BrowserExtensionState;
use crate::signals::exclusions::ExclusionMatcher;
use crate::signals::stream::SignalEvent;

/// Filename of the Unix domain socket inside [`IPC_SUBDIR`]. The pipe
/// name on Windows is the constant [`WINDOWS_PIPE_NAME`].
#[cfg(unix)]
pub const SOCKET_FILENAME: &str = "sock";

/// Owner-private subdirectory of `data_dir` that holds the IPC socket.
/// Defence in depth against the `bind`-before-`chmod` race: the socket
/// briefly exists with `bind`'s default permissions before the explicit
/// `chmod 0600` lands, so we hide it inside a directory the OS won't
/// traverse for any user other than the current owner (`mkdir 0700`).
#[cfg(unix)]
pub const IPC_SUBDIR: &str = "ipc";

/// Maximum bytes per JSON frame on the socket. Real `BrowserMessage`
/// frames (domain + path + title + a few flags) are well under 16 KB.
/// 64 KB is generous headroom — a peer that writes more without a
/// newline is presumed malicious or buggy and the connection is dropped.
/// This bounds the per-connection memory the listener can hold while
/// reading.
pub const MAX_LINE_BYTES: usize = 64 * 1024;

/// Maximum concurrent client connections the listener will service. Real
/// workloads need at most one (the user's primary browser) plus maybe a
/// second during an extension reload. 8 is generous; reaping the
/// connection `JoinSet` at this cap throttles a runaway reconnect flood
/// to "as fast as a slot frees" instead of "as fast as the runtime can
/// spawn tasks".
pub const MAX_CONCURRENT_CONNECTIONS: usize = 8;

#[cfg(windows)]
pub const WINDOWS_PIPE_NAME: &str = r"\\.\pipe\cairn";

/// Resolve the socket path inside `data_dir/<IPC_SUBDIR>/`. Unix-only —
/// the Windows listener uses the fixed [`WINDOWS_PIPE_NAME`] and ignores
/// `data_dir`.
#[cfg(unix)]
pub fn socket_path(data_dir: &Path) -> PathBuf {
    data_dir.join(IPC_SUBDIR).join(SOCKET_FILENAME)
}

/// Bind + serve the browser-signal socket, running until the snapshot
/// stream's receiver is dropped (clean shutdown) or the caller aborts
/// the future (plugin disabled). Returns `Err` only if the initial bind
/// fails — the [`super::plugin`] wrapper logs that and lets the rest of
/// the app run without the browser source.
pub async fn run(
    data_dir: PathBuf,
    event_tx: mpsc::Sender<SignalEvent>,
    exclusions: Arc<RwLock<ExclusionMatcher>>,
    extension_state: Arc<BrowserExtensionState>,
) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        run_unix(data_dir, event_tx, exclusions, extension_state).await
    }
    #[cfg(windows)]
    {
        let _ = data_dir; // unused — the pipe name is a constant
        run_windows(event_tx, exclusions, extension_state).await
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

// -----------------------------------------------------------------
// Unix
// -----------------------------------------------------------------

/// Best-effort `chmod`. Split out so both the success and the failure
/// (log) arms are unit-tested directly rather than depending on a
/// filesystem that rejects `set_permissions`.
#[cfg(unix)]
fn chmod_best_effort(path: &Path, mode: u32, what: &str) {
    use std::os::unix::fs::PermissionsExt;
    if let Err(e) = std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode)) {
        log::warn!("browser: chmod {mode:o} on {what} failed: {e}");
    }
}

/// Remove a stale socket file left by a crashed previous run. `bind`
/// would fail with `EADDRINUSE` otherwise. No `exists()` probe: a
/// symlink swap between the probe and the remove would leak, so we just
/// try and succeed-or-ignore. Split out so each arm is unit-tested.
#[cfg(unix)]
fn remove_stale_socket(path: &Path) {
    match std::fs::remove_file(path) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => log::debug!("browser: stale-file remove failed: {e}"),
    }
}

/// Create the owner-private `ipc/` dir, unlink any stale socket, bind,
/// and lock the socket down to `0600`. Synchronous (every step is a
/// `std::fs` call or the sync `UnixListener::bind`), but must run inside
/// a tokio runtime so the bound listener registers with the reactor.
#[cfg(unix)]
fn bind_unix(data_dir: &Path) -> std::io::Result<(tokio::net::UnixListener, PathBuf)> {
    let ipc_dir = data_dir.join(IPC_SUBDIR);
    std::fs::create_dir_all(&ipc_dir)?;
    chmod_best_effort(&ipc_dir, 0o700, "ipc dir");

    let path = socket_path(data_dir);
    remove_stale_socket(&path);
    let listener = tokio::net::UnixListener::bind(&path)?;
    chmod_best_effort(&path, 0o600, "socket");
    Ok((listener, path))
}

/// Removes the socket file when the accept loop ends — whether it broke
/// cleanly (driver gone) or the host aborted it (source disabled). The
/// next enable also unlinks a stale file, so this is belt-and-braces; it
/// keeps a disabled source from leaving a dangling socket behind.
#[cfg(unix)]
struct SocketCleanup {
    path: PathBuf,
}

#[cfg(unix)]
impl Drop for SocketCleanup {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}

#[cfg(unix)]
async fn run_unix(
    data_dir: PathBuf,
    event_tx: mpsc::Sender<SignalEvent>,
    exclusions: Arc<RwLock<ExclusionMatcher>>,
    extension_state: Arc<BrowserExtensionState>,
) -> std::io::Result<()> {
    let (listener, path) = bind_unix(&data_dir)?;
    serve_unix(
        listener,
        path,
        event_tx,
        exclusions,
        extension_state,
        MAX_CONCURRENT_CONNECTIONS,
    )
    .await;
    Ok(())
}

#[cfg(unix)]
async fn serve_unix(
    listener: tokio::net::UnixListener,
    path: PathBuf,
    event_tx: mpsc::Sender<SignalEvent>,
    exclusions: Arc<RwLock<ExclusionMatcher>>,
    extension_state: Arc<BrowserExtensionState>,
    max_conns: usize,
) {
    let _cleanup = SocketCleanup { path };
    let mut conns: tokio::task::JoinSet<()> = tokio::task::JoinSet::new();
    loop {
        // Bound concurrency: `conns.len()` counts spawned-but-unreaped
        // tasks, so reaping at the cap throttles a reconnect flood and
        // keeps the handle backlog from growing unbounded.
        while conns.len() >= max_conns {
            conns.join_next().await;
        }
        tokio::select! {
            // Bias toward the shutdown signal so a closed driver wins
            // over a ready accept.
            biased;
            _ = event_tx.closed() => break,
            accepted = listener.accept() => {
                if let Ok((stream, _)) = accepted {
                    conns.spawn(handle_conn(
                        stream,
                        event_tx.clone(),
                        exclusions.clone(),
                        extension_state.clone(),
                    ));
                }
                // An accept error on a socket we own carries no action
                // we can take; we loop and let the `event_tx.closed()`
                // arm (or a host abort) end us, so a transient
                // EINTR/EMFILE doesn't tear the listener down.
            }
        }
    }
    // `conns` drops here (and on abort), aborting in-flight handlers.
}

// -----------------------------------------------------------------
// Windows
// -----------------------------------------------------------------

#[cfg(windows)]
async fn run_windows(
    event_tx: mpsc::Sender<SignalEvent>,
    exclusions: Arc<RwLock<ExclusionMatcher>>,
    extension_state: Arc<BrowserExtensionState>,
) -> std::io::Result<()> {
    use tokio::net::windows::named_pipe::ServerOptions;
    // Bind the first instance up-front so a second Cairn process gets
    // ERROR_PIPE_BUSY instead of silently spawning a second listener the
    // extension would never reach.
    let mut server = ServerOptions::new()
        .first_pipe_instance(true)
        .reject_remote_clients(true)
        .create(WINDOWS_PIPE_NAME)?;

    let mut conns: tokio::task::JoinSet<()> = tokio::task::JoinSet::new();
    loop {
        while conns.len() >= MAX_CONCURRENT_CONNECTIONS {
            conns.join_next().await;
        }
        tokio::select! {
            biased;
            _ = event_tx.closed() => break,
            connected = server.connect() => {
                if let Err(e) = connected {
                    log::warn!("browser: named-pipe connect error: {e}");
                    break;
                }
                // Hand off the connected instance and rebind a fresh
                // listener for the next client (mirrors UnixListener::accept).
                let pipe = server;
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
                conns.spawn(handle_conn(
                    pipe,
                    event_tx.clone(),
                    exclusions.clone(),
                    extension_state.clone(),
                ));
            }
        }
    }
    Ok(())
}

// -----------------------------------------------------------------
// Per-connection framing + dispatch
// -----------------------------------------------------------------

/// Read one newline-terminated frame, bounded at [`MAX_LINE_BYTES`].
/// Returns `Ok(Some(line))` for a complete frame, `Ok(None)` on EOF
/// (peer closed), and `Err` for IO errors. A frame that exceeds the cap
/// returns `Err` so the caller drops the connection; otherwise a hostile
/// peer could OOM us by sending gigabytes without a newline.
async fn read_capped_line<R: AsyncRead + Unpin>(
    reader: &mut BufReader<R>,
) -> std::io::Result<Option<Vec<u8>>> {
    let mut buf = Vec::new();
    // The `take` adapter caps the read; without it a peer sending 1 GiB
    // with no newline would grow `buf` until OOM.
    let mut limited = reader.take((MAX_LINE_BYTES + 1) as u64);
    let n = limited.read_until(b'\n', &mut buf).await?;
    if n == 0 {
        return Ok(None); // EOF
    }
    if buf.len() > MAX_LINE_BYTES {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "browser: frame exceeds MAX_LINE_BYTES",
        ));
    }
    // Strip trailing \n / \r\n so callers don't have to.
    while matches!(buf.last(), Some(b'\n') | Some(b'\r')) {
        buf.pop();
    }
    Ok(Some(buf))
}

#[cfg(any(unix, windows))]
async fn handle_conn<S>(
    stream: S,
    event_tx: mpsc::Sender<SignalEvent>,
    exclusions: Arc<RwLock<ExclusionMatcher>>,
    extension_state: Arc<BrowserExtensionState>,
) where
    S: AsyncRead + Unpin,
{
    let mut reader = BufReader::new(stream);
    loop {
        match read_capped_line(&mut reader).await {
            Ok(Some(line)) => {
                let s = match std::str::from_utf8(&line) {
                    Ok(s) => s,
                    Err(_) => {
                        // Non-UTF8 frame — log a brief warning (no
                        // payload) and drop the connection.
                        log::debug!("browser: non-utf8 frame; dropping connection");
                        break;
                    }
                };
                if matches!(
                    process_line(s, &event_tx, &exclusions, &extension_state).await,
                    LineOutcome::Break
                ) {
                    break;
                }
            }
            Ok(None) => break, // client closed
            Err(e) => {
                log::debug!("browser: read error: {e}");
                break;
            }
        }
    }
}

/// Control signal from [`process_line`]: `Continue` means read the next
/// frame; `Break` means the downstream channel is closed (snapshot
/// stream gone) so further parsing is wasted and we drop the connection.
#[cfg(any(unix, windows))]
enum LineOutcome {
    Continue,
    Break,
}

#[cfg(any(unix, windows))]
async fn process_line(
    line: &str,
    event_tx: &mpsc::Sender<SignalEvent>,
    exclusions: &Arc<RwLock<ExclusionMatcher>>,
    extension_state: &BrowserExtensionState,
) -> LineOutcome {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return LineOutcome::Continue;
    }
    let msg: BrowserMessage = match serde_json::from_str(trimmed) {
        Ok(m) => m,
        Err(e) => {
            // Don't echo the raw line — it can carry user URL data that
            // PRIVACY.md forbids putting in logs.
            log::debug!("browser: malformed JSON ({e}); dropping line");
            return LineOutcome::Continue;
        }
    };
    let Some(ctx) = handle_message(&msg, exclusions, extension_state) else {
        return LineOutcome::Continue;
    };
    // Drop the connection if the snapshot stream is gone — otherwise we'd
    // keep parsing JSON for a downstream that can't act on it.
    match event_tx.send(SignalEvent::Browser(Some(ctx))).await {
        Ok(()) => LineOutcome::Continue,
        Err(_) => {
            log::warn!("browser: snapshot stream closed; dropping connection");
            LineOutcome::Break
        }
    }
}

// -----------------------------------------------------------------
// Tests
// -----------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    // ---- pure helpers (deterministic, no socket) -------------------

    #[cfg(unix)]
    #[test]
    fn chmod_best_effort_success_and_failure_arms() {
        // Success: a real temp file is chmodded without logging.
        let dir = tempfile::tempdir().unwrap();
        let f = dir.path().join("f");
        std::fs::write(&f, b"x").unwrap();
        chmod_best_effort(&f, 0o600, "test file");
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(&f).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);

        // Failure: set_permissions on a missing path errors → log arm.
        // Must not panic.
        chmod_best_effort(&dir.path().join("does-not-exist"), 0o600, "ghost");
    }

    #[cfg(unix)]
    #[test]
    fn remove_stale_socket_covers_all_arms() {
        let dir = tempfile::tempdir().unwrap();
        // Ok: an existing file is removed.
        let f = dir.path().join("stale");
        std::fs::write(&f, b"x").unwrap();
        remove_stale_socket(&f);
        assert!(!f.exists());
        // NotFound: removing a missing file is a silent no-op.
        remove_stale_socket(&dir.path().join("missing"));
        // Other error: remove_file on a directory is neither Ok nor
        // NotFound → the debug-log arm, without panicking.
        remove_stale_socket(dir.path());
        assert!(dir.path().exists(), "directory must survive remove_file");
    }

    // ---- read_capped_line (in-memory) ------------------------------

    #[tokio::test]
    async fn read_capped_line_caps_at_max_line_bytes() {
        use std::io::Cursor;
        // MAX_LINE_BYTES + 1 with no newline → InvalidData (over cap).
        let oversize = vec![b'a'; MAX_LINE_BYTES + 1];
        let mut reader = BufReader::new(Cursor::new(oversize));
        assert!(
            read_capped_line(&mut reader).await.is_err(),
            "oversize without newline must error"
        );

        // Exactly MAX_LINE_BYTES (including the newline) → whole frame.
        let mut exact = vec![b'a'; MAX_LINE_BYTES - 1];
        exact.push(b'\n');
        let mut reader = BufReader::new(Cursor::new(exact));
        let line = read_capped_line(&mut reader)
            .await
            .expect("at-cap frame ok")
            .expect("frame present");
        assert_eq!(line.len(), MAX_LINE_BYTES - 1);
    }

    #[tokio::test]
    async fn read_capped_line_strips_crlf_and_lf() {
        use std::io::Cursor;
        for input in ["foo\n", "foo\r\n"] {
            let mut reader = BufReader::new(Cursor::new(input));
            let line = read_capped_line(&mut reader).await.unwrap().unwrap();
            assert_eq!(&line, b"foo", "expected `foo`, got {line:?}");
        }
    }

    #[tokio::test]
    async fn read_capped_line_returns_none_on_immediate_eof() {
        use std::io::Cursor;
        let mut reader = BufReader::new(Cursor::new(Vec::<u8>::new()));
        assert!(read_capped_line(&mut reader).await.unwrap().is_none());
    }

    // ---- process_line (in-memory channel) --------------------------

    fn fresh_exclusions() -> Arc<RwLock<ExclusionMatcher>> {
        Arc::new(RwLock::new(ExclusionMatcher::default()))
    }

    #[tokio::test]
    async fn process_line_skips_whitespace_only_lines() {
        let (tx, mut rx) = mpsc::channel::<SignalEvent>(4);
        let exclusions = fresh_exclusions();
        let state = BrowserExtensionState::new();
        for input in ["", "   ", "\t\t", " \r"] {
            assert!(matches!(
                process_line(input, &tx, &exclusions, &state).await,
                LineOutcome::Continue
            ));
        }
        assert!(rx.try_recv().is_err(), "whitespace lines emit nothing");
    }

    #[tokio::test]
    async fn process_line_drops_malformed_json() {
        let (tx, mut rx) = mpsc::channel::<SignalEvent>(4);
        let exclusions = fresh_exclusions();
        let state = BrowserExtensionState::new();
        assert!(matches!(
            process_line("{not json", &tx, &exclusions, &state).await,
            LineOutcome::Continue
        ));
        assert!(rx.try_recv().is_err(), "malformed JSON emits nothing");
    }

    #[tokio::test]
    async fn process_line_drops_filtered_message_without_emitting() {
        // An incognito message is dropped by handle_message → Continue,
        // no event. Exercises the `let Some(ctx) = … else` None arm.
        let (tx, mut rx) = mpsc::channel::<SignalEvent>(4);
        let exclusions = fresh_exclusions();
        let state = BrowserExtensionState::new();
        let line = r#"{"domain":"github.com","incognito":true,"focused":true}"#;
        assert!(matches!(
            process_line(line, &tx, &exclusions, &state).await,
            LineOutcome::Continue
        ));
        assert!(rx.try_recv().is_err(), "incognito emits nothing");
    }

    #[tokio::test]
    async fn process_line_emits_browser_event_for_a_good_line() {
        let (tx, mut rx) = mpsc::channel::<SignalEvent>(4);
        let exclusions = fresh_exclusions();
        let state = BrowserExtensionState::new();
        let line = r#"{"domain":"example.com","focused":true}"#;
        assert!(matches!(
            process_line(line, &tx, &exclusions, &state).await,
            LineOutcome::Continue
        ));
        match rx.try_recv() {
            Ok(SignalEvent::Browser(Some(ctx))) => assert_eq!(ctx.domain, "example.com"),
            other => panic!("expected Browser(Some(example.com)), got {other:?}"),
        }
    }

    #[tokio::test]
    async fn process_line_breaks_when_receiver_dropped() {
        let (tx, rx) = mpsc::channel::<SignalEvent>(4);
        drop(rx); // snapshot stream gone → send fails → Break
        let exclusions = fresh_exclusions();
        let state = BrowserExtensionState::new();
        let line = r#"{"domain":"example.com","focused":true}"#;
        assert!(matches!(
            process_line(line, &tx, &exclusions, &state).await,
            LineOutcome::Break
        ));
    }

    // ---- handle_conn (in-memory reader) ----------------------------

    #[tokio::test]
    async fn handle_conn_processes_line_then_breaks_on_eof() {
        use std::io::Cursor;
        let (tx, mut rx) = mpsc::channel::<SignalEvent>(4);
        let exclusions = fresh_exclusions();
        let state = Arc::new(BrowserExtensionState::new());
        let input = Cursor::new(b"{\"domain\":\"eof.example\",\"focused\":true}\n".to_vec());
        // One complete frame, then EOF — covers Ok(Some)→Continue and
        // the Ok(None)→break arm in a single deterministic run.
        handle_conn(input, tx, exclusions, state).await;
        match rx.try_recv() {
            Ok(SignalEvent::Browser(Some(ctx))) => assert_eq!(ctx.domain, "eof.example"),
            other => panic!("expected Browser(Some(eof.example)), got {other:?}"),
        }
    }

    #[tokio::test]
    async fn handle_conn_drops_connection_on_non_utf8_frame() {
        use std::io::Cursor;
        let (tx, mut rx) = mpsc::channel::<SignalEvent>(4);
        let exclusions = fresh_exclusions();
        let state = Arc::new(BrowserExtensionState::new());
        // Invalid UTF-8 terminated by a newline → the from_utf8 check
        // drops the connection before any parse.
        let input = Cursor::new(vec![0xFF, 0xFE, b'\n']);
        handle_conn(input, tx, exclusions, state).await;
        assert!(rx.try_recv().is_err(), "non-utf8 frame emits nothing");
    }

    #[tokio::test]
    async fn handle_conn_drops_connection_on_oversized_frame() {
        use std::io::Cursor;
        let (tx, mut rx) = mpsc::channel::<SignalEvent>(4);
        let exclusions = fresh_exclusions();
        let state = Arc::new(BrowserExtensionState::new());
        // MAX_LINE_BYTES + 1 bytes, no newline → read_capped_line errors
        // → handle_conn's Err arm drops the connection.
        let input = Cursor::new(vec![b'a'; MAX_LINE_BYTES + 1]);
        handle_conn(input, tx, exclusions, state).await;
        assert!(rx.try_recv().is_err(), "oversized frame emits nothing");
    }

    #[tokio::test]
    async fn handle_conn_breaks_when_snapshot_stream_closed() {
        use std::io::Cursor;
        let (tx, rx) = mpsc::channel::<SignalEvent>(4);
        drop(rx); // snapshot stream gone → process_line returns Break
        let exclusions = fresh_exclusions();
        let state = Arc::new(BrowserExtensionState::new());
        // A valid frame whose send fails → handle_conn breaks the
        // connection (covers the `LineOutcome::Break` → break arm).
        let input = Cursor::new(b"{\"domain\":\"x.example\",\"focused\":true}\n".to_vec());
        handle_conn(input, tx, exclusions, state).await;
    }

    // ---- Unix socket integration -----------------------------------

    #[cfg(unix)]
    async fn wait_for_socket(path: &std::path::Path) {
        for _ in 0..50 {
            if path.exists() {
                return;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn unix_socket_roundtrip_emits_browser_event() {
        use tokio::io::AsyncWriteExt;
        use tokio::net::UnixStream;
        use tokio::time::{timeout, Duration};

        let dir = tempfile::tempdir().unwrap();
        let data_dir = dir.path().to_path_buf();
        let (tx, mut rx) = mpsc::channel::<SignalEvent>(8);
        let exclusions = fresh_exclusions();
        let state = Arc::new(BrowserExtensionState::new());

        let serve = tokio::spawn(run(data_dir.clone(), tx, exclusions, state));
        let path = socket_path(&data_dir);
        wait_for_socket(&path).await;

        let mut client = UnixStream::connect(&path).await.expect("connect");
        client
            .write_all(b"{\"domain\":\"github.com\",\"focused\":true,\"incognito\":false}\n")
            .await
            .unwrap();

        let ev = timeout(Duration::from_secs(2), rx.recv())
            .await
            .expect("receive within timeout")
            .expect("channel still open");
        match ev {
            SignalEvent::Browser(Some(ctx)) => assert_eq!(ctx.domain, "github.com"),
            other => panic!("expected Browser(Some), got {other:?}"),
        }
        serve.abort();
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn unix_socket_drops_excluded_and_incognito_but_passes_others() {
        use tokio::io::AsyncWriteExt;
        use tokio::net::UnixStream;
        use tokio::time::{timeout, Duration};

        let dir = tempfile::tempdir().unwrap();
        let data_dir = dir.path().to_path_buf();
        let (tx, mut rx) = mpsc::channel::<SignalEvent>(8);
        // `bank.example` is excluded at the collector — it must never
        // reach the stream.
        let exclusions = Arc::new(RwLock::new(ExclusionMatcher::for_test(
            &[],
            &[],
            &["bank.example"],
        )));
        let state = Arc::new(BrowserExtensionState::new());

        let serve = tokio::spawn(run(data_dir.clone(), tx, exclusions, state));
        let path = socket_path(&data_dir);
        wait_for_socket(&path).await;

        let mut client = UnixStream::connect(&path).await.unwrap();
        // Excluded, then incognito, then a good one — only the last
        // should surface, proving the first two were dropped in order.
        client
            .write_all(
                b"{\"domain\":\"bank.example\",\"focused\":true}\n\
                  {\"domain\":\"secret.example\",\"incognito\":true,\"focused\":true}\n\
                  {\"domain\":\"good.example\",\"focused\":true}\n",
            )
            .await
            .unwrap();

        let ev = timeout(Duration::from_secs(2), rx.recv())
            .await
            .expect("the non-excluded message arrives")
            .unwrap();
        match ev {
            SignalEvent::Browser(Some(ctx)) => assert_eq!(ctx.domain, "good.example"),
            other => panic!("expected Browser(Some(good.example)), got {other:?}"),
        }
        serve.abort();
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn unix_socket_perms_are_locked_down() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let (listener, path) = bind_unix(dir.path()).expect("bind");
        // Socket file is owner-only.
        let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600, "expected socket 0600, got {mode:o}");
        // The parent ipc dir is owner-only-traverse.
        let ipc_dir = dir.path().join(IPC_SUBDIR);
        let dmode = std::fs::metadata(&ipc_dir).unwrap().permissions().mode() & 0o777;
        assert_eq!(dmode, 0o700, "expected ipc dir 0700, got {dmode:o}");
        drop(listener);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn unix_bind_unlinks_a_stale_socket_file() {
        // A leftover file at the socket path must be unlinked so bind
        // doesn't fail with EADDRINUSE.
        let dir = tempfile::tempdir().unwrap();
        let path = socket_path(dir.path());
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, b"stale").unwrap();
        let (listener, _path) = bind_unix(dir.path()).expect("bind despite stale file");
        drop(listener);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn run_returns_err_when_data_dir_is_unusable() {
        // data_dir is a *file*, so create_dir_all of the ipc subdir
        // fails and `?` propagates — run() returns Err, never panics.
        let dir = tempfile::tempdir().unwrap();
        let file_path = dir.path().join("not-a-dir");
        std::fs::write(&file_path, b"x").unwrap();
        let (tx, _rx) = mpsc::channel::<SignalEvent>(4);
        let exclusions = fresh_exclusions();
        let state = Arc::new(BrowserExtensionState::new());
        assert!(
            run(file_path, tx, exclusions, state).await.is_err(),
            "binding under a file path must error"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn run_exits_and_cleans_up_when_receiver_dropped() {
        let dir = tempfile::tempdir().unwrap();
        let data_dir = dir.path().to_path_buf();
        let (tx, rx) = mpsc::channel::<SignalEvent>(8);
        let exclusions = fresh_exclusions();
        let state = Arc::new(BrowserExtensionState::new());

        let handle = tokio::spawn(run(data_dir.clone(), tx, exclusions, state));
        let path = socket_path(&data_dir);
        wait_for_socket(&path).await;
        assert!(path.exists(), "socket bound");

        // Drop the only receiver → event_tx.closed() fires → the accept
        // loop breaks → run() returns Ok → SocketCleanup removes the file.
        drop(rx);
        let result = tokio::time::timeout(std::time::Duration::from_secs(2), handle)
            .await
            .expect("run exits after the receiver drops")
            .expect("run task joined");
        assert!(result.is_ok(), "clean shutdown returns Ok, got {result:?}");

        for _ in 0..50 {
            if !path.exists() {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        assert!(!path.exists(), "SocketCleanup removed the socket on exit");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn serve_unix_caps_concurrent_connections() {
        use tokio::io::AsyncWriteExt;
        use tokio::net::UnixStream;
        use tokio::time::{timeout, Duration};

        let dir = tempfile::tempdir().unwrap();
        let (listener, path) = bind_unix(dir.path()).expect("bind");
        let (tx, mut rx) = mpsc::channel::<SignalEvent>(8);
        let exclusions = fresh_exclusions();
        let state = Arc::new(BrowserExtensionState::new());

        // max_conns = 1: the loop must reap conn #1 before accepting
        // conn #2 — exercises the `while conns.len() >= max_conns`
        // backpressure branch deterministically.
        let serve = tokio::spawn(serve_unix(listener, path.clone(), tx, exclusions, state, 1));

        // Conn #1 stays open, holding the single slot.
        let mut c1 = UnixStream::connect(&path).await.unwrap();
        c1.write_all(b"{\"domain\":\"first.example\",\"focused\":true}\n")
            .await
            .unwrap();
        let ev1 = timeout(Duration::from_secs(2), rx.recv())
            .await
            .unwrap()
            .unwrap();
        assert!(matches!(ev1, SignalEvent::Browser(Some(ref c)) if c.domain == "first.example"));

        // Conn #2 connects + writes, but its handler can't start until
        // the slot frees, so nothing arrives yet.
        let mut c2 = UnixStream::connect(&path).await.unwrap();
        c2.write_all(b"{\"domain\":\"second.example\",\"focused\":true}\n")
            .await
            .unwrap();
        assert!(
            timeout(Duration::from_millis(200), rx.recv())
                .await
                .is_err(),
            "conn #2 must wait for the single slot to free"
        );

        // Close conn #1 → its handler ends → the slot frees → conn #2 is
        // accepted and its domain lands.
        drop(c1);
        let ev2 = timeout(Duration::from_secs(2), rx.recv())
            .await
            .unwrap()
            .unwrap();
        assert!(matches!(ev2, SignalEvent::Browser(Some(ref c)) if c.domain == "second.example"));
        serve.abort();
    }
}
