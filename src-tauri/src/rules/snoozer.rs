//! Rule-snooze tracker.
//!
//! Suggestion-banner dismissals silence the matching rule for a
//! configurable duration (default 5 min per `docs/RULES_ENGINE.md`
//! §6). The user can also opt to snooze *all* suggestions for a
//! longer window — "1h" / "until tomorrow" — via the banner's
//! overflow menu.
//!
//! This module owns the in-memory map. The data is intentionally
//! NOT persisted across app launches — a fresh launch is a fresh
//! attention budget. The matcher consults [`Snoozer::is_snoozed`]
//! before evaluating any rule against a snapshot.
//!
//! ## Concurrency
//!
//! Held as `Arc<Mutex<Snoozer>>` in `AppState`. The IPC mutators
//! (`snooze_rule`, `snooze_all`, `unsnooze_all`) take the lock
//! briefly; the fanout's evaluate loop also takes the lock per
//! snapshot publish. `std::sync::Mutex` is sufficient — every
//! critical section is bounded by a small map iteration with no
//! `.await` inside.

use chrono::{DateTime, Duration, Utc};
use serde::Serialize;
use std::collections::HashMap;

/// Snooze map. `rules` is per-rule (suppress *this* rule until
/// `expires_at`); `global` is the "snooze everything" override
/// (suppress *every* suggestion until `expires_at` regardless of
/// per-rule state). When both apply, the later expiration wins —
/// per-rule un-snoozing while a global is active still keeps the
/// rule silenced until the global lifts.
#[derive(Debug, Default, Clone)]
pub struct Snoozer {
    rules: HashMap<String, DateTime<Utc>>,
    global: Option<DateTime<Utc>>,
}

/// JSON shape returned by the `list_snoozes` IPC so the UI can
/// render "snoozed until …" indicators on rule rows.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SnoozeSnapshot {
    /// `(rule_id, expiresAt)` pairs that haven't expired yet.
    pub rules: Vec<(String, DateTime<Utc>)>,
    /// The global "snooze all" expiration, or `None` if not active.
    pub global: Option<DateTime<Utc>>,
}

impl Snoozer {
    pub fn new() -> Self {
        Self::default()
    }

    /// True when the given rule should be skipped by the matcher.
    /// Lazily prunes expired entries on every check.
    pub fn is_snoozed(&mut self, rule_id: &str, now: DateTime<Utc>) -> bool {
        if let Some(g) = self.global {
            if g > now {
                return true;
            }
            self.global = None;
        }
        match self.rules.get(rule_id).copied() {
            Some(expires) if expires > now => true,
            Some(_) => {
                self.rules.remove(rule_id);
                false
            }
            None => false,
        }
    }

    /// Per-rule snooze for `duration` from `now`. Replaces any
    /// existing snooze for this rule — the *later* expiration wins
    /// so re-snoozing within an active window can only extend, not
    /// shorten.
    pub fn snooze_rule(&mut self, rule_id: &str, duration: Duration, now: DateTime<Utc>) {
        let new_expiry = now + duration;
        let entry = self.rules.entry(rule_id.to_string()).or_insert(new_expiry);
        if new_expiry > *entry {
            *entry = new_expiry;
        }
    }

    /// Global snooze for `duration` from `now`. Same later-wins
    /// rule as `snooze_rule`.
    pub fn snooze_all(&mut self, duration: Duration, now: DateTime<Utc>) {
        let new_expiry = now + duration;
        match self.global {
            Some(existing) if existing >= new_expiry => {}
            _ => self.global = Some(new_expiry),
        }
    }

    /// Clear every snooze (per-rule + global). Used by the
    /// "un-snooze everything" affordance in Settings.
    pub fn unsnooze_all(&mut self) {
        self.rules.clear();
        self.global = None;
    }

    /// Project the current state into a JSON-friendly snapshot
    /// (un-expired entries only). Used by `list_snoozes` IPC for
    /// the Rules view's "snoozed until …" badges.
    pub fn snapshot(&self, now: DateTime<Utc>) -> SnoozeSnapshot {
        let rules: Vec<(String, DateTime<Utc>)> = self
            .rules
            .iter()
            .filter(|(_, exp)| **exp > now)
            .map(|(k, v)| (k.clone(), *v))
            .collect();
        let global = self.global.filter(|g| *g > now);
        SnoozeSnapshot { rules, global }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn t(secs: i64) -> DateTime<Utc> {
        chrono::DateTime::from_timestamp(secs, 0).unwrap()
    }

    #[test]
    fn fresh_snoozer_silences_nothing() {
        let mut s = Snoozer::new();
        assert!(!s.is_snoozed("r1", t(1000)));
    }

    #[test]
    fn snooze_rule_silences_only_that_rule() {
        let mut s = Snoozer::new();
        s.snooze_rule("r1", Duration::seconds(60), t(1000));
        assert!(s.is_snoozed("r1", t(1030)));
        assert!(!s.is_snoozed("r2", t(1030)));
    }

    #[test]
    fn snooze_rule_expires_after_duration() {
        let mut s = Snoozer::new();
        s.snooze_rule("r1", Duration::seconds(60), t(1000));
        assert!(s.is_snoozed("r1", t(1059)));
        assert!(!s.is_snoozed("r1", t(1061)));
    }

    #[test]
    fn re_snooze_extends_but_does_not_shorten() {
        let mut s = Snoozer::new();
        s.snooze_rule("r1", Duration::seconds(300), t(1000));
        // Re-snooze with a SHORTER duration shouldn't shorten the
        // existing window — the user already chose 5 minutes.
        s.snooze_rule("r1", Duration::seconds(10), t(1000));
        assert!(s.is_snoozed("r1", t(1200)));
    }

    #[test]
    fn re_snooze_with_longer_duration_wins() {
        let mut s = Snoozer::new();
        s.snooze_rule("r1", Duration::seconds(60), t(1000));
        s.snooze_rule("r1", Duration::seconds(3600), t(1010));
        // Original 60s would expire at 1060; new 1h expires at 4610.
        assert!(s.is_snoozed("r1", t(2000)));
    }

    #[test]
    fn snooze_all_silences_every_rule() {
        let mut s = Snoozer::new();
        s.snooze_all(Duration::seconds(3600), t(1000));
        assert!(s.is_snoozed("r1", t(2000)));
        assert!(s.is_snoozed("r2", t(2000)));
        assert!(s.is_snoozed("never-seen-before", t(2000)));
    }

    #[test]
    fn snooze_all_expires_and_unblocks() {
        let mut s = Snoozer::new();
        s.snooze_all(Duration::seconds(60), t(1000));
        assert!(s.is_snoozed("r1", t(1030)));
        assert!(!s.is_snoozed("r1", t(1100)));
    }

    #[test]
    fn unsnooze_all_clears_everything() {
        let mut s = Snoozer::new();
        s.snooze_rule("r1", Duration::seconds(3600), t(1000));
        s.snooze_all(Duration::seconds(3600), t(1000));
        s.unsnooze_all();
        assert!(!s.is_snoozed("r1", t(2000)));
        assert!(!s.is_snoozed("r2", t(2000)));
    }

    #[test]
    fn expired_per_rule_entries_are_pruned_on_check() {
        let mut s = Snoozer::new();
        s.snooze_rule("r1", Duration::seconds(60), t(1000));
        // Past expiry; check prunes.
        s.is_snoozed("r1", t(2000));
        // Snapshot reflects the pruned state.
        let snap = s.snapshot(t(2000));
        assert!(snap.rules.is_empty());
    }

    #[test]
    fn snapshot_excludes_expired_entries() {
        let mut s = Snoozer::new();
        s.snooze_rule("expired", Duration::seconds(1), t(1000));
        s.snooze_rule("active", Duration::seconds(3600), t(1000));
        s.snooze_all(Duration::seconds(1), t(1000));
        let snap = s.snapshot(t(2000));
        assert_eq!(snap.rules.len(), 1);
        assert_eq!(snap.rules[0].0, "active");
        assert!(snap.global.is_none());
    }

    #[test]
    fn global_snooze_keeps_silencing_even_after_per_rule_expires() {
        let mut s = Snoozer::new();
        s.snooze_rule("r1", Duration::seconds(60), t(1000));
        s.snooze_all(Duration::seconds(3600), t(1000));
        // 60s in: both still active.
        assert!(s.is_snoozed("r1", t(1030)));
        // 5 min in: per-rule expired, but global wins.
        assert!(s.is_snoozed("r1", t(1300)));
        // 2 h in: global also expired.
        assert!(!s.is_snoozed("r1", t(8200)));
    }
}
