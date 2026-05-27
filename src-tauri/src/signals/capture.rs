//! Debug-only "Capture raw signals" mode.
//!
//! Per `docs/PRIVACY.md` and `docs/RULES_ENGINE.md` §8 this is the one
//! place in Cairn that writes the raw `SignalSnapshot` stream to disk.
//! The lifecycle is strictly session-scoped:
//!
//! * Never persisted across launches. The toggle starts off every time
//!   Cairn boots — there is no row in the settings DB.
//! * Enable opens `~/.cairn/debug-signals.ndjson` (or the platform
//!   equivalent) and spawns a writer task that subscribes to the same
//!   [`signals::stream::SnapshotStream`] the matcher consumes, then
//!   appends every new snapshot as one newline-delimited JSON record.
//! * Disable flushes, closes, and **deletes** the file. The file is
//!   the capture; once capture is off, the file must not exist.
//! * If a stale file is found at startup (e.g. previous crash) it is
//!   deleted on next boot and a warning is logged — so the on-disk
//!   contract matches the "sticky off" UI contract.
//!
//! ## Why subscribe to the stream
//!
//! The matcher (in `signals::fanout`) already consumes
//! `stream.subscribe()`. Hanging the capture writer off the same
//! `watch::Receiver` guarantees we record exactly what the rules
//! engine sees — same debounce window, same exclusion redactions, no
//! risk of the debug log diverging from production behaviour.
//!
//! `SignalCapture::start_with_receiver` is the testable seam: prod
//! passes `stream.subscribe()`; tests pass a fake `watch::Receiver`.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use serde::Serialize;
use tokio::fs::{File, OpenOptions};
use tokio::io::AsyncWriteExt;
use tokio::sync::{oneshot, watch, Mutex};
use tokio::task::JoinHandle;

use crate::rules::SignalSnapshot;

/// File name of the on-disk capture log, relative to the data dir.
pub const CAPTURE_FILENAME: &str = "debug-signals.ndjson";

/// Public status payload shipped to the popover footer banner.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CaptureStatus {
    pub active: bool,
    pub path: Option<String>,
    pub bytes_written: u64,
}

impl CaptureStatus {
    pub fn inactive() -> Self {
        Self {
            active: false,
            path: None,
            bytes_written: 0,
        }
    }
}

struct Session {
    path: PathBuf,
    bytes: Arc<AtomicU64>,
    stop_tx: Option<oneshot::Sender<()>>,
    task: Option<JoinHandle<()>>,
}

/// Shared in-memory handle. There is exactly one of these per running
/// Cairn process; it never persists.
#[derive(Default, Clone)]
pub struct SignalCapture {
    inner: Arc<Mutex<Option<Session>>>,
}

impl SignalCapture {
    pub fn new() -> Self {
        Self::default()
    }

    pub async fn is_active(&self) -> bool {
        self.inner.lock().await.is_some()
    }

    pub async fn status(&self) -> CaptureStatus {
        match &*self.inner.lock().await {
            None => CaptureStatus::inactive(),
            Some(s) => CaptureStatus {
                active: true,
                path: Some(s.path.to_string_lossy().into_owned()),
                bytes_written: s.bytes.load(Ordering::Relaxed),
            },
        }
    }

    /// Start a capture session that subscribes to `snapshot_rx`. The
    /// writer task wakes on every new snapshot the stream publishes
    /// and appends one JSON line to `<data_dir>/debug-signals.ndjson`.
    ///
    /// Returns the absolute path of the file created.
    pub async fn start_with_receiver(
        &self,
        data_dir: &Path,
        snapshot_rx: watch::Receiver<Option<SignalSnapshot>>,
    ) -> Result<String, String> {
        let mut guard = self.inner.lock().await;
        if guard.is_some() {
            return Err("capture already running".into());
        }
        tokio::fs::create_dir_all(data_dir)
            .await
            .map_err(|e| e.to_string())?;
        let path = data_dir.join(CAPTURE_FILENAME);
        // Truncate any pre-existing file: if a crash left one behind
        // we start clean rather than appending mixed runs together.
        // (Boot-time `cleanup_stale` should already have removed it,
        // but belt-and-braces in case the data dir was written to
        // between cleanup and this call.)
        let file = OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(true)
            .open(&path)
            .await
            .map_err(|e| e.to_string())?;

        let bytes = Arc::new(AtomicU64::new(0));
        let (stop_tx, stop_rx) = oneshot::channel();
        let task = tokio::spawn(writer_loop(file, snapshot_rx, bytes.clone(), stop_rx));

        let path_string = path.to_string_lossy().into_owned();
        *guard = Some(Session {
            path,
            bytes,
            stop_tx: Some(stop_tx),
            task: Some(task),
        });
        log::warn!("capture: started debug raw-signal capture → {path_string}");
        Ok(path_string)
    }

    /// Stop the running session: cancel the writer, close the handle,
    /// and **delete** the file.
    pub async fn stop(&self) -> Result<(), String> {
        let session = self.inner.lock().await.take();
        let Some(mut session) = session else {
            return Err("capture not running".into());
        };
        if let Some(tx) = session.stop_tx.take() {
            let _ = tx.send(());
        }
        if let Some(task) = session.task.take() {
            let _ = task.await;
        }
        match tokio::fs::remove_file(&session.path).await {
            Ok(()) => {
                log::info!(
                    "capture: stopped and deleted {}",
                    session.path.to_string_lossy()
                );
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                log::info!(
                    "capture: stopped; file {} already gone",
                    session.path.to_string_lossy()
                );
            }
            Err(e) => return Err(e.to_string()),
        }
        Ok(())
    }
}

async fn writer_loop(
    mut file: File,
    mut snapshot_rx: watch::Receiver<Option<SignalSnapshot>>,
    bytes: Arc<AtomicU64>,
    mut stop_rx: oneshot::Receiver<()>,
) {
    // Drain the current value first so the file has *something* in it
    // immediately when capture starts (otherwise a long-idle stream
    // can leave the user staring at an empty file thinking it broke).
    // Clone-and-drop the watch::Ref in its own scope so the guard
    // doesn't linger across the .await — otherwise the future fails
    // to be Send and `tokio::spawn` rejects it.
    let initial = snapshot_rx.borrow().clone();
    if let Some(snap) = initial {
        write_line(&mut file, &snap, &bytes).await;
    }
    loop {
        tokio::select! {
            biased;
            _ = &mut stop_rx => break,
            changed = snapshot_rx.changed() => {
                if changed.is_err() {
                    // Sender dropped — stream is gone. Nothing more to write.
                    break;
                }
                let next = snapshot_rx.borrow().clone();
                if let Some(snap) = next {
                    write_line(&mut file, &snap, &bytes).await;
                }
            }
        }
    }
    // Best-effort drain on shutdown. Errors here are logged but cannot
    // be propagated — the session is already considered stopped.
    if let Err(e) = file.flush().await {
        log::debug!("capture: final flush err (benign): {e}");
    }
}

async fn write_line(file: &mut File, snap: &SignalSnapshot, bytes: &AtomicU64) {
    let mut line = match serde_json::to_string(snap) {
        Ok(s) => s,
        Err(e) => {
            log::warn!("capture: serialise failed: {e}");
            return;
        }
    };
    line.push('\n');
    if let Err(e) = file.write_all(line.as_bytes()).await {
        log::warn!("capture: write failed: {e}");
        return;
    }
    if let Err(e) = file.flush().await {
        log::warn!("capture: flush failed: {e}");
        return;
    }
    bytes.fetch_add(line.len() as u64, Ordering::Relaxed);
}

/// Boot-time cleanup. If `data_dir/debug-signals.ndjson` exists when
/// Cairn starts, it must be a leftover from a previous run that
/// crashed or was killed mid-capture (because the "Capture raw
/// signals" toggle is in-memory and starts off every launch). Delete
/// it and log a warning so we never silently keep stale captured data
/// around.
pub async fn cleanup_stale(data_dir: &Path) -> std::io::Result<()> {
    let path = data_dir.join(CAPTURE_FILENAME);
    match tokio::fs::remove_file(&path).await {
        Ok(()) => {
            log::warn!(
                "capture: removed stale {} (capture is off by default; toggle does not persist)",
                path.to_string_lossy()
            );
            Ok(())
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;
    use tempfile::tempdir;
    use tokio::io::AsyncReadExt;

    fn empty_snapshot() -> SignalSnapshot {
        SignalSnapshot {
            ide_folder: None,
            git_branch: None,
            window_title: None,
            app_name: None,
            browser_domain: None,
            calendar: vec![],
        }
    }

    fn snap_with(folder: &str) -> SignalSnapshot {
        SignalSnapshot {
            ide_folder: Some(folder.into()),
            git_branch: None,
            window_title: None,
            app_name: None,
            browser_domain: None,
            calendar: vec![],
        }
    }

    #[tokio::test]
    async fn status_is_inactive_by_default() {
        let cap = SignalCapture::new();
        let st = cap.status().await;
        assert!(!st.active);
        assert!(st.path.is_none());
        assert_eq!(st.bytes_written, 0);
        assert!(!cap.is_active().await);
    }

    /// Wait until the writer's running byte count reaches at least
    /// `n`. Polls the in-memory atomic so this is race-free even on
    /// loaded CI runners; bails after ~1s so a regression doesn't
    /// hang the suite. Returns the bytes count it observed.
    async fn wait_for_bytes(cap: &SignalCapture, at_least: u64) -> u64 {
        for _ in 0..100 {
            let n = cap.status().await.bytes_written;
            if n >= at_least {
                return n;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        cap.status().await.bytes_written
    }

    #[tokio::test]
    async fn start_writes_initial_snapshot_then_each_publish() {
        let dir = tempdir().unwrap();
        let (tx, rx) = watch::channel(Some(snap_with("tick-0")));
        let cap = SignalCapture::new();
        let path = cap
            .start_with_receiver(dir.path(), rx)
            .await
            .expect("start ok");

        // Wait for the writer to drain the initial snapshot before
        // publishing more — the watch channel only retains the latest
        // value, so without this sync `tick-0` would get overwritten
        // by `tick-1` before the writer task ran. (The race only
        // matters in tests; production publishes are 500ms apart.)
        let after_initial = wait_for_bytes(&cap, 1).await;
        assert!(after_initial > 0, "initial snapshot must be written");

        tx.send(Some(snap_with("tick-1"))).unwrap();
        wait_for_bytes(&cap, after_initial + 1).await;
        tx.send(Some(snap_with("tick-2"))).unwrap();
        wait_for_bytes(&cap, after_initial + 2).await;

        let st = cap.status().await;
        assert!(st.active);
        assert_eq!(st.path.as_deref(), Some(path.as_str()));

        let mut buf = String::new();
        File::open(&path)
            .await
            .unwrap()
            .read_to_string(&mut buf)
            .await
            .unwrap();
        let folders: Vec<String> = buf
            .lines()
            .map(|l| {
                let v: SignalSnapshot = serde_json::from_str(l).expect("valid ndjson");
                v.ide_folder.unwrap_or_default()
            })
            .collect();
        assert_eq!(
            folders,
            vec![
                "tick-0".to_string(),
                "tick-1".to_string(),
                "tick-2".to_string(),
            ],
            "every publish must end up as one ndjson line in order",
        );

        cap.stop().await.unwrap();
    }

    #[tokio::test]
    async fn stop_deletes_the_file_and_resets_status() {
        let dir = tempdir().unwrap();
        let (_tx, rx) = watch::channel(Some(empty_snapshot()));
        let cap = SignalCapture::new();
        let path_str = cap.start_with_receiver(dir.path(), rx).await.unwrap();
        let path = PathBuf::from(&path_str);
        assert!(path.exists(), "file must exist while capture is running");

        cap.stop().await.unwrap();

        assert!(!cap.is_active().await);
        assert!(
            !path.exists(),
            "stop_signal_capture must delete the ndjson file"
        );
        let st = cap.status().await;
        assert!(!st.active);
        assert!(st.path.is_none());
        assert_eq!(st.bytes_written, 0);
    }

    #[tokio::test]
    async fn double_start_is_rejected() {
        let dir = tempdir().unwrap();
        let (_tx, rx) = watch::channel(Some(empty_snapshot()));
        let cap = SignalCapture::new();
        cap.start_with_receiver(dir.path(), rx.clone())
            .await
            .unwrap();
        let err = cap.start_with_receiver(dir.path(), rx).await.unwrap_err();
        assert!(err.contains("already running"));
        cap.stop().await.unwrap();
    }

    #[tokio::test]
    async fn stop_without_start_is_an_error() {
        let cap = SignalCapture::new();
        let err = cap.stop().await.unwrap_err();
        assert!(err.contains("not running"));
    }

    #[tokio::test]
    async fn cleanup_stale_removes_leftover_file() {
        let dir = tempdir().unwrap();
        let path = dir.path().join(CAPTURE_FILENAME);
        tokio::fs::write(&path, b"{\"app_name\":\"left over\"}\n")
            .await
            .unwrap();
        assert!(path.exists());

        cleanup_stale(dir.path()).await.unwrap();

        assert!(
            !path.exists(),
            "cleanup_stale must delete leftover capture files at startup"
        );
    }

    #[tokio::test]
    async fn cleanup_stale_is_idempotent_when_nothing_to_remove() {
        let dir = tempdir().unwrap();
        cleanup_stale(dir.path()).await.unwrap();
        cleanup_stale(dir.path()).await.unwrap();
    }

    #[tokio::test]
    async fn capture_is_sticky_off_after_simulated_relaunch() {
        // Simulate: a previous Cairn process crashed mid-capture
        // leaving the ndjson file on disk. On the next launch — a
        // fresh `SignalCapture` plus boot-time `cleanup_stale` — the
        // file must be gone and `is_active()` must be false. This
        // mirrors the lib.rs setup sequence.
        let dir = tempdir().unwrap();
        let leftover = dir.path().join(CAPTURE_FILENAME);
        tokio::fs::write(&leftover, b"stale\n").await.unwrap();

        cleanup_stale(dir.path()).await.unwrap();
        let cap = SignalCapture::new();
        assert!(!cap.is_active().await);
        assert!(!leftover.exists());
    }

    #[tokio::test]
    async fn writer_loop_exits_when_sender_drops() {
        let dir = tempdir().unwrap();
        let (tx, rx) = watch::channel(Some(empty_snapshot()));
        let cap = SignalCapture::new();
        cap.start_with_receiver(dir.path(), rx).await.unwrap();
        drop(tx);
        // The writer loop should exit on its own; `stop` then just
        // cleans up file state. This guards against a future leak
        // where the loop ignores the channel-close signal.
        cap.stop().await.unwrap();
    }
}
