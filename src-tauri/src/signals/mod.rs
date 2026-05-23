//! Signal collectors. Each submodule owns one signal source. The
//! collectors emit `SignalSnapshot` deltas to the rules engine; no
//! collector writes to the DB and none persists raw values unless the
//! debug "capture raw signals" toggle is on (see `docs/PRIVACY.md`).

pub mod calendar;
pub mod idle;
pub mod snapshot;
pub mod window;
