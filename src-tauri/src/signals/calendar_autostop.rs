//! Calendar auto-stop scheduler.
//!
//! When a Strict rule whose `when` includes a `calendar.event`
//! condition auto-starts a timer at the start of a meeting, the
//! timer needs to *stop* at the meeting's end too — unless the
//! user manually overrode it. Per M1 #10's acceptance criteria.
//!
//! This task wakes on a slow interval, queries every running
//! `source = "rule"` entry, and checks whether the rule that
//! started it still matches a currently-active calendar event. If
//! the rule no longer fires AND the entry hasn't been touched
//! since creation, the task closes it.
//!
//! ## Manual override detection
//!
//! Every entry carries `created_at` and `updated_at`. `start_entry`
//! writes both to "now" at creation. `update_entry` pushes
//! `updated_at` forward on any field change. So
//! `updated_at > created_at + tolerance` ⇒ "user touched it" ⇒
//! skip auto-stop. The tolerance handles the within-the-second
//! created/updated equality from `start_entry`'s own write.
//!
//! ## Why not in the snapshot stream's fanout
//!
//! The fanout already evaluates rules on every snapshot publish
//! (~2 Hz under load). Auto-stop is a write path and is intentionally
//! slower — once per `AUTOSTOP_INTERVAL` is plenty for a feature
//! whose granularity is meetings (typically ≥ 15 min).

use chrono::{DateTime, Duration, Utc};
use sqlx::{Row, SqlitePool};
use std::sync::Arc;

use crate::rules::{evaluate, Confidence, Rule, SignalSnapshot};
// `Confidence` is used by `should_auto_stop`'s Strict gate.
use crate::signals::calendar::CalendarRegistry;

/// How often the auto-stop task wakes. Meetings are minute-grained
/// so 30s is plenty; aligning with the calendar tick keeps the
/// task footprint predictable.
pub const AUTOSTOP_INTERVAL: std::time::Duration = std::time::Duration::from_secs(30);

/// `updated_at - created_at` tolerance for "the user has not
/// touched this entry." A single `start_entry` transaction writes
/// both timestamps to the same `now_str` so the immediate diff
/// after creation is zero. The 2s slop absorbs a *fast user* who
/// races to type into the description / change the project within
/// a couple of seconds of confirm — without this, those edits
/// would silently disable auto-stop.
///
/// Sufficient-but-not-correct: the proper fix is an explicit
/// `auto_stop_eligible` column on entries flipped by any
/// `update_entry` write or "Stop" click. Tracked for a follow-up
/// with the rest of the entry-schema cleanup.
const TOUCH_TOLERANCE_SECS: i64 = 2;

/// A snapshot of a running entry the auto-stop task considers.
/// Pulled from the `entries` table; only the fields needed for
/// the should-stop decision.
#[derive(Debug, Clone)]
pub struct RunningRuleEntry {
    pub id: String,
    pub rule_id: String,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

/// True iff the auto-stop task should close `entry` now. Pure —
/// no IO, no clock. Tests can construct synthetic entries + rules
/// + active events and assert directly.
///
/// Returns `false` (keep running) when:
/// - the entry's rule_id doesn't match any of the provided rules
///   (e.g. the rule was deleted — leave the entry alone, the user
///   can stop manually);
/// - the rule has no `calendar.event` condition at all (this
///   task only owns calendar-bound stops);
/// - the rule still matches against the current snapshot;
/// - the user has touched the entry (updated_at > created_at + slop).
///
/// Returns `true` only when the rule exists, is calendar-bound,
/// the rule no longer matches the snapshot, AND the entry is
/// pristine.
pub fn should_auto_stop(
    entry: &RunningRuleEntry,
    rules: &[Rule],
    snapshot: &SignalSnapshot,
) -> bool {
    let Some(rule) = rules.iter().find(|r| r.id == entry.rule_id) else {
        // Rule deleted while the entry was running. We don't have
        // enough context to know what the user wants — leave it
        // for manual cleanup.
        return false;
    };
    // Disabling a rule mid-meeting is a perfectly reasonable way
    // to say "keep the timer running past the scheduled end."
    // Without this gate, the auto-stop would fire on the very next
    // tick because `evaluate` skips disabled rules. Respect the
    // user's choice.
    if !rule.enabled {
        return false;
    }
    // Auto-stop is for Strict rules only. Suggestive matches
    // required an explicit Confirm click; treating the resulting
    // entry as "user-tracked until the user stops it" is the
    // conservative default. (Suggestive rules don't even surface
    // here today because the confirm path passes
    // `source = "rule"`, but the entry's lifecycle is the user's
    // call from that point on.)
    if !matches!(rule.confidence, Confidence::Strict) {
        return false;
    }
    // Only calendar-bound rules drive auto-stop. The same task
    // could in principle handle other conditions but the issue
    // is scoped to calendar.
    let has_cal_cond = rule
        .when
        .iter()
        .any(|c| matches!(c, crate::rules::Condition::CalendarEvent { .. }));
    if !has_cal_cond {
        return false;
    }
    // Manual-override gate: any `update_entry` past creation
    // pushes `updated_at` forward; treat anything beyond the
    // tolerance as user activity. The tolerance window
    // (`TOUCH_TOLERANCE_SECS`) absorbs the same-transaction
    // `created_at == updated_at` write from `start_entry` plus a
    // small slop for a user racing to type a description.
    let touch_window = Duration::seconds(TOUCH_TOLERANCE_SECS);
    if entry.updated_at - entry.created_at > touch_window {
        return false;
    }
    // Auto-stop iff the rule no longer matches against the live
    // snapshot. Use the simple `evaluate` rather than the snoozer
    // variant — snooze affects *new* matches, not whether to stop
    // an already-running entry. A single-rule iterator means
    // `evaluate` returning `Some` is unambiguous; just check
    // is_some.
    let still_matches = evaluate(std::iter::once(rule), snapshot).is_some();
    !still_matches
}

/// Query the DB for every running rule-driven entry. Used by the
/// auto-stop loop's check phase; returns `Vec` rather than a stream
/// because the result set is small (one open entry per active
/// calendar rule).
async fn list_running_rule_entries(pool: &SqlitePool) -> Vec<RunningRuleEntry> {
    let rows = match sqlx::query(
        "SELECT id, rule_id, created_at, updated_at FROM entries \
         WHERE ended_at IS NULL AND source = 'rule' AND rule_id IS NOT NULL",
    )
    .fetch_all(pool)
    .await
    {
        Ok(rows) => rows,
        Err(e) => {
            log::warn!("calendar-autostop: query failed: {e}");
            return Vec::new();
        }
    };
    rows.into_iter()
        .filter_map(|r| {
            let id: String = r.get("id");
            let rule_id: Option<String> = r.get("rule_id");
            let rule_id = rule_id?;
            let created_at: String = r.get("created_at");
            let updated_at: String = r.get("updated_at");
            let created_at = created_at.parse().ok()?;
            let updated_at = updated_at.parse().ok()?;
            Some(RunningRuleEntry {
                id,
                rule_id,
                created_at,
                updated_at,
            })
        })
        .collect()
}

/// Close `entry_id` at `now`. Used by the auto-stop loop after
/// `should_auto_stop` decides to fire.
///
/// Guards against `ended_at < started_at`: if the wall clock moved
/// backwards between `start_entry` and this tick (NTP correction,
/// sleep/wake on macOS, DST), the `MAX(started_at, ?1)` expression
/// floors `ended_at` at the entry's start so the report layer
/// never sees a negative duration.
async fn close_entry(pool: &SqlitePool, entry_id: &str, now: DateTime<Utc>) {
    let now_str = now.to_rfc3339();
    if let Err(e) = sqlx::query(
        "UPDATE entries SET ended_at = MAX(started_at, ?1), updated_at = ?1 \
         WHERE id = ?2 AND ended_at IS NULL",
    )
    .bind(&now_str)
    .bind(entry_id)
    .execute(pool)
    .await
    {
        log::warn!("calendar-autostop: close {entry_id} failed: {e}");
    }
}

/// Run the auto-stop loop. Wakes every `AUTOSTOP_INTERVAL`, takes
/// a snapshot of running rule-driven entries + the live calendar,
/// and closes anything whose calendar binding has expired and
/// hasn't been touched.
///
/// Exits when the pool is closed; the task is otherwise expected
/// to run until process exit.
///
/// `rules_cache` is the `AppState.rules_cache` snapshot fronted by
/// `Arc<RwLock<_>>`. The task clones the cache contents per-tick;
/// IPC mutators refresh it after writes (see issue #55).
pub async fn run(
    pool: SqlitePool,
    calendar: Arc<CalendarRegistry>,
    rules_cache: Arc<std::sync::RwLock<Vec<Rule>>>,
) {
    let mut ticker = tokio::time::interval(AUTOSTOP_INTERVAL);
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    // Skip the first immediate tick — the app just started; no
    // running entries to auto-stop yet, and we want to avoid
    // racing the lib.rs setup hot path.
    ticker.tick().await;
    loop {
        ticker.tick().await;
        let now = Utc::now();
        let entries = list_running_rule_entries(&pool).await;
        if entries.is_empty() {
            continue;
        }
        // Build a snapshot with the currently-active calendar
        // events; window / git / browser fields are intentionally
        // left empty — the auto-stop decision is calendar-bound
        // by design (filtered to rules with `calendar.event`
        // conditions in `should_auto_stop`).
        let active = calendar.active_events_at(now).await;
        let calendar_events: Vec<_> = active
            .into_iter()
            .map(|a| crate::rules::CalendarEvent {
                title: a.event.summary,
                source_label: a.source_label,
                attendees: a.event.attendees,
                all_day: a.event.all_day,
            })
            .collect();
        let snapshot = SignalSnapshot {
            ide_folder: None,
            git_branch: None,
            window_title: None,
            app_name: None,
            browser_domain: None,
            calendar: calendar_events,
        };

        // Snapshot the rules cache into a local clone so the read
        // lock is released before we do anything `await`-y. Cache
        // is refreshed by IPC mutators (see issue #55).
        let rules: Vec<Rule> = match rules_cache.read() {
            Ok(guard) => guard.clone(),
            Err(_) => {
                log::warn!("calendar-autostop: rules cache lock poisoned, skipping tick");
                continue;
            }
        };

        for entry in entries {
            if should_auto_stop(&entry, &rules, &snapshot) {
                close_entry(&pool, &entry.id, now).await;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rules::{CalendarEvent, Condition, Op, RuleAction};

    fn cal_rule(id: &str) -> Rule {
        Rule {
            id: id.into(),
            name: format!("rule-{id}"),
            enabled: true,
            priority: 0,
            confidence: Confidence::Strict,
            when: vec![Condition::CalendarEvent {
                op: Op::IsActive,
                value: String::new(),
                any: false,
            }],
            then: RuleAction {
                project: Some("meetings".into()),
                tags: vec![],
                tags_from_calendar: false,
                description_template: None,
            },
        }
    }

    fn non_cal_rule(id: &str) -> Rule {
        Rule {
            id: id.into(),
            name: format!("rule-{id}"),
            enabled: true,
            priority: 0,
            confidence: Confidence::Strict,
            when: vec![Condition::AppName {
                op: Op::Equals,
                value: "Zed".into(),
                any: false,
            }],
            then: RuleAction {
                project: Some("cairn".into()),
                tags: vec![],
                tags_from_calendar: false,
                description_template: None,
            },
        }
    }

    fn pristine_entry(rule_id: &str) -> RunningRuleEntry {
        let now = Utc::now();
        RunningRuleEntry {
            id: "e1".into(),
            rule_id: rule_id.into(),
            created_at: now,
            updated_at: now,
        }
    }

    fn snap_with_event(title: &str) -> SignalSnapshot {
        SignalSnapshot {
            ide_folder: None,
            git_branch: None,
            window_title: None,
            app_name: None,
            browser_domain: None,
            calendar: vec![CalendarEvent {
                title: title.into(),
                source_label: "Work".into(),
                attendees: vec![],
                all_day: false,
            }],
        }
    }

    fn empty_snap() -> SignalSnapshot {
        SignalSnapshot {
            ide_folder: None,
            git_branch: None,
            window_title: None,
            app_name: None,
            browser_domain: None,
            calendar: vec![],
        }
    }

    #[test]
    fn stops_when_calendar_rule_no_longer_matches() {
        let rule = cal_rule("r-cal");
        // No active events → rule no longer matches → stop.
        assert!(should_auto_stop(
            &pristine_entry("r-cal"),
            &[rule],
            &empty_snap()
        ));
    }

    #[test]
    fn keeps_running_when_rule_still_matches() {
        let rule = cal_rule("r-cal");
        assert!(!should_auto_stop(
            &pristine_entry("r-cal"),
            &[rule],
            &snap_with_event("Stand-up")
        ));
    }

    #[test]
    fn keeps_running_when_user_touched_the_entry() {
        // Manual override: updated_at is significantly later than
        // created_at. The auto-stop must respect the user's edit.
        let rule = cal_rule("r-cal");
        let entry = RunningRuleEntry {
            id: "e1".into(),
            rule_id: "r-cal".into(),
            created_at: Utc::now() - Duration::minutes(30),
            updated_at: Utc::now() - Duration::minutes(5),
        };
        // No active event → rule wouldn't match → would normally
        // stop. But user touched it, so we leave it.
        assert!(!should_auto_stop(&entry, &[rule], &empty_snap()));
    }

    #[test]
    fn within_tolerance_window_still_treated_as_pristine() {
        // updated_at == created_at + 1s is within the 2s tolerance
        // (sqlx may truncate sub-second precision).
        let rule = cal_rule("r-cal");
        let created = Utc::now() - Duration::minutes(10);
        let entry = RunningRuleEntry {
            id: "e1".into(),
            rule_id: "r-cal".into(),
            created_at: created,
            updated_at: created + Duration::seconds(1),
        };
        assert!(should_auto_stop(&entry, &[rule], &empty_snap()));
    }

    #[test]
    fn does_not_stop_non_calendar_rules() {
        // Auto-stop is calendar-bound by design. A rule with only
        // an `app.name` condition should never get auto-stopped by
        // this task — the user manages app-based rules themselves.
        let rule = non_cal_rule("r-app");
        let snap = SignalSnapshot {
            // App is no longer Zed → rule wouldn't match.
            app_name: Some("Slack".into()),
            ide_folder: None,
            git_branch: None,
            window_title: None,
            browser_domain: None,
            calendar: vec![],
        };
        assert!(!should_auto_stop(&pristine_entry("r-app"), &[rule], &snap));
    }

    #[test]
    fn does_not_stop_when_rule_was_deleted() {
        // If the rule was deleted while the entry was running,
        // we don't know what the user wants. Leave it alone.
        let entry = pristine_entry("r-deleted");
        // No rules in the slice — the rule was deleted.
        assert!(!should_auto_stop(&entry, &[], &empty_snap()));
    }

    #[test]
    fn does_not_stop_suggestive_rules() {
        // Auto-stop is for Strict rules — Suggestive rules require
        // the user's explicit Confirm anyway, so the entry's
        // continued existence is the user's intent. Leave it.
        let mut rule = cal_rule("r-cal");
        rule.confidence = Confidence::Suggestive;
        assert!(!should_auto_stop(
            &pristine_entry("r-cal"),
            &[rule],
            &empty_snap()
        ));
    }

    // ---- New regression tests for the round-2 review fixes ----

    #[test]
    fn does_not_stop_when_rule_is_disabled() {
        // Disabling a rule mid-meeting is a valid way to say
        // "keep the timer running past the scheduled end."
        // Auto-stop must respect that — without this gate the
        // first tick after disable would fire because `evaluate`
        // skips disabled rules and returns `None`.
        let mut rule = cal_rule("r-cal");
        rule.enabled = false;
        // Rule still has calendar.event condition, no event
        // active — without the enabled gate, this would fire.
        assert!(!should_auto_stop(
            &pristine_entry("r-cal"),
            &[rule],
            &empty_snap()
        ));
    }

    #[test]
    fn auto_stops_even_when_rule_is_snoozed() {
        // Snooze affects whether NEW matches surface; it does NOT
        // pin a running entry open. A meeting that ends while the
        // rule is snoozed should still auto-stop.
        let rule = cal_rule("r-cal");
        // No active event → rule wouldn't match the snapshot. The
        // auto-stop path uses `evaluate` (no snoozer) for exactly
        // this reason — pin that it still fires.
        assert!(should_auto_stop(
            &pristine_entry("r-cal"),
            &[rule],
            &empty_snap()
        ));
    }

    // ---- DB-backed: list_running_rule_entries ----

    #[tokio::test]
    async fn list_running_rule_entries_returns_only_source_rule_entries() {
        let (_dir, db) = crate::test_support::test_db().await;
        let now = Utc::now().to_rfc3339();
        // Insert a manual entry (skipped), a rule entry without
        // rule_id (skipped), a rule entry with rule_id (kept), and
        // a closed rule entry (skipped).
        for (id, source, rule_id, ended) in [
            ("e-manual", "manual", None::<&str>, None::<&str>),
            ("e-rule-no-id", "rule", None, None),
            ("e-rule", "rule", Some("r-cal"), None),
            (
                "e-rule-closed",
                "rule",
                Some("r-cal"),
                Some("2026-05-25T15:00:00Z"),
            ),
        ] {
            sqlx::query(
                r#"
                INSERT INTO entries (id, project_id, task_id, description, started_at, ended_at, source, rule_id, created_at, updated_at)
                VALUES (?1, NULL, NULL, '', ?2, ?3, ?4, ?5, ?2, ?2)
                "#,
            )
            .bind(id)
            .bind(&now)
            .bind(ended)
            .bind(source)
            .bind(rule_id)
            .execute(&db.pool)
            .await
            .unwrap();
        }
        let entries = list_running_rule_entries(&db.pool).await;
        let ids: Vec<&str> = entries.iter().map(|e| e.id.as_str()).collect();
        assert_eq!(ids, vec!["e-rule"]);
    }
}
