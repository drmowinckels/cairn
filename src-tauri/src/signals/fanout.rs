//! Fan-out from the snapshot stream to consumers:
//!  - Tauri events `signal:snapshot` and `signal:match`, consumed by
//!    the suggestion banner (#6) and the Live Signals card.
//!  - Rules-engine evaluation against the engine-shape rules cached
//!    in `AppState.rules_cache` (loaded once at startup, refreshed
//!    by `save_rule` / `delete_rule` IPC mutators — see issue #55).
//!
//! Kept separate from `stream.rs` so the stream itself can stay
//! pure-tokio (DB + Tauri free) and remain unit-testable on every
//! platform. The pure projection helpers here (`project_rules`,
//! `outcome_for`) are independently testable; the async loop that
//! wires the rules-cache + AppHandle is exercised by integration tests
//! gated off Windows (same constraint as `tauri::test::mock_app`).

use serde::{Deserialize, Serialize};
use sqlx::Row;
use sqlx::SqlitePool;
use tauri::{AppHandle, Emitter, Runtime};
use tokio::sync::{broadcast, watch};

use crate::rules::{Condition, Confidence, Rule, RuleAction, RuleMatch, SignalSnapshot};
use crate::signals::stream::IdleResume;

/// Tauri window label the fan-out task targets when emitting
/// events. The popover is the only window today; using `emit_to`
/// instead of `emit` prevents the snapshot payload (which carries
/// `window_title` from the OS) from being broadcast to any future
/// window that doesn't strictly need it. See the security review
/// notes on PR #5.
pub const POPOVER_LABEL: &str = "popover";

/// Window label for the idle-time prompt (#93). Shown centered +
/// focused when the user returns from an idle period.
pub const IDLE_LABEL: &str = "idle";

/// Event name fired on every published snapshot. The Live Signals
/// card in Rules subscribes here.
pub const EVENT_SNAPSHOT: &str = "signal:snapshot";

/// Event name fired when a snapshot produces a rule match. The
/// suggestion banner (#6) listens here.
pub const EVENT_MATCH: &str = "signal:match";

/// Event name fired when the user resumes from an idle period. The
/// Today view's idle-modal (#7) listens here.
pub const EVENT_IDLE_RESUME: &str = "signal:idle-resume";

/// Payload for the `signal:match` event. The UI needs both the
/// matched rule's projection (project + tags) AND the snapshot that
/// triggered it, so the user understands *why* the banner fired.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MatchOutcome {
    /// The matched rule's projection — `None` when no rule matched.
    pub rule_match: Option<RuleMatch>,
    /// The snapshot that produced the match.
    pub snapshot: SignalSnapshot,
}

/// The shape stored in the `rules.body` SQL column. The IPC
/// `Rule.body` is left as `serde_json::Value` for storage round-
/// tripping; this struct is how the rules engine reads it.
#[derive(Debug, Clone, Deserialize)]
struct RuleBody {
    #[serde(default)]
    confidence: Confidence,
    /// Per `docs/RULES_ENGINE.md` §4 + #16. `serde(default)` so older
    /// body JSON rows persisted before this field existed deserialize
    /// cleanly to `Prompt` — never silently changes a rule's behavior
    /// on app upgrade.
    #[serde(default, rename = "ambiguityBehavior")]
    ambiguity_behavior: crate::rules::AmbiguityBehavior,
    #[serde(default)]
    when: Vec<Condition>,
    then: RuleAction,
}

/// Project IPC-shaped rules (with raw JSON body) into rules-engine
/// shaped rules (with parsed `when` + `then`). Rules whose body
/// can't be deserialised are dropped silently — they're already
/// broken in the DB, and the suggestion banner is the wrong place
/// to surface a schema error.
pub fn project_rules(rules: Vec<crate::ipc::Rule>) -> Vec<Rule> {
    rules
        .into_iter()
        .filter_map(|r| match serde_json::from_value::<RuleBody>(r.body) {
            Ok(body) => Some(Rule {
                id: r.id,
                name: r.name,
                enabled: r.enabled,
                priority: r.priority,
                confidence: body.confidence,
                ambiguity_behavior: body.ambiguity_behavior,
                when: body.when,
                then: body.then,
            }),
            Err(e) => {
                // Log the rule_id but NOT the body — body strings
                // can carry user-entered project names / window-
                // title regex patterns that may include PII.
                log::warn!("fanout: rule {} body invalid, dropping: {e}", r.id);
                None
            }
        })
        .collect()
}

/// Evaluate a snapshot against a list of rules and build the
/// outcome the fan-out task emits. Pure — no IO, no Tauri.
pub fn outcome_for(snapshot: SignalSnapshot, rules: &[Rule]) -> MatchOutcome {
    outcome_for_with_snoozer(snapshot, rules, None)
}

/// Same as `outcome_for` but consults a snoozer first. Rules that
/// are currently snoozed (per-rule or globally) are skipped, which
/// is what the production fanout uses on every snapshot publish.
pub fn outcome_for_with_snoozer(
    snapshot: SignalSnapshot,
    rules: &[Rule],
    snoozer: Option<&mut crate::rules::Snoozer>,
) -> MatchOutcome {
    outcome_for_full(snapshot, rules, snoozer, None)
}

/// Superset path: snoozer + attendee-exclusion filter. The
/// production fanout supplies both so `tags_from_calendar`
/// attendees pass through the user's exclusion list before
/// reaching the published `signal:match` payload.
pub fn outcome_for_full(
    snapshot: SignalSnapshot,
    rules: &[Rule],
    snoozer: Option<&mut crate::rules::Snoozer>,
    attendee_filter: Option<&dyn crate::rules::AttendeeExclusionCheck>,
) -> MatchOutcome {
    let rule_match = crate::rules::evaluate_full(
        rules,
        &snapshot,
        snoozer,
        attendee_filter,
        chrono::Utc::now(),
    );
    MatchOutcome {
        rule_match,
        snapshot,
    }
}

/// One-shot load of the rules table in the engine shape. Used at
/// startup (`lib.rs::setup`) and by IPC mutators
/// (`save_rule` / `delete_rule`) to refresh the
/// `AppState.rules_cache` after a write. The fanout itself never
/// calls this — it reads the cache instead, per issue #55.
///
/// Returns `Err` on SQL failure so callers can distinguish
/// "no rules" from "the query failed and we don't actually know
/// what's in the table." Critical for `reload_rules`: writing an
/// empty `Vec` to the cache on a transient `SQLITE_BUSY` would
/// silently disable every rule until the next mutator runs.
pub async fn load_engine_rules(pool: &SqlitePool) -> Result<Vec<Rule>, sqlx::Error> {
    let ipc_rules = load_rules(pool).await?;
    Ok(project_rules(ipc_rules))
}

/// Load every rule from the DB, in priority order, in the IPC
/// shape. Returns `Err` on SQL failure; rows whose `body` column
/// can't be parsed as JSON are dropped (with a warn-log keyed by
/// `rule_id` — body strings can carry user-entered patterns that
/// may include PII so we never log them).
///
/// `pub(crate)` so other backend tasks can reuse the same query +
/// parse logic instead of duplicating.
pub(crate) async fn load_rules(pool: &SqlitePool) -> Result<Vec<crate::ipc::Rule>, sqlx::Error> {
    let rows =
        sqlx::query("SELECT id, name, enabled, priority, body FROM rules ORDER BY priority ASC")
            .fetch_all(pool)
            .await?;
    let mut out = Vec::with_capacity(rows.len());
    for r in rows {
        let id: String = r.get("id");
        let body_str: String = r.get("body");
        let body: serde_json::Value = match serde_json::from_str(&body_str) {
            Ok(v) => v,
            Err(e) => {
                // Intentionally do NOT log `body_str` — it can
                // carry user-entered project names / window-title
                // regex patterns that may include PII. The rule_id
                // is enough for the user to locate the broken row.
                log::warn!("fanout: rule {id} body unparseable, dropping: {e}");
                continue;
            }
        };
        out.push(crate::ipc::Rule {
            id,
            name: r.get("name"),
            enabled: r.get::<i64, _>("enabled") != 0,
            priority: r.get("priority"),
            body,
        });
    }
    Ok(out)
}

/// Run the fan-out loop. Exits cleanly when the upstream
/// `watch::Sender` is dropped (driver shutdown).
///
/// The initial `None` value held by the watch channel is consumed
/// via `borrow_and_update` so we don't fire `signal:match` for
/// "no rules + no snapshot" on startup. The loop then waits for
/// `changed()` and processes every `Some(snapshot)` publish.
///
/// Events are emitted via `emit_to(POPOVER_LABEL, …)` rather than
/// the global `emit(…)` to prevent the snapshot payload (which
/// carries `window_title` from the OS) from being broadcast to any
/// future window that doesn't strictly need it. See the security
/// review on PR #5.
pub async fn run<R: Runtime>(
    mut rx: watch::Receiver<Option<SignalSnapshot>>,
    rules_cache: std::sync::Arc<std::sync::RwLock<Vec<Rule>>>,
    snoozer: std::sync::Arc<std::sync::Mutex<crate::rules::Snoozer>>,
    exclusions: std::sync::Arc<std::sync::RwLock<crate::signals::exclusions::ExclusionMatcher>>,
    app: AppHandle<R>,
) {
    let _ = rx.borrow_and_update();
    while rx.changed().await.is_ok() {
        let Some(snap) = rx.borrow_and_update().clone() else {
            // A `None` after `changed()` shouldn't happen — the
            // driver only ever transitions None→Some — but be
            // defensive.
            continue;
        };
        // Snapshot the rules cache into a local clone so the read-
        // lock is released before any subsequent locking. Cache is
        // refreshed by `ipc::save_rule` / `ipc::delete_rule` after
        // each write (see issue #55).
        let parsed: Vec<Rule> = match rules_cache.read() {
            Ok(guard) => guard.clone(),
            Err(_) => {
                // Lock poisoned (panic inside a mutator). Fall back
                // to the empty-rules path so the matcher still runs
                // — emitting `signal:snapshot` is more useful than
                // dropping the tick.
                log::warn!("fanout: rules cache lock poisoned, evaluating against empty rules");
                Vec::new()
            }
        };
        // Snapshot the exclusion matcher into a local clone so the
        // read-lock is released before we acquire the snoozer mutex
        // (avoids deadlock potential if a future refactor mixes lock
        // orderings, and decouples the matcher's borrow lifetime).
        let exclusions_snapshot = match exclusions.read() {
            Ok(guard) => Some(guard.clone()),
            Err(_) => {
                log::warn!("fanout: exclusions lock poisoned, attendee filter disabled");
                None
            }
        };
        let attendee_filter = exclusions_snapshot
            .as_ref()
            .map(|m| m as &dyn crate::rules::AttendeeExclusionCheck);
        let outcome = match snoozer.lock() {
            Ok(mut guard) => outcome_for_full(snap, &parsed, Some(&mut *guard), attendee_filter),
            Err(_) => {
                // Lock poisoned (panic inside a previous IPC). Fall
                // back to the no-snooze path so the matcher still
                // runs — dropping every match would be a worse UX
                // than the (unlikely) chance of firing a snoozed
                // rule for one cycle until the next snooze write
                // replaces the lock state. Attendee filter still
                // applies — that's privacy, not UX.
                log::warn!("fanout: snoozer lock poisoned, evaluating without snooze gate");
                outcome_for_full(snap, &parsed, None, attendee_filter)
            }
        };
        if let Err(e) = app.emit_to(POPOVER_LABEL, EVENT_SNAPSHOT, &outcome.snapshot) {
            log::debug!("fanout: emit_to {POPOVER_LABEL} {EVENT_SNAPSHOT} failed: {e}");
        }
        if let Some(rule_match) = &outcome.rule_match {
            if let Err(e) = app.emit_to(POPOVER_LABEL, EVENT_MATCH, rule_match) {
                log::debug!("fanout: emit_to {POPOVER_LABEL} {EVENT_MATCH} failed: {e}");
            }
        }
    }
}

/// Sibling of `run` for idle-resume events. The stream's broadcast
/// channel fires one `IdleResume` per `Idle → Active` transition;
/// this task re-emits each as `signal:idle-resume` to the popover
/// window. Exits cleanly when every clone of the broadcast sender
/// has been dropped (driver shutdown).
/// True iff some entry is currently open (`ended_at IS NULL`) — i.e. a
/// timer is running. On a query error we fail safe and return false so
/// the idle prompt is suppressed rather than shown spuriously.
pub(crate) async fn running_entry_exists(pool: &SqlitePool) -> bool {
    match sqlx::query("SELECT 1 FROM entries WHERE ended_at IS NULL LIMIT 1")
        .fetch_optional(pool)
        .await
    {
        Ok(row) => row.is_some(),
        Err(e) => {
            log::warn!("fanout: running-entry check failed: {e}; suppressing idle prompt");
            false
        }
    }
}

pub async fn run_idle_resume<R: Runtime>(
    mut rx: broadcast::Receiver<IdleResume>,
    app: AppHandle<R>,
) {
    loop {
        match rx.recv().await {
            Ok(resume) => {
                use tauri::Manager;
                // Only prompt if a timer was running through the idle
                // period (#93 follow-up). The timer keeps running across
                // idle, so a still-open entry on return means the user
                // was tracking work; if nothing is running they weren't
                // working, and there's no idle time to attribute — skip.
                // Borrow of `state` is scoped to this match so it is not
                // held across the later window/emit work + re-fetch.
                let has_running = match app.try_state::<crate::AppState>() {
                    Some(state) => running_entry_exists(&state.db.pool).await,
                    None => {
                        log::warn!("fanout: AppState unavailable; idle prompt skipped");
                        false
                    }
                };
                if !has_running {
                    log::debug!("fanout: idle resume but no running timer; skipping idle prompt");
                    continue;
                }
                // Present the dedicated idle prompt window (#93),
                // centered + focused so it lands where the user's
                // attention is on return.
                if let Some(win) = app.get_webview_window(IDLE_LABEL) {
                    use tauri_plugin_positioner::{Position, WindowExt};
                    let _ = win.move_window(Position::Center);
                    let _ = win.show();
                    let _ = win.set_focus();
                } else {
                    log::warn!("fanout: idle window missing; idle prompt not shown");
                }
                if let Err(e) = app.emit_to(IDLE_LABEL, EVENT_IDLE_RESUME, &resume) {
                    log::debug!("fanout: emit_to {IDLE_LABEL} {EVENT_IDLE_RESUME} failed: {e}");
                }
                // Stash for the cold-start race: the window's webview
                // may not be listening yet on the first show, so it
                // fetches this via `pending_idle` on mount.
                if let Some(state) = app.try_state::<crate::AppState>() {
                    if let Ok(mut guard) = state.last_idle.lock() {
                        *guard = Some(resume);
                    }
                }
            }
            Err(broadcast::error::RecvError::Closed) => return,
            Err(broadcast::error::RecvError::Lagged(skipped)) => {
                // Capacity-bounded — a slow subscriber dropped
                // `skipped` events. Usually because the popover
                // was hidden while idle resumes fired; not
                // interesting enough to warn-log every time.
                log::debug!("fanout: idle-resume lagged, missed {skipped} events");
            }
        }
    }
}

// -----------------------------------------------------------------
// Tests
// -----------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rules::{CalendarEvent, Op};
    use serde_json::json;

    fn snap_with_app(app: &str) -> SignalSnapshot {
        SignalSnapshot {
            ide_folder: None,
            git_branch: None,
            window_title: None,
            app_name: Some(app.to_string()),
            browser_domain: None,
            calendar: Vec::new(),
        }
    }

    fn rule_matching_app(id: &str, app: &str, project: &str) -> crate::ipc::Rule {
        crate::ipc::Rule {
            id: id.to_string(),
            name: format!("rule-{id}"),
            enabled: true,
            priority: 10,
            body: json!({
                "when": [{
                    "signal": "app.name",
                    "op": "equals",
                    "value": app,
                }],
                "then": { "project": project, "tags": [], "tagsFromCalendar": false }
            }),
        }
    }

    #[test]
    fn project_rules_drops_unparsable_body() {
        let good = rule_matching_app("good", "Cairn", "cairn");
        let bad = crate::ipc::Rule {
            id: "bad".to_string(),
            name: "rule-bad".to_string(),
            enabled: true,
            priority: 20,
            body: json!({"this": "is not a rule body"}),
        };
        let parsed = project_rules(vec![good, bad]);
        assert_eq!(parsed.len(), 1, "bad body dropped, good rule retained");
        assert_eq!(parsed[0].id, "good");
    }

    #[test]
    fn project_rules_preserves_when_then_shape() {
        let parsed = project_rules(vec![rule_matching_app("r1", "Cairn", "cairn")]);
        assert_eq!(parsed.len(), 1);
        assert_eq!(parsed[0].when.len(), 1);
        assert!(matches!(
            &parsed[0].when[0],
            Condition::AppName { op: Op::Equals, value, any: false } if value == "Cairn"
        ));
        assert_eq!(parsed[0].then.project.as_deref(), Some("cairn"));
    }

    #[test]
    fn outcome_for_returns_match_when_rule_fires() {
        let rules = project_rules(vec![rule_matching_app("r1", "Cairn", "cairn")]);
        let outcome = outcome_for(snap_with_app("Cairn"), &rules);
        let m = outcome
            .rule_match
            .expect("rule fires for matching app_name");
        assert_eq!(m.rule_id, "r1");
        assert_eq!(m.project.as_deref(), Some("cairn"));
        assert_eq!(outcome.snapshot.app_name.as_deref(), Some("Cairn"));
    }

    #[test]
    fn outcome_for_returns_none_when_no_rule_fires() {
        let rules = project_rules(vec![rule_matching_app("r1", "Cairn", "cairn")]);
        let outcome = outcome_for(snap_with_app("Other"), &rules);
        assert!(outcome.rule_match.is_none());
        // Snapshot is always echoed regardless of match.
        assert_eq!(outcome.snapshot.app_name.as_deref(), Some("Other"));
    }

    #[test]
    fn outcome_for_handles_empty_rule_set() {
        let outcome = outcome_for(snap_with_app("Anything"), &[]);
        assert!(outcome.rule_match.is_none());
    }

    #[test]
    fn outcome_for_echoes_calendar_events_in_snapshot() {
        let mut snap = snap_with_app("Cairn");
        snap.calendar.push(CalendarEvent {
            title: "Stand-up".into(),
            source_label: "Work".into(),
            attendees: vec![],
            all_day: false,
        });
        let outcome = outcome_for(snap, &[]);
        assert_eq!(outcome.snapshot.calendar.len(), 1);
        assert_eq!(outcome.snapshot.calendar[0].title, "Stand-up");
    }

    // ---- DB-backed test: load_rules round-trips IPC rules --------

    #[cfg(not(target_os = "windows"))]
    #[tokio::test]
    async fn load_rules_returns_rules_in_priority_order() {
        let (_dir, db) = crate::test_support::test_db().await;
        // Insert two rules out of priority order — load_rules must
        // return them sorted ASC by priority.
        for (id, prio) in [("late", 50i64), ("early", 10i64)] {
            let body = json!({
                "when": [],
                "then": { "project": "p", "tags": [], "tagsFromCalendar": false }
            });
            sqlx::query(
                "INSERT INTO rules (id, name, enabled, priority, body, created_at, updated_at) \
                 VALUES (?1, ?2, 1, ?3, ?4, ?5, ?5)",
            )
            .bind(id)
            .bind(format!("rule-{id}"))
            .bind(prio)
            .bind(body.to_string())
            .bind(chrono::Utc::now().to_rfc3339())
            .execute(&db.pool)
            .await
            .unwrap();
        }
        let rules = load_rules(&db.pool).await.expect("load_rules ok");
        assert_eq!(rules.len(), 2);
        assert_eq!(rules[0].id, "early");
        assert_eq!(rules[1].id, "late");
    }

    #[cfg(not(target_os = "windows"))]
    #[tokio::test]
    async fn load_rules_returns_empty_on_fresh_db() {
        let (_dir, db) = crate::test_support::test_db().await;
        let rules = load_rules(&db.pool).await.expect("load_rules ok");
        assert!(rules.is_empty());
    }

    #[cfg(not(target_os = "windows"))]
    #[tokio::test]
    async fn load_rules_errors_when_pool_is_closed() {
        // Pin the regression that the round-1 review caught: previously
        // `load_rules` swallowed SQL errors and returned `Vec::new()`,
        // which `reload_rules` would happily write into the cache —
        // silently disabling every rule on a transient `SQLITE_BUSY`.
        // Now SQL failures bubble; the caller decides what to do.
        let (_dir, db) = crate::test_support::test_db().await;
        db.pool.close().await;
        let res = load_rules(&db.pool).await;
        assert!(
            res.is_err(),
            "load_rules must return Err on SQL failure so reload_rules \
             can keep the cache intact instead of blanking it",
        );
    }

    // ---- Integration test: full run() loop via mock_app ----------

    #[cfg(not(target_os = "windows"))]
    #[tokio::test]
    async fn run_processes_publishes_until_sender_drops() {
        // Cover the `run()` async loop body. Drive the watch channel
        // directly so we don't depend on the snapshot-stream driver
        // being in scope; the contract we're pinning here is "every
        // Some(snapshot) the channel receives goes through the
        // load_rules → outcome_for → emit_to pipeline, and the loop
        // exits cleanly when the sender drops".
        let (_dir, _app, _db) = crate::test_support::mock_app_with_db().await;
        let (tx, rx) = watch::channel::<Option<SignalSnapshot>>(None);
        let app = _app.handle().clone();
        let rules_cache = std::sync::Arc::new(std::sync::RwLock::new(Vec::<Rule>::new()));
        let snoozer = std::sync::Arc::new(std::sync::Mutex::new(crate::rules::Snoozer::new()));
        let exclusions = std::sync::Arc::new(std::sync::RwLock::new(
            crate::signals::exclusions::ExclusionMatcher::default(),
        ));
        let task =
            tokio::spawn(async move { run(rx, rules_cache, snoozer, exclusions, app).await });

        // Push one real snapshot — drives one iteration of the loop.
        tx.send(Some(snap_with_app("Cairn"))).unwrap();
        // Push a second snapshot — exercises the `changed()` path
        // re-entering the loop.
        tx.send(Some(snap_with_app("Other"))).unwrap();

        // Give the loop a moment to run.
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;

        // Dropping the sender closes the channel; run() exits.
        drop(tx);

        // The task should complete promptly — if `run()` failed to
        // exit on channel close, this would time out.
        tokio::time::timeout(std::time::Duration::from_secs(2), task)
            .await
            .expect("run() exits on sender drop")
            .expect("run() task joined cleanly");
    }

    #[cfg(not(target_os = "windows"))]
    #[tokio::test]
    async fn run_does_not_touch_db_pool() {
        // Pin issue #55's contract: the fanout evaluates against
        // `rules_cache`, never the DB. To prove it, close the DB
        // pool *before* starting the fanout — if `run()` were still
        // querying the rules table on every tick, the closed-pool
        // error would surface in the logs and the loop would
        // either panic or never reach `emit_to`. The loop must
        // continue to process snapshots cleanly and exit on
        // sender drop.
        let (_dir, _app, db) = crate::test_support::mock_app_with_db().await;
        // Insert a rule into the DB *and* the cache. With the cache
        // wired correctly, only the cached projection is used.
        let rules_cache = std::sync::Arc::new(std::sync::RwLock::new(project_rules(vec![
            rule_matching_app("cached", "Cached", "from-cache"),
        ])));
        // Close the DB pool — any subsequent SQL would error.
        db.pool.close().await;

        let (tx, rx) = watch::channel::<Option<SignalSnapshot>>(None);
        let app_handle = _app.handle().clone();
        let snoozer = std::sync::Arc::new(std::sync::Mutex::new(crate::rules::Snoozer::new()));
        let exclusions = std::sync::Arc::new(std::sync::RwLock::new(
            crate::signals::exclusions::ExclusionMatcher::default(),
        ));
        let task =
            tokio::spawn(
                async move { run(rx, rules_cache, snoozer, exclusions, app_handle).await },
            );

        // Drive the loop through several iterations — with the pool
        // closed, any per-tick DB read would now fail visibly.
        for app in ["Cached", "Other", "Cached"] {
            tx.send(Some(snap_with_app(app))).unwrap();
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        drop(tx);
        tokio::time::timeout(std::time::Duration::from_secs(2), task)
            .await
            .expect("run() exits on sender drop even with closed pool")
            .expect("run() task joined cleanly");
    }

    #[tokio::test]
    async fn running_entry_exists_reflects_open_entries() {
        let (_dir, db) = crate::test_support::test_db().await;
        // Fresh DB seeds projects but no entries → nothing running.
        assert!(!running_entry_exists(&db.pool).await);

        let now = chrono::Utc::now().to_rfc3339();
        sqlx::query(
            "INSERT INTO entries (id, project_id, task_id, description, started_at, ended_at, source, created_at, updated_at) \
             VALUES ('e-open', NULL, NULL, '', ?1, NULL, 'manual', ?1, ?1)",
        )
        .bind(&now)
        .execute(&db.pool)
        .await
        .unwrap();
        assert!(running_entry_exists(&db.pool).await, "open entry → running");

        // Close it — no longer running.
        sqlx::query("UPDATE entries SET ended_at = ?1 WHERE id = 'e-open'")
            .bind(&now)
            .execute(&db.pool)
            .await
            .unwrap();
        assert!(
            !running_entry_exists(&db.pool).await,
            "closed entry → not running"
        );
    }
}
