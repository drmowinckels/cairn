//! Plugin host (in-process, compiled-in). See `docs/PLUGINS.md`.
//!
//! A plugin is an optional / networked / secrets-bearing / paid
//! capability that core never links on its always-on path. v1 wires up
//! one kind: the **signal source**, which feeds the rules engine via
//! the same [`SignalEvent`] channel the core collectors use — so the
//! driver can't tell a plugin's events from a core one's. Calendar is
//! the first signal-source plugin (#111).
//!
//! This is the host's first slice: it registers and starts sources and
//! exposes their manifests. Per-source enable/disable (and the handle
//! plumbing to stop a running source) lands with the settings UI later
//! in the #111 stack; `Capability::Paid` lands with billing (#109).

pub mod calendar;

use tokio::sync::mpsc;

use crate::signals::stream::SignalEvent;

/// A capability a plugin declares in its manifest. The host and the
/// settings UI read these to keep the privacy contract enforceable — a
/// plugin may only use a capability it names. See `docs/PRIVACY.md`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
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

impl PluginManifest {
    pub fn has_capability(&self, cap: Capability) -> bool {
        self.capabilities.contains(&cap)
    }
}

/// A source of signals that feed the rules engine. Origin-agnostic:
/// the driver folds a plugin's `SignalEvent`s into the snapshot exactly
/// as it does a core collector's. See `docs/PLUGINS.md`.
pub trait SignalSource: Send + Sync {
    fn manifest(&self) -> &PluginManifest;

    /// Spawn the source's task(s), pushing `SignalEvent`s through `tx`
    /// (drop-on-full, never blocking the driver) and exiting when `tx`
    /// closes. Must be called from within a tokio runtime.
    fn start(&self, tx: mpsc::Sender<SignalEvent>);
}

/// Registry of opt-in signal-source plugins. Core's always-on sources
/// (window · git · idle) are not registered here — they need no
/// manifest. The host owns lifecycle: register, expose manifests to the
/// UI, and start the registered set against the stream.
#[derive(Default)]
pub struct SignalSourceHost {
    sources: Vec<Box<dyn SignalSource>>,
}

impl SignalSourceHost {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn register(&mut self, source: Box<dyn SignalSource>) {
        self.sources.push(source);
    }

    /// Every registered plugin's manifest, for the settings UI and the
    /// startup transparency log.
    pub fn manifests(&self) -> Vec<&PluginManifest> {
        self.sources.iter().map(|s| s.manifest()).collect()
    }

    /// Start every registered source against the stream's sender. Must
    /// be called from within a tokio runtime.
    pub fn start_all(&self, tx: mpsc::Sender<SignalEvent>) {
        for source in &self.sources {
            source.start(tx.clone());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    static TEST_MANIFEST: PluginManifest = PluginManifest {
        id: "test-src",
        name: "Test Source",
        capabilities: &[Capability::Network],
    };

    /// A signal source that pushes a single empty `Calendar` event when
    /// started, so the host wiring is exercised without real OS signals.
    struct DummySource;
    impl SignalSource for DummySource {
        fn manifest(&self) -> &PluginManifest {
            &TEST_MANIFEST
        }
        fn start(&self, tx: mpsc::Sender<SignalEvent>) {
            tokio::spawn(async move {
                let _ = tx.send(SignalEvent::Calendar(vec![])).await;
            });
        }
    }

    #[test]
    fn manifest_capability_lookup() {
        assert!(TEST_MANIFEST.has_capability(Capability::Network));
        assert!(!TEST_MANIFEST.has_capability(Capability::Secrets));
    }

    #[test]
    fn empty_host_has_no_manifests() {
        let host = SignalSourceHost::new();
        assert!(host.manifests().is_empty());
    }

    #[test]
    fn register_exposes_manifest() {
        let mut host = SignalSourceHost::new();
        host.register(Box::new(DummySource));
        let manifests = host.manifests();
        assert_eq!(manifests.len(), 1);
        assert_eq!(manifests[0].id, "test-src");
        assert!(manifests[0].has_capability(Capability::Network));
    }

    #[tokio::test]
    async fn start_all_runs_each_registered_source() {
        let mut host = SignalSourceHost::new();
        host.register(Box::new(DummySource));
        let (tx, mut rx) = mpsc::channel::<SignalEvent>(4);
        host.start_all(tx);

        // The source pushed its event through the host-provided sender.
        let ev = tokio::time::timeout(std::time::Duration::from_secs(1), rx.recv())
            .await
            .expect("source pushed within timeout")
            .expect("channel open");
        assert!(matches!(ev, SignalEvent::Calendar(ref e) if e.is_empty()));
    }
}
