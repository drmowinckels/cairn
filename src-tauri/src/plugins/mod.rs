//! Plugin host (in-process, compiled-in). See `docs/PLUGINS.md`.
//!
//! A plugin is an optional / networked / secrets-bearing / paid
//! capability that core never links on its always-on path. v1 wires up
//! one kind: the **signal source**, which feeds the rules engine via
//! the same [`SignalEvent`] channel the core collectors use — so the
//! driver can't tell a plugin's events from a core one's. Calendar is
//! the first signal-source plugin (#111).
//!
//! The host owns each opt-in source's lifecycle: register, start the
//! enabled set, expose their status to the settings UI, and toggle a
//! source on/off at runtime. Enabled state is persisted (`plugins::store`)
//! so a user who turns a networked plugin off stays opted out across
//! launches. `Capability::Paid` lands with billing (#109).

pub mod calendar;
pub mod store;

use std::collections::HashMap;
use std::future::Future;

use serde::Serialize;
use tokio::sync::mpsc;
use tokio::task::AbortHandle;

use crate::signals::stream::SignalEvent;

/// A capability a plugin declares in its manifest. The host and the
/// settings UI read these to keep the privacy contract enforceable — a
/// plugin may only use a capability it names. See `docs/PRIVACY.md`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Capability {
    /// Makes network requests. Destinations may be user-configured
    /// (e.g. calendar ICS feeds); the UI surfaces live activity.
    Network,
    /// Reads or writes credentials in the OS keychain.
    Secrets,
}

/// Static identity + declared capabilities for a plugin.
#[derive(Debug, Clone, Copy)]
pub struct PluginManifest {
    /// Stable machine id (e.g. `"calendar"`).
    pub id: &'static str,
    /// Human-facing name shown in settings.
    pub name: &'static str,
    /// What this plugin is allowed to do. Empty = fully local + free.
    pub capabilities: &'static [Capability],
}

/// A plugin's current state, sent to the settings UI by the
/// `list_plugins` / `set_plugin_enabled` IPC commands.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginStatus {
    pub id: String,
    pub name: String,
    pub capabilities: Vec<Capability>,
    pub enabled: bool,
}

/// Abort handle for a running source. The host keeps this so a source
/// can be stopped (on disable / shutdown) without closing the shared
/// `SignalEvent` channel every other source also writes to. Dropping a
/// `SourceHandle` does NOT stop the source — call [`SourceHandle::stop`].
pub struct SourceHandle {
    abort: AbortHandle,
}

impl SourceHandle {
    /// Abort the source task.
    pub fn stop(self) {
        self.abort.abort();
    }
}

/// Spawn a source future under a supervisor that logs a panic instead
/// of letting the source die silently. Returns the handle used to stop
/// it. A normal exit (channel closed) or a cancellation (the source was
/// disabled) is expected and not logged.
pub fn spawn_supervised<F>(id: &'static str, fut: F) -> SourceHandle
where
    F: Future<Output = ()> + Send + 'static,
{
    let task = tokio::spawn(fut);
    let abort = task.abort_handle();
    tokio::spawn(async move { log_join_result(id, task.await) });
    SourceHandle { abort }
}

/// Decide what to log for a finished source task. A normal exit (channel
/// closed) or a cancellation (the source was disabled) is expected and
/// silent; only a panic is logged. Split out so the branch logic is
/// unit-tested directly rather than through a spawned supervisor task
/// whose timing would make coverage non-deterministic.
fn log_join_result(id: &'static str, result: Result<(), tokio::task::JoinError>) {
    match result {
        Ok(()) => {}
        Err(e) if e.is_cancelled() => {}
        Err(e) => log::error!("signal source '{id}' panicked: {e}"),
    }
}

/// A source of signals that feed the rules engine. Origin-agnostic:
/// the driver folds a plugin's `SignalEvent`s into the snapshot exactly
/// as it does a core collector's. See `docs/PLUGINS.md`.
pub trait SignalSource: Send + Sync {
    fn manifest(&self) -> &PluginManifest;

    /// Spawn the source's task(s), pushing `SignalEvent`s through `tx`
    /// (drop-on-full, never blocking the driver) and exiting when `tx`
    /// closes or the returned handle is stopped. Use [`spawn_supervised`]
    /// so a panic surfaces in the logs. Must be called within a runtime.
    fn start(&self, tx: mpsc::Sender<SignalEvent>) -> SourceHandle;

    /// Called after the source is stopped on disable, so it can push a
    /// final event clearing its contribution from the snapshot — a
    /// disabled source must go quiet, not freeze its last value in every
    /// future snapshot. Default: nothing to clear.
    fn on_disabled(&self, _tx: &mpsc::Sender<SignalEvent>) {}
}

/// Registry + lifecycle for opt-in signal-source plugins. Core's
/// always-on sources (window · git · idle) are not registered here —
/// they need no manifest. Lives behind a `tokio::Mutex` in `AppState`
/// because the toggle IPC mutates running state while `list_plugins`
/// reads it.
#[derive(Default)]
pub struct SignalSourceHost {
    sources: Vec<Box<dyn SignalSource>>,
    enabled: HashMap<&'static str, bool>,
    running: HashMap<&'static str, SourceHandle>,
}

impl SignalSourceHost {
    pub fn new() -> Self {
        Self::default()
    }

    /// Register a source. Defaults to enabled until `start_with` applies
    /// the persisted flags.
    pub fn register(&mut self, source: Box<dyn SignalSource>) {
        let id = source.manifest().id;
        self.enabled.insert(id, true);
        self.sources.push(source);
    }

    /// Apply persisted enabled flags and start every enabled source.
    /// A source absent from `flags` defaults to enabled (a plugin that
    /// predates its persistence row must stay on). Must be called within
    /// a runtime.
    pub fn start_with(&mut self, flags: &HashMap<String, bool>, tx: mpsc::Sender<SignalEvent>) {
        let plan: Vec<(&'static str, bool)> = self
            .sources
            .iter()
            .map(|s| {
                let id = s.manifest().id;
                (id, flags.get(id).copied().unwrap_or(true))
            })
            .collect();
        for (id, on) in plan {
            self.enabled.insert(id, on);
            if on {
                self.start_source(id, &tx);
            }
        }
    }

    /// Toggle a source at runtime. Enabling a stopped source starts it;
    /// disabling a running source stops it and lets it clear its
    /// contribution (`on_disabled`). Idempotent. Returns `Err` for an
    /// unknown plugin id. Does NOT persist — the caller writes the flag
    /// to `plugins::store` after this returns, so the live session is
    /// always correct; a failed persist only means the choice reverts on
    /// the next launch, never that the running state and the DB disagree
    /// within a session.
    pub fn set_enabled(
        &mut self,
        id: &str,
        enabled: bool,
        tx: &mpsc::Sender<SignalEvent>,
    ) -> Result<(), String> {
        let static_id = self
            .sources
            .iter()
            .map(|s| s.manifest().id)
            .find(|sid| *sid == id)
            .ok_or_else(|| format!("unknown plugin '{id}'"))?;

        self.enabled.insert(static_id, enabled);
        if enabled {
            self.start_source(static_id, tx);
        } else if let Some(handle) = self.running.remove(static_id) {
            handle.stop();
            if let Some(src) = self.sources.iter().find(|s| s.manifest().id == static_id) {
                src.on_disabled(tx);
            }
        }
        Ok(())
    }

    /// Every registered plugin's current state, for the settings UI and
    /// the startup transparency log.
    pub fn statuses(&self) -> Vec<PluginStatus> {
        self.sources
            .iter()
            .map(|s| {
                let m = s.manifest();
                PluginStatus {
                    id: m.id.to_string(),
                    name: m.name.to_string(),
                    capabilities: m.capabilities.to_vec(),
                    enabled: self.enabled.get(m.id).copied().unwrap_or(true),
                }
            })
            .collect()
    }

    /// Start the source with `id` if it isn't already running, storing
    /// its handle. No-op if already running or the id is unknown.
    fn start_source(&mut self, id: &'static str, tx: &mpsc::Sender<SignalEvent>) {
        if self.running.contains_key(id) {
            return;
        }
        let handle = self
            .sources
            .iter()
            .find(|s| s.manifest().id == id)
            .map(|s| s.start(tx.clone()));
        if let Some(handle) = handle {
            self.running.insert(id, handle);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rules::CalendarEvent;
    use std::collections::HashMap;
    use std::time::Duration;

    static DUMMY_MANIFEST: PluginManifest = PluginManifest {
        id: "dummy",
        name: "Dummy",
        capabilities: &[Capability::Network],
    };

    /// On start, pushes one non-empty `Calendar` event (a "running"
    /// marker). The handle stays in the host's running map, so a
    /// re-enable is a no-op while a disable removes it and respawns on
    /// the next enable. On disable, pushes an empty one (the "cleared"
    /// marker) so tests can observe the clear-on-disable contract.
    struct DummySource;
    impl SignalSource for DummySource {
        fn manifest(&self) -> &PluginManifest {
            &DUMMY_MANIFEST
        }
        fn start(&self, tx: mpsc::Sender<SignalEvent>) -> SourceHandle {
            spawn_supervised("dummy", async move {
                let _ = tx
                    .send(SignalEvent::Calendar(vec![CalendarEvent {
                        title: "running".into(),
                        source_label: "dummy".into(),
                        attendees: vec![],
                        all_day: false,
                    }]))
                    .await;
            })
        }
        fn on_disabled(&self, tx: &mpsc::Sender<SignalEvent>) {
            let _ = tx.try_send(SignalEvent::Calendar(vec![]));
        }
    }

    static QUIET_MANIFEST: PluginManifest = PluginManifest {
        id: "quiet",
        name: "Quiet",
        capabilities: &[],
    };

    /// A source that does NOT override `on_disabled` — exercises the
    /// trait's default (clear nothing).
    struct QuietSource;
    impl SignalSource for QuietSource {
        fn manifest(&self) -> &PluginManifest {
            &QUIET_MANIFEST
        }
        fn start(&self, _tx: mpsc::Sender<SignalEvent>) -> SourceHandle {
            spawn_supervised("quiet", async {})
        }
    }

    async fn recv(rx: &mut mpsc::Receiver<SignalEvent>) -> SignalEvent {
        tokio::time::timeout(Duration::from_secs(1), rx.recv())
            .await
            .expect("event within timeout")
            .expect("channel open")
    }

    #[test]
    fn register_defaults_to_enabled_in_statuses() {
        let mut host = SignalSourceHost::new();
        host.register(Box::new(DummySource));
        let s = host.statuses();
        assert_eq!(s.len(), 1);
        assert_eq!(s[0].id, "dummy");
        assert!(s[0].enabled);
        assert_eq!(s[0].capabilities, vec![Capability::Network]);
    }

    #[tokio::test]
    async fn start_with_respects_disabled_flag() {
        let mut host = SignalSourceHost::new();
        host.register(Box::new(DummySource));
        let (tx, mut rx) = mpsc::channel::<SignalEvent>(4);
        let flags = HashMap::from([("dummy".to_string(), false)]);
        // Keep our own `tx` clone so the channel stays open and a missing
        // event reads as a timeout, not a closed channel.
        host.start_with(&flags, tx.clone());

        // Disabled at startup → no "running" marker is ever pushed.
        assert!(
            tokio::time::timeout(Duration::from_millis(200), rx.recv())
                .await
                .is_err(),
            "a disabled source must not start"
        );
        assert!(!host.statuses()[0].enabled);
    }

    #[tokio::test]
    async fn start_with_absent_flag_defaults_enabled() {
        let mut host = SignalSourceHost::new();
        host.register(Box::new(DummySource));
        let (tx, mut rx) = mpsc::channel::<SignalEvent>(4);
        host.start_with(&HashMap::new(), tx);
        // Started → the running marker arrives.
        assert!(matches!(recv(&mut rx).await, SignalEvent::Calendar(ref e) if !e.is_empty()));
        assert!(host.statuses()[0].enabled);
    }

    #[tokio::test]
    async fn toggle_off_clears_then_toggle_on_restarts() {
        let mut host = SignalSourceHost::new();
        host.register(Box::new(DummySource));
        let (tx, mut rx) = mpsc::channel::<SignalEvent>(8);
        host.start_with(&HashMap::new(), tx.clone());
        // running marker
        assert!(matches!(recv(&mut rx).await, SignalEvent::Calendar(ref e) if !e.is_empty()));

        // Disable → stops the source and pushes the cleared (empty) event.
        host.set_enabled("dummy", false, &tx).unwrap();
        assert!(matches!(recv(&mut rx).await, SignalEvent::Calendar(ref e) if e.is_empty()));
        assert!(!host.statuses()[0].enabled);

        // Re-enable → starts it again; the running marker returns.
        host.set_enabled("dummy", true, &tx).unwrap();
        assert!(matches!(recv(&mut rx).await, SignalEvent::Calendar(ref e) if !e.is_empty()));
        assert!(host.statuses()[0].enabled);
    }

    #[tokio::test]
    async fn toggle_is_idempotent() {
        let mut host = SignalSourceHost::new();
        host.register(Box::new(DummySource));
        let (tx, mut rx) = mpsc::channel::<SignalEvent>(8);
        host.start_with(&HashMap::new(), tx.clone());
        assert!(matches!(recv(&mut rx).await, SignalEvent::Calendar(ref e) if !e.is_empty()));

        // Enabling an already-running source does nothing (no second
        // running marker is pushed).
        host.set_enabled("dummy", true, &tx).unwrap();
        assert!(
            tokio::time::timeout(Duration::from_millis(200), rx.recv())
                .await
                .is_err(),
            "re-enabling a running source must not restart it"
        );
    }

    #[tokio::test]
    async fn set_enabled_unknown_id_errors() {
        let mut host = SignalSourceHost::new();
        host.register(Box::new(DummySource));
        let (tx, _rx) = mpsc::channel::<SignalEvent>(4);
        let err = host.set_enabled("nope", false, &tx).unwrap_err();
        assert!(
            err.contains("nope"),
            "error names the unknown plugin: {err}"
        );
    }

    #[tokio::test]
    async fn disabling_a_not_running_source_is_a_noop() {
        // Disable a source that was never started (registered but
        // start_with not called). The "remove a running handle" branch
        // is skipped — no clear event, no panic.
        let mut host = SignalSourceHost::new();
        host.register(Box::new(DummySource));
        let (tx, mut rx) = mpsc::channel::<SignalEvent>(4);
        host.set_enabled("dummy", false, &tx).unwrap();
        assert!(!host.statuses()[0].enabled);
        assert!(rx.try_recv().is_err(), "nothing to clear, nothing pushed");
    }

    #[tokio::test]
    async fn default_on_disabled_clears_nothing() {
        // A source that uses the trait's default `on_disabled` pushes no
        // clearing event when disabled.
        let mut host = SignalSourceHost::new();
        host.register(Box::new(QuietSource));
        let (tx, mut rx) = mpsc::channel::<SignalEvent>(4);
        host.start_with(&HashMap::new(), tx.clone());
        host.set_enabled("quiet", false, &tx).unwrap();
        assert!(
            rx.try_recv().is_err(),
            "default on_disabled must not push a clearing event"
        );
    }

    #[tokio::test]
    async fn log_join_result_handles_ok_cancel_and_panic() {
        // Drive each arm with a real `JoinError` from tokio, so the
        // supervisor's branch logic is covered deterministically rather
        // than through a spawned task gated on a sleep.
        log_join_result("ok", tokio::spawn(async {}).await);

        let cancelled = tokio::spawn(std::future::pending::<()>());
        cancelled.abort();
        let result = cancelled.await;
        assert!(result.as_ref().is_err_and(|e| e.is_cancelled()));
        log_join_result("cancel", result);

        let panicked = tokio::spawn(async { panic!("source exploded") }).await;
        assert!(panicked.as_ref().is_err_and(|e| e.is_panic()));
        log_join_result("boom", panicked);
    }
}
