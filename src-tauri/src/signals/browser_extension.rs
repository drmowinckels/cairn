//! Browser-extension liveness tracker.
//!
//! The browser collector itself lands in M7 — it speaks to a thin
//! browser-shipped helper over a local IPC socket. Until then this
//! module is the public surface the rest of the app talks to: a tiny
//! in-memory ledger of "we last heard from the extension at T" that
//! the Settings → Integrations card consumes. M7 just calls
//! [`BrowserExtensionState::record_heartbeat`].

use chrono::{DateTime, Duration, Utc};
use serde::Serialize;
use std::sync::Mutex;

/// How recent a heartbeat has to be to count as "connected".
pub const CONNECTED_WINDOW_SECS: i64 = 60;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BrowserExtensionStatus {
    pub connected: bool,
    pub last_seen: Option<DateTime<Utc>>,
    pub browser_label: Option<String>,
}

#[derive(Default)]
pub struct BrowserExtensionState {
    inner: Mutex<Inner>,
}

#[derive(Default, Debug, Clone)]
struct Inner {
    last_seen: Option<DateTime<Utc>>,
    browser_label: Option<String>,
}

impl BrowserExtensionState {
    pub fn new() -> Self {
        Self::default()
    }

    /// Called by the browser collector each time it receives a push
    /// from the extension. Recording a `None` label clears the label
    /// (e.g. extension disconnected explicitly).
    #[allow(dead_code)] // wired in by M7's collector
    pub fn record_heartbeat(&self, browser_label: Option<String>, at: DateTime<Utc>) {
        let mut guard = self.inner.lock().expect("browser-extension lock");
        guard.last_seen = Some(at);
        if browser_label.is_some() {
            guard.browser_label = browser_label;
        }
    }

    pub fn snapshot(&self, now: DateTime<Utc>) -> BrowserExtensionStatus {
        let guard = self.inner.lock().expect("browser-extension lock");
        let last_seen = guard.last_seen;
        let connected = match last_seen {
            Some(t) => now.signed_duration_since(t) <= Duration::seconds(CONNECTED_WINDOW_SECS),
            None => false,
        };
        BrowserExtensionStatus {
            connected,
            last_seen,
            browser_label: guard.browser_label.clone(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    fn t(secs: i64) -> DateTime<Utc> {
        Utc.timestamp_opt(secs, 0).unwrap()
    }

    #[test]
    fn empty_state_is_disconnected() {
        let s = BrowserExtensionState::new();
        let snap = s.snapshot(t(100));
        assert!(!snap.connected);
        assert!(snap.last_seen.is_none());
        assert!(snap.browser_label.is_none());
    }

    #[test]
    fn fresh_heartbeat_is_connected() {
        let s = BrowserExtensionState::new();
        s.record_heartbeat(Some("Safari".into()), t(100));
        let snap = s.snapshot(t(110));
        assert!(snap.connected);
        assert_eq!(snap.last_seen, Some(t(100)));
        assert_eq!(snap.browser_label.as_deref(), Some("Safari"));
    }

    #[test]
    fn stale_heartbeat_is_disconnected() {
        let s = BrowserExtensionState::new();
        s.record_heartbeat(Some("Firefox".into()), t(100));
        let snap = s.snapshot(t(100 + CONNECTED_WINDOW_SECS + 1));
        assert!(!snap.connected);
        assert_eq!(snap.last_seen, Some(t(100)));
        assert_eq!(snap.browser_label.as_deref(), Some("Firefox"));
    }

    #[test]
    fn heartbeat_at_exact_window_boundary_counts_as_connected() {
        let s = BrowserExtensionState::new();
        s.record_heartbeat(None, t(100));
        let snap = s.snapshot(t(100 + CONNECTED_WINDOW_SECS));
        assert!(snap.connected);
    }

    #[test]
    fn empty_label_does_not_clobber_existing() {
        let s = BrowserExtensionState::new();
        s.record_heartbeat(Some("Safari".into()), t(100));
        s.record_heartbeat(None, t(110));
        let snap = s.snapshot(t(115));
        assert_eq!(snap.browser_label.as_deref(), Some("Safari"));
    }
}
