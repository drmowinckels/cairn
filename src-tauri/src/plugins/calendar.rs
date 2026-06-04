//! The calendar signal-source plugin (#111).
//!
//! Wraps the existing [`CalendarRegistry`] behind the [`SignalSource`]
//! boundary. Calendar qualifies as a plugin on two counts: it is
//! optional (not everyone uses it), and it is networked (ICS fetch) +
//! secrets-bearing (keychain) — the one core subsystem that opens a
//! network/secrets hole. Its manifest declares both so the privacy UI
//! can surface them. See `docs/PLUGINS.md` and `docs/PRIVACY.md`.
//!
//! This wrapper is the first step of the extraction: core still
//! compiles in the calendar code, but it now starts through the plugin
//! host rather than a bespoke `spawn_*`. Moving `signals/calendar/*`
//! and keychain ownership fully behind the boundary is later work in
//! the #111 stack.

use std::sync::Arc;

use tokio::sync::mpsc;

use crate::plugins::{spawn_supervised, Capability, PluginManifest, SignalSource, SourceHandle};
use crate::signals::calendar::CalendarRegistry;
use crate::signals::stream::{self, SignalEvent, CALENDAR_TICK_INTERVAL};

static MANIFEST: PluginManifest = PluginManifest {
    id: "calendar",
    name: "Calendar",
    capabilities: &[Capability::Network, Capability::Secrets],
};

pub struct CalendarPlugin {
    registry: Arc<CalendarRegistry>,
}

impl CalendarPlugin {
    pub fn new(registry: Arc<CalendarRegistry>) -> Self {
        Self { registry }
    }
}

impl SignalSource for CalendarPlugin {
    fn manifest(&self) -> &PluginManifest {
        &MANIFEST
    }

    fn start(&self, tx: mpsc::Sender<SignalEvent>) -> SourceHandle {
        spawn_supervised(
            MANIFEST.id,
            stream::calendar_source(tx, self.registry.clone(), CALENDAR_TICK_INTERVAL),
        )
    }

    fn on_disabled(&self, tx: &mpsc::Sender<SignalEvent>) {
        // The source was just aborted, so its last-pushed events are
        // frozen in the driver's `LiveState` and there is NO future tick
        // to clear them. Deliver one empty event reliably so a disabled
        // calendar clears from every future snapshot instead of leaving
        // ghost meetings that rules keep matching. `try_send` would drop
        // the clear under a full channel — and nothing would re-send it
        // — so spawn a tiny task that `await`s capacity. Ordering holds:
        // any non-empty event the source already enqueued sits ahead of
        // this empty one, so the driver still settles on empty.
        let tx = tx.clone();
        tokio::spawn(async move {
            let _ = tx.send(SignalEvent::Calendar(vec![])).await;
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::test_db;

    #[tokio::test]
    async fn manifest_declares_network_and_secrets() {
        let (_dir, db) = test_db().await;
        let registry = Arc::new(CalendarRegistry::new(db.pool.clone()).expect("registry builds"));
        let plugin = CalendarPlugin::new(registry);
        let m = plugin.manifest();
        assert_eq!(m.id, "calendar");
        assert!(
            m.capabilities.contains(&Capability::Network),
            "calendar fetches ICS"
        );
        assert!(
            m.capabilities.contains(&Capability::Secrets),
            "calendar stores feed tokens in the keychain"
        );
        assert_eq!(m.capabilities.len(), 2, "no undeclared capabilities");
    }

    #[tokio::test]
    async fn start_pushes_calendar_events_through_the_channel() {
        let (_dir, db) = test_db().await;
        let registry = Arc::new(CalendarRegistry::new(db.pool.clone()).expect("registry builds"));
        let plugin = CalendarPlugin::new(registry);
        let (tx, mut rx) = mpsc::channel::<SignalEvent>(4);

        let handle = plugin.start(tx);

        // A fresh registry has no sources, so the first tick pushes an
        // empty calendar event through the boundary.
        let ev = tokio::time::timeout(std::time::Duration::from_secs(1), rx.recv())
            .await
            .expect("calendar plugin pushes within timeout")
            .expect("channel open");
        assert!(matches!(ev, SignalEvent::Calendar(ref e) if e.is_empty()));

        handle.stop();
    }

    #[tokio::test]
    async fn on_disabled_pushes_an_empty_clearing_event() {
        let (_dir, db) = test_db().await;
        let registry = Arc::new(CalendarRegistry::new(db.pool.clone()).expect("registry builds"));
        let plugin = CalendarPlugin::new(registry);
        let (tx, mut rx) = mpsc::channel::<SignalEvent>(4);

        plugin.on_disabled(&tx);

        // Delivery is via a spawned task that awaits channel capacity.
        let ev = tokio::time::timeout(std::time::Duration::from_secs(1), rx.recv())
            .await
            .expect("on_disabled pushed a clearing event")
            .expect("channel open");
        assert!(
            matches!(ev, SignalEvent::Calendar(ref e) if e.is_empty()),
            "disabling calendar must clear it from the snapshot"
        );
    }
}
