//! Signal collectors. Each submodule owns one signal source. The
//! collectors emit `SignalSnapshot` deltas to the rules engine; no
//! collector writes to the DB and none persists raw values unless the
//! debug "capture raw signals" toggle is on (see `docs/PRIVACY.md`).
//!
//! The collectors ship ahead of the snapshot stream that consumes them
//! (M1). `#![allow(dead_code)]` keeps `cargo clippy --all-targets -- -D
//! warnings` happy until then.
#![allow(dead_code)]

pub mod browser;
pub mod browser_extension;
pub mod calendar;
pub mod calendar_autostop;
pub mod capture;
pub mod exclusions;
pub mod fanout;
pub mod git;
pub mod git_watcher;
pub mod ide;
pub mod idle;
pub mod snapshot;
pub mod stream;
pub mod window;
