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

use std::path::PathBuf;
use std::sync::Arc;
use std::sync::RwLock;
use std::time::Duration;

use chrono::{DateTime, Utc};
use serde::Serialize;
use tokio::sync::{broadcast, mpsc, watch};
use tokio::time::Instant;

use crate::plugins::calendar::CalendarRegistry;
use crate::rules::{CalendarEvent, SignalSnapshot};
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

/// How many seconds without input qualifies as "idle". Default 5
/// minutes per `docs/DESIGN_SPEC.md` §3.4.3. Crossing this threshold
/// while a timer is running starts an idle period; when the user
/// returns (seconds resets) the driver emits `IdleResume`.
///
/// The matching "Settings → Detection prompts" UI lives with M4's
/// settings schema work; for now the threshold is a compile-time
/// constant. The stream's spawn accepts an override so tests don't
/// have to wait 5 minutes.
pub const DEFAULT_IDLE_THRESHOLD_SECS: u64 = 300;

/// Emitted on every `Idle → Active` transition. The frontend
/// translates this into the Today view's ambiguity modal: the user
/// chooses Keep / Discard / Move-to-break for the
/// `[since, until]` window.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IdleResume {
    /// When the user went idle (computed from the OS-reported
    /// `seconds_since_input` at the moment idle was first observed).
    pub since: DateTime<Utc>,
    /// When the user came back (the wall-clock at the moment we saw
    /// `seconds` drop back below threshold).
    pub until: DateTime<Utc>,
    /// `until - since`, in seconds. Always positive; equal to or
    /// greater than the configured threshold.
    pub duration_seconds: u64,
}

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
    /// Browser context derived from a local-IPC push by a small
    /// browser extension (issue #35, M7). Carries only the domain —
    /// path and title are dropped at the collector boundary per
    /// `docs/PRIVACY.md`. The exclusion list is applied BEFORE the
    /// event reaches the stream, so any value seen here is allowed
    /// to participate in matching.
    Browser(Option<crate::signals::browser::BrowserContext>),
    /// Active calendar events, pushed by the calendar source on each
    /// tick. Carries its payload like every other source so the
    /// driver never reaches back into a `CalendarRegistry` — this is
    /// the seam a calendar *plugin* plugs into (see `docs/PLUGINS.md`).
    /// An empty vec means "no events active right now", which still
    /// arms a publish so a just-ended event clears from the snapshot.
    Calendar(Vec<CalendarEvent>),
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
    idle_resume_tx: broadcast::Sender<IdleResume>,
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

    /// Subscribe to `Idle → Active` transition events. Each
    /// subscriber receives every `IdleResume` published from the
    /// moment they subscribe; missed events while detached are
    /// dropped (broadcast capacity = `IDLE_RESUME_CAPACITY`). The
    /// fanout task is the production consumer — it re-emits each
    /// resume as the `signal:idle-resume` Tauri event so the
    /// Today view's idle modal can render.
    pub fn subscribe_idle_resume(&self) -> broadcast::Receiver<IdleResume> {
        self.idle_resume_tx.subscribe()
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
    /// Latest browser context from the local-IPC collector (#35),
    /// or `None` when no extension has reported recently. The
    /// `apply_event` arm for `SignalEvent::Browser` writes this
    /// straight through — the exclusion + privacy filters fire
    /// *before* the event reaches the stream.
    browser: Option<crate::signals::browser::BrowserContext>,
    /// Latest active calendar events from the calendar source's last
    /// tick. The driver reads this on publish instead of pulling from
    /// a `CalendarRegistry` — keeping the driver origin-agnostic.
    calendar: Vec<CalendarEvent>,
    idle: IdleState,
    /// When the user first crossed the idle threshold. `None` while
    /// active; `Some(ts)` while idle. The transition `Some → None`
    /// is what fires an `IdleResume` event.
    idle_since: Option<DateTime<Utc>>,
}

/// Broadcast channel capacity for `IdleResume` events. Idle ↔
/// Active transitions are rare (one per multi-minute idle period),
/// so 8 is generous — a backed-up subscriber that misses events
/// is not the end of the world; the user can still resolve the
/// modal manually via the Today view.
const IDLE_RESUME_CAPACITY: usize = 8;

/// Spawn the snapshot-stream driver. Returns a handle that owns
/// subscribers and the event sender. The actual source tasks
/// (window/calendar/idle) are spawned separately by
/// `spawn_default_sources` once the stream exists.
///
/// `exclusions` is the in-memory exclusion-list snapshot consulted
/// by `apply_event` on every `Window` (and future browser-domain)
/// event. Wrapped in `Arc<RwLock<_>>` so the `save_exclusion` /
/// `delete_exclusion` IPC handlers can invalidate after a write.
pub fn spawn(exclusions: Arc<RwLock<ExclusionMatcher>>, debounce: Duration) -> SnapshotStream {
    spawn_full(
        exclusions,
        debounce,
        Duration::from_secs(DEFAULT_IDLE_THRESHOLD_SECS),
        Vec::new(),
    )
}

/// Same as `spawn` but takes an explicit idle threshold so tests
/// can use short values (e.g. 1s) instead of waiting the production
/// default of 5 minutes.
pub fn spawn_with_idle_threshold(
    exclusions: Arc<RwLock<ExclusionMatcher>>,
    debounce: Duration,
    idle_threshold: Duration,
) -> SnapshotStream {
    spawn_full(exclusions, debounce, idle_threshold, Vec::new())
}

/// Full spawn signature accepting the git watcher's discovered
/// repo paths. The driver passes these into
/// `signals::ide::derive_ide_folder` so the IDE-folder resolution
/// can fall back to longest-prefix repo-path matching for editors
/// whose title doesn't fit a known pattern (Vim / Neovim / custom
/// titles). See PR #59 for the `derive_ide_folder` shape and M1
/// #4 for the watcher.
pub fn spawn_full(
    exclusions: Arc<RwLock<ExclusionMatcher>>,
    debounce: Duration,
    idle_threshold: Duration,
    repo_paths: Vec<PathBuf>,
) -> SnapshotStream {
    let (event_tx, event_rx) = mpsc::channel::<SignalEvent>(EVENT_CHANNEL_CAPACITY);
    let (snapshot_tx, snapshot_rx) = watch::channel::<Option<SignalSnapshot>>(None);
    let (idle_tx, idle_rx) = watch::channel(IdleState::default());
    let (idle_resume_tx, _) = broadcast::channel::<IdleResume>(IDLE_RESUME_CAPACITY);

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
        idle_resume_tx.clone(),
        exclusions,
        debounce,
        idle_threshold,
        Arc::new(repo_paths),
    ));
    tokio::spawn(supervise(driver_handle));

    SnapshotStream {
        snapshot_rx,
        idle_rx,
        idle_resume_tx,
        event_tx,
    }
}

/// Supervise a spawned driver task: await its `JoinHandle`, log the
/// terminal state. Extracted from `spawn` so tests can drive it with
/// a synthetic panicking task and assert the log path executes.
async fn supervise<T>(handle: tokio::task::JoinHandle<T>) {
    match handle.await {
        Ok(_) => {
            // Driver returned normally (graceful shutdown). No log
            // line — this is the expected path on test tear-down.
        }
        Err(e) if e.is_panic() => {
            log::error!("snapshot stream driver panicked: {e}");
        }
        Err(e) if e.is_cancelled() => {
            log::warn!("snapshot stream driver was cancelled");
        }
        Err(e) => {
            log::warn!("snapshot stream driver JoinError (other): {e}");
        }
    }
}

/// Spawn the core always-on source tasks: window poller and idle
/// poller. These are the zero-config, fully-local signals that core
/// owns unconditionally (`docs/PLUGINS.md`). Each task ends when the
/// stream's `event_tx` is dropped (i.e. when the stream itself goes
/// away in test tear-down). In production they run until process exit.
///
/// Calendar is *not* spawned here — it needs the `CalendarRegistry`
/// and is the first source slated to move behind the plugin boundary
/// (#111), so it has its own spawner (`spawn_calendar_source`).
pub fn spawn_default_sources(stream: &SnapshotStream) {
    let tx = stream.event_sender();
    tokio::spawn(window_source(tx.clone(), WINDOW_POLL_INTERVAL));
    tokio::spawn(idle_source(tx, IDLE_POLL_INTERVAL));
}

// -----------------------------------------------------------------
// driver
// -----------------------------------------------------------------

#[allow(clippy::too_many_arguments)]
async fn driver(
    mut event_rx: mpsc::Receiver<SignalEvent>,
    snapshot_tx: watch::Sender<Option<SignalSnapshot>>,
    idle_tx: watch::Sender<IdleState>,
    idle_resume_tx: broadcast::Sender<IdleResume>,
    exclusions: Arc<RwLock<ExclusionMatcher>>,
    debounce: Duration,
    idle_threshold: Duration,
    repo_paths: Arc<Vec<PathBuf>>,
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
                        apply_event(
                            &mut state,
                            &idle_tx,
                            &idle_resume_tx,
                            &exclusions,
                            idle_threshold,
                            ev,
                        );
                        next_publish_at = Some(Instant::now() + debounce);
                    }
                    None => {
                        // All senders dropped — graceful shutdown
                        // path (mostly exercised by tests). Flush
                        // one final snapshot if a debounce was
                        // pending, then exit.
                        if next_publish_at.is_some() {
                            publish(&state, &snapshot_tx, &exclusions, &repo_paths).await;
                        }
                        return;
                    }
                }
            }

            _ = sleep_until(next_publish_at), if next_publish_at.is_some() => {
                publish(&state, &snapshot_tx, &exclusions, &repo_paths).await;
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
    idle_resume_tx: &broadcast::Sender<IdleResume>,
    exclusions: &Arc<RwLock<ExclusionMatcher>>,
    idle_threshold: Duration,
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
        SignalEvent::Browser(browser) => {
            // The collector at `signals/browser` has already applied
            // the privacy gates (incognito / unfocused / empty) and
            // the exclusion list before sending the event. Any value
            // we see here is allowed to drive the snapshot directly.
            state.browser = browser;
        }
        SignalEvent::Calendar(events) => {
            // The calendar source has already mapped active events to
            // the snapshot shape; store them straight through. The
            // driver no longer pulls from a registry on publish.
            state.calendar = events;
        }
        SignalEvent::Idle(idle) => {
            state.idle = idle;
            // Idle is broadcast immediately on its own channel so
            // the ambiguity modal (#7) doesn't have to wait for the
            // 500ms debounce. `send` is non-blocking; the `Err`
            // case (no receivers) is intentionally ignored — idle
            // is informational.
            let _ = idle_tx.send(idle);

            // Idle-tracker state machine:
            // - Active → Idle: `seconds >= threshold`. Record the
            //   wall-clock at which the idle period started
            //   (now - seconds).
            // - Idle → Active: `seconds` dropped back below the
            //   threshold AND the reading is `Some`. The OS resets
            //   `seconds_since_input` to 0 on the next user input,
            //   so this transition is how we detect "the user is
            //   back". Emit an `IdleResume` so the fanout can fire
            //   the Tauri event the modal listens to.
            // - `seconds = None` (OS query failed): preserve the
            //   current `idle_since` state. A transient permission
            //   glitch in the middle of an idle period must NOT
            //   fire a bogus resume — only a confirmed
            //   "user is back" reading does that.
            let threshold_s = idle_threshold.as_secs();
            let now = Utc::now();
            if let Some(current_s) = idle.seconds {
                let is_idle = current_s >= threshold_s && threshold_s > 0;
                match (state.idle_since, is_idle) {
                    (None, true) => {
                        let elapsed = chrono::Duration::seconds(current_s as i64);
                        state.idle_since = Some(now - elapsed);
                    }
                    (Some(since), false) => {
                        let duration_seconds = (now - since).num_seconds().max(0) as u64;
                        let resume = IdleResume {
                            since,
                            until: now,
                            duration_seconds,
                        };
                        // `send` only errors when no subscribers
                        // are active — ignore (the user just
                        // wasn't looking, no harm done).
                        let _ = idle_resume_tx.send(resume);
                        state.idle_since = None;
                    }
                    _ => {}
                }
            }
        }
    }
}

async fn publish(
    state: &LiveState,
    snapshot_tx: &watch::Sender<Option<SignalSnapshot>>,
    exclusions: &Arc<RwLock<ExclusionMatcher>>,
    repo_paths: &[PathBuf],
) {
    let calendar_events = state.calendar.clone();

    let (app_name, window_title, ide_folder) = match state.front.as_ref() {
        Some(w) => {
            let folder = w
                .title
                .as_deref()
                .and_then(|t| crate::signals::ide::derive_ide_folder(&w.app_name, t, repo_paths))
                .map(|p| p.to_string_lossy().into_owned());
            (Some(w.app_name.clone()), w.title.clone(), folder)
        }
        None => (None, None, None),
    };

    let git_branch = state.git.as_ref().and_then(|g| g.branch.clone());

    let browser_domain = state.browser.as_ref().map(|b| b.domain.clone());

    let mut snap = SignalSnapshot {
        ide_folder,
        git_branch,
        window_title,
        app_name,
        browser_domain,
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

/// The calendar signal source loop. Owns a `CalendarRegistry`,
/// re-queries active events on each tick, and pushes them as
/// `SignalEvent::Calendar`. `pub(crate)` so the calendar plugin
/// (`crate::plugins::calendar`) can spawn it behind the
/// `SignalSource` boundary; nothing else should call it directly.
pub(crate) async fn calendar_source(
    tx: mpsc::Sender<SignalEvent>,
    calendar: Arc<CalendarRegistry>,
    interval: Duration,
) {
    // Fire the first tick immediately, then every `interval`. Before
    // the driver-decoupling refactor, `publish` pulled calendar on
    // every snapshot, so calendar was available from the first
    // window/idle publish (~1s after launch). Now that the driver
    // reads cached `state.calendar`, the source must prime it
    // promptly — otherwise stream snapshots would be calendar-blind
    // until the first tick. An immediate query+push restores that:
    // it arms a debounce and publishes a calendar-only snapshot,
    // which is correct (a meeting in progress IS active state).
    let mut ticker = tokio::time::interval(interval);
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        ticker.tick().await;
        // The source — not the driver — queries the registry and maps
        // active events into the snapshot shape, then pushes the
        // payload. This is what keeps the driver origin-agnostic.
        let events = crate::plugins::calendar::to_calendar_events(
            calendar.active_events_at(Utc::now()).await,
        );
        if !push_or_drop(&tx, SignalEvent::Calendar(events)) {
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
        // The stream no longer touches the DB or a CalendarRegistry —
        // calendar events arrive as pushed `SignalEvent::Calendar`
        // payloads. The TempDir is kept only to mirror the other
        // helpers' return shape.
        let (dir, _db) = test_db().await;
        let exclusions = Arc::new(RwLock::new(excl));
        let stream = spawn(exclusions, debounce);
        (dir, stream)
    }

    async fn fresh_stream_with_idle_threshold(
        debounce: Duration,
        idle_threshold: Duration,
    ) -> (tempfile::TempDir, SnapshotStream) {
        let (dir, _db) = test_db().await;
        let exclusions = Arc::new(RwLock::new(ExclusionMatcher::default()));
        let stream = spawn_with_idle_threshold(exclusions, debounce, idle_threshold);
        (dir, stream)
    }

    async fn fresh_stream_with_repo_paths(
        debounce: Duration,
        repo_paths: Vec<PathBuf>,
    ) -> (tempfile::TempDir, SnapshotStream) {
        let (dir, _db) = test_db().await;
        let exclusions = Arc::new(RwLock::new(ExclusionMatcher::default()));
        let stream = spawn_full(
            exclusions,
            debounce,
            Duration::from_secs(DEFAULT_IDLE_THRESHOLD_SECS),
            repo_paths,
        );
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
    async fn empty_calendar_event_alone_publishes_snapshot() {
        let (_dir, stream) = fresh_stream(Duration::from_millis(50)).await;
        let tx = stream.event_sender();
        let mut rx = stream.subscribe();
        let _ = rx.borrow_and_update();

        tx.send(SignalEvent::Calendar(vec![])).await.unwrap();

        let result = tokio::time::timeout(Duration::from_secs(1), rx.changed()).await;
        assert!(
            matches!(result, Ok(Ok(()))),
            "a calendar event (even empty) arms the debounce and publishes a snapshot"
        );
        // The published snapshot is a real Some(...) value with an
        // empty calendar (we pushed no events).
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
    async fn pushed_calendar_events_appear_in_published_snapshot() {
        // The decoupling's core contract (docs/PLUGINS.md): calendar
        // events now travel as a `SignalEvent::Calendar` payload, not
        // a driver-side registry pull. Pushing events directly — as a
        // calendar plugin would — must surface them in the snapshot.
        let (_dir, stream) = fresh_stream(Duration::from_millis(50)).await;
        let tx = stream.event_sender();
        let mut rx = stream.subscribe();
        let _ = rx.borrow_and_update();

        tx.send(SignalEvent::Calendar(vec![CalendarEvent {
            title: "Stand-up".into(),
            source_label: "Work".into(),
            attendees: vec![],
            all_day: false,
        }]))
        .await
        .unwrap();

        tokio::time::timeout(Duration::from_secs(1), rx.changed())
            .await
            .expect("calendar event triggers a publish")
            .expect("channel still open");
        let snap = rx.borrow().clone().expect("Some snapshot");
        assert_eq!(snap.calendar.len(), 1);
        assert_eq!(snap.calendar[0].title, "Stand-up");
        assert_eq!(snap.calendar[0].source_label, "Work");

        // A subsequent empty push clears the events — a just-ended
        // event must not linger in the cached LiveState.
        tx.send(SignalEvent::Calendar(vec![])).await.unwrap();
        tokio::time::timeout(Duration::from_secs(1), rx.changed())
            .await
            .expect("empty calendar event triggers a publish")
            .expect("channel still open");
        let snap = rx.borrow().clone().expect("Some snapshot");
        assert!(
            snap.calendar.is_empty(),
            "ended events must clear from the snapshot, got {:?}",
            snap.calendar
        );
    }

    #[tokio::test]
    async fn dropping_senders_mid_debounce_flushes_a_final_snapshot() {
        // Driver graceful-shutdown path: when every event sender drops
        // while a debounce is still pending, the driver must flush one
        // final snapshot before exiting rather than discard the armed
        // event. A long debounce guarantees the timer branch can't
        // fire first, so the `recv() == None` + `next_publish_at.is_some()`
        // path is the one that publishes.
        let (_dir, _db) = test_db().await;
        let exclusions = Arc::new(RwLock::new(ExclusionMatcher::default()));
        let stream = spawn(exclusions, Duration::from_secs(30));
        let mut rx = stream.subscribe();
        let _ = rx.borrow_and_update();

        let tx = stream.event_sender();
        // Arm a debounce, then drop every sender before it elapses.
        tx.send(SignalEvent::Calendar(vec![])).await.unwrap();
        drop(tx);
        drop(stream);

        tokio::time::timeout(Duration::from_secs(1), rx.changed())
            .await
            .expect("a final snapshot is flushed on graceful shutdown")
            .expect("snapshot channel still open");
        assert!(
            rx.borrow().is_some(),
            "graceful shutdown with a pending debounce must publish, not drop"
        );
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
        let (_dir, _db) = test_db().await;
        let exclusions = Arc::new(RwLock::new(ExclusionMatcher::default()));
        let stream = spawn(exclusions.clone(), Duration::from_millis(50));
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

        // Step 3: a non-window event (an empty calendar push) arms
        // the debounce without touching `front`. publish() re-runs
        // the redaction filter and the now-excluded title must NOT
        // leak.
        tx.send(SignalEvent::Calendar(vec![])).await.unwrap();
        // Wait for the next publish.
        tokio::time::timeout(Duration::from_secs(1), rx.changed())
            .await
            .expect("publish runs after calendar event")
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
    async fn repo_paths_feed_ide_folder_fallback_for_terminal_editor() {
        // The whole point of `spawn_full`'s `repo_paths` arg is to
        // make `derive_ide_folder`'s longest-prefix fallback work
        // for terminal-based editors. Pin that wiring with a
        // window event from `iTerm2` whose title contains the
        // full repo path; the published snapshot's `ide_folder`
        // should resolve to that path even though the editor isn't
        // in the title-parser allow-list.
        let repo = PathBuf::from("/home/u/code/cairn");
        let (_dir, stream) =
            fresh_stream_with_repo_paths(Duration::from_millis(50), vec![repo.clone()]).await;
        let tx = stream.event_sender();
        let mut rx = stream.subscribe();
        let _ = rx.borrow_and_update();

        tx.send(SignalEvent::Window(Some(fw(
            "iTerm2",
            Some("nvim: /home/u/code/cairn/src/lib.rs"),
        ))))
        .await
        .unwrap();

        let snap = wait_for_app_name(&mut rx, "iTerm2", Duration::from_secs(1))
            .await
            .expect("iTerm2 publish arrives");
        assert_eq!(
            snap.ide_folder.as_deref(),
            Some(repo.to_str().unwrap()),
            "repo-paths fallback must resolve the terminal editor's working dir"
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
    async fn browser_event_publishes_to_snapshot_browser_domain() {
        // Sibling of `git_event_publishes_to_snapshot_git_branch`:
        // the SignalEvent::Browser arm in apply_event writes straight
        // through to LiveState.browser, which `publish` projects to
        // SignalSnapshot.browser_domain. A None Browser event after
        // a Some clears the field — same shape as the Git arm.
        use crate::signals::browser::BrowserContext;
        let (_dir, stream) = fresh_stream(Duration::from_millis(50)).await;
        let tx = stream.event_sender();
        let mut rx = stream.subscribe();
        let _ = rx.borrow_and_update();

        tx.send(SignalEvent::Browser(Some(BrowserContext {
            domain: "github.com".to_string(),
        })))
        .await
        .unwrap();
        tokio::time::timeout(Duration::from_secs(1), rx.changed())
            .await
            .expect("publish runs")
            .expect("channel still open");
        let snap = rx.borrow().clone().expect("Some snapshot");
        assert_eq!(snap.browser_domain.as_deref(), Some("github.com"));

        // None clears it (user closed the browser tab).
        tx.send(SignalEvent::Browser(None)).await.unwrap();
        tokio::time::timeout(Duration::from_secs(1), rx.changed())
            .await
            .ok();
        assert_eq!(
            rx.borrow().clone().and_then(|s| s.browser_domain),
            None,
            "Browser(None) clears the snapshot's browser_domain"
        );
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
    async fn poisoned_exclusions_lock_drops_window_signal_fail_closed() {
        // Poison the RwLock by panicking while holding the write
        // guard. The driver's apply_event must fail closed — i.e.
        // drop the incoming Window event rather than letting it
        // through.
        let exclusions = Arc::new(RwLock::new(ExclusionMatcher::default()));
        let poisoner = exclusions.clone();
        // `catch_unwind` so the test thread doesn't itself fail.
        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _guard = poisoner.write().unwrap();
            panic!("simulated poison");
        }));
        assert!(
            exclusions.read().is_err(),
            "RwLock should be poisoned for the test to be meaningful"
        );

        let (_dir, _db) = test_db().await;
        let stream = spawn(exclusions, Duration::from_millis(50));
        let tx = stream.event_sender();
        let mut rx = stream.subscribe();
        let _ = rx.borrow_and_update();

        tx.send(SignalEvent::Window(Some(fw("Chrome", Some("Banking")))))
            .await
            .unwrap();

        // The poisoned lock + fail-closed pattern means:
        // apply_event drops the front, AND publish also fully
        // redacts. The published snapshot must have no OS-derived
        // fields.
        tokio::time::timeout(Duration::from_secs(1), rx.changed())
            .await
            .expect("publish runs")
            .expect("channel still open");
        let snap = rx.borrow().clone().expect("Some snapshot");
        assert!(snap.app_name.is_none(), "poisoned lock leaked app_name");
        assert!(
            snap.window_title.is_none(),
            "poisoned lock leaked window_title"
        );
    }

    #[tokio::test]
    async fn supervise_completes_quietly_on_normal_exit() {
        let handle = tokio::spawn(async { 42 });
        // No panic, no log assertion — just verify the supervisor
        // completes without itself panicking.
        supervise(handle).await;
    }

    #[tokio::test]
    async fn supervise_logs_on_panic() {
        let handle = tokio::spawn(async { panic!("driver exploded") });
        // The supervisor must NOT propagate the panic — it logs and
        // returns. If it did propagate, this test would itself
        // panic and fail.
        supervise(handle).await;
    }

    #[tokio::test]
    async fn supervise_logs_on_cancellation() {
        let handle = tokio::spawn(async {
            // Never finishes on its own — must be aborted.
            std::future::pending::<()>().await;
        });
        handle.abort();
        supervise(handle).await;
    }

    #[tokio::test]
    async fn push_or_drop_handles_closed_channel() {
        let (tx, rx) = mpsc::channel::<SignalEvent>(2);
        drop(rx);
        // Closed channel → caller signals the source to exit.
        let ok = push_or_drop(&tx, SignalEvent::Calendar(vec![]));
        assert!(!ok, "push_or_drop returns false when the channel is closed");
    }

    #[tokio::test]
    async fn push_or_drop_drops_silently_when_full() {
        let (tx, _rx) = mpsc::channel::<SignalEvent>(1);
        // Fill the channel.
        tx.try_send(SignalEvent::Calendar(vec![])).unwrap();
        // Second push should drop, NOT block, and still return true
        // (the source keeps polling).
        let ok = push_or_drop(&tx, SignalEvent::Calendar(vec![]));
        assert!(ok, "push_or_drop returns true even on Full");
    }

    #[tokio::test]
    async fn calendar_source_pushes_active_events_on_tick() {
        // The source — not the driver — queries the registry and
        // pushes a `SignalEvent::Calendar`. A fresh registry has no
        // sources, so the first tick pushes an empty event. Closing
        // the receiver makes the next push fail, exiting the loop.
        let (_dir, db) = test_db().await;
        let calendar =
            Arc::new(CalendarRegistry::new(db.pool.clone()).expect("calendar registry builds"));
        let (tx, mut rx) = mpsc::channel::<SignalEvent>(4);
        let handle = tokio::spawn(calendar_source(tx, calendar, Duration::from_millis(20)));

        let ev = tokio::time::timeout(Duration::from_secs(1), rx.recv())
            .await
            .expect("calendar source pushes within timeout")
            .expect("channel still open");
        assert!(
            matches!(ev, SignalEvent::Calendar(ref events) if events.is_empty()),
            "expected an empty SignalEvent::Calendar (no sources registered), got {ev:?}"
        );

        // Drop the receiver; the source must exit on the next push.
        drop(rx);
        tokio::time::timeout(Duration::from_secs(1), handle)
            .await
            .expect("calendar source exits when the channel closes")
            .expect("calendar source task joined cleanly");
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

    // -- Idle tracker (Active → Idle → Active transition) ------------

    #[tokio::test]
    async fn idle_resume_fires_when_seconds_drops_below_threshold() {
        let (_dir, stream) =
            fresh_stream_with_idle_threshold(Duration::from_millis(50), Duration::from_secs(60))
                .await;
        let tx = stream.event_sender();
        let mut resume_rx = stream.subscribe_idle_resume();

        // Cross the threshold → driver records `idle_since`. No
        // event yet.
        tx.send(SignalEvent::Idle(IdleState { seconds: Some(90) }))
            .await
            .unwrap();
        let immediate = tokio::time::timeout(Duration::from_millis(100), resume_rx.recv()).await;
        assert!(
            immediate.is_err(),
            "Active→Idle alone should NOT fire a resume event"
        );

        // Drop back to 0 → Idle → Active transition fires resume.
        tx.send(SignalEvent::Idle(IdleState { seconds: Some(0) }))
            .await
            .unwrap();
        let resume = tokio::time::timeout(Duration::from_secs(1), resume_rx.recv())
            .await
            .expect("resume event arrives within the timeout")
            .expect("broadcast channel still open");
        // Duration is at least the threshold (within timing slop)
        // and bounded by `seconds reported on the first event
        // (90) + the few ms the test takes to drive the second
        // event`. Both bounds keep a future refactor from
        // accidentally setting since=epoch or until=year-3000.
        assert!(
            resume.duration_seconds >= 60,
            "duration {} should be >= threshold 60",
            resume.duration_seconds
        );
        assert!(
            resume.duration_seconds < 120,
            "duration {} should be < ~test-window (90 + slop)",
            resume.duration_seconds
        );
        assert!(resume.until > resume.since);
    }

    #[tokio::test]
    async fn idle_resume_does_not_fire_for_brief_below_threshold_blip() {
        let (_dir, stream) =
            fresh_stream_with_idle_threshold(Duration::from_millis(50), Duration::from_secs(300))
                .await;
        let tx = stream.event_sender();
        let mut resume_rx = stream.subscribe_idle_resume();

        // 30s and 60s are both below the 300s threshold → no idle
        // period was ever observed → no resume event on the
        // transition back to 0.
        tx.send(SignalEvent::Idle(IdleState { seconds: Some(30) }))
            .await
            .unwrap();
        tx.send(SignalEvent::Idle(IdleState { seconds: Some(60) }))
            .await
            .unwrap();
        tx.send(SignalEvent::Idle(IdleState { seconds: Some(0) }))
            .await
            .unwrap();

        let immediate = tokio::time::timeout(Duration::from_millis(200), resume_rx.recv()).await;
        assert!(
            immediate.is_err(),
            "below-threshold blips must not produce a resume event"
        );
    }

    #[tokio::test]
    async fn idle_resume_handles_multiple_cycles() {
        let (_dir, stream) =
            fresh_stream_with_idle_threshold(Duration::from_millis(50), Duration::from_secs(60))
                .await;
        let tx = stream.event_sender();
        let mut resume_rx = stream.subscribe_idle_resume();

        // Cycle 1
        tx.send(SignalEvent::Idle(IdleState { seconds: Some(120) }))
            .await
            .unwrap();
        tx.send(SignalEvent::Idle(IdleState { seconds: Some(0) }))
            .await
            .unwrap();
        let r1 = tokio::time::timeout(Duration::from_secs(1), resume_rx.recv())
            .await
            .expect("first resume arrives")
            .expect("channel open");
        assert!(r1.duration_seconds >= 60 && r1.duration_seconds < 150);

        // Cycle 2
        tx.send(SignalEvent::Idle(IdleState { seconds: Some(180) }))
            .await
            .unwrap();
        tx.send(SignalEvent::Idle(IdleState { seconds: Some(0) }))
            .await
            .unwrap();
        let r2 = tokio::time::timeout(Duration::from_secs(1), resume_rx.recv())
            .await
            .expect("second resume arrives")
            .expect("channel open");
        assert!(r2.duration_seconds >= 60 && r2.duration_seconds < 210);
        // The two cycles produce distinct since values and r2 is
        // after r1.
        assert_ne!(r1.since, r2.since);
        assert!(r2.until > r1.until);
    }

    #[tokio::test]
    async fn idle_unavailable_does_not_trigger_resume() {
        // `IdleState { seconds: None }` is "the OS query failed".
        // It must NOT count as Active for transition purposes —
        // otherwise a transient permission glitch in the middle of
        // an idle period would fire a bogus resume.
        let (_dir, stream) =
            fresh_stream_with_idle_threshold(Duration::from_millis(50), Duration::from_secs(60))
                .await;
        let tx = stream.event_sender();
        let mut resume_rx = stream.subscribe_idle_resume();

        // Cross threshold.
        tx.send(SignalEvent::Idle(IdleState { seconds: Some(120) }))
            .await
            .unwrap();
        // Glitch: OS query returns None for a tick.
        tx.send(SignalEvent::Idle(IdleState { seconds: None }))
            .await
            .unwrap();

        let immediate = tokio::time::timeout(Duration::from_millis(200), resume_rx.recv()).await;
        assert!(
            immediate.is_err(),
            "transient OS-query glitch should NOT fire a resume mid-idle"
        );

        // User actually returns — Some(0) — this should fire.
        tx.send(SignalEvent::Idle(IdleState { seconds: Some(0) }))
            .await
            .unwrap();
        let r = tokio::time::timeout(Duration::from_secs(1), resume_rx.recv())
            .await
            .expect("real resume fires when seconds drops to Some(0)")
            .expect("channel open");
        assert!(r.duration_seconds >= 60);
    }
}
