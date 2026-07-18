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

/// Window label for the detection-suggestion notification overlay (#267).
/// Shown at the screen's top-right corner, click-through-until-painted
/// like the idle window, when the "Detection prompts" setting is
/// `"notification"`. Unlike the idle prompt, this window never steals OS
/// focus — it's a dismissible proposal, not a forced choice (see
/// `ipc::notification_window_painted_impl`).
pub const NOTIFY_LABEL: &str = "notify";

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

/// How long an always-on-top overlay window (idle prompt #261, suggestion
/// notification #267) may stay shown without the frontend confirming its
/// webview painted before the watchdog hides it. Generous because the
/// window is click-through until the paint ack lands, so a slow-but-working
/// paint is harmless — only a webview that never renders reaches the
/// timeout, and hiding it beats leaving an invisible, undismissable,
/// always-on-top overlay. Shared by both overlay windows; a future
/// divergence in timeout can split this back into two constants.
pub(crate) const OVERLAY_PAINT_WATCHDOG_TIMEOUT: std::time::Duration =
    std::time::Duration::from_secs(4);

/// Present the idle window safely and arm the paint watchdog (#261).
/// Returns the show generation the watchdog guards, or `None` when app
/// state is unavailable (then nothing is armed). The window is shown
/// click-through (input passes through) and the painted flag is cleared,
/// so a webview that never renders can't trap input; `idle_window_painted`
/// later makes it interactive once it confirms paint.
pub(crate) fn show_idle_with_watchdog<R: Runtime>(
    app: &AppHandle<R>,
    win: &tauri::WebviewWindow<R>,
    timeout: std::time::Duration,
) -> Option<u64> {
    use std::sync::atomic::Ordering::SeqCst;
    use tauri::Manager;

    let _ = win.set_ignore_cursor_events(true);
    // `center()` returns a `Result` (no monitor → `Err`), unlike the
    // positioner's `move_window`, which unwraps the monitor and panics.
    let _ = win.center();
    let _ = win.show();

    let state = app.try_state::<crate::AppState>()?;
    state.idle_painted.store(false, SeqCst);
    let generation = state.idle_show_gen.fetch_add(1, SeqCst) + 1;
    spawn_idle_watchdog(app.clone(), generation, timeout);
    Some(generation)
}

/// Spawn the paint watchdog for a given show generation. Split from its
/// body (`idle_watchdog_task`) so the timing-free decision is unit-tested
/// directly without waiting on the real timeout.
fn spawn_idle_watchdog<R: Runtime>(
    app: AppHandle<R>,
    generation: u64,
    timeout: std::time::Duration,
) {
    tauri::async_runtime::spawn(idle_watchdog_task(app, generation, timeout));
}

async fn idle_watchdog_task<R: Runtime>(
    app: AppHandle<R>,
    generation: u64,
    timeout: std::time::Duration,
) {
    tokio::time::sleep(timeout).await;
    enforce_idle_watchdog(&app, generation);
}

/// Watchdog action after the timeout (#261): if this show is still the
/// current one and the webview never confirmed paint, hide the idle window
/// (and drop its click-through state) so it can't linger as an invisible
/// overlay. Returns whether it hid the window.
pub(crate) fn enforce_idle_watchdog<R: Runtime>(app: &AppHandle<R>, generation: u64) -> bool {
    use std::sync::atomic::Ordering::SeqCst;
    use tauri::Manager;

    let Some(state) = app.try_state::<crate::AppState>() else {
        return false;
    };
    if !overlay_watchdog_should_hide(
        generation,
        state.idle_show_gen.load(SeqCst),
        state.idle_painted.load(SeqCst),
    ) {
        return false;
    }
    let Some(win) = app.get_webview_window(IDLE_LABEL) else {
        return false;
    };
    log::warn!(
        "fanout: idle window never confirmed paint within {OVERLAY_PAINT_WATCHDOG_TIMEOUT:?}; hiding to avoid an invisible input trap (#261)"
    );
    let _ = win.set_ignore_cursor_events(false);
    let _ = win.hide();
    true
}

/// Move `win` to the top-right corner of its current monitor. A deliberate
/// hand-rolled alternative to `tauri_plugin_positioner`'s `Position::TopRight`
/// (used safely elsewhere in this codebase only via native `.center()`):
/// the plugin's `calculate_position` does `window.current_monitor()?.unwrap()`
/// — it panics outright when no monitor is available, which is exactly the
/// `MockRuntime` test environment this codebase's Rust test suite runs
/// under (see `show_idle_with_watchdog`'s own note on why it uses the
/// native `.center()` instead of the plugin for the same reason). This
/// helper mirrors the plugin's top-right math but fails soft: a missing
/// monitor/size query just leaves the window wherever it last was, which
/// only happens under a runtime with no real display.
fn position_top_right<R: Runtime>(win: &tauri::WebviewWindow<R>) {
    let Ok(Some(monitor)) = win.current_monitor() else {
        return;
    };
    let Ok(size) = win.outer_size() else {
        return;
    };
    let screen_pos = monitor.position();
    let screen_size = monitor.size();
    let x = screen_pos.x + (screen_size.width as i32 - size.width as i32);
    let y = screen_pos.y;
    let _ = win.set_position(tauri::PhysicalPosition::new(x, y));
}

/// Present the suggestion-notification window safely and arm its paint
/// watchdog (#267) — the notify window mirrors the idle window's
/// click-through-until-painted hardening (#261/#262) since it is the same
/// kind of foot-gun: a new transparent, always-on-top, undecorated window.
/// Returns the show generation the watchdog guards, or `None` when app
/// state is unavailable. Positioned at the screen's top-right corner via
/// `position_top_right` — see its doc comment for why this isn't the
/// positioner plugin's `Position::TopRight`/`Position::Tray*`.
pub(crate) fn show_notify_with_watchdog<R: Runtime>(
    app: &AppHandle<R>,
    win: &tauri::WebviewWindow<R>,
    timeout: std::time::Duration,
) -> Option<u64> {
    use std::sync::atomic::Ordering::SeqCst;
    use tauri::Manager;

    let _ = win.set_ignore_cursor_events(true);
    position_top_right(win);
    let _ = win.show();

    let state = app.try_state::<crate::AppState>()?;
    state.notify_painted.store(false, SeqCst);
    state.notify_currently_shown.store(true, SeqCst);
    let generation = state.notify_show_gen.fetch_add(1, SeqCst) + 1;
    spawn_notify_watchdog(app.clone(), generation, timeout);
    Some(generation)
}

/// Spawn the notification window's paint watchdog. Split from its body
/// (`notify_watchdog_task`) for the same reason as `spawn_idle_watchdog`:
/// the timing-free decision stays directly unit-testable.
fn spawn_notify_watchdog<R: Runtime>(
    app: AppHandle<R>,
    generation: u64,
    timeout: std::time::Duration,
) {
    tauri::async_runtime::spawn(notify_watchdog_task(app, generation, timeout));
}

async fn notify_watchdog_task<R: Runtime>(
    app: AppHandle<R>,
    generation: u64,
    timeout: std::time::Duration,
) {
    tokio::time::sleep(timeout).await;
    enforce_notify_watchdog(&app, generation);
}

/// Watchdog action after the timeout (#267): if this show is still current
/// and the webview never confirmed paint, hide the notify window (and drop
/// its click-through state) so it can't linger as an invisible overlay.
/// Returns whether it hid the window.
pub(crate) fn enforce_notify_watchdog<R: Runtime>(app: &AppHandle<R>, generation: u64) -> bool {
    use std::sync::atomic::Ordering::SeqCst;
    use tauri::Manager;

    let Some(state) = app.try_state::<crate::AppState>() else {
        return false;
    };
    if !overlay_watchdog_should_hide(
        generation,
        state.notify_show_gen.load(SeqCst),
        state.notify_painted.load(SeqCst),
    ) {
        return false;
    }
    let Some(win) = app.get_webview_window(NOTIFY_LABEL) else {
        return false;
    };
    log::warn!(
        "fanout: notification window never confirmed paint within {OVERLAY_PAINT_WATCHDOG_TIMEOUT:?}; hiding to avoid an invisible input trap (#267)"
    );
    let _ = win.set_ignore_cursor_events(false);
    let _ = win.hide();
    state.notify_currently_shown.store(false, SeqCst);
    true
}

/// Pure decision for the paint watchdog: hide only when this show is still
/// the latest (not superseded by a newer show) and the webview never
/// confirmed paint.
pub(crate) fn overlay_watchdog_should_hide(
    shown_generation: u64,
    current_generation: u64,
    painted: bool,
) -> bool {
    shown_generation == current_generation && !painted
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
                // (The window also re-checks current_running at resolve
                // time — see use-idle-window.ts — to cover the timer being
                // stopped between this show and the user's choice.)
                // Present the dedicated idle prompt window (#93), centered.
                // Shown click-through and unfocused until the frontend
                // confirms paint (#261) so a non-painting webview can't
                // become an invisible input trap; a watchdog hides it if no
                // paint lands. `set_focus` happens in `idle_window_painted`.
                if let Some(win) = app.get_webview_window(IDLE_LABEL) {
                    show_idle_with_watchdog(&app, &win, OVERLAY_PAINT_WATCHDOG_TIMEOUT);
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
    // Only the MockRuntime window tests use these, and those are gated off
    // Windows (see `mock_app_with_db`); keep the imports gated too so the
    // Windows `-D warnings` build doesn't trip on them as unused.
    #[cfg(not(target_os = "windows"))]
    use std::time::Duration;
    #[cfg(not(target_os = "windows"))]
    use tauri::Manager;

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
    fn outcome_for_surfaces_matched_signals_for_evidence_line() {
        // #143: the `signal:match` payload must carry the live signal
        // values that contributed to the match so the suggestion
        // banner can render its "why" chips.
        let rules = project_rules(vec![rule_matching_app("r1", "Cairn", "cairn")]);
        let mut snap = snap_with_app("Cairn");
        snap.git_branch = Some("feat/x".into());
        let outcome = outcome_for(snap, &rules);
        let m = outcome.rule_match.expect("rule fires");
        // Only the app.name condition matched, so only it contributes
        // a chip — the unreferenced git branch does not leak in.
        assert_eq!(
            m.matched_signals,
            vec![crate::rules::MatchedSignal {
                signal: "app.name".into(),
                value: "Cairn".into(),
            }],
        );
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

    #[cfg(not(target_os = "windows"))]
    #[tokio::test]
    async fn run_idle_resume_only_prompts_when_a_timer_is_running() {
        use crate::AppState;
        let (_dir, _app, db) = crate::test_support::mock_app_with_db().await;
        // An idle window so the running-timer path actually presents it
        // (exercising the `Some(win)` arm + watchdog wiring), not just the
        // "window missing" warning.
        let _idle = idle_window(_app.handle()).await;
        let app = _app.handle().clone();
        let (tx, rx) = broadcast::channel::<IdleResume>(8);
        let task = tokio::spawn(async move { run_idle_resume(rx, app).await });

        let now = chrono::Utc::now();
        let resume = IdleResume {
            since: now - chrono::Duration::minutes(10),
            until: now,
            duration_seconds: 600,
        };

        // No running entry → the prompt is skipped; last_idle stays None.
        tx.send(resume.clone()).unwrap();
        tokio::time::sleep(std::time::Duration::from_millis(80)).await;
        assert!(
            _app.try_state::<AppState>()
                .unwrap()
                .last_idle
                .lock()
                .unwrap()
                .is_none(),
            "no running timer → no idle prompt"
        );

        // Open an entry → the prompt proceeds; last_idle is stashed.
        let n = now.to_rfc3339();
        sqlx::query(
            "INSERT INTO entries (id, project_id, task_id, description, started_at, ended_at, source, created_at, updated_at) \
             VALUES ('e-run', NULL, NULL, '', ?1, NULL, 'manual', ?1, ?1)",
        )
        .bind(&n)
        .execute(&db.pool)
        .await
        .unwrap();
        tx.send(resume).unwrap();
        tokio::time::sleep(std::time::Duration::from_millis(80)).await;
        assert!(
            _app.try_state::<AppState>()
                .unwrap()
                .last_idle
                .lock()
                .unwrap()
                .is_some(),
            "running timer → idle prompt presented"
        );

        drop(tx);
        let _ = tokio::time::timeout(std::time::Duration::from_secs(2), task).await;
    }

    // ---- #261: idle-window paint watchdog / click-through-until-painted ----

    #[test]
    fn idle_watchdog_hides_only_when_current_and_unpainted() {
        // Current show, never painted → hide.
        assert!(overlay_watchdog_should_hide(3, 3, false));
        // Current show but painted → leave it (the prompt is up).
        assert!(!overlay_watchdog_should_hide(3, 3, true));
        // Superseded by a newer show → this watchdog is stale, do nothing.
        assert!(!overlay_watchdog_should_hide(2, 3, false));
    }

    #[cfg(not(target_os = "windows"))]
    async fn idle_window<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> tauri::WebviewWindow<R> {
        tauri::WebviewWindowBuilder::new(app, IDLE_LABEL, tauri::WebviewUrl::default())
            .visible(false)
            .build()
            .expect("idle window builds")
    }

    #[cfg(not(target_os = "windows"))]
    #[tokio::test]
    async fn show_idle_presents_click_through_and_arms_watchdog() {
        use std::sync::atomic::Ordering::SeqCst;
        let (_dir, app, _db) = crate::test_support::mock_app_with_db().await;
        let handle = app.handle().clone();
        let win = idle_window(&handle).await;

        let generation = show_idle_with_watchdog(&handle, &win, OVERLAY_PAINT_WATCHDOG_TIMEOUT)
            .expect("state present → watchdog armed");

        assert_eq!(generation, 1, "first show is generation 1");
        assert!(win.is_visible().unwrap(), "window is shown");
        let state = app.try_state::<crate::AppState>().unwrap();
        assert_eq!(state.idle_show_gen.load(SeqCst), 1);
        assert!(
            !state.idle_painted.load(SeqCst),
            "painted is cleared until the frontend confirms"
        );
    }

    #[cfg(not(target_os = "windows"))]
    #[tokio::test]
    async fn show_idle_without_app_state_arms_nothing() {
        use tauri::test::{mock_builder, mock_context, noop_assets};
        let app = mock_builder()
            .build(mock_context(noop_assets()))
            .expect("bare mock app");
        let win = idle_window(app.handle()).await;
        assert!(
            show_idle_with_watchdog(app.handle(), &win, OVERLAY_PAINT_WATCHDOG_TIMEOUT).is_none(),
            "no AppState → no generation, no watchdog"
        );
    }

    #[cfg(not(target_os = "windows"))]
    #[tokio::test]
    async fn watchdog_leaves_a_painted_window_up() {
        use std::sync::atomic::Ordering::SeqCst;
        let (_dir, app, _db) = crate::test_support::mock_app_with_db().await;
        let handle = app.handle().clone();
        let win = idle_window(&handle).await;
        let generation =
            show_idle_with_watchdog(&handle, &win, OVERLAY_PAINT_WATCHDOG_TIMEOUT).expect("armed");
        // Frontend confirmed paint before the timeout.
        app.try_state::<crate::AppState>()
            .unwrap()
            .idle_painted
            .store(true, SeqCst);

        assert!(
            !enforce_idle_watchdog(&handle, generation),
            "painted → not hidden"
        );
        assert!(win.is_visible().unwrap(), "the prompt stays up");
    }

    #[cfg(not(target_os = "windows"))]
    #[tokio::test]
    async fn watchdog_ignores_a_superseded_generation() {
        let (_dir, app, _db) = crate::test_support::mock_app_with_db().await;
        let handle = app.handle().clone();
        let win = idle_window(&handle).await;
        let first =
            show_idle_with_watchdog(&handle, &win, OVERLAY_PAINT_WATCHDOG_TIMEOUT).expect("armed");
        // A newer show bumps the generation; the first watchdog is now stale.
        let _second =
            show_idle_with_watchdog(&handle, &win, OVERLAY_PAINT_WATCHDOG_TIMEOUT).expect("armed");

        assert!(
            !enforce_idle_watchdog(&handle, first),
            "stale generation → no-op"
        );
        assert!(win.is_visible().unwrap());
    }

    #[cfg(not(target_os = "windows"))]
    #[tokio::test]
    async fn watchdog_without_app_state_is_a_noop() {
        use tauri::test::{mock_builder, mock_context, noop_assets};
        let app = mock_builder()
            .build(mock_context(noop_assets()))
            .expect("bare mock app");
        assert!(
            !enforce_idle_watchdog(app.handle(), 1),
            "no AppState → nothing to enforce"
        );
    }

    #[cfg(not(target_os = "windows"))]
    #[tokio::test]
    async fn watchdog_without_a_window_is_a_noop() {
        use std::sync::atomic::Ordering::SeqCst;
        let (_dir, app, _db) = crate::test_support::mock_app_with_db().await;
        // State says "shown, unpainted" but no idle window exists.
        let state = app.try_state::<crate::AppState>().unwrap();
        state.idle_show_gen.store(1, SeqCst);
        state.idle_painted.store(false, SeqCst);
        assert!(
            !enforce_idle_watchdog(app.handle(), 1),
            "no idle window → nothing to hide"
        );
    }

    #[cfg(not(target_os = "windows"))]
    #[tokio::test]
    async fn watchdog_hides_a_current_unpainted_window() {
        use std::sync::atomic::Ordering::SeqCst;
        let (_dir, app, _db) = crate::test_support::mock_app_with_db().await;
        let handle = app.handle().clone();
        let _win = idle_window(&handle).await;
        let state = app.try_state::<crate::AppState>().unwrap();
        state.idle_show_gen.store(1, SeqCst);
        state.idle_painted.store(false, SeqCst);

        // Assert on the return value, not `is_visible()`: MockRuntime's
        // `hide()` doesn't synchronously flip visibility, but `enforce`
        // returns `true` exactly when it ran the hide path.
        assert!(
            enforce_idle_watchdog(&handle, 1),
            "current + unpainted → hidden"
        );
    }

    #[cfg(not(target_os = "windows"))]
    #[tokio::test]
    async fn watchdog_task_runs_enforce_after_the_timeout() {
        use std::sync::atomic::Ordering::SeqCst;
        let (_dir, app, _db) = crate::test_support::mock_app_with_db().await;
        let handle = app.handle().clone();
        let win = idle_window(&handle).await;
        let _ = win.show();
        let state = app.try_state::<crate::AppState>().unwrap();
        state.idle_show_gen.store(1, SeqCst);
        // Painted before the timeout → the task's enforce must leave it up.
        // `show()` reliably reports visible under MockRuntime (unlike hide).
        state.idle_painted.store(true, SeqCst);

        idle_watchdog_task(handle.clone(), 1, Duration::from_millis(20)).await;
        assert!(win.is_visible().unwrap(), "painted → task left it up");
    }

    // ---- #267: notification-window paint watchdog / click-through-until-painted ----

    #[cfg(not(target_os = "windows"))]
    async fn notify_window<R: tauri::Runtime>(
        app: &tauri::AppHandle<R>,
    ) -> tauri::WebviewWindow<R> {
        tauri::WebviewWindowBuilder::new(app, NOTIFY_LABEL, tauri::WebviewUrl::default())
            .visible(false)
            .build()
            .expect("notify window builds")
    }

    #[cfg(not(target_os = "windows"))]
    #[tokio::test]
    async fn show_notify_presents_click_through_and_arms_watchdog() {
        use std::sync::atomic::Ordering::SeqCst;
        let (_dir, app, _db) = crate::test_support::mock_app_with_db().await;
        let handle = app.handle().clone();
        let win = notify_window(&handle).await;

        let generation = show_notify_with_watchdog(&handle, &win, OVERLAY_PAINT_WATCHDOG_TIMEOUT)
            .expect("state present → watchdog armed");

        assert_eq!(generation, 1, "first show is generation 1");
        assert!(win.is_visible().unwrap(), "window is shown");
        let state = app.try_state::<crate::AppState>().unwrap();
        assert_eq!(state.notify_show_gen.load(SeqCst), 1);
        assert!(
            !state.notify_painted.load(SeqCst),
            "painted is cleared until the frontend confirms"
        );
    }

    #[cfg(not(target_os = "windows"))]
    #[tokio::test]
    async fn show_notify_without_app_state_arms_nothing() {
        use tauri::test::{mock_builder, mock_context, noop_assets};
        let app = mock_builder()
            .build(mock_context(noop_assets()))
            .expect("bare mock app");
        let win = notify_window(app.handle()).await;
        assert!(
            show_notify_with_watchdog(app.handle(), &win, OVERLAY_PAINT_WATCHDOG_TIMEOUT).is_none(),
            "no AppState → no generation, no watchdog"
        );
    }

    #[cfg(not(target_os = "windows"))]
    #[tokio::test]
    async fn notify_watchdog_leaves_a_painted_window_up() {
        use std::sync::atomic::Ordering::SeqCst;
        let (_dir, app, _db) = crate::test_support::mock_app_with_db().await;
        let handle = app.handle().clone();
        let win = notify_window(&handle).await;
        let generation = show_notify_with_watchdog(&handle, &win, OVERLAY_PAINT_WATCHDOG_TIMEOUT)
            .expect("armed");
        // Frontend confirmed paint before the timeout.
        app.try_state::<crate::AppState>()
            .unwrap()
            .notify_painted
            .store(true, SeqCst);

        assert!(
            !enforce_notify_watchdog(&handle, generation),
            "painted → not hidden"
        );
        assert!(win.is_visible().unwrap(), "the notification stays up");
    }

    #[cfg(not(target_os = "windows"))]
    #[tokio::test]
    async fn notify_watchdog_ignores_a_superseded_generation() {
        let (_dir, app, _db) = crate::test_support::mock_app_with_db().await;
        let handle = app.handle().clone();
        let win = notify_window(&handle).await;
        let first = show_notify_with_watchdog(&handle, &win, OVERLAY_PAINT_WATCHDOG_TIMEOUT)
            .expect("armed");
        // A newer show (e.g. a different rule matching moments later) bumps
        // the generation; the first watchdog is now stale.
        let _second = show_notify_with_watchdog(&handle, &win, OVERLAY_PAINT_WATCHDOG_TIMEOUT)
            .expect("armed");

        assert!(
            !enforce_notify_watchdog(&handle, first),
            "stale generation → no-op"
        );
        assert!(win.is_visible().unwrap());
    }

    #[cfg(not(target_os = "windows"))]
    #[tokio::test]
    async fn notify_watchdog_without_app_state_is_a_noop() {
        use tauri::test::{mock_builder, mock_context, noop_assets};
        let app = mock_builder()
            .build(mock_context(noop_assets()))
            .expect("bare mock app");
        assert!(
            !enforce_notify_watchdog(app.handle(), 1),
            "no AppState → nothing to enforce"
        );
    }

    #[cfg(not(target_os = "windows"))]
    #[tokio::test]
    async fn notify_watchdog_without_a_window_is_a_noop() {
        use std::sync::atomic::Ordering::SeqCst;
        let (_dir, app, _db) = crate::test_support::mock_app_with_db().await;
        // State says "shown, unpainted" but no notify window exists.
        let state = app.try_state::<crate::AppState>().unwrap();
        state.notify_show_gen.store(1, SeqCst);
        state.notify_painted.store(false, SeqCst);
        assert!(
            !enforce_notify_watchdog(app.handle(), 1),
            "no notify window → nothing to hide"
        );
    }

    #[cfg(not(target_os = "windows"))]
    #[tokio::test]
    async fn notify_watchdog_hides_a_current_unpainted_window() {
        use std::sync::atomic::Ordering::SeqCst;
        let (_dir, app, _db) = crate::test_support::mock_app_with_db().await;
        let handle = app.handle().clone();
        let _win = notify_window(&handle).await;
        let state = app.try_state::<crate::AppState>().unwrap();
        state.notify_show_gen.store(1, SeqCst);
        state.notify_painted.store(false, SeqCst);

        // Assert on the return value, not `is_visible()`: MockRuntime's
        // `hide()` doesn't synchronously flip visibility, but `enforce`
        // returns `true` exactly when it ran the hide path.
        assert!(
            enforce_notify_watchdog(&handle, 1),
            "current + unpainted → hidden"
        );
    }

    #[cfg(not(target_os = "windows"))]
    #[tokio::test]
    async fn notify_watchdog_task_runs_enforce_after_the_timeout() {
        use std::sync::atomic::Ordering::SeqCst;
        let (_dir, app, _db) = crate::test_support::mock_app_with_db().await;
        let handle = app.handle().clone();
        let win = notify_window(&handle).await;
        let _ = win.show();
        let state = app.try_state::<crate::AppState>().unwrap();
        state.notify_show_gen.store(1, SeqCst);
        // Painted before the timeout → the task's enforce must leave it up.
        // `show()` reliably reports visible under MockRuntime (unlike hide).
        state.notify_painted.store(true, SeqCst);

        notify_watchdog_task(handle.clone(), 1, Duration::from_millis(20)).await;
        assert!(win.is_visible().unwrap(), "painted → task left it up");
    }
}
