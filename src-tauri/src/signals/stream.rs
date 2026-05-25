//! Snapshot stream + scheduler.
//!
//! Owns the "live" `SignalSnapshot` that the rules engine and the UI
//! both subscribe to. Sources (window poller, git HEAD watcher,
//! calendar tick, idle detector) push [`SignalEvent`] values into a
//! single [`tokio::sync::mpsc`] channel; a driver task collapses
//! bursts within a 500ms debounce window and re-publishes a fresh
//! snapshot on a [`tokio::sync::watch`] channel.
//!
//! ## Why a stream
//!
//! Before this module, `signals::snapshot::build` was only invoked
//! synchronously from the `current_snapshot` IPC — i.e. only when the
//! UI explicitly asked. That model can't power suggestion banners or
//! the "Live signals" card, both of which need to react to OS-level
//! changes without polling-on-render. The stream inverts that: sources
//! push, consumers subscribe.
//!
//! ## Architecture
//!
//! ```text
//!   window poller ─┐
//!   git watcher  ──┼─► mpsc<SignalEvent> ─► driver task ─┬─► watch<Option<SignalSnapshot>>
//!   calendar tick ─┤                       (500ms debounce)│
//!   idle poller  ──┘                                       └─► watch<IdleState>
//!                                                              │
//!                                                              └─► fan-out task
//!                                                                  ├─ rules::evaluate
//!                                                                  └─ AppHandle::emit_to(popover)
//! ```
//!
//! The driver task is deterministic: every event mutates an in-memory
//! `LiveState`, then arms a debounce deadline. When the deadline
//! fires, the driver composes a fresh `SignalSnapshot` (pulling
//! `active_events_at(now)` from the calendar registry) and publishes.
//!
//! ## Privacy
//!
//! The `Window` source consults an [`ExclusionMatcher`] before
//! sending — apps and window-title substrings on the exclusion list
//! are dropped *at the collector*, so the matched signal never
//! reaches the rules engine, the published snapshot, or any
//! webview. This implements the contract from `docs/PRIVACY.md`.
//!
//! ## Cross-platform
//!
//! The stream itself is pure tokio — runs unchanged on macOS,
//! Ubuntu, Windows. Source tasks delegate to the per-platform
//! collectors (`signals::window::current`,
//! `signals::idle::seconds_since_input`) via `spawn_blocking` so a
//! slow subprocess on the host doesn't stall the tokio worker.

use std::sync::Arc;
use std::sync::RwLock;
use std::time::Duration;

use chrono::Utc;
use tokio::sync::{mpsc, watch};
use tokio::time::Instant;

use crate::rules::{CalendarEvent, SignalSnapshot};
use crate::signals::calendar::CalendarRegistry;
use crate::signals::exclusions::ExclusionMatcher;
use crate::signals::git::GitContext;
use crate::signals::window::FrontWindow;

/// Default debounce window. Bursts of events within this window
/// collapse into a single published snapshot.
pub const DEFAULT_DEBOUNCE: Duration = Duration::from_millis(500);

/// How often the window-source poller checks the frontmost window.
/// 1s is the floor the acceptance criteria pin; AX notifications on
/// macOS would beat it but the polling fallback works everywhere.
pub const WINDOW_POLL_INTERVAL: Duration = Duration::from_secs(1);

/// How often the calendar-tick source re-queries the registry.
/// Calendar events are time-bounded — start/end transitions need a
/// snapshot rebuild to surface them. 30s keeps the snapshot fresh
/// without spamming the rules fan-out.
pub const CALENDAR_TICK_INTERVAL: Duration = Duration::from_secs(30);

/// How often the idle-source poller checks user input recency.
/// Idle is for the ambiguity modal (#7); fine-grained polling isn't
/// useful — the threshold check is what triggers UI.
pub const IDLE_POLL_INTERVAL: Duration = Duration::from_secs(15);

/// Bounded mpsc capacity for `SignalEvent`. Sources use `try_send`
/// and drop on overflow rather than awaiting — a backed-up driver
/// (e.g. a slow `calendar.active_events_at` call) must never deadlock
/// the source tasks. The debounce window already collapses bursts,
/// so dropping the occasional event under load just collapses harder.
const EVENT_CHANNEL_CAPACITY: usize = 64;

/// An event pushed by one of the signal sources. The driver task
/// folds these into a `LiveState` and republishes the resulting
/// snapshot after the debounce window closes.
#[derive(Debug, Clone)]
pub enum SignalEvent {
    Window(Option<FrontWindow>),
    /// Git context for the currently relevant repo, or `None` if the
    /// user has navigated outside any tracked repo. Wired by the
    /// notify-based watcher that lands with the remainder of #4 —
    /// the variant is here today so the publish path's git_branch
    /// projection ships with the snapshot stream.
    Git(Option<GitContext>),
    /// Calendar tick: re-query `active_events_at(now)`. The event
    /// carries no payload — the calendar registry is the source of
    /// truth.
    CalendarRefresh,
    Idle(IdleState),
}

/// Idle state. `seconds = Some(n)` is "the OS reports n seconds
/// since the last user input"; `seconds = None` is "we cannot
/// determine idle state on this host" (CGEventSource permission
/// denied, X11 not running, etc.) — explicitly distinct from "the
/// user is active" so the ambiguity modal (#7) can choose a safe
/// default.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct IdleState {
    pub seconds: Option<u64>,
}

/// Cancellation-aware handle on a running snapshot stream.
///
/// In production the stream is held inside `AppState` for the
/// lifetime of the Tauri runtime; in tests, dropping the
/// `SnapshotStream` value drops the internal `event_tx` and the
/// driver exits cleanly. (The source tasks each own a clone of
/// `event_tx`, so the driver only sees the channel close after every
/// source has dropped its clone — but in production the source
/// tasks are spawned without a cancellation handle, so they only
/// shut down at process exit. That's acceptable for a desktop app
/// with no live-reload story.)
pub struct SnapshotStream {
    snapshot_rx: watch::Receiver<Option<SignalSnapshot>>,
    idle_rx: watch::Receiver<IdleState>,
    event_tx: mpsc::Sender<SignalEvent>,
}

impl SnapshotStream {
    /// Subscribe to snapshot updates. The receiver's initial value
    /// is `None` until the driver publishes its first snapshot — the
    /// `current_snapshot` IPC falls back to a synchronous
    /// `snapshot::build` when this is `None` so a popover opened
    /// pre-first-publish doesn't see empty fields.
    pub fn subscribe(&self) -> watch::Receiver<Option<SignalSnapshot>> {
        self.snapshot_rx.clone()
    }

    /// Subscribe to idle-state updates. Same semantics as
    /// `subscribe`; the consumer of this is the ambiguity modal
    /// (#7). The published value is `IdleState::default()` until the
    /// idle source posts its first reading.
    pub fn subscribe_idle(&self) -> watch::Receiver<IdleState> {
        self.idle_rx.clone()
    }

    /// Sender that source tasks push events through. Cloning this
    /// is cheap — every source owns its own clone. Public so tests
    /// and the planned git watcher (#4 tail-end) can inject events
    /// directly without needing to spawn another source task.
    pub fn event_sender(&self) -> mpsc::Sender<SignalEvent> {
        self.event_tx.clone()
    }

    /// Current snapshot if the driver has ever published one,
    /// otherwise `None`. The `current_snapshot` IPC must fall back
    /// to `snapshot::build` for the `None` case so the popover never
    /// shows blank fields on cold start.
    pub fn current(&self) -> Option<SignalSnapshot> {
        self.snapshot_rx.borrow().clone()
    }
}

/// In-memory state the driver task maintains between debounce
/// windows. Each field is the latest value seen from its source.
#[derive(Default)]
struct LiveState {
    front: Option<FrontWindow>,
    git: Option<GitContext>,
    idle: IdleState,
}

/// Spawn the snapshot-stream driver. Returns a handle that owns
/// subscribers and the event sender. The actual source tasks
/// (window/calendar/idle) are spawned separately by
/// `spawn_default_sources` once the stream exists.
///
/// `exclusions` is the in-memory exclusion-list snapshot consulted
/// by `apply_event` on every `Window` (and future browser-domain)
/// event. Wrapped in `Arc<RwLock<_>>` so the `save_exclusion` /
/// `delete_exclusion` IPC handlers can invalidate after a write.
pub fn spawn(
    calendar: Arc<CalendarRegistry>,
    exclusions: Arc<RwLock<ExclusionMatcher>>,
    debounce: Duration,
) -> SnapshotStream {
    let (event_tx, event_rx) = mpsc::channel::<SignalEvent>(EVENT_CHANNEL_CAPACITY);
    let (snapshot_tx, snapshot_rx) = watch::channel::<Option<SignalSnapshot>>(None);
    let (idle_tx, idle_rx) = watch::channel(IdleState::default());

    // Spawn the driver as a normal task, then a supervisor that
    // awaits its JoinHandle and logs on panic. Without the
    // supervisor, a panic in `publish` (e.g. an `RwLock` poison
    // deep in the calendar registry) would silently kill the
    // driver and leave every subscriber stuck on the last
    // published value forever — a worst-case stale-data failure
    // mode that produces no telemetry. The supervisor at least
    // surfaces the panic in the logs; auto-restart belongs with
    // the cancellation-token shutdown story (#7's quit path).
    let driver_handle = tokio::spawn(driver(
        event_rx,
        snapshot_tx,
        idle_tx,
        calendar,
        exclusions,
        debounce,
    ));
    tokio::spawn(async move {
        if let Err(e) = driver_handle.await {
            if e.is_panic() {
                log::error!("snapshot stream driver panicked: {e}");
            } else if e.is_cancelled() {
                log::warn!("snapshot stream driver was cancelled");
            }
        }
    });

    SnapshotStream {
        snapshot_rx,
        idle_rx,
        event_tx,
    }
}

/// Spawn the default cross-platform source tasks: window poller,
/// calendar tick, idle poller. Each task ends when the stream's
/// `event_tx` is dropped (i.e. when the stream itself goes away in
/// test tear-down). In production they run until process exit.
pub fn spawn_default_sources(stream: &SnapshotStream) {
    let tx = stream.event_sender();
    tokio::spawn(window_source(tx.clone(), WINDOW_POLL_INTERVAL));
    tokio::spawn(calendar_tick_source(tx.clone(), CALENDAR_TICK_INTERVAL));
    tokio::spawn(idle_source(tx, IDLE_POLL_INTERVAL));
}

// -----------------------------------------------------------------
// driver
// -----------------------------------------------------------------

async fn driver(
    mut event_rx: mpsc::Receiver<SignalEvent>,
    snapshot_tx: watch::Sender<Option<SignalSnapshot>>,
    idle_tx: watch::Sender<IdleState>,
    calendar: Arc<CalendarRegistry>,
    exclusions: Arc<RwLock<ExclusionMatcher>>,
    debounce: Duration,
) {
    let mut state = LiveState::default();
    let mut next_publish_at: Option<Instant> = None;

    loop {
        tokio::select! {
            // Bias toward draining events: a flood of events should
            // not be starved by the debounce branch.
            biased;

            ev = event_rx.recv() => {
                match ev {
                    Some(ev) => {
                        apply_event(&mut state, &idle_tx, &exclusions, ev);
                        next_publish_at = Some(Instant::now() + debounce);
                    }
                    None => {
                        // All senders dropped — graceful shutdown
                        // path (mostly exercised by tests). Flush
                        // one final snapshot if a debounce was
                        // pending, then exit.
                        if next_publish_at.is_some() {
                            publish(&state, &snapshot_tx, &calendar, &exclusions).await;
                        }
                        return;
                    }
                }
            }

            _ = sleep_until(next_publish_at), if next_publish_at.is_some() => {
                publish(&state, &snapshot_tx, &calendar, &exclusions).await;
                next_publish_at = None;
            }
        }
    }
}

/// Sleep until the optional deadline, or pend forever if `None`.
/// The caller gates this branch via `select!`'s `if` guard, so the
/// `None` arm is never actually awaited.
async fn sleep_until(deadline: Option<Instant>) {
    match deadline {
        Some(t) => tokio::time::sleep_until(t).await,
        None => std::future::pending::<()>().await,
    }
}

fn apply_event(
    state: &mut LiveState,
    idle_tx: &watch::Sender<IdleState>,
    exclusions: &Arc<RwLock<ExclusionMatcher>>,
    ev: SignalEvent,
) {
    match ev {
        SignalEvent::Window(front) => {
            // Per docs/PRIVACY.md: the exclusion list applies *here*,
            // at the collector, before the title reaches the rules
            // engine or any subscriber. A matched front-window is
            // collapsed to `None` so the snapshot publishes the
            // user's privacy choice rather than the excluded app.
            let filtered = front.and_then(|w| {
                let excluded = match exclusions.read() {
                    Ok(guard) => guard.matches_window(&w),
                    Err(_) => {
                        // RwLock poisoned (panic in a writer) — fail
                        // closed: assume the worst and drop the
                        // signal. The next save_exclusion will
                        // create a fresh lock by replacing the
                        // contents under a new guard, but for now
                        // there's nothing safe to compare against.
                        log::warn!("exclusions: read lock poisoned, dropping window signal");
                        true
                    }
                };
                if excluded {
                    None
                } else {
                    Some(w)
                }
            });
            state.front = filtered;
        }
        SignalEvent::Git(git) => {
            state.git = git;
        }
        SignalEvent::CalendarRefresh => {
            // No state mutation — the driver re-queries calendar on
            // publish. The event just arms the debounce.
        }
        SignalEvent::Idle(idle) => {
            state.idle = idle;
            // Idle is broadcast immediately on its own channel so
            // the ambiguity modal (#7) doesn't have to wait for the
            // 500ms debounce. `send` is non-blocking; the `Err`
            // case (no receivers) is intentionally ignored — idle
            // is informational.
            let _ = idle_tx.send(idle);
        }
    }
}

async fn publish(
    state: &LiveState,
    snapshot_tx: &watch::Sender<Option<SignalSnapshot>>,
    calendar: &Arc<CalendarRegistry>,
    exclusions: &Arc<RwLock<ExclusionMatcher>>,
) {
    let active = calendar.active_events_at(Utc::now()).await;
    let calendar_events: Vec<CalendarEvent> = active
        .into_iter()
        .map(|a| CalendarEvent {
            title: a.event.summary,
            source_label: a.source_label,
            attendees: a.event.attendees,
            all_day: a.event.all_day,
        })
        .collect();

    let (app_name, window_title, ide_folder) = match state.front.as_ref() {
        Some(w) => {
            let folder = w
                .title
                .as_deref()
                .and_then(|t| crate::signals::window::derive_ide_folder(&w.app_name, t))
                .map(|p| p.to_string_lossy().into_owned());
            (Some(w.app_name.clone()), w.title.clone(), folder)
        }
        None => (None, None, None),
    };

    let git_branch = state.git.as_ref().and_then(|g| g.branch.clone());

    let mut snap = SignalSnapshot {
        ide_folder,
        git_branch,
        window_title,
        app_name,
        browser_domain: None,
        calendar: calendar_events,
    };

    // Defence-in-depth: even though `apply_event` already filters
    // incoming Window signals against the matcher, the cached
    // `LiveState.front` from BEFORE a mid-session exclusion add
    // could still leak here. Re-running the filter on the composed
    // snapshot covers that gap. Also covers a future browser
    // collector that emits `browser_domain` directly.
    if let Ok(guard) = exclusions.read() {
        guard.redact_snapshot(&mut snap);
    } else {
        // Lock poisoned (writer panicked). Fail closed: drop every
        // OS-derived field. This matches `apply_event`'s poisoned-
        // lock behaviour.
        log::warn!("exclusions: read lock poisoned, redacting snapshot fully");
        snap.app_name = None;
        snap.window_title = None;
        snap.ide_folder = None;
        snap.git_branch = None;
        snap.browser_domain = None;
    }

    let _ = snapshot_tx.send_replace(Some(snap));
}

// -----------------------------------------------------------------
// sources
// -----------------------------------------------------------------

/// Push an event onto the driver channel without ever blocking. If
/// the channel is full (driver behind), we *drop* the event rather
/// than `.await` on `.send()` — the debounce window collapses
/// bursts anyway, and a backed-up driver must never deadlock the
/// source tasks. Returns `false` if the channel is closed (i.e. the
/// driver shut down), which signals the source to exit.
fn push_or_drop(tx: &mpsc::Sender<SignalEvent>, ev: SignalEvent) -> bool {
    use mpsc::error::TrySendError;
    match tx.try_send(ev) {
        Ok(()) => true,
        Err(TrySendError::Full(_)) => {
            log::debug!("snapshot stream event dropped: channel full (driver behind)");
            true
        }
        Err(TrySendError::Closed(_)) => false,
    }
}

async fn window_source(tx: mpsc::Sender<SignalEvent>, interval: Duration) {
    let mut last: Option<FrontWindow> = None;
    let mut ticker = tokio::time::interval(interval);
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        ticker.tick().await;
        // signals::window::current() is blocking on every platform
        // (osascript subprocess on macOS, xdotool on Linux,
        // GetWindowTextW + QueryFullProcessImageNameW on Windows).
        // Run it on the blocking pool so a slow subprocess never
        // stalls the tokio worker that runs the driver / fanout.
        let current = match tokio::task::spawn_blocking(crate::signals::window::current).await {
            Ok(w) => w,
            Err(e) => {
                log::warn!("window source spawn_blocking failed: {e}");
                None
            }
        };
        if current != last {
            if !push_or_drop(&tx, SignalEvent::Window(current.clone())) {
                return;
            }
            last = current;
        }
    }
}

async fn calendar_tick_source(tx: mpsc::Sender<SignalEvent>, interval: Duration) {
    // Start the first tick `interval` from now — the default
    // `tokio::time::interval` fires immediately, which would arm a
    // debounce before any window/idle signal had a chance to prime
    // state. Using `interval_at` makes "skip first tick" explicit.
    let mut ticker = tokio::time::interval_at(Instant::now() + interval, interval);
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        ticker.tick().await;
        if !push_or_drop(&tx, SignalEvent::CalendarRefresh) {
            return;
        }
    }
}

async fn idle_source(tx: mpsc::Sender<SignalEvent>, interval: Duration) {
    let mut last = IdleState::default();
    let mut ticker = tokio::time::interval(interval);
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        ticker.tick().await;
        // Mirror window_source's JoinError handling. A panic in the
        // blocking task is a different failure mode from "the OS
        // query returned None" (permission denied / Wayland) and
        // must be logged loudly — silently folding it into the
        // same `None` would mask a real bug.
        let seconds =
            match tokio::task::spawn_blocking(crate::signals::idle::seconds_since_input).await {
                Ok(v) => v,
                Err(e) if e.is_panic() => {
                    log::error!("idle source spawn_blocking panicked: {e}");
                    None
                }
                Err(e) => {
                    log::warn!("idle source spawn_blocking error: {e}");
                    None
                }
            };
        let current = IdleState { seconds };
        // Push when the 30s bucket changes — fine-grained "one more
        // second idle" events would arm the debounce on every tick
        // without ambiguity-modal-level meaning. Also push when the
        // availability of the reading itself changes (Some↔None), so
        // the consumer can show "idle detection unavailable" the
        // moment the underlying permission disappears.
        let bucket_changed = current.seconds.map(|s| s / 30) != last.seconds.map(|s| s / 30);
        let availability_changed = current.seconds.is_some() != last.seconds.is_some();
        if bucket_changed || availability_changed {
            if !push_or_drop(&tx, SignalEvent::Idle(current)) {
                return;
            }
            last = current;
        }
    }
}

// -----------------------------------------------------------------
// Tests
// -----------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::signals::window::FrontWindow;
    use crate::test_support::test_db;
    use std::time::Duration;

    fn fw(app: &str, title: Option<&str>) -> FrontWindow {
        FrontWindow {
            app_name: app.to_string(),
            title: title.map(str::to_string),
        }
    }

    async fn fresh_stream(debounce: Duration) -> (tempfile::TempDir, SnapshotStream) {
        fresh_stream_with_exclusions(debounce, ExclusionMatcher::default()).await
    }

    async fn fresh_stream_with_exclusions(
        debounce: Duration,
        excl: ExclusionMatcher,
    ) -> (tempfile::TempDir, SnapshotStream) {
        let (dir, db) = test_db().await;
        let calendar =
            Arc::new(CalendarRegistry::new(db.pool.clone()).expect("calendar registry builds"));
        let exclusions = Arc::new(RwLock::new(excl));
        let stream = spawn(calendar, exclusions, debounce);
        (dir, stream)
    }

    /// Wait for the watch receiver to observe a `Some(snap)` whose
    /// `app_name` matches `expected`. Polls `changed()` until the
    /// timeout, so the test doesn't race the debounce.
    async fn wait_for_app_name(
        rx: &mut watch::Receiver<Option<SignalSnapshot>>,
        expected: &str,
        timeout: Duration,
    ) -> Option<SignalSnapshot> {
        let deadline = Instant::now() + timeout;
        loop {
            let remaining = deadline.checked_duration_since(Instant::now())?;
            match tokio::time::timeout(remaining, rx.changed()).await {
                Ok(Ok(())) => {
                    if let Some(snap) = rx.borrow_and_update().clone() {
                        if snap.app_name.as_deref() == Some(expected) {
                            return Some(snap);
                        }
                    }
                }
                Ok(Err(_)) => panic!("watch channel closed before expected snapshot"),
                Err(_) => return None,
            }
        }
    }

    #[tokio::test]
    async fn current_returns_none_before_first_publish() {
        let (_dir, stream) = fresh_stream(Duration::from_millis(50)).await;
        // No events sent — `current` must return None so the
        // `current_snapshot` IPC knows to fall back to
        // `snapshot::build`.
        assert!(stream.current().is_none());
    }

    #[tokio::test]
    async fn single_event_publishes_after_debounce() {
        let (_dir, stream) = fresh_stream(Duration::from_millis(50)).await;
        let tx = stream.event_sender();
        let mut rx = stream.subscribe();
        let _ = rx.borrow_and_update();

        tx.send(SignalEvent::Window(Some(fw("Cairn", None))))
            .await
            .expect("send window event");

        let snap = wait_for_app_name(&mut rx, "Cairn", Duration::from_secs(1))
            .await
            .expect("driver publishes a snapshot containing the window event");
        assert_eq!(snap.app_name.as_deref(), Some("Cairn"));
    }

    #[tokio::test]
    async fn burst_events_within_window_collapse_to_one_publish() {
        let (_dir, stream) = fresh_stream(Duration::from_millis(150)).await;
        let tx = stream.event_sender();
        let mut rx = stream.subscribe();
        let _ = rx.borrow_and_update();

        for app in ["First", "Second", "Last"] {
            tx.send(SignalEvent::Window(Some(fw(app, None))))
                .await
                .expect("send");
            tokio::time::sleep(Duration::from_millis(20)).await;
        }

        let snap = wait_for_app_name(&mut rx, "Last", Duration::from_secs(1))
            .await
            .expect("burst collapses to a single publish of the last state");
        assert_eq!(snap.app_name.as_deref(), Some("Last"));

        let further = tokio::time::timeout(Duration::from_millis(200), rx.changed()).await;
        assert!(
            further.is_err(),
            "burst should produce exactly one published snapshot",
        );
    }

    #[tokio::test]
    async fn events_spaced_beyond_window_each_publish() {
        let (_dir, stream) = fresh_stream(Duration::from_millis(50)).await;
        let tx = stream.event_sender();
        let mut rx = stream.subscribe();
        let _ = rx.borrow_and_update();

        tx.send(SignalEvent::Window(Some(fw("Alpha", None))))
            .await
            .unwrap();
        assert!(
            wait_for_app_name(&mut rx, "Alpha", Duration::from_secs(1))
                .await
                .is_some(),
            "first event publishes",
        );

        tokio::time::sleep(Duration::from_millis(120)).await;

        tx.send(SignalEvent::Window(Some(fw("Beta", None))))
            .await
            .unwrap();
        assert!(
            wait_for_app_name(&mut rx, "Beta", Duration::from_secs(1))
                .await
                .is_some(),
            "second event publishes a separate snapshot",
        );
    }

    #[tokio::test]
    async fn idle_event_publishes_on_separate_channel() {
        let (_dir, stream) = fresh_stream(Duration::from_millis(50)).await;
        let tx = stream.event_sender();
        let mut idle_rx = stream.subscribe_idle();
        let _ = idle_rx.borrow_and_update();

        tx.send(SignalEvent::Idle(IdleState { seconds: Some(120) }))
            .await
            .unwrap();

        // Idle channel updates immediately, not on debounce.
        tokio::time::timeout(Duration::from_millis(200), idle_rx.changed())
            .await
            .expect("idle channel publishes")
            .expect("idle channel still open");
        assert_eq!(idle_rx.borrow().seconds, Some(120));
    }

    #[tokio::test]
    async fn dropping_sender_closes_driver() {
        let (_dir, stream) = fresh_stream(Duration::from_millis(50)).await;
        let mut rx = stream.subscribe();
        let _ = rx.borrow_and_update();
        drop(stream);
        let result = tokio::time::timeout(Duration::from_secs(1), rx.changed()).await;
        assert!(
            matches!(result, Ok(Err(_))),
            "driver shut down → subscriber sees a closed channel, got {result:?}",
        );
    }

    #[tokio::test]
    async fn window_with_ide_title_populates_ide_folder() {
        let (_dir, stream) = fresh_stream(Duration::from_millis(50)).await;
        let tx = stream.event_sender();
        let mut rx = stream.subscribe();
        let _ = rx.borrow_and_update();

        tx.send(SignalEvent::Window(Some(fw(
            "Zed",
            Some("rules.tsx — cairn"),
        ))))
        .await
        .unwrap();

        let snap = wait_for_app_name(&mut rx, "Zed", Duration::from_secs(1))
            .await
            .expect("driver publishes the IDE window");
        assert_eq!(snap.ide_folder.as_deref(), Some("cairn"));
        assert_eq!(snap.window_title.as_deref(), Some("rules.tsx — cairn"));
    }

    #[tokio::test]
    async fn calendar_refresh_alone_publishes_snapshot() {
        let (_dir, stream) = fresh_stream(Duration::from_millis(50)).await;
        let tx = stream.event_sender();
        let mut rx = stream.subscribe();
        let _ = rx.borrow_and_update();

        tx.send(SignalEvent::CalendarRefresh).await.unwrap();

        let result = tokio::time::timeout(Duration::from_secs(1), rx.changed()).await;
        assert!(
            matches!(result, Ok(Ok(()))),
            "calendar refresh alone arms the debounce and publishes a snapshot"
        );
        // The published snapshot is a real Some(...) value with an
        // empty calendar (no sources registered in this test).
        let published = rx.borrow().clone();
        let snap = published.expect("publish produced Some(snapshot), not None");
        assert!(snap.calendar.is_empty());
        // Other fields default — no window/idle/git events were
        // sent — so this also asserts "publishing on calendar alone
        // doesn't invent state out of thin air".
        assert!(snap.app_name.is_none());
        assert!(snap.git_branch.is_none());
    }

    #[tokio::test]
    async fn excluded_window_signal_is_dropped_at_the_collector() {
        // Privacy contract: an excluded app must never appear in
        // any published snapshot. Set up the exclusion BEFORE the
        // stream sees any window event.
        let (_dir, stream) = fresh_stream_with_exclusions(
            Duration::from_millis(50),
            ExclusionMatcher::for_test(&["1Password"], &[], &[]),
        )
        .await;
        let tx = stream.event_sender();
        let mut rx = stream.subscribe();
        let _ = rx.borrow_and_update();

        // Send an excluded app — driver must drop the front-window
        // and publish a snapshot whose app_name is None.
        tx.send(SignalEvent::Window(Some(fw(
            "1Password",
            Some("vault opened"),
        ))))
        .await
        .unwrap();

        // Wait for publish (excluded events still arm the debounce —
        // the publish just doesn't carry the excluded title).
        tokio::time::timeout(Duration::from_secs(1), rx.changed())
            .await
            .expect("excluded event still triggers a publish (with cleared title)")
            .expect("channel still open");

        let snap = rx
            .borrow()
            .clone()
            .expect("driver published Some(snapshot)");
        assert!(
            snap.app_name.is_none(),
            "excluded app_name leaked through: {:?}",
            snap.app_name
        );
        assert!(
            snap.window_title.is_none(),
            "excluded window_title leaked through: {:?}",
            snap.window_title
        );
    }

    #[tokio::test]
    async fn excluded_by_title_substring_drops_signal() {
        let (_dir, stream) = fresh_stream_with_exclusions(
            Duration::from_millis(50),
            ExclusionMatcher::for_test(&[], &["Banking"], &[]),
        )
        .await;
        let tx = stream.event_sender();
        let mut rx = stream.subscribe();
        let _ = rx.borrow_and_update();

        tx.send(SignalEvent::Window(Some(fw(
            "Chrome",
            Some("Banking — Chase"),
        ))))
        .await
        .unwrap();

        tokio::time::timeout(Duration::from_secs(1), rx.changed())
            .await
            .expect("publish runs")
            .expect("channel still open");
        let snap = rx.borrow().clone().expect("Some snapshot");
        assert!(snap.app_name.is_none());
        assert!(snap.window_title.is_none());
    }

    #[tokio::test]
    async fn mid_session_exclusion_add_redacts_stale_cached_front() {
        // Reviewer's B1.2: when an exclusion is added AFTER the
        // driver has cached a non-excluded front-window, the next
        // publish must still redact — the cached LiveState.front
        // can't leak through. Defence-in-depth in `publish` is what
        // closes this gap (the `apply_event` filter only sees
        // *incoming* events).
        let (_dir, db) = test_db().await;
        let calendar =
            Arc::new(CalendarRegistry::new(db.pool.clone()).expect("calendar registry builds"));
        let exclusions = Arc::new(RwLock::new(ExclusionMatcher::default()));
        let stream = spawn(
            calendar.clone(),
            exclusions.clone(),
            Duration::from_millis(50),
        );
        let tx = stream.event_sender();
        let mut rx = stream.subscribe();
        let _ = rx.borrow_and_update();

        // Step 1: send a Chrome window event (no exclusions yet).
        tx.send(SignalEvent::Window(Some(fw(
            "Chrome",
            Some("Banking — Chase"),
        ))))
        .await
        .unwrap();
        let snap = wait_for_app_name(&mut rx, "Chrome", Duration::from_secs(1))
            .await
            .expect("Chrome window published before exclusion was added");
        assert_eq!(snap.app_name.as_deref(), Some("Chrome"));
        assert_eq!(snap.window_title.as_deref(), Some("Banking — Chase"));

        // Step 2: user adds an exclusion for "Banking" mid-session.
        // The cached LiveState.front is still Chrome+Banking title.
        *exclusions.write().unwrap() = ExclusionMatcher::for_test(&[], &["Banking"], &[]);

        // Step 3: a calendar-refresh-style event (no Window event)
        // arms the debounce. publish() re-runs the redaction filter
        // and the now-excluded title must NOT leak.
        tx.send(SignalEvent::CalendarRefresh).await.unwrap();
        // Wait for the next publish.
        tokio::time::timeout(Duration::from_secs(1), rx.changed())
            .await
            .expect("publish runs after CalendarRefresh")
            .expect("channel still open");
        let snap = rx.borrow().clone().expect("Some snapshot");
        assert!(
            snap.app_name.is_none(),
            "stale-cached app_name leaked after mid-session exclusion: {:?}",
            snap.app_name
        );
        assert!(
            snap.window_title.is_none(),
            "stale-cached window_title leaked: {:?}",
            snap.window_title
        );
    }

    #[tokio::test]
    async fn git_event_populates_git_branch() {
        let (_dir, stream) = fresh_stream(Duration::from_millis(50)).await;
        let tx = stream.event_sender();
        let mut rx = stream.subscribe();
        let _ = rx.borrow_and_update();

        tx.send(SignalEvent::Git(Some(GitContext {
            repo_path: std::path::PathBuf::from("/tmp/cairn"),
            branch: Some("feat/snapshot-stream".to_string()),
        })))
        .await
        .unwrap();

        tokio::time::timeout(Duration::from_secs(1), rx.changed())
            .await
            .expect("publish runs")
            .expect("channel still open");
        let snap = rx.borrow().clone().expect("Some snapshot");
        assert_eq!(snap.git_branch.as_deref(), Some("feat/snapshot-stream"));
    }

    #[tokio::test]
    async fn git_none_clears_branch() {
        let (_dir, stream) = fresh_stream(Duration::from_millis(50)).await;
        let tx = stream.event_sender();
        let mut rx = stream.subscribe();
        let _ = rx.borrow_and_update();

        // First a Some(GitContext) to set the branch.
        tx.send(SignalEvent::Git(Some(GitContext {
            repo_path: std::path::PathBuf::from("/tmp/cairn"),
            branch: Some("main".to_string()),
        })))
        .await
        .unwrap();
        tokio::time::timeout(Duration::from_secs(1), rx.changed())
            .await
            .ok();
        assert_eq!(
            rx.borrow().clone().and_then(|s| s.git_branch),
            Some("main".to_string())
        );

        // Then a None to clear it (user navigated out of the repo).
        tx.send(SignalEvent::Git(None)).await.unwrap();
        tokio::time::timeout(Duration::from_secs(1), rx.changed())
            .await
            .ok();
        assert_eq!(rx.borrow().clone().and_then(|s| s.git_branch), None);
    }

    #[tokio::test]
    async fn window_publish_works_after_idle_event() {
        // Originally `idle_state_persists_across_publishes`. The
        // assertion doesn't actually pin persistence — it pins that
        // a window publish following an idle event still carries the
        // window state. Renamed to match what the test verifies.
        let (_dir, stream) = fresh_stream(Duration::from_millis(50)).await;
        let tx = stream.event_sender();
        let mut rx = stream.subscribe();
        let _ = rx.borrow_and_update();

        tx.send(SignalEvent::Idle(IdleState { seconds: Some(300) }))
            .await
            .unwrap();
        tokio::time::timeout(Duration::from_secs(1), rx.changed())
            .await
            .ok();

        tx.send(SignalEvent::Window(Some(fw("Cairn", None))))
            .await
            .unwrap();
        let snap = wait_for_app_name(&mut rx, "Cairn", Duration::from_secs(1))
            .await
            .expect("window publish after idle");
        assert_eq!(snap.app_name.as_deref(), Some("Cairn"));
    }

    #[tokio::test]
    async fn idle_none_propagates_distinctly_from_active() {
        // R4 from review: "idle unavailable" must be distinct from
        // "user is active" so the ambiguity modal can choose a safe
        // default. Verify both Some(0) and None come through the
        // idle watch channel correctly.
        let (_dir, stream) = fresh_stream(Duration::from_millis(50)).await;
        let tx = stream.event_sender();
        let mut idle_rx = stream.subscribe_idle();
        let _ = idle_rx.borrow_and_update();

        tx.send(SignalEvent::Idle(IdleState { seconds: Some(0) }))
            .await
            .unwrap();
        idle_rx.changed().await.ok();
        assert_eq!(idle_rx.borrow().seconds, Some(0));

        tx.send(SignalEvent::Idle(IdleState { seconds: None }))
            .await
            .unwrap();
        idle_rx.changed().await.ok();
        assert_eq!(idle_rx.borrow().seconds, None);
    }
}
