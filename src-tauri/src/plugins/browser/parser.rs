//! Pure parsing + privacy gating for browser pushes. No IO, no sockets,
//! no locks held across `.await` — every function here is synchronous and
//! unit-tested directly (the `*_impl` / pure-function pattern). The socket
//! shell lives in [`super::listener`].
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
//! Per `docs/PRIVACY.md`, two classes of message MUST be dropped before
//! they reach the snapshot stream:
//!
//! - **Incognito / private** windows (`incognito: true`).
//! - **Unfocused** updates (a "we lost focus" heartbeat).
//!
//! After those drop, the user's [`ExclusionMatcher`] is consulted: a
//! domain on the exclusion list never reaches the stream. Only `domain`
//! survives this boundary — `path` and `title` are intentionally dropped
//! so they can't be persisted or matched against.

use std::sync::{Arc, RwLock};

use chrono::Utc;
use serde::{Deserialize, Serialize};

use crate::signals::browser_extension::BrowserExtensionState;
use crate::signals::exclusions::ExclusionMatcher;

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

/// Decide whether an incoming message contributes a [`BrowserContext`].
/// Returns `None` for messages we must drop (incognito, unfocused, empty
/// domain) per `docs/PRIVACY.md`. Pure — no IO, no locks. The
/// exclusion-list filter is applied by [`handle_message`] because it
/// needs the live `ExclusionMatcher`.
///
/// The domain is **lowercased** at this boundary. RFC 1035 specifies
/// DNS labels as case-insensitive, but the in-memory exclusion matcher
/// does a literal `==` compare (see
/// `signals/exclusions::matches_domain`). Normalising here means an
/// extension that emits `"GitHub.com"` is matched against a `github.com`
/// exclusion — without it, the privacy contract that CLAUDE.md calls
/// non-negotiable would silently leak any domain the browser happens to
/// capitalise.
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
        domain: domain.to_ascii_lowercase(),
    })
}

/// Final-stage gate: project the message through the privacy pipeline +
/// exclusion matcher and (separately) heartbeat the Integrations card.
/// Returns the context to forward to the stream, or `None` if the
/// message must be dropped.
///
/// Synchronous and lock-scoped — exported so the unit tests can exercise
/// the full pipeline without spinning up a real socket.
pub fn handle_message(
    msg: &BrowserMessage,
    exclusions: &Arc<RwLock<ExclusionMatcher>>,
    extension_state: &BrowserExtensionState,
) -> Option<BrowserContext> {
    // Heartbeat fires for EVERY message — including incognito /
    // unfocused — so the Integrations card reflects "the extension is
    // alive" regardless of whether the user is currently producing
    // privacy-sensitive signals.
    extension_state.record_heartbeat(msg.browser_label.clone(), Utc::now());

    let ctx = project_message(msg)?;
    let excluded = match exclusions.read() {
        Ok(guard) => guard.matches_domain(&ctx.domain),
        Err(_) => {
            // Lock poisoned (writer panicked). Fail closed: drop the
            // signal. Mirrors `apply_event`'s policy for window events.
            // The next `save_exclusion` mutator will replace the inner
            // state under a fresh guard.
            log::warn!("browser: exclusions read lock poisoned; dropping browser signal");
            return None;
        }
    };
    if excluded {
        return None;
    }
    Some(ctx)
}

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

    fn matcher_with_excluded_domain(domain: &str) -> Arc<RwLock<ExclusionMatcher>> {
        Arc::new(RwLock::new(ExclusionMatcher::for_test(&[], &[], &[domain])))
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

    #[test]
    fn project_message_lowercases_domain() {
        // An extension emitting `Github.com` must match a `github.com`
        // exclusion. DNS labels are case-insensitive per RFC 1035; the
        // in-memory exclusion matcher does a literal `==`, so we
        // normalise at the boundary or the privacy contract leaks.
        for raw in ["Github.com", "GITHUB.COM", "github.com", "  GitHub.COM  "] {
            let m = msg_with_domain(raw);
            let ctx = project_message(&m).expect("focused non-incognito projects");
            assert_eq!(ctx.domain, "github.com");
        }
    }

    // ---- BrowserMessage serde defaults -----------------------------

    #[test]
    fn browser_message_missing_focused_defaults_to_true() {
        // Older extensions that don't carry the focus flag are treated
        // as foreground (the alternative — defaulting to false — would
        // drop every message they send).
        let raw = r#"{"domain":"github.com"}"#;
        let m: BrowserMessage = serde_json::from_str(raw).unwrap();
        assert!(m.focused);
        assert!(!m.incognito);
        assert_eq!(m.browser_label, None);
    }

    #[test]
    fn browser_message_camel_case_browser_label() {
        // The JS-side field is `browserLabel` (camelCase); serde must
        // accept that, not `browser_label`.
        let raw = r#"{"domain":"x.com","browserLabel":"Chrome 120"}"#;
        let m: BrowserMessage = serde_json::from_str(raw).unwrap();
        assert_eq!(m.browser_label.as_deref(), Some("Chrome 120"));
    }

    // ---- handle_message (with exclusions + heartbeat) --------------

    #[test]
    fn handle_message_records_heartbeat_even_for_dropped_messages() {
        // The extension is alive whenever it sends ANYTHING, even an
        // incognito ping. The Integrations card reflects that.
        let state = BrowserExtensionState::new();
        let mut m = msg_with_domain("github.com");
        m.incognito = true;
        m.browser_label = Some("Chrome 120".into());
        let exc = Arc::new(RwLock::new(ExclusionMatcher::default()));
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
    fn handle_message_lowercases_then_consults_exclusion_list() {
        // End-to-end pin: a mixed-case `GitHub.com` matches a lowercase
        // `github.com` exclusion. Without `to_ascii_lowercase` in
        // `project_message` the matcher misses and the rules engine
        // fires on a domain the user explicitly excluded.
        let exc = matcher_with_excluded_domain("github.com");
        let state = BrowserExtensionState::new();
        let m = msg_with_domain("GitHub.com");
        assert!(handle_message(&m, &exc, &state).is_none());
    }

    #[test]
    fn handle_message_drops_on_poisoned_exclusions_lock() {
        // Poison by spawning a thread that takes the write lock and
        // panics; the matcher read then fails and we fail closed.
        let exc = Arc::new(RwLock::new(ExclusionMatcher::default()));
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
}
