//! Pro rate model (#109): plugin-owned hourly rates with historical
//! effective-from dates, resolved **most-granular-wins** —
//! task ▸ project ▸ client ▸ workspace. All money lives here; core stays
//! money-free. Rates are stored as integer minor units of an ISO 4217
//! currency so amounts are never floats.

use serde::Serialize;
use sqlx::{Row, SqlitePool};

use super::err;

/// A stored hourly rate. `amount_cents` is minor units of `currency`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Rate {
    pub id: String,
    pub scope_type: String,
    /// Empty for the `workspace` default; the client/project/task id otherwise.
    pub scope_id: String,
    pub amount_cents: i64,
    pub currency: String,
    /// ISO date (`YYYY-MM-DD`); the rate applies to work on or after it.
    pub effective_from: String,
    pub created_at: String,
}

/// The rate that applies to a piece of work, plus which scope supplied it
/// (so the UI can explain "billed at the project rate").
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedRate {
    pub amount_cents: i64,
    pub currency: String,
    pub scope_type: String,
    pub effective_from: String,
}

const SCOPES: [&str; 4] = ["workspace", "client", "project", "task"];

/// A more-specific scope outranks a broader one regardless of dates —
/// most-granular-wins. Ordered so a `(priority, effective_from)` tuple
/// sorts to the applicable rate.
fn scope_priority(scope_type: &str) -> u8 {
    match scope_type {
        "task" => 3,
        "project" => 2,
        "client" => 1,
        _ => 0, // workspace
    }
}

/// Validate the scope and canonicalize its id: the workspace default is a
/// singleton (id always empty); every other scope needs a non-empty id.
fn normalize_scope(scope_type: &str, scope_id: &str) -> Result<(String, String), String> {
    if !SCOPES.contains(&scope_type) {
        return Err(format!("unknown rate scope: {scope_type}"));
    }
    if scope_type == "workspace" {
        return Ok(("workspace".into(), String::new()));
    }
    let id = scope_id.trim();
    if id.is_empty() {
        return Err(format!("a {scope_type} rate needs a {scope_type} id"));
    }
    Ok((scope_type.into(), id.into()))
}

/// Accept any case, store the canonical 3-letter ISO 4217 code.
fn normalize_currency(currency: &str) -> Result<String, String> {
    let c = currency.trim().to_ascii_uppercase();
    if c.len() == 3 && c.bytes().all(|b| b.is_ascii_alphabetic()) {
        Ok(c)
    } else {
        Err(format!(
            "currency must be a 3-letter code (got {currency:?})"
        ))
    }
}

fn validate_date(effective_from: &str) -> Result<String, String> {
    let d = effective_from.trim();
    chrono::NaiveDate::parse_from_str(d, "%Y-%m-%d")
        .map_err(|_| format!("effective_from must be YYYY-MM-DD (got {effective_from:?})"))?;
    Ok(d.to_string())
}

/// The instant to price against — an ISO 8601 date or timestamp. Only the
/// leading `YYYY-MM-DD` is validated; the remainder is compared
/// lexicographically against `effective_from`, which is sound because ISO
/// 8601's textual order is chronological. Note the comparison is on the
/// *written* calendar date, so an offset timestamp resolves against its
/// local date rather than its UTC instant — intended for a calendar-date
/// rate model.
fn validate_at(at: &str) -> Result<String, String> {
    let at = at.trim();
    let head = at
        .get(..10)
        .ok_or_else(|| format!("`at` must be an ISO 8601 date or timestamp (got {at:?})"))?;
    chrono::NaiveDate::parse_from_str(head, "%Y-%m-%d")
        .map_err(|_| format!("`at` must be an ISO 8601 date or timestamp (got {at:?})"))?;
    Ok(at.to_string())
}

fn row_to_rate(r: &sqlx::sqlite::SqliteRow) -> Rate {
    Rate {
        id: r.get("id"),
        scope_type: r.get("scope_type"),
        scope_id: r.get("scope_id"),
        amount_cents: r.get("amount_cents"),
        currency: r.get("currency"),
        effective_from: r.get("effective_from"),
        created_at: r.get("created_at"),
    }
}

/// Set the rate for a scope effective from a date. A second call with the
/// same scope and date updates the amount/currency in place (one rate per
/// scope per effective date) rather than stacking duplicates.
pub async fn set_rate(
    pool: &SqlitePool,
    scope_type: &str,
    scope_id: &str,
    amount_cents: i64,
    currency: &str,
    effective_from: &str,
) -> Result<Rate, String> {
    if amount_cents < 0 {
        return Err("a rate can't be negative".into());
    }
    let (scope_type, scope_id) = normalize_scope(scope_type, scope_id)?;
    let currency = normalize_currency(currency)?;
    let effective_from = validate_date(effective_from)?;
    let id = uuid::Uuid::new_v4().to_string();
    let row = sqlx::query(
        "INSERT INTO billing_rates \
           (id, scope_type, scope_id, amount_cents, currency, effective_from) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6) \
         ON CONFLICT(scope_type, scope_id, effective_from) DO UPDATE SET \
           amount_cents = excluded.amount_cents, currency = excluded.currency \
         RETURNING id, scope_type, scope_id, amount_cents, currency, effective_from, created_at",
    )
    .bind(&id)
    .bind(&scope_type)
    .bind(&scope_id)
    .bind(amount_cents)
    .bind(&currency)
    .bind(&effective_from)
    .fetch_one(pool)
    .await
    .map_err(err)?;
    Ok(row_to_rate(&row))
}

/// Every configured rate, grouped by scope with the newest effective date
/// first — the shape the rate table renders.
pub async fn list_rates(pool: &SqlitePool) -> Result<Vec<Rate>, String> {
    let rows = sqlx::query(
        "SELECT id, scope_type, scope_id, amount_cents, currency, effective_from, created_at \
           FROM billing_rates \
          ORDER BY scope_type, scope_id, effective_from DESC",
    )
    .fetch_all(pool)
    .await
    .map_err(err)?;
    Ok(rows.iter().map(row_to_rate).collect())
}

pub async fn delete_rate(pool: &SqlitePool, id: &str) -> Result<(), String> {
    sqlx::query("DELETE FROM billing_rates WHERE id = ?1")
        .bind(id)
        .execute(pool)
        .await
        .map_err(err)?;
    Ok(())
}

struct Candidate {
    priority: u8,
    effective_from: String,
    amount_cents: i64,
    currency: String,
    scope_type: String,
}

/// The rate that applies to work at `at` for a given client/project/task,
/// or `None` if nothing is configured. Most-granular-wins: the most
/// specific scope with *any* rate effective on or before `at` supplies it,
/// and within that scope the latest such effective date is used — so a
/// task rate set years ago still beats a fresh client rate, and re-pricing
/// forward never rewrites history. Absent scopes (`None`) match nothing.
pub async fn resolve_rate(
    pool: &SqlitePool,
    client_id: Option<&str>,
    project_id: Option<&str>,
    task_id: Option<&str>,
    at: &str,
) -> Result<Option<ResolvedRate>, String> {
    let at = validate_at(at)?;
    // A NULL bind never matches `scope_id = ?`, so an absent scope drops
    // out of the query naturally; the workspace clause needs no id.
    let rows = sqlx::query(
        "SELECT scope_type, amount_cents, currency, effective_from \
           FROM billing_rates \
          WHERE effective_from <= ?1 \
            AND ( scope_type = 'workspace' \
               OR (scope_type = 'client'  AND scope_id = ?2) \
               OR (scope_type = 'project' AND scope_id = ?3) \
               OR (scope_type = 'task'    AND scope_id = ?4) )",
    )
    .bind(&at)
    .bind(client_id)
    .bind(project_id)
    .bind(task_id)
    .fetch_all(pool)
    .await
    .map_err(err)?;

    let best = rows
        .into_iter()
        .map(|r| {
            let scope_type: String = r.get("scope_type");
            Candidate {
                priority: scope_priority(&scope_type),
                effective_from: r.get("effective_from"),
                amount_cents: r.get("amount_cents"),
                currency: r.get("currency"),
                scope_type,
            }
        })
        .max_by(|a, b| {
            (a.priority, a.effective_from.as_str()).cmp(&(b.priority, b.effective_from.as_str()))
        });

    Ok(best.map(|c| ResolvedRate {
        amount_cents: c.amount_cents,
        currency: c.currency,
        scope_type: c.scope_type,
        effective_from: c.effective_from,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::test_db;

    #[tokio::test]
    async fn set_rate_stores_normalizes_and_lists() {
        let (_dir, db) = test_db().await;
        let r = set_rate(&db.pool, "workspace", "ignored", 12000, "usd", "2026-01-01")
            .await
            .unwrap();
        // Workspace id is canonicalized to empty; currency upper-cased.
        assert_eq!(r.scope_id, "");
        assert_eq!(r.currency, "USD");
        assert_eq!(r.amount_cents, 12000);

        let all = list_rates(&db.pool).await.unwrap();
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].scope_type, "workspace");
    }

    #[tokio::test]
    async fn set_rate_upserts_the_same_scope_and_date() {
        let (_dir, db) = test_db().await;
        set_rate(&db.pool, "client", "c1", 10000, "EUR", "2026-01-01")
            .await
            .unwrap();
        set_rate(&db.pool, "client", "c1", 11000, "EUR", "2026-01-01")
            .await
            .unwrap();
        let all = list_rates(&db.pool).await.unwrap();
        assert_eq!(all.len(), 1, "same scope + date updates in place");
        assert_eq!(all[0].amount_cents, 11000);
    }

    #[tokio::test]
    async fn set_rate_rejects_bad_input() {
        let (_dir, db) = test_db().await;
        assert!(set_rate(&db.pool, "client", "c1", -1, "USD", "2026-01-01")
            .await
            .unwrap_err()
            .contains("negative"));
        assert!(set_rate(&db.pool, "planet", "c1", 100, "USD", "2026-01-01")
            .await
            .unwrap_err()
            .contains("unknown rate scope"));
        assert!(set_rate(&db.pool, "client", "  ", 100, "USD", "2026-01-01")
            .await
            .unwrap_err()
            .contains("needs a client id"));
        assert!(set_rate(&db.pool, "client", "c1", 100, "US", "2026-01-01")
            .await
            .unwrap_err()
            .contains("3-letter code"));
        // 3 chars but not all alphabetic — exercises the letter check itself.
        assert!(set_rate(&db.pool, "client", "c1", 100, "US1", "2026-01-01")
            .await
            .unwrap_err()
            .contains("3-letter code"));
        assert!(set_rate(&db.pool, "client", "c1", 100, "USD", "01-2026")
            .await
            .unwrap_err()
            .contains("YYYY-MM-DD"));
    }

    #[tokio::test]
    async fn delete_rate_removes_it() {
        let (_dir, db) = test_db().await;
        let r = set_rate(&db.pool, "project", "p1", 9000, "USD", "2026-01-01")
            .await
            .unwrap();
        delete_rate(&db.pool, &r.id).await.unwrap();
        assert!(list_rates(&db.pool).await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn resolve_prefers_the_most_granular_scope() {
        let (_dir, db) = test_db().await;
        set_rate(&db.pool, "workspace", "", 5000, "USD", "2026-01-01")
            .await
            .unwrap();
        set_rate(&db.pool, "client", "c1", 8000, "USD", "2026-01-01")
            .await
            .unwrap();
        set_rate(&db.pool, "project", "p1", 10000, "USD", "2026-01-01")
            .await
            .unwrap();
        set_rate(&db.pool, "task", "t1", 15000, "USD", "2026-01-01")
            .await
            .unwrap();

        let full = resolve_rate(&db.pool, Some("c1"), Some("p1"), Some("t1"), "2026-06-01")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(full.scope_type, "task");
        assert_eq!(full.amount_cents, 15000);

        // Drop the task ⇒ project rate; drop the project ⇒ client; then workspace.
        let proj = resolve_rate(&db.pool, Some("c1"), Some("p1"), None, "2026-06-01")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(proj.scope_type, "project");
        let client = resolve_rate(&db.pool, Some("c1"), None, None, "2026-06-01")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(client.scope_type, "client");
        let ws = resolve_rate(&db.pool, None, None, None, "2026-06-01")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(ws.scope_type, "workspace");
    }

    #[tokio::test]
    async fn resolve_uses_the_rate_effective_at_the_work_date() {
        let (_dir, db) = test_db().await;
        set_rate(&db.pool, "project", "p1", 10000, "USD", "2026-01-01")
            .await
            .unwrap();
        set_rate(&db.pool, "project", "p1", 12000, "USD", "2026-07-01")
            .await
            .unwrap();

        // Work in spring bills at the old rate; the July raise applies only
        // to work on or after it — history is never rewritten.
        let spring = resolve_rate(&db.pool, None, Some("p1"), None, "2026-05-15")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(spring.amount_cents, 10000);
        let summer = resolve_rate(&db.pool, None, Some("p1"), None, "2026-07-01")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(summer.amount_cents, 12000);
    }

    #[tokio::test]
    async fn resolve_ignores_rates_that_are_not_yet_effective() {
        let (_dir, db) = test_db().await;
        set_rate(&db.pool, "project", "p1", 10000, "USD", "2026-07-01")
            .await
            .unwrap();
        // Work before the only rate's effective date has no applicable rate.
        let none = resolve_rate(&db.pool, None, Some("p1"), None, "2026-06-30")
            .await
            .unwrap();
        assert!(none.is_none());
    }

    #[tokio::test]
    async fn granularity_beats_a_newer_broader_rate() {
        let (_dir, db) = test_db().await;
        // An old task rate and a much newer client rate.
        set_rate(&db.pool, "task", "t1", 15000, "USD", "2025-01-01")
            .await
            .unwrap();
        set_rate(&db.pool, "client", "c1", 9000, "USD", "2026-07-01")
            .await
            .unwrap();
        let r = resolve_rate(&db.pool, Some("c1"), Some("p1"), Some("t1"), "2026-07-15")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            r.scope_type, "task",
            "most-granular wins regardless of date"
        );
        assert_eq!(r.amount_cents, 15000);
    }

    #[tokio::test]
    async fn resolve_accepts_a_timestamp_and_returns_none_when_unconfigured() {
        let (_dir, db) = test_db().await;
        assert!(resolve_rate(&db.pool, Some("c1"), None, None, "2026-06-01")
            .await
            .unwrap()
            .is_none());

        set_rate(&db.pool, "client", "c1", 8000, "USD", "2026-06-01")
            .await
            .unwrap();
        // An RFC3339 timestamp on the effective date resolves (lexicographic
        // order == chronological order).
        let r = resolve_rate(
            &db.pool,
            Some("c1"),
            None,
            None,
            "2026-06-01T09:30:00+00:00",
        )
        .await
        .unwrap()
        .unwrap();
        assert_eq!(r.amount_cents, 8000);
        assert_eq!(r.currency, "USD");
        assert_eq!(r.effective_from, "2026-06-01");
    }

    #[tokio::test]
    async fn resolve_rejects_a_malformed_at() {
        let (_dir, db) = test_db().await;
        // Too short to slice a date head from.
        assert!(resolve_rate(&db.pool, None, None, None, "yesterday")
            .await
            .unwrap_err()
            .contains("ISO 8601"));
        assert!(resolve_rate(&db.pool, None, None, None, "2026")
            .await
            .unwrap_err()
            .contains("ISO 8601"));
        // Long enough to slice, but not a real date — exercises the parse.
        assert!(resolve_rate(&db.pool, None, None, None, "2026-13-40")
            .await
            .unwrap_err()
            .contains("ISO 8601"));
    }
}
