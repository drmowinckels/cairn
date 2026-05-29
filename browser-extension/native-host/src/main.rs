//! Cairn browser-extension native messaging host.
//!
//! The browser launches this binary once per browser session and pipes
//! messages to it over stdin in the Chrome Native Messaging format:
//!
//!     ┌────────────────┬─────────────────────────────────────┐
//!     │ u32 little-end │ that many bytes of UTF-8 JSON       │
//!     └────────────────┴─────────────────────────────────────┘
//!
//! See: https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging#native-messaging-host-protocol
//!
//! For each well-formed message we forward a newline-delimited JSON
//! line to the local Cairn IPC socket:
//!
//! - Unix: `<XDG_DATA_HOME or ~/.local/share>/cairn/ipc/sock` (falls
//!   back to platform-equivalent `app_data_dir`).
//! - Windows: `\\.\pipe\cairn`.
//!
//! ## Privacy gates
//!
//! Per `docs/PRIVACY.md`:
//!
//! - Reject any field other than the documented set (`domain`,
//!   `incognito`, `focused`, `browserLabel`). A buggy extension
//!   sending the full URL gets the extra fields stripped here.
//! - The host never logs to disk by default. The optional
//!   `CAIRN_HOST_DEBUG=1` env-var enables stderr logging for
//!   troubleshooting — stderr from a native host is captured by the
//!   browser and not written to a user-readable file.
//! - We don't open the socket on startup. The first valid message
//!   triggers the connect; an idle session never opens it.

use std::io::{BufReader, Read, Write};
#[cfg(unix)]
use std::os::unix::net::UnixStream;
use std::path::PathBuf;
use std::time::Duration;

use serde::{Deserialize, Serialize};

/// Maximum size in bytes of a single inbound Native Messaging frame.
/// Chrome's documented limit is 1 MiB; we clamp at 64 KiB because real
/// `BrowserMessage` payloads are well under 1 KiB. A larger frame is
/// dropped silently (browser side is presumed to be malicious or buggy).
const MAX_INBOUND_BYTES: u32 = 64 * 1024;

/// Maximum size of any frame we emit back to the browser. Today we
/// never reply (the extension is fire-and-forget), but Chrome reads
/// stdout in this same length-prefixed format, so the constant lives
/// here for future-proofing.
#[allow(dead_code)]
const MAX_OUTBOUND_BYTES: u32 = 64 * 1024;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Inbound {
    domain: String,
    #[serde(default)]
    incognito: bool,
    #[serde(default = "default_true")]
    focused: bool,
    #[serde(default)]
    browser_label: Option<String>,
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Outbound<'a> {
    domain: &'a str,
    incognito: bool,
    focused: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    browser_label: Option<&'a str>,
}

fn main() {
    let debug = std::env::var_os("CAIRN_HOST_DEBUG").is_some();
    if let Err(e) = run(debug) {
        if debug {
            eprintln!("cairn-browser-host: exiting with error: {e}");
        }
        // Non-zero exit so the browser knows we crashed.
        std::process::exit(1);
    }
}

fn run(debug: bool) -> std::io::Result<()> {
    let socket = socket_path();
    if debug {
        eprintln!("cairn-browser-host: target socket = {}", socket.display());
    }
    let stdin = std::io::stdin();
    let mut reader = BufReader::new(stdin.lock());
    let mut socket: Option<SocketConn> = None;

    loop {
        let raw = match read_frame(&mut reader)? {
            Some(b) => b,
            None => return Ok(()), // EOF — browser closed the pipe
        };
        let Ok(msg) = serde_json::from_slice::<Inbound>(&raw) else {
            if debug {
                eprintln!("cairn-browser-host: malformed JSON frame; dropping");
            }
            continue;
        };
        // Project to the outbound shape — explicit allowlist of fields.
        // Any extras on the inbound side are dropped by serde's default
        // behaviour, but emitting via the typed `Outbound` struct also
        // ensures we never leak a future field through transparently.
        let out = Outbound {
            domain: msg.domain.as_str(),
            incognito: msg.incognito,
            focused: msg.focused,
            browser_label: msg.browser_label.as_deref(),
        };
        let line = match serde_json::to_string(&out) {
            Ok(s) => s,
            Err(e) => {
                if debug {
                    eprintln!("cairn-browser-host: serialize failed: {e}");
                }
                continue;
            }
        };
        if let Err(e) = send_to_socket(&mut socket, &line) {
            if debug {
                eprintln!("cairn-browser-host: socket write failed: {e}");
            }
            // Drop the connection and try again on the next message.
            socket = None;
        }
    }
}

/// Read one Native Messaging frame from stdin. Returns `Ok(None)` on
/// EOF, `Err` on a malformed length prefix or oversize frame. The
/// browser is expected to close stdin on extension shutdown; we return
/// cleanly in that case.
fn read_frame<R: Read>(reader: &mut R) -> std::io::Result<Option<Vec<u8>>> {
    let mut len_buf = [0u8; 4];
    match reader.read_exact(&mut len_buf) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(e) => return Err(e),
    }
    let len = u32::from_le_bytes(len_buf);
    if len > MAX_INBOUND_BYTES {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!("cairn-browser-host: frame too large ({len} bytes)"),
        ));
    }
    let mut buf = vec![0u8; len as usize];
    reader.read_exact(&mut buf)?;
    Ok(Some(buf))
}

/// Persistent connection to the main app's IPC socket. We hold it open
/// across messages so high-frequency tab switches don't pay the
/// `connect`/`close` cost per message. The connection is lazy: opened
/// on the first message and re-opened after any write error.
struct SocketConn {
    #[cfg(unix)]
    stream: UnixStream,
    #[cfg(windows)]
    stream: std::fs::File,
}

impl SocketConn {
    fn connect(path: &std::path::Path) -> std::io::Result<Self> {
        #[cfg(unix)]
        {
            let stream = UnixStream::connect(path)?;
            stream.set_write_timeout(Some(Duration::from_secs(1)))?;
            Ok(Self { stream })
        }
        #[cfg(windows)]
        {
            // Named pipes on Windows are file-like: open via OpenOptions.
            // Tokio's named pipe API is async; the host stays sync (one
            // thread, blocking IO), so we use std::fs::OpenOptions which
            // delegates to CreateFileW with the right access flags.
            use std::os::windows::fs::OpenOptionsExt;
            // FILE_FLAG_OVERLAPPED is the default in tokio's NamedPipeServer;
            // we want SYNCHRONOUS access from this side.
            let stream = std::fs::OpenOptions::new()
                .read(true)
                .write(true)
                .custom_flags(0) // synchronous
                .open(path)?;
            Ok(Self { stream })
        }
    }

    fn write_line(&mut self, line: &str) -> std::io::Result<()> {
        self.stream.write_all(line.as_bytes())?;
        self.stream.write_all(b"\n")?;
        self.stream.flush()?;
        Ok(())
    }
}

fn send_to_socket(slot: &mut Option<SocketConn>, line: &str) -> std::io::Result<()> {
    if slot.is_none() {
        let path = socket_path();
        *slot = Some(SocketConn::connect(&path)?);
    }
    let Some(conn) = slot.as_mut() else {
        unreachable!()
    };
    conn.write_line(line)
}

/// Resolve the main app's IPC socket path.
///
/// We can't reuse the main app's `tauri::AppHandle::path()` from a
/// standalone binary, so this duplicates Tauri's resolution logic for
/// `app_data_dir` keyed by the bundle identifier (`io.drmowinckels.cairn`).
fn socket_path() -> PathBuf {
    if let Some(env) = std::env::var_os("CAIRN_HOST_SOCKET") {
        return PathBuf::from(env);
    }
    #[cfg(target_os = "macos")]
    {
        let home = std::env::var_os("HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("/tmp"));
        home.join("Library")
            .join("Application Support")
            .join("io.drmowinckels.cairn")
            .join("ipc")
            .join("sock")
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        // XDG_DATA_HOME ?? "$HOME/.local/share"
        let base = std::env::var_os("XDG_DATA_HOME")
            .map(PathBuf::from)
            .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".local/share")))
            .unwrap_or_else(|| PathBuf::from("/tmp"));
        base.join("io.drmowinckels.cairn").join("ipc").join("sock")
    }
    #[cfg(windows)]
    {
        PathBuf::from(r"\\.\pipe\cairn")
    }
}

// -----------------------------------------------------------------
// Tests
// -----------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    fn write_frame(buf: &mut Vec<u8>, payload: &[u8]) {
        let len = payload.len() as u32;
        buf.extend_from_slice(&len.to_le_bytes());
        buf.extend_from_slice(payload);
    }

    // ---- read_frame ------------------------------------------------

    #[test]
    fn read_frame_handles_eof_cleanly() {
        let mut reader = Cursor::new(Vec::new());
        let r = read_frame(&mut reader).unwrap();
        assert!(r.is_none(), "EOF should produce Ok(None)");
    }

    #[test]
    fn read_frame_parses_a_well_formed_message() {
        let mut buf = Vec::new();
        write_frame(&mut buf, br#"{"domain":"github.com","focused":true}"#);
        let mut reader = Cursor::new(buf);
        let r = read_frame(&mut reader).unwrap().unwrap();
        let inb: Inbound = serde_json::from_slice(&r).unwrap();
        assert_eq!(inb.domain, "github.com");
        assert!(inb.focused);
        assert!(!inb.incognito);
    }

    #[test]
    fn read_frame_rejects_oversized_frame() {
        let mut buf = Vec::new();
        // Length prefix = MAX_INBOUND_BYTES + 1
        let len = MAX_INBOUND_BYTES + 1;
        buf.extend_from_slice(&len.to_le_bytes());
        let mut reader = Cursor::new(buf);
        let r = read_frame(&mut reader);
        assert!(
            r.is_err() && r.as_ref().unwrap_err().kind() == std::io::ErrorKind::InvalidData,
            "oversize frame must return InvalidData, got {r:?}"
        );
    }

    // ---- Inbound serde defaults ------------------------------------

    #[test]
    fn inbound_missing_focused_defaults_to_true() {
        let inb: Inbound = serde_json::from_str(r#"{"domain":"x.com"}"#).unwrap();
        assert!(inb.focused);
    }

    #[test]
    fn inbound_extra_fields_are_silently_ignored() {
        // A buggy extension that sends `path` or `title` must NOT
        // cause us to forward them. Serde drops unknown fields by
        // default; this test pins that policy so a future
        // `deny_unknown_fields` accidentally added would break it.
        let inb: Inbound = serde_json::from_str(
            r#"{"domain":"x.com","focused":true,"path":"/leaked","title":"oops"}"#,
        )
        .unwrap();
        assert_eq!(inb.domain, "x.com");
        // Re-serialize via the Outbound shape and assert path/title
        // can't sneak through.
        let out = Outbound {
            domain: inb.domain.as_str(),
            incognito: inb.incognito,
            focused: inb.focused,
            browser_label: inb.browser_label.as_deref(),
        };
        let s = serde_json::to_string(&out).unwrap();
        assert!(!s.contains("path"));
        assert!(!s.contains("title"));
        assert!(!s.contains("leaked"));
    }

    #[test]
    fn outbound_omits_absent_browser_label() {
        let out = Outbound {
            domain: "x.com",
            incognito: false,
            focused: true,
            browser_label: None,
        };
        let s = serde_json::to_string(&out).unwrap();
        assert!(!s.contains("browserLabel"));
    }

    #[test]
    fn outbound_emits_camel_case_browser_label() {
        let out = Outbound {
            domain: "x.com",
            incognito: false,
            focused: true,
            browser_label: Some("Chrome 120"),
        };
        let s = serde_json::to_string(&out).unwrap();
        assert!(s.contains("\"browserLabel\":\"Chrome 120\""));
    }

    // ---- socket_path resolution ------------------------------------

    #[test]
    fn socket_path_honours_env_override() {
        // The override is the only deterministic way to test
        // `socket_path` cross-platform — the other branches depend on
        // $HOME / XDG_DATA_HOME / etc. that vary between hosts.
        // SAFETY: setting env vars in tests is racy, but this var
        // isn't read by anything else in the suite.
        unsafe { std::env::set_var("CAIRN_HOST_SOCKET", "/tmp/cairn-test-socket") };
        let p = socket_path();
        assert_eq!(p, PathBuf::from("/tmp/cairn-test-socket"));
        unsafe { std::env::remove_var("CAIRN_HOST_SOCKET") };
    }
}
