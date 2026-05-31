//! Pure decision logic for Cairn's proactive prompts (issues #99, #105).
//!
//! Cairn occasionally wants to *offer* something to the user without being
//! asked: "you're idle during your working hours — start tracking?" (#99),
//! or later "this looks like a different task — switch?" (#105). Both must
//! obey the same two guards so the app never nags:
//!
//! 1. **A working-hours window.** Only prompt inside the user's configured
//!    hours. Outside the window (and when the feature is disabled) we stay
//!    silent. This is the quiet-hours mechanism the triage on #99/#105 asks
//!    for.
//! 2. **A rate limit.** Never prompt more often than every `throttle_minutes`.
//!
//! This module is intentionally **pure** — no clock, no I/O, no Tauri. The
//! caller passes `now`, the last-prompt time, and the current activity
//! signals; [`PromptSchedule::decide`] returns a [`PromptDecision`]. #99 is
//! the first caller (idle → offer-to-start); #105 will reuse the same
//! [`PromptSchedule`] with its own caller-supplied "trigger" signal.
//!
//! #99 drives the actual prompt from the frontend (where the prompt UI and
//! its localStorage config live) via the TS mirror of this module
//! (`src/lib/prompt-scheduler.ts`). This Rust module is the canonical,
//! exhaustively-tested reference and the in-process engine #105 will consume
//! when the rule-switch prompt moves its decision backend-side. Until that
//! caller lands, `decide`/`idle_trigger` are exercised only by the unit
//! tests — same "ships ahead of its consumer" pattern as `signals/mod.rs`.
#![allow(dead_code)]

use serde::Deserialize;

/// Minutes in a day, used to validate the working-hours window.
const MINUTES_PER_DAY: u32 = 24 * 60;

/// User-configured working-hours window plus the throttle. Mirrors the
/// frontend `WorkingHours` pref (see `src/lib/use-working-hours.ts`); the
/// frontend owns persistence (localStorage) and forwards the active config
/// when it asks the scheduler to decide.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptSchedule {
    /// Master switch. Off by default — Cairn must not nag out of the box.
    pub enabled: bool,
    /// Window start as minutes since local midnight (`0..=1439`).
    pub start_minute: u32,
    /// Window end as minutes since local midnight (`1..=1440`). Exclusive.
    pub end_minute: u32,
    /// Don't prompt more than once per this many minutes.
    pub throttle_minutes: u32,
}

impl Default for PromptSchedule {
    fn default() -> Self {
        Self::off()
    }
}

/// Why the scheduler decided not to prompt (or that it would). Surfaced so
/// callers and tests can assert the *reason*, not just the boolean — and so
/// a future debug overlay can explain "we stayed quiet because …".
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PromptDecision {
    /// All guards passed: the caller may show its prompt.
    Prompt,
    /// The feature is switched off.
    Disabled,
    /// The local time is outside the configured working-hours window.
    OutsideWindow,
    /// The caller's trigger condition isn't met (e.g. not idle, or a timer
    /// is already running). The caller decides what "triggered" means.
    NotTriggered,
    /// We prompted too recently; the throttle is still cooling down.
    Throttled,
}

impl PromptDecision {
    /// Convenience for the common "may I prompt?" question.
    pub fn should_prompt(self) -> bool {
        matches!(self, PromptDecision::Prompt)
    }
}

impl PromptSchedule {
    /// A disabled schedule with a sensible default window (09:00–17:00) and a
    /// 30-minute throttle. Used as the default so that *if* the user flips the
    /// switch on they get reasonable hours without further configuration.
    pub const fn off() -> Self {
        Self {
            enabled: false,
            start_minute: 9 * 60,
            end_minute: 17 * 60,
            throttle_minutes: 30,
        }
    }

    /// Clamp the config into a coherent state: a valid window and a throttle
    /// of at least one minute. Tolerates malformed input (e.g. a deserialized
    /// config with `start >= end`) by collapsing it to the closed/empty case
    /// so [`Self::in_window`] never panics and never spuriously matches.
    fn normalized(self) -> Self {
        let start = self.start_minute.min(MINUTES_PER_DAY);
        let end = self.end_minute.min(MINUTES_PER_DAY);
        Self {
            enabled: self.enabled,
            start_minute: start,
            end_minute: end,
            throttle_minutes: self.throttle_minutes.max(1),
        }
    }

    /// Is `minute_of_day` inside the working-hours window? The window is
    /// half-open `[start, end)`. A non-positive-width window (start >= end,
    /// including the all-zero malformed case) is treated as empty: never in
    /// window. Same-day windows only — overnight shifts are out of scope for
    /// v1 (documented follow-up).
    fn in_window(&self, minute_of_day: u32) -> bool {
        self.start_minute < self.end_minute
            && minute_of_day >= self.start_minute
            && minute_of_day < self.end_minute
    }

    /// Decide whether a proactive prompt may fire right now.
    ///
    /// - `minute_of_day`: local time as minutes since midnight (`0..=1439`).
    /// - `now_ms` / `last_prompt_ms`: wall-clock millis for the throttle.
    ///   `last_prompt_ms == None` means "never prompted".
    /// - `triggered`: the caller's condition. For #99 this is
    ///   "user is idle past the threshold AND no timer is running".
    ///
    /// The guards are evaluated in a fixed priority so the returned
    /// [`PromptDecision`] is the single most relevant reason: disabled →
    /// outside window → not triggered → throttled → prompt.
    pub fn decide(
        &self,
        minute_of_day: u32,
        now_ms: i64,
        last_prompt_ms: Option<i64>,
        triggered: bool,
    ) -> PromptDecision {
        let cfg = self.normalized();
        if !cfg.enabled {
            return PromptDecision::Disabled;
        }
        if !cfg.in_window(minute_of_day) {
            return PromptDecision::OutsideWindow;
        }
        if !triggered {
            return PromptDecision::NotTriggered;
        }
        if let Some(last) = last_prompt_ms {
            let elapsed_ms = now_ms.saturating_sub(last);
            let throttle_ms = cfg.throttle_minutes as i64 * 60_000;
            // A future or equal last-prompt time (clock skew) is treated as
            // "just prompted" — stay quiet rather than risk double-prompting.
            if elapsed_ms < throttle_ms {
                return PromptDecision::Throttled;
            }
        }
        PromptDecision::Prompt
    }
}

/// Caller-side helper for the #99 idle trigger: the user is "idle enough" to
/// offer tracking only when the OS reports an idle duration past the
/// threshold **and** no timer is currently running. Kept here (pure) so the
/// trigger rule is unit-tested alongside the scheduler rather than buried in
/// the frontend hook.
///
/// `idle_seconds == None` means the host can't report idle (permission
/// denied / unsupported) — treated as "not idle" so we never prompt blind.
pub fn idle_trigger(idle_seconds: Option<u64>, threshold_seconds: u64, is_tracking: bool) -> bool {
    if is_tracking {
        return false;
    }
    match idle_seconds {
        Some(secs) => secs >= threshold_seconds,
        None => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn on() -> PromptSchedule {
        PromptSchedule {
            enabled: true,
            start_minute: 9 * 60,
            end_minute: 17 * 60,
            throttle_minutes: 30,
        }
    }

    const NOON: u32 = 12 * 60;
    const MIN_MS: i64 = 60_000;

    #[test]
    fn default_is_off_with_sane_window() {
        let d = PromptSchedule::default();
        assert!(!d.enabled);
        assert_eq!(d.start_minute, 9 * 60);
        assert_eq!(d.end_minute, 17 * 60);
        assert_eq!(d.throttle_minutes, 30);
        assert_eq!(PromptSchedule::off(), d);
    }

    #[test]
    fn disabled_never_prompts_even_when_triggered_in_window() {
        let cfg = PromptSchedule {
            enabled: false,
            ..on()
        };
        assert_eq!(cfg.decide(NOON, 0, None, true), PromptDecision::Disabled);
    }

    #[test]
    fn outside_window_does_not_prompt() {
        let cfg = on();
        // Before start.
        assert_eq!(
            cfg.decide(8 * 60, 0, None, true),
            PromptDecision::OutsideWindow
        );
        // Exactly at end is exclusive.
        assert_eq!(
            cfg.decide(17 * 60, 0, None, true),
            PromptDecision::OutsideWindow
        );
        // After end.
        assert_eq!(
            cfg.decide(20 * 60, 0, None, true),
            PromptDecision::OutsideWindow
        );
    }

    #[test]
    fn window_boundaries_are_half_open() {
        let cfg = on();
        // Start is inclusive and triggered → prompt.
        assert_eq!(cfg.decide(9 * 60, 0, None, true), PromptDecision::Prompt);
        // One minute before end is still in.
        assert_eq!(
            cfg.decide(17 * 60 - 1, 0, None, true),
            PromptDecision::Prompt
        );
    }

    #[test]
    fn not_triggered_in_window_does_not_prompt() {
        let cfg = on();
        assert_eq!(
            cfg.decide(NOON, 0, None, false),
            PromptDecision::NotTriggered
        );
    }

    #[test]
    fn prompts_when_enabled_in_window_triggered_and_never_prompted() {
        assert_eq!(on().decide(NOON, 0, None, true), PromptDecision::Prompt);
    }

    #[test]
    fn throttled_when_within_rate_limit() {
        let cfg = on();
        let last = 1_000_000;
        // 29 minutes after last prompt: still cooling down (throttle 30).
        let now = last + 29 * MIN_MS;
        assert_eq!(
            cfg.decide(NOON, now, Some(last), true),
            PromptDecision::Throttled
        );
    }

    #[test]
    fn prompts_again_once_past_rate_limit() {
        let cfg = on();
        let last = 1_000_000;
        // Exactly 30 minutes later: throttle elapsed → prompt.
        let now = last + 30 * MIN_MS;
        assert_eq!(
            cfg.decide(NOON, now, Some(last), true),
            PromptDecision::Prompt
        );
    }

    #[test]
    fn clock_skew_last_prompt_in_future_stays_quiet() {
        let cfg = on();
        let now = 1_000_000;
        let last = now + 5 * MIN_MS;
        assert_eq!(
            cfg.decide(NOON, now, Some(last), true),
            PromptDecision::Throttled
        );
    }

    #[test]
    fn malformed_inverted_window_never_matches() {
        let cfg = PromptSchedule {
            enabled: true,
            start_minute: 17 * 60,
            end_minute: 9 * 60,
            throttle_minutes: 30,
        };
        assert_eq!(
            cfg.decide(NOON, 0, None, true),
            PromptDecision::OutsideWindow
        );
    }

    #[test]
    fn zero_throttle_is_clamped_to_one_minute() {
        let cfg = PromptSchedule {
            throttle_minutes: 0,
            ..on()
        };
        let last = 1_000_000;
        // 30s after last prompt with a clamped 1-minute throttle: throttled.
        assert_eq!(
            cfg.decide(NOON, last + 30_000, Some(last), true),
            PromptDecision::Throttled
        );
        // 1 minute later: allowed.
        assert_eq!(
            cfg.decide(NOON, last + MIN_MS, Some(last), true),
            PromptDecision::Prompt
        );
    }

    #[test]
    fn out_of_range_minutes_are_clamped_not_panicking() {
        let cfg = PromptSchedule {
            enabled: true,
            start_minute: 5_000,
            end_minute: 9_000,
            throttle_minutes: 30,
        };
        // Both clamp to MINUTES_PER_DAY → empty window → never in window.
        assert_eq!(
            cfg.decide(NOON, 0, None, true),
            PromptDecision::OutsideWindow
        );
    }

    #[test]
    fn decision_should_prompt_helper() {
        assert!(PromptDecision::Prompt.should_prompt());
        assert!(!PromptDecision::Disabled.should_prompt());
        assert!(!PromptDecision::OutsideWindow.should_prompt());
        assert!(!PromptDecision::NotTriggered.should_prompt());
        assert!(!PromptDecision::Throttled.should_prompt());
    }

    #[test]
    fn idle_trigger_requires_idle_past_threshold_and_no_timer() {
        assert!(idle_trigger(Some(300), 300, false));
        assert!(idle_trigger(Some(600), 300, false));
        // Below threshold.
        assert!(!idle_trigger(Some(299), 300, false));
        // Tracking → never triggered, even if very idle.
        assert!(!idle_trigger(Some(999), 300, true));
        // Host can't report idle → not triggered.
        assert!(!idle_trigger(None, 300, false));
    }

    #[test]
    fn deserializes_from_camelcase_json() {
        let parsed: PromptSchedule = serde_json::from_str(
            r#"{"enabled":true,"startMinute":540,"endMinute":1020,"throttleMinutes":30}"#,
        )
        .unwrap();
        assert_eq!(parsed, on());
    }
}
