//! Fan-out from the snapshot stream to consumers:
//!  - Tauri events `signal:snapshot` and `signal:match`, consumed by
//!    the suggestion banner (#6) and the Live Signals card.
//!  - Rules-engine evaluation against the rules currently in the DB.
//!
//! Kept separate from `stream.rs` so the stream itself can stay
//! pure-tokio (DB + Tauri free) and remain unit-testable on every
//! platform. The pure projection helpers here (`project_rules`,
//! `outcome_for`) are independently testable; the async loop that
//! wires DB + AppHandle is exercised by integration tests gated off
//! Windows (same constraint as `tauri::test::mock_app`).

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
    let rule_match = crate::rules::evaluate(rules, &snapshot);
    MatchOutcome {
        rule_match,
        snapshot,
    }
}

/// Load every rule from the DB, in priority order, in the IPC
/// shape. Used by the fan-out task on each snapshot tick. Kept
/// parallel to `ipc::list_rules` (which is gated behind a Tauri
/// `State`) so the fan-out loop can run without a `State`.
async fn load_rules(pool: &SqlitePool) -> Vec<crate::ipc::Rule> {
    let rows = match sqlx::query(
        "SELECT id, name, enabled, priority, body FROM rules ORDER BY priority ASC",
    )
    .fetch_all(pool)
    .await
    {
        Ok(rows) => rows,
        Err(e) => {
            log::warn!("fanout: rules query failed: {e}");
            return Vec::new();
        }
    };
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
    out
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
    pool: SqlitePool,
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
        let rules = load_rules(&pool).await;
        let parsed = project_rules(rules);
        let outcome = outcome_for(snap, &parsed);
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
pub async fn run_idle_resume<R: Runtime>(
    mut rx: broadcast::Receiver<IdleResume>,
    app: AppHandle<R>,
) {
    loop {
        match rx.recv().await {
            Ok(resume) => {
                if let Err(e) = app.emit_to(POPOVER_LABEL, EVENT_IDLE_RESUME, &resume) {
                    log::debug!("fanout: emit_to {POPOVER_LABEL} {EVENT_IDLE_RESUME} failed: {e}");
                }
            }
            Err(broadcast::error::RecvError::Closed) => return,
            Err(broadcast::error::RecvError::Lagged(skipped)) => {
                // Capacity-bounded — a slow subscriber dropped
                // `skipped` events. Log so an idle-modal that
                // looks "missed" has a paper trail.
                log::warn!("fanout: idle-resume lagged, missed {skipped} events");
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
        let rules = load_rules(&db.pool).await;
        assert_eq!(rules.len(), 2);
        assert_eq!(rules[0].id, "early");
        assert_eq!(rules[1].id, "late");
    }

    #[cfg(not(target_os = "windows"))]
    #[tokio::test]
    async fn load_rules_returns_empty_on_fresh_db() {
        let (_dir, db) = crate::test_support::test_db().await;
        let rules = load_rules(&db.pool).await;
        assert!(rules.is_empty());
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
        let (_dir, _app, db) = crate::test_support::mock_app_with_db().await;
        let (tx, rx) = watch::channel::<Option<SignalSnapshot>>(None);
        let app = _app.handle().clone();
        let pool = db.pool.clone();
        let task = tokio::spawn(async move { run(rx, pool, app).await });

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
}
