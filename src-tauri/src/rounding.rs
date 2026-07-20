//! Optional time rounding applied at the **display/export layer only** —
//! raw `started_at`/`ended_at` timestamps are never mutated (issue #107).
//!
//! Rounding is per-entry: each entry's duration is rounded to the configured
//! interval before it is summed into a report total or written to CSV. A
//! disabled config (`interval_minutes == 0`) is the identity transform.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum RoundMode {
    #[default]
    Nearest,
    Up,
    Down,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Rounding {
    /// Rounding interval in minutes. `0` disables rounding.
    pub interval_minutes: u32,
    pub mode: RoundMode,
}

/// Deserialise a project row's nullable rounding columns into `Option<Rounding>`.
/// Returns `None` when either column is NULL (inherit global); returns `Some`
/// only when both are present and the mode string is a recognised variant.
pub(crate) fn project_rounding_from_row(row: &sqlx::sqlite::SqliteRow) -> Option<Rounding> {
    use sqlx::Row;
    let minutes: Option<i64> = row.get("rounding_interval_minutes");
    let mode_str: Option<String> = row.get("rounding_mode");
    match (minutes, mode_str) {
        (Some(m), Some(s)) => {
            let mode = match s.as_str() {
                "up" => RoundMode::Up,
                "down" => RoundMode::Down,
                _ => RoundMode::Nearest,
            };
            Some(Rounding {
                interval_minutes: m.max(0) as u32,
                mode,
            })
        }
        _ => None,
    }
}

/// Serialise `Option<Rounding>` into the two nullable DB columns.
/// `None` produces `(None, None)` → NULLs in SQLite (inherit global).
pub(crate) fn rounding_to_columns(r: Option<Rounding>) -> (Option<i64>, Option<String>) {
    match r {
        None => (None, None),
        Some(rounding) => {
            let mode = match rounding.mode {
                RoundMode::Up => "up",
                RoundMode::Down => "down",
                RoundMode::Nearest => "nearest",
            };
            (
                Some(rounding.interval_minutes as i64),
                Some(mode.to_string()),
            )
        }
    }
}

/// Return the effective rounding for a given entry: the project-level override
/// wins when present; falls back to the caller-supplied global otherwise.
///
/// This is the single source of truth for the inheritance rule — report
/// aggregation, CSV export, and any future consumer all call this function
/// rather than re-implementing the fallback logic.
pub fn effective_rounding(project_override: Option<Rounding>, global: Rounding) -> Rounding {
    project_override.unwrap_or(global)
}

impl Default for Rounding {
    fn default() -> Self {
        Self::off()
    }
}

impl Rounding {
    pub const fn off() -> Self {
        Self {
            interval_minutes: 0,
            mode: RoundMode::Nearest,
        }
    }

    /// Round a positive duration in seconds to the configured interval.
    /// Non-positive inputs clamp to `0`; a disabled config returns the
    /// duration unchanged. Note: under `Nearest`/`Down`, a duration shorter
    /// than half/one interval rounds to `0` — standard timesheet behaviour.
    pub fn round_secs(&self, secs: i64) -> i64 {
        let interval = self.interval_minutes as i64 * 60;
        if interval <= 0 || secs <= 0 {
            return secs.max(0);
        }
        let rem = secs % interval;
        if rem == 0 {
            return secs;
        }
        let floor = secs - rem;
        match self.mode {
            RoundMode::Down => floor,
            RoundMode::Up => floor + interval,
            RoundMode::Nearest => {
                if rem * 2 >= interval {
                    floor + interval
                } else {
                    floor
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const M: i64 = 60;

    fn r(interval: u32, mode: RoundMode) -> Rounding {
        Rounding {
            interval_minutes: interval,
            mode,
        }
    }

    #[test]
    fn disabled_is_identity() {
        let off = Rounding::off();
        assert_eq!(off.interval_minutes, 0);
        assert_eq!(off.round_secs(7 * M + 13), 7 * M + 13);
        assert_eq!(Rounding::default().round_secs(7 * M + 13), 7 * M + 13);
    }

    #[test]
    fn non_positive_clamps_to_zero() {
        assert_eq!(r(15, RoundMode::Nearest).round_secs(0), 0);
        assert_eq!(r(15, RoundMode::Nearest).round_secs(-30), 0);
        assert_eq!(Rounding::off().round_secs(-30), 0);
    }

    #[test]
    fn exact_multiples_are_unchanged() {
        for mode in [RoundMode::Nearest, RoundMode::Up, RoundMode::Down] {
            assert_eq!(r(15, mode).round_secs(30 * M), 30 * M);
        }
    }

    #[test]
    fn nearest_rounds_to_closest_with_half_up() {
        let n = r(15, RoundMode::Nearest);
        assert_eq!(n.round_secs(7 * M), 0); // 7 < 7.5 → down
        assert_eq!(n.round_secs(7 * M + 30), 15 * M); // exactly half → up
        assert_eq!(n.round_secs(8 * M), 15 * M);
        assert_eq!(n.round_secs(22 * M), 15 * M); // 22 < 22.5 → down
        assert_eq!(n.round_secs(23 * M), 30 * M);
    }

    #[test]
    fn up_always_ceils_nonexact() {
        let u = r(15, RoundMode::Up);
        assert_eq!(u.round_secs(1), 15 * M);
        assert_eq!(u.round_secs(15 * M + 1), 30 * M);
    }

    #[test]
    fn down_always_floors() {
        let d = r(15, RoundMode::Down);
        assert_eq!(d.round_secs(14 * M + 59), 0);
        assert_eq!(d.round_secs(29 * M), 15 * M);
    }

    #[test]
    fn deserializes_from_camelcase_json() {
        let parsed: Rounding =
            serde_json::from_str(r#"{"intervalMinutes":15,"mode":"up"}"#).unwrap();
        assert_eq!(parsed, r(15, RoundMode::Up));
    }

    #[test]
    fn effective_rounding_prefers_project_override() {
        let global = r(15, RoundMode::Nearest);
        let project = r(5, RoundMode::Up);
        assert_eq!(effective_rounding(Some(project), global), project);
    }

    #[test]
    fn effective_rounding_falls_back_to_global_when_none() {
        let global = r(15, RoundMode::Down);
        assert_eq!(effective_rounding(None, global), global);
    }

    #[test]
    fn effective_rounding_off_project_overrides_active_global() {
        let global = r(15, RoundMode::Nearest);
        let disabled = Rounding::off();
        assert_eq!(effective_rounding(Some(disabled), global), disabled);
    }
}
