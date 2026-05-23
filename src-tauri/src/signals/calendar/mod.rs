//! Calendar signal collector.
//!
//! Reads VEVENTs from user-registered ICS sources (subscription URLs from
//! Google Calendar / iCloud / Outlook / Fastmail, or local files) and
//! holds the *currently active* events in memory for the rules engine.
//!
//! Privacy:
//! - Event titles, attendees, descriptions live in memory only; they are
//!   never persisted by Cairn. They are evaluated against rules and then
//!   replaced by the next fetch.
//! - Fetches go only to URLs the user explicitly added.
//! - URL secrets (Google's secret-address tokens etc.) live in the OS
//!   keychain, not in the SQLite store.

pub mod fetcher;
pub mod parser;
pub mod registry;
pub mod secrets;
pub mod store;

pub use parser::ActiveEvent;
pub use registry::{CalendarKind, CalendarRegistry, CalendarSource, SyncStatus};
