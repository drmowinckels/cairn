//! Browser signal-source plugin (#37).
//!
//! Lives under `plugins/` — not `signals/` — because browser is an
//! **optional** signal source behind the plugin boundary; see
//! `docs/PLUGINS.md`. Core's always-on collectors (window · git · idle)
//! stay in `signals/`. Unlike calendar, browser is fully local: it only
//! receives the active-tab domain over a per-user loopback socket
//! (`listener`), maps it to a [`BrowserContext`] (`parser`), and feeds
//! the rules engine through the same `SignalEvent::Browser` channel every
//! other source uses. Nothing leaves the machine.
//!
//! Privacy (see `docs/PRIVACY.md`):
//! - Only `domain` survives the collector boundary; tab `path`/`title`
//!   are dropped at the `parser` and never persisted or matched.
//! - Incognito and unfocused pushes are dropped, and the user's
//!   exclusion list is applied **before** any event reaches the engine.
//! - The extension-liveness ledger (`BrowserExtensionState`) is shared
//!   with the Settings → Integrations IPC and stays in `signals/`.
//!
//! The browser extension itself (Safari/Firefox/Chrome) ships separately
//! and is out of scope for this slice — see the #37 follow-ups.

mod listener;
mod parser;
mod plugin;

pub use parser::BrowserContext;
pub use plugin::BrowserPlugin;
