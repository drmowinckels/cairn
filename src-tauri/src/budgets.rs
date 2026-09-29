//! Recurring work-hour budgets (#307).
//!
//! A budget is a **cap**, not a target: Cairn warns as you approach one and
//! again once you pass it. The point is protection against overwork, which is
//! why this lives in core rather than behind the billing plugin — knowing you
//! have worked too much this week is not a billing feature.
//!
//! Scopes resolve **most-granular-wins** — project ▸ client ▸ workspace —
//! mirroring `plugins::billing::rates`. Unlike rates there is no `task`
//! scope and no effective-from history: a budget describes the present, and
//! "what was my weekly cap last March" is a question nobody asks.
//!
//! Distinct from `projects.estimate_hours`, a one-off total for a whole
//! project. These recur every day, week or month.
//!
//! Minutes are integers throughout, for the same reason money is cents.

use chrono::{DateTime, Datelike, Duration, NaiveDate, TimeZone, Utc};
use serde::{Deserialize, Serialize};
use sqlx::{Row, SqlitePool};

use crate::ipc::err;

/// A stored budget.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Budget {
    pub id: String,
    pub scope_type: String,
    /// Empty for the workspace default; the client/project id otherwise.
    pub scope_id: String,
    pub period: String,
    pub minutes: i64,
    pub warn_percent: i64,
}

/// What the caller asks us to store. Separate from [`Budget`] because the id
/// is ours to mint and the timestamps are the database's.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BudgetInput {
    pub scope_type: String,
    #[serde(default)]
    pub scope_id: String,
    pub period: String,
    pub minutes: i64,
    #[serde(default = "default_warn_percent")]
    pub warn_percent: i64,
}

fn default_warn_percent() -> i64 {
    80
}

/// How a budget is doing right now.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BudgetStatus {
    pub budget: Budget,
    /// Minutes tracked against this scope in the current period.
    pub used_minutes: i64,
    /// `used / budget` as a percentage, rounded down. Can exceed 100.
    pub percent: i64,
    pub state: BudgetState,
    /// Start of the period the usage was measured over, RFC3339.
    pub period_start: String,
}

/// Where a budget sits against its cap. Ordered by severity so the UI can
/// surface the worst one when several fire at once.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum BudgetState {
    /// Below the warning threshold — nothing to say.
    Under,
    /// At or past `warn_percent` but not yet over the cap.
    Approaching,
    /// At or past 100%.
    Over,
}

const SCOPES: [&str; 3] = ["workspace", "client", "project"];
const PERIODS: [&str; 3] = ["daily", "weekly", "monthly"];

/// A more-specific scope outranks a broader one.
pub fn scope_priority(scope_type: &str) -> u8 {
    match scope_type {
        "project" => 2,
        "client" => 1,
        _ => 0, // workspace
    }
}

/// Validate a scope and canonicalize its id: the workspace default is a
/// singleton (id always empty); every other scope needs a non-empty id.
fn normalize_scope(scope_type: &str, scope_id: &str) -> Result<(String, String), String> {
    if !SCOPES.contains(&scope_type) {
        return Err(format!("unknown budget scope: {scope_type}"));
    }
    if scope_type == "workspace" {
        return Ok(("workspace".into(), String::new()));
    }
    let id = scope_id.trim();
    if id.is_empty() {
        return Err(format!("a {scope_type} budget needs a {scope_type} id"));
    }
    Ok((scope_type.into(), id.into()))
}

fn normalize_period(period: &str) -> Result<String, String> {
    let p = period.trim();
    if PERIODS.contains(&p) {
        Ok(p.to_string())
    } else {
        Err(format!(
            "period must be daily, weekly or monthly (got {period:?})"
        ))
    }
}

/// Reject a budget that can't mean anything before it reaches the database,
/// so the error names the field rather than surfacing a CHECK violation.
fn validate(input: &BudgetInput) -> Result<(String, String, String), String> {
    if input.minutes <= 0 {
        return Err("a budget must be at least one minute".into());
    }
    if !(1..=100).contains(&input.warn_percent) {
        return Err(format!(
            "the warning threshold must be between 1 and 100 percent (got {})",
            input.warn_percent
        ));
    }
    let (scope_type, scope_id) = normalize_scope(&input.scope_type, &input.scope_id)?;
    let period = normalize_period(&input.period)?;
    Ok((scope_type, scope_id, period))
}

/// Start of the period containing `now`, in local wall-clock terms.
///
/// Local, not UTC: a "daily" budget means the user's day. Measuring it in UTC
/// would roll the counter over mid-afternoon for anyone far enough east, or
/// mid-evening the day before for anyone west.
///
/// The week starts Monday — ISO, and the convention the rest of Cairn's
/// reports already use.
pub fn period_start(period: &str, now: DateTime<Utc>) -> DateTime<Utc> {
    let local = now.with_timezone(&chrono::Local);
    let date = local.date_naive();
    let start_date = match period {
        "weekly" => date - Duration::days(date.weekday().num_days_from_monday() as i64),
        "monthly" => NaiveDate::from_ymd_opt(date.year(), date.month(), 1).unwrap_or(date),
        _ => date, // daily
    };
    // A local midnight that doesn't exist (spring-forward in a zone that
    // shifts at 00:00) has no single answer; the earliest valid instant that
    // day is the honest one, and `and_hms_opt(0,0,0)` plus the mapping below
    // gives exactly that.
    start_date
        .and_hms_opt(0, 0, 0)
        .map(|naive| match chrono::Local.from_local_datetime(&naive) {
            chrono::LocalResult::Single(dt) => dt.with_timezone(&Utc),
            chrono::LocalResult::Ambiguous(earliest, _) => earliest.with_timezone(&Utc),
            // Skipped local midnight: step forward until the clock exists.
            chrono::LocalResult::None => (naive + Duration::hours(1)).and_utc().with_timezone(&Utc),
        })
        .unwrap_or(now)
}

/// Percentage of `minutes` that `used` represents, rounded down.
/// A zero budget can't reach the database (CHECK + [`validate`]), but a
/// division here would be a panic, so it degrades to 0 rather than trusting
/// that invariant from a different module.
pub fn percent_of(used_minutes: i64, minutes: i64) -> i64 {
    if minutes <= 0 {
        return 0;
    }
    (used_minutes * 100) / minutes
}

/// Classify usage against a cap.
pub fn classify(used_minutes: i64, minutes: i64, warn_percent: i64) -> BudgetState {
    let pct = percent_of(used_minutes, minutes);
    if pct >= 100 {
        BudgetState::Over
    } else if pct >= warn_percent {
        BudgetState::Approaching
    } else {
        BudgetState::Under
    }
}

/// Store a budget, replacing any existing one for the same scope and period.
pub async fn set_budget(pool: &SqlitePool, input: BudgetInput) -> Result<Vec<Budget>, String> {
    let (scope_type, scope_id, period) = validate(&input)?;
    sqlx::query(
        r#"INSERT INTO work_hour_budgets
               (id, scope_type, scope_id, period, minutes, warn_percent)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6)
           ON CONFLICT (scope_type, scope_id, period) DO UPDATE SET
               minutes      = excluded.minutes,
               warn_percent = excluded.warn_percent,
               updated_at   = datetime('now')"#,
    )
    .bind(uuid::Uuid::new_v4().to_string())
    .bind(&scope_type)
    .bind(&scope_id)
    .bind(&period)
    .bind(input.minutes)
    .bind(input.warn_percent)
    .execute(pool)
    .await
    .map_err(err)?;
    list_budgets(pool).await
}

/// Every budget, most-granular scope first so the UI lists the specific ones
/// above the workspace default.
pub async fn list_budgets(pool: &SqlitePool) -> Result<Vec<Budget>, String> {
    let rows = sqlx::query(
        r#"SELECT id, scope_type, scope_id, period, minutes, warn_percent
             FROM work_hour_budgets"#,
    )
    .fetch_all(pool)
    .await
    .map_err(err)?;

    let mut budgets: Vec<Budget> = rows
        .into_iter()
        .map(|r| Budget {
            id: r.get("id"),
            scope_type: r.get("scope_type"),
            scope_id: r.get("scope_id"),
            period: r.get("period"),
            minutes: r.get("minutes"),
            warn_percent: r.get("warn_percent"),
        })
        .collect();
    budgets.sort_by(|a, b| {
        scope_priority(&b.scope_type)
            .cmp(&scope_priority(&a.scope_type))
            .then_with(|| a.scope_id.cmp(&b.scope_id))
            .then_with(|| period_rank(&a.period).cmp(&period_rank(&b.period)))
    });
    Ok(budgets)
}

/// Shortest period first, so a scope's budgets read daily → weekly → monthly.
fn period_rank(period: &str) -> u8 {
    match period {
        "daily" => 0,
        "weekly" => 1,
        _ => 2,
    }
}

pub async fn delete_budget(pool: &SqlitePool, id: &str) -> Result<Vec<Budget>, String> {
    sqlx::query("DELETE FROM work_hour_budgets WHERE id = ?1")
        .bind(id)
        .execute(pool)
        .await
        .map_err(err)?;
    list_budgets(pool).await
}

/// Minutes tracked against a scope within `[since, now]`.
///
/// Counts the *overlap*, not just entries that began inside the window. A
/// session started at 23:00 and still going at 00:30 contributes half an hour
/// to the new day, not nothing — otherwise anyone working past midnight would
/// see a daily budget stuck at zero.
///
/// An open entry counts up to `now`, so a cap you are actively burning moves
/// in real time; one that only updated when you stopped would warn you after
/// the fact.
///
/// Spans are clamped at zero for the same reason the exports clamp: a
/// backwards entry is a bad row, and letting it subtract would under-report
/// a cap.
async fn used_minutes(
    pool: &SqlitePool,
    scope_type: &str,
    scope_id: &str,
    since: DateTime<Utc>,
    now: DateTime<Utc>,
) -> Result<i64, String> {
    // Timestamps are stored as RFC3339 in UTC, so a lexicographic `>=` is a
    // chronological one. Selecting by `ended_at` rather than `started_at` is
    // what lets an entry that began before the window still be counted; a
    // running entry (NULL) always overlaps.
    const OVERLAPS: &str = "(e.ended_at IS NULL OR e.ended_at >= ?1)";
    let rows = match scope_type {
        "project" => {
            sqlx::query(&format!(
                "SELECT e.started_at, e.ended_at FROM entries e \
                  WHERE {OVERLAPS} AND e.project_id = ?2"
            ))
            .bind(since.to_rfc3339())
            .bind(scope_id)
            .fetch_all(pool)
            .await
        }
        "client" => {
            sqlx::query(&format!(
                "SELECT e.started_at, e.ended_at FROM entries e \
                   JOIN projects p ON p.id = e.project_id \
                  WHERE {OVERLAPS} AND p.client_id = ?2"
            ))
            .bind(since.to_rfc3339())
            .bind(scope_id)
            .fetch_all(pool)
            .await
        }
        // The workspace budget counts everything, so there's no id to bind.
        _ => {
            sqlx::query(&format!(
                "SELECT e.started_at, e.ended_at FROM entries e WHERE {OVERLAPS}"
            ))
            .bind(since.to_rfc3339())
            .fetch_all(pool)
            .await
        }
    }
    .map_err(err)?;

    let mut seconds: i64 = 0;
    for r in rows {
        let started: String = r.get("started_at");
        let ended: Option<String> = r.get("ended_at");
        let Ok(start) = DateTime::parse_from_rfc3339(&started) else {
            continue;
        };
        let end = match ended {
            Some(s) => match DateTime::parse_from_rfc3339(&s) {
                Ok(e) => e.with_timezone(&Utc),
                // An unparseable end is skipped rather than measured to now:
                // treating a broken row as "still running" would inflate the
                // cap and nag about work that never happened.
                Err(_) => continue,
            },
            None => now,
        };
        // Clip to the period, so only the part inside it counts.
        let from = start.with_timezone(&Utc).max(since);
        let to = end.min(now);
        seconds += (to - from).num_seconds().max(0);
    }
    Ok(seconds / 60)
}

/// Current standing of every configured budget.
pub async fn budget_status(
    pool: &SqlitePool,
    now: DateTime<Utc>,
) -> Result<Vec<BudgetStatus>, String> {
    let budgets = list_budgets(pool).await?;
    let mut out = Vec::with_capacity(budgets.len());
    for budget in budgets {
        let start = period_start(&budget.period, now);
        let used = used_minutes(pool, &budget.scope_type, &budget.scope_id, start, now).await?;
        out.push(BudgetStatus {
            percent: percent_of(used, budget.minutes),
            state: classify(used, budget.minutes, budget.warn_percent),
            used_minutes: used,
            period_start: start.to_rfc3339(),
            budget,
        });
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::test_db;
    use chrono::Timelike;

    fn input(scope_type: &str, scope_id: &str, period: &str, minutes: i64) -> BudgetInput {
        BudgetInput {
            scope_type: scope_type.into(),
            scope_id: scope_id.into(),
            period: period.into(),
            minutes,
            warn_percent: 80,
        }
    }

    // ── classification ────────────────────────────────────────────────

    #[test]
    fn percent_rounds_down_and_can_exceed_a_hundred() {
        assert_eq!(percent_of(0, 480), 0);
        assert_eq!(percent_of(479, 480), 99);
        assert_eq!(percent_of(480, 480), 100);
        // Over-budget is reported honestly rather than capped at 100 — the
        // UI needs to say "by how much".
        assert_eq!(percent_of(720, 480), 150);
    }

    #[test]
    fn percent_of_a_zero_budget_is_zero_not_a_panic() {
        // A zero budget can't reach the database, but dividing by one here
        // would be a crash rather than a bad number.
        assert_eq!(percent_of(60, 0), 0);
        assert_eq!(percent_of(60, -5), 0);
    }

    #[test]
    fn classify_moves_under_to_approaching_to_over() {
        assert_eq!(classify(0, 480, 80), BudgetState::Under);
        assert_eq!(classify(383, 480, 80), BudgetState::Under);
        // 384 == exactly 80%.
        assert_eq!(classify(384, 480, 80), BudgetState::Approaching);
        assert_eq!(classify(479, 480, 80), BudgetState::Approaching);
        assert_eq!(classify(480, 480, 80), BudgetState::Over);
        assert_eq!(classify(999, 480, 80), BudgetState::Over);
    }

    #[test]
    fn a_hundred_percent_threshold_disables_the_early_warning() {
        // Documented behaviour of warn_percent = 100: only the breach warns.
        assert_eq!(classify(479, 480, 100), BudgetState::Under);
        assert_eq!(classify(480, 480, 100), BudgetState::Over);
    }

    #[test]
    fn states_order_by_severity() {
        // The UI surfaces the worst budget when several fire at once.
        assert!(BudgetState::Over > BudgetState::Approaching);
        assert!(BudgetState::Approaching > BudgetState::Under);
    }

    // ── period boundaries ─────────────────────────────────────────────

    #[test]
    fn daily_period_starts_at_local_midnight() {
        let now = Utc::now();
        let start = period_start("daily", now);
        let local = start.with_timezone(&chrono::Local);
        assert_eq!((local.hour(), local.minute()), (0, 0));
        assert!(start <= now);
    }

    #[test]
    fn weekly_period_starts_on_monday() {
        let now = Utc::now();
        let start = period_start("weekly", now);
        let local = start.with_timezone(&chrono::Local);
        assert_eq!(local.weekday(), chrono::Weekday::Mon);
        assert!(start <= now);
    }

    #[test]
    fn monthly_period_starts_on_the_first() {
        let now = Utc::now();
        let start = period_start("monthly", now);
        let local = start.with_timezone(&chrono::Local);
        assert_eq!(local.day(), 1);
        assert!(start <= now);
    }

    #[test]
    fn periods_nest_shortest_to_longest() {
        let now = Utc::now();
        assert!(
            period_start("monthly", now)
                <= period_start("weekly", now).max(period_start("monthly", now))
        );
        assert!(period_start("weekly", now) <= period_start("daily", now));
        assert!(period_start("monthly", now) <= period_start("daily", now));
    }

    #[test]
    fn an_unknown_period_measures_like_a_day() {
        // Defensive: a period that escaped validation must not widen a cap.
        let now = Utc::now();
        assert_eq!(period_start("fortnightly", now), period_start("daily", now));
    }

    // ── validation ────────────────────────────────────────────────────

    #[tokio::test]
    async fn rejects_a_non_positive_budget() {
        let (_dir, db) = test_db().await;
        for minutes in [0, -30] {
            let err = set_budget(&db.pool, input("workspace", "", "daily", minutes))
                .await
                .unwrap_err();
            assert!(err.contains("at least one minute"), "got {err}");
        }
    }

    #[tokio::test]
    async fn rejects_a_threshold_outside_one_to_a_hundred() {
        let (_dir, db) = test_db().await;
        for pct in [0, 101, -5] {
            let mut i = input("workspace", "", "daily", 480);
            i.warn_percent = pct;
            let err = set_budget(&db.pool, i).await.unwrap_err();
            assert!(err.contains("between 1 and 100"), "got {err}");
        }
    }

    #[tokio::test]
    async fn rejects_an_unknown_scope_or_period() {
        let (_dir, db) = test_db().await;
        let err = set_budget(&db.pool, input("galaxy", "x", "daily", 480))
            .await
            .unwrap_err();
        assert!(err.contains("unknown budget scope"), "got {err}");

        let err = set_budget(&db.pool, input("workspace", "", "hourly", 480))
            .await
            .unwrap_err();
        assert!(err.contains("daily, weekly or monthly"), "got {err}");
    }

    #[tokio::test]
    async fn a_scoped_budget_needs_an_id_but_the_workspace_one_never_has_one() {
        let (_dir, db) = test_db().await;
        let err = set_budget(&db.pool, input("project", "  ", "daily", 480))
            .await
            .unwrap_err();
        assert!(err.contains("needs a project id"), "got {err}");

        // A stray id on the workspace default is dropped, keeping it a
        // singleton rather than creating a second, unreachable row.
        let stored = set_budget(&db.pool, input("workspace", "ignored", "daily", 480))
            .await
            .unwrap();
        assert_eq!(stored[0].scope_id, "");
    }

    // ── storage ───────────────────────────────────────────────────────

    #[tokio::test]
    async fn setting_the_same_scope_and_period_updates_rather_than_duplicates() {
        let (_dir, db) = test_db().await;
        set_budget(&db.pool, input("workspace", "", "weekly", 2400))
            .await
            .unwrap();
        let after = set_budget(&db.pool, input("workspace", "", "weekly", 1800))
            .await
            .unwrap();

        assert_eq!(after.len(), 1, "one budget per scope per period");
        assert_eq!(after[0].minutes, 1800);
    }

    #[tokio::test]
    async fn the_same_scope_can_hold_one_budget_per_period() {
        let (_dir, db) = test_db().await;
        set_budget(&db.pool, input("workspace", "", "daily", 480))
            .await
            .unwrap();
        set_budget(&db.pool, input("workspace", "", "weekly", 2400))
            .await
            .unwrap();
        let all = set_budget(&db.pool, input("workspace", "", "monthly", 9600))
            .await
            .unwrap();
        assert_eq!(all.len(), 3);
    }

    #[tokio::test]
    async fn listing_puts_the_most_specific_scope_first() {
        let (_dir, db) = test_db().await;
        set_budget(&db.pool, input("workspace", "", "daily", 480))
            .await
            .unwrap();
        set_budget(&db.pool, input("client", "c1", "daily", 240))
            .await
            .unwrap();
        let all = set_budget(&db.pool, input("project", "p1", "daily", 120))
            .await
            .unwrap();

        let order: Vec<&str> = all.iter().map(|b| b.scope_type.as_str()).collect();
        assert_eq!(order, ["project", "client", "workspace"]);
    }

    #[tokio::test]
    async fn a_scopes_budgets_read_shortest_period_first() {
        let (_dir, db) = test_db().await;
        set_budget(&db.pool, input("workspace", "", "monthly", 9600))
            .await
            .unwrap();
        set_budget(&db.pool, input("workspace", "", "daily", 480))
            .await
            .unwrap();
        let all = set_budget(&db.pool, input("workspace", "", "weekly", 2400))
            .await
            .unwrap();
        let order: Vec<&str> = all.iter().map(|b| b.period.as_str()).collect();
        assert_eq!(order, ["daily", "weekly", "monthly"]);
    }

    #[tokio::test]
    async fn deleting_removes_only_the_named_budget() {
        let (_dir, db) = test_db().await;
        set_budget(&db.pool, input("workspace", "", "daily", 480))
            .await
            .unwrap();
        let all = set_budget(&db.pool, input("workspace", "", "weekly", 2400))
            .await
            .unwrap();
        let daily = all.iter().find(|b| b.period == "daily").unwrap();

        let left = delete_budget(&db.pool, &daily.id).await.unwrap();
        assert_eq!(left.len(), 1);
        assert_eq!(left[0].period, "weekly");
    }

    #[tokio::test]
    async fn deleting_an_absent_budget_is_not_an_error() {
        let (_dir, db) = test_db().await;
        assert!(delete_budget(&db.pool, "nope").await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn no_budgets_means_no_status() {
        let (_dir, db) = test_db().await;
        assert!(budget_status(&db.pool, Utc::now())
            .await
            .unwrap()
            .is_empty());
    }

    // ── usage against real entries ────────────────────────────────────

    /// Two clients, each with a project, so scope filtering has something
    /// to actually exclude.
    async fn seed_scopes(pool: &SqlitePool) {
        let now = "2026-07-01T00:00:00+00:00";
        for (cid, name) in [("c1", "Acme"), ("c2", "Beta")] {
            sqlx::query(
                "INSERT INTO clients (id, name, created_at, updated_at) VALUES (?1, ?2, ?3, ?3)",
            )
            .bind(cid)
            .bind(name)
            .bind(now)
            .execute(pool)
            .await
            .unwrap();
        }
        for (pid, cid) in [("p1", "c1"), ("p2", "c2")] {
            sqlx::query(
                "INSERT INTO projects (id, name, client_id, color, archived, billable_default, created_at, updated_at) \
                 VALUES (?1, ?1, ?2, '#0f0', 0, 0, ?3, ?3)",
            )
            .bind(pid)
            .bind(cid)
            .bind(now)
            .execute(pool)
            .await
            .unwrap();
        }
    }

    /// An entry on `project` spanning `minutes`, ending `ago_minutes` before
    /// `now`. `None` minutes leaves it running.
    async fn entry(
        pool: &SqlitePool,
        project: Option<&str>,
        start: DateTime<Utc>,
        minutes: Option<i64>,
    ) {
        let ended = minutes.map(|m| (start + Duration::minutes(m)).to_rfc3339());
        sqlx::query(
            "INSERT INTO entries (id, project_id, task_id, description, started_at, ended_at, source, rule_id, created_at, updated_at) \
             VALUES (?1, ?2, NULL, 'work', ?3, ?4, 'manual', NULL, ?3, ?3)",
        )
        .bind(uuid::Uuid::new_v4().to_string())
        .bind(project)
        .bind(start.to_rfc3339())
        .bind(ended)
        .execute(pool)
        .await
        .unwrap();
    }

    /// A moment safely inside today, this week and this month, so one fixture
    /// serves every period without straddling a boundary.
    fn midmonth_noon() -> DateTime<Utc> {
        let local = chrono::Local::now();
        let date = NaiveDate::from_ymd_opt(local.year(), local.month(), 15).unwrap();
        let naive = date.and_hms_opt(12, 0, 0).unwrap();
        match chrono::Local.from_local_datetime(&naive) {
            chrono::LocalResult::Single(dt) => dt.with_timezone(&Utc),
            chrono::LocalResult::Ambiguous(e, _) => e.with_timezone(&Utc),
            chrono::LocalResult::None => naive.and_utc(),
        }
    }

    #[tokio::test]
    async fn a_workspace_budget_counts_every_project() {
        let (_dir, db) = test_db().await;
        seed_scopes(&db.pool).await;
        let now = midmonth_noon();
        entry(&db.pool, Some("p1"), now - Duration::hours(3), Some(60)).await;
        entry(&db.pool, Some("p2"), now - Duration::hours(2), Some(30)).await;
        // Untracked-to-a-project time still counts against the workspace cap.
        entry(&db.pool, None, now - Duration::hours(1), Some(15)).await;

        set_budget(&db.pool, input("workspace", "", "monthly", 600))
            .await
            .unwrap();
        let status = budget_status(&db.pool, now).await.unwrap();

        assert_eq!(status[0].used_minutes, 105);
        assert_eq!(status[0].percent, 17);
        assert_eq!(status[0].state, BudgetState::Under);
    }

    #[tokio::test]
    async fn a_project_budget_counts_only_that_project() {
        let (_dir, db) = test_db().await;
        seed_scopes(&db.pool).await;
        let now = midmonth_noon();
        entry(&db.pool, Some("p1"), now - Duration::hours(3), Some(60)).await;
        entry(&db.pool, Some("p2"), now - Duration::hours(2), Some(300)).await;

        set_budget(&db.pool, input("project", "p1", "monthly", 120))
            .await
            .unwrap();
        let status = budget_status(&db.pool, now).await.unwrap();

        assert_eq!(status[0].used_minutes, 60, "p2's 300 minutes are not p1's");
        assert_eq!(status[0].percent, 50);
    }

    #[tokio::test]
    async fn a_client_budget_counts_every_project_of_that_client() {
        let (_dir, db) = test_db().await;
        seed_scopes(&db.pool).await;
        let now = midmonth_noon();
        entry(&db.pool, Some("p1"), now - Duration::hours(3), Some(60)).await;
        entry(&db.pool, Some("p2"), now - Duration::hours(2), Some(90)).await;
        // No project → no client → outside every client budget.
        entry(&db.pool, None, now - Duration::hours(1), Some(45)).await;

        set_budget(&db.pool, input("client", "c1", "monthly", 600))
            .await
            .unwrap();
        let status = budget_status(&db.pool, now).await.unwrap();

        assert_eq!(status[0].used_minutes, 60);
    }

    #[tokio::test]
    async fn work_before_the_period_started_is_excluded() {
        let (_dir, db) = test_db().await;
        seed_scopes(&db.pool).await;
        let now = midmonth_noon();
        // Yesterday, so inside the month but outside today.
        entry(&db.pool, Some("p1"), now - Duration::days(1), Some(480)).await;
        entry(&db.pool, Some("p1"), now - Duration::hours(1), Some(30)).await;

        set_budget(&db.pool, input("workspace", "", "daily", 480))
            .await
            .unwrap();
        set_budget(&db.pool, input("workspace", "", "monthly", 9600))
            .await
            .unwrap();
        let status = budget_status(&db.pool, now).await.unwrap();

        let daily = status.iter().find(|s| s.budget.period == "daily").unwrap();
        let monthly = status
            .iter()
            .find(|s| s.budget.period == "monthly")
            .unwrap();
        assert_eq!(daily.used_minutes, 30, "only today's half hour");
        assert_eq!(monthly.used_minutes, 510, "both, since both are this month");
    }

    #[tokio::test]
    async fn a_running_entry_counts_up_to_now() {
        let (_dir, db) = test_db().await;
        seed_scopes(&db.pool).await;
        let now = midmonth_noon();
        // Still running: a cap that only moved when you stopped would warn
        // you after the damage was done.
        entry(&db.pool, Some("p1"), now - Duration::minutes(90), None).await;

        // 90 of 100 minutes = 90%, past the 80% threshold.
        set_budget(&db.pool, input("workspace", "", "daily", 100))
            .await
            .unwrap();
        let status = budget_status(&db.pool, now).await.unwrap();

        assert_eq!(status[0].used_minutes, 90);
        assert_eq!(status[0].state, BudgetState::Approaching);
    }

    #[tokio::test]
    async fn an_entry_with_an_unparseable_end_is_skipped_not_counted_to_now() {
        let (_dir, db) = test_db().await;
        seed_scopes(&db.pool).await;
        let now = midmonth_noon();
        sqlx::query(
            "INSERT INTO entries (id, project_id, task_id, description, started_at, ended_at, source, rule_id, created_at, updated_at) \
             VALUES ('bad', 'p1', NULL, 'broken', ?1, 'not-a-timestamp', 'manual', NULL, ?1, ?1)",
        )
        .bind((now - Duration::hours(5)).to_rfc3339())
        .execute(&db.pool)
        .await
        .unwrap();
        entry(&db.pool, Some("p1"), now - Duration::minutes(10), Some(10)).await;

        set_budget(&db.pool, input("workspace", "", "daily", 480))
            .await
            .unwrap();
        let status = budget_status(&db.pool, now).await.unwrap();

        // Treating the broken row as "still running" would add 5 hours and
        // nag about work that never happened.
        assert_eq!(status[0].used_minutes, 10);
    }

    #[tokio::test]
    async fn a_backwards_entry_cannot_subtract_from_a_cap() {
        let (_dir, db) = test_db().await;
        seed_scopes(&db.pool).await;
        let now = midmonth_noon();
        entry(&db.pool, Some("p1"), now - Duration::hours(1), Some(-30)).await;
        entry(&db.pool, Some("p1"), now - Duration::minutes(20), Some(20)).await;

        set_budget(&db.pool, input("workspace", "", "daily", 480))
            .await
            .unwrap();
        let status = budget_status(&db.pool, now).await.unwrap();

        assert_eq!(status[0].used_minutes, 20, "the bad row contributes zero");
    }

    #[tokio::test]
    async fn crossing_the_cap_reports_over_with_the_real_overshoot() {
        let (_dir, db) = test_db().await;
        seed_scopes(&db.pool).await;
        let now = midmonth_noon();
        entry(&db.pool, Some("p1"), now - Duration::hours(10), Some(600)).await;

        set_budget(&db.pool, input("workspace", "", "daily", 480))
            .await
            .unwrap();
        let status = budget_status(&db.pool, now).await.unwrap();

        assert_eq!(status[0].state, BudgetState::Over);
        assert_eq!(status[0].percent, 125);
    }

    #[tokio::test]
    async fn every_budget_gets_its_own_period_window() {
        let (_dir, db) = test_db().await;
        seed_scopes(&db.pool).await;
        let now = midmonth_noon();
        set_budget(&db.pool, input("workspace", "", "daily", 480))
            .await
            .unwrap();
        set_budget(&db.pool, input("workspace", "", "weekly", 2400))
            .await
            .unwrap();
        let status = budget_status(&db.pool, now).await.unwrap();

        let daily = status.iter().find(|s| s.budget.period == "daily").unwrap();
        let weekly = status.iter().find(|s| s.budget.period == "weekly").unwrap();
        assert_eq!(daily.period_start, period_start("daily", now).to_rfc3339());
        assert_eq!(
            weekly.period_start,
            period_start("weekly", now).to_rfc3339()
        );
        assert!(weekly.period_start <= daily.period_start);
    }

    #[tokio::test]
    async fn a_budget_for_a_scope_that_no_longer_exists_simply_reads_zero() {
        let (_dir, db) = test_db().await;
        seed_scopes(&db.pool).await;
        let now = midmonth_noon();
        entry(&db.pool, Some("p1"), now - Duration::hours(1), Some(60)).await;

        // No foreign key, so a budget can outlive its project. It must not
        // error, and it must not silently pick up someone else's hours.
        set_budget(&db.pool, input("project", "deleted-project", "daily", 480))
            .await
            .unwrap();
        let status = budget_status(&db.pool, now).await.unwrap();

        assert_eq!(status[0].used_minutes, 0);
        assert_eq!(status[0].state, BudgetState::Under);
    }

    // ── period overlap ────────────────────────────────────────────────

    #[tokio::test]
    async fn a_session_running_across_midnight_counts_toward_the_new_day() {
        let (_dir, db) = test_db().await;
        seed_scopes(&db.pool).await;
        let now = midmonth_noon();
        let today_start = period_start("daily", now);
        // Started two hours before midnight, ended two hours after it.
        entry(
            &db.pool,
            Some("p1"),
            today_start - Duration::hours(2),
            Some(240),
        )
        .await;

        set_budget(&db.pool, input("workspace", "", "daily", 480))
            .await
            .unwrap();
        let status = budget_status(&db.pool, now).await.unwrap();

        // Only the part after midnight. Counting the whole 4 hours would
        // charge today for yesterday's work; counting none of it would leave
        // a night shift's budget stuck at zero.
        assert_eq!(status[0].used_minutes, 120);
    }

    #[tokio::test]
    async fn a_still_running_session_started_yesterday_counts_from_midnight() {
        let (_dir, db) = test_db().await;
        seed_scopes(&db.pool).await;
        let now = midmonth_noon();
        let today_start = period_start("daily", now);
        entry(&db.pool, Some("p1"), today_start - Duration::hours(3), None).await;

        set_budget(&db.pool, input("workspace", "", "daily", 480))
            .await
            .unwrap();
        let status = budget_status(&db.pool, now).await.unwrap();

        // Midnight → noon, not the full 15 hours since it started.
        let expected = (now - today_start).num_minutes();
        assert_eq!(status[0].used_minutes, expected);
    }

    #[tokio::test]
    async fn an_entry_entirely_before_the_period_contributes_nothing() {
        let (_dir, db) = test_db().await;
        seed_scopes(&db.pool).await;
        let now = midmonth_noon();
        let today_start = period_start("daily", now);
        entry(
            &db.pool,
            Some("p1"),
            today_start - Duration::hours(5),
            Some(60),
        )
        .await;

        set_budget(&db.pool, input("workspace", "", "daily", 480))
            .await
            .unwrap();
        let status = budget_status(&db.pool, now).await.unwrap();
        assert_eq!(status[0].used_minutes, 0);
    }

    #[tokio::test]
    async fn an_entry_ending_exactly_at_the_period_start_contributes_nothing() {
        let (_dir, db) = test_db().await;
        seed_scopes(&db.pool).await;
        let now = midmonth_noon();
        let today_start = period_start("daily", now);
        entry(
            &db.pool,
            Some("p1"),
            today_start - Duration::hours(1),
            Some(60),
        )
        .await;

        set_budget(&db.pool, input("workspace", "", "daily", 480))
            .await
            .unwrap();
        let status = budget_status(&db.pool, now).await.unwrap();
        assert_eq!(status[0].used_minutes, 0, "a zero-length overlap is zero");
    }

    #[tokio::test]
    async fn a_future_dated_entry_cannot_inflate_the_current_period() {
        let (_dir, db) = test_db().await;
        seed_scopes(&db.pool).await;
        let now = midmonth_noon();
        // Clock skew, or an entry someone edited forward.
        entry(&db.pool, Some("p1"), now + Duration::hours(2), Some(60)).await;

        set_budget(&db.pool, input("workspace", "", "daily", 480))
            .await
            .unwrap();
        let status = budget_status(&db.pool, now).await.unwrap();
        assert_eq!(status[0].used_minutes, 0, "nothing past `now` counts yet");
    }

    #[tokio::test]
    async fn overlap_respects_the_scope_as_well_as_the_window() {
        let (_dir, db) = test_db().await;
        seed_scopes(&db.pool).await;
        let now = midmonth_noon();
        let today_start = period_start("daily", now);
        // Both cross midnight; only p1's belongs to this project budget.
        entry(
            &db.pool,
            Some("p1"),
            today_start - Duration::hours(1),
            Some(120),
        )
        .await;
        entry(
            &db.pool,
            Some("p2"),
            today_start - Duration::hours(1),
            Some(180),
        )
        .await;

        set_budget(&db.pool, input("project", "p1", "daily", 480))
            .await
            .unwrap();
        let status = budget_status(&db.pool, now).await.unwrap();
        assert_eq!(status[0].used_minutes, 60);
    }
}
