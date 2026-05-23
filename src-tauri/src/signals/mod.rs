//! Signal collectors. Each submodule owns one signal source. The
//! collectors emit `SignalSnapshot` deltas to the rules engine; no
//! collector writes to the DB and none persists raw values unless the
//! debug "capture raw signals" toggle is on (see `docs/PRIVACY.md`).
//!
//! The collectors ship ahead of the snapshot stream that consumes them
//! (M1). `#![allow(dead_code)]` keeps `cargo clippy --all-targets -- -D
//! warnings` happy until then.
#![allow(dead_code)]

pub mod idle;
pub mod window;
