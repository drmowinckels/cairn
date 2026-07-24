//! Pro profitability report (#109): the first consumer of the rate model.
//! Over a date range it prices every billable entry at the rate in effect
//! on its start date (most-granular-wins, historical) and rolls the result
//! up by project — billable vs non-billable hours and billable amounts.
//!
//! Amounts never cross currencies: a rate carries its own currency, so
//! totals are grouped *by currency* (one bucket in the common single-
//! currency case). Billable time with no rate configured is reported
//! separately as `unrated_billable_seconds` — hours you could bill but the
//! report can't price yet.

use std::collections::BTreeMap;

use chrono::{DateTime, Utc};
use serde::Serialize;
use sqlx::{Row, SqlitePool};

use super::err;
use super::rates::{amount_cents, list_rates, resolve_from, Rate};
use crate::ipc::parse_ts;
use crate::rounding::{effective_rounding, project_rounding_from_row, Rounding};

/// A billable subtotal in a single currency (amounts never mix currencies).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CurrencyAmount {
    pub currency: String,
    pub amount_cents: i64,
    /// The billable seconds that produced this amount (excludes unrated time).
    pub billable_seconds: i64,
}

/// One project's slice of the report. Grouping mirrors the time reports:
/// the local project when present, else the remote-task project name (#110),
/// else the no-project bucket (`project_id` and `remote_project_name` both
/// `None`).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectProfit {
    pub project_id: Option<String>,
    pub remote_project_name: Option<String>,
    pub billable_seconds: i64,
    pub nonbillable_seconds: i64,
    pub unrated_billable_seconds: i64,
    pub amounts: Vec<CurrencyAmount>,
}

/// The whole report for a range.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfitabilityReport {
    pub from: String,
    pub to: String,
    pub billable_seconds: i64,
    pub nonbillable_seconds: i64,
    pub unrated_billable_seconds: i64,
    pub totals: Vec<CurrencyAmount>,
    pub by_project: Vec<ProjectProfit>,
}

/// One entry reduced to what pricing needs: its scope ids (client via its
/// project), billable flag, project rounding override, and a concrete span.
struct ProfitRow {
    project_id: Option<String>,
    client_id: Option<String>,
    task_id: Option<String>,
    remote_project_name: Option<String>,
    billable: bool,
    project_rounding: Option<Rounding>,
    /// The raw stored `started_at` (UTC), used verbatim to resolve the rate
    /// in effect on the entry's recorded date. The report *window* is local,
    /// so a near-midnight entry on the exact day a rate changes could be
    /// priced on the neighbouring UTC date — a rare, deliberate trade for a
    /// stable, timezone-independent pricing date.
    started_raw: String,
    start: DateTime<Utc>,
    end: DateTime<Utc>,
}

async fn fetch_profit_rows(
    pool: &SqlitePool,
    start_utc: DateTime<Utc>,
    end_utc: DateTime<Utc>,
    now: DateTime<Utc>,
) -> Result<Vec<ProfitRow>, String> {
    let sqlrows = sqlx::query(
        r#"
        SELECT e.project_id,
               e.task_id,
               e.billable,
               e.started_at,
               e.ended_at,
               p.client_id,
               p.rounding_interval_minutes,
               p.rounding_mode,
               t.remote_project_name
          FROM entries e
          LEFT JOIN projects p ON p.id = e.project_id
          LEFT JOIN tasks t ON t.id = e.task_id
         WHERE e.started_at >= ?1 AND e.started_at < ?2
        "#,
    )
    .bind(start_utc.to_rfc3339())
    .bind(end_utc.to_rfc3339())
    .fetch_all(pool)
    .await
    .map_err(err)?;

    let mut rows = Vec::with_capacity(sqlrows.len());
    for row in sqlrows {
        let started_raw: String = row.get("started_at");
        let start = parse_ts(&started_raw)?;
        let end = match row.get::<Option<String>, _>("ended_at") {
            Some(s) => parse_ts(s)?,
            None => now,
        };
        rows.push(ProfitRow {
            project_id: row.get("project_id"),
            client_id: row.get("client_id"),
            task_id: row.get("task_id"),
            remote_project_name: row.get("remote_project_name"),
            billable: row.get::<i64, _>("billable") != 0,
            project_rounding: project_rounding_from_row(&row),
            started_raw,
            start,
            end,
        });
    }
    Ok(rows)
}

/// The grouping key: local project id, else remote project name, else the
/// no-project bucket. Mirrors the time report's `ReportGroup`.
type GroupKey = (Option<String>, Option<String>);

fn group_key(r: &ProfitRow) -> GroupKey {
    match (&r.project_id, &r.remote_project_name) {
        (Some(id), _) => (Some(id.clone()), None),
        (None, Some(name)) => (None, Some(name.clone())),
        (None, None) => (None, None),
    }
}

#[derive(Default)]
struct Accum {
    billable_seconds: i64,
    nonbillable_seconds: i64,
    unrated_billable_seconds: i64,
    /// currency → (amount_cents, billable_seconds)
    by_currency: BTreeMap<String, (i64, i64)>,
}

fn to_amounts(by_currency: BTreeMap<String, (i64, i64)>) -> Vec<CurrencyAmount> {
    by_currency
        .into_iter()
        .map(
            |(currency, (amount_cents, billable_seconds))| CurrencyAmount {
                currency,
                amount_cents,
                billable_seconds,
            },
        )
        .collect()
}

/// Pure aggregation: price each row against `rates` and roll up by project
/// and (within billable amounts) by currency.
fn compute(
    rows: &[ProfitRow],
    rates: &[Rate],
    global_rounding: Rounding,
    from: String,
    to: String,
) -> ProfitabilityReport {
    let mut groups: BTreeMap<GroupKey, Accum> = BTreeMap::new();
    // Top-level currency totals, summed across every project.
    let mut totals: BTreeMap<String, (i64, i64)> = BTreeMap::new();
    let mut billable_seconds = 0;
    let mut nonbillable_seconds = 0;
    let mut unrated_billable_seconds = 0;

    for r in rows {
        // `round_secs` clamps a non-positive span (end < start) to 0.
        let secs = effective_rounding(r.project_rounding, global_rounding)
            .round_secs((r.end - r.start).num_seconds());
        // Drop zero-length spans (and time that rounds away) before they touch
        // a group — matching the time report, so a project never appears with
        // an all-zero slice and no spurious $0 currency total is emitted.
        if secs == 0 {
            continue;
        }
        let acc = groups.entry(group_key(r)).or_default();

        if !r.billable {
            acc.nonbillable_seconds += secs;
            nonbillable_seconds += secs;
            continue;
        }

        acc.billable_seconds += secs;
        billable_seconds += secs;
        match resolve_from(
            rates,
            r.client_id.as_deref(),
            r.project_id.as_deref(),
            r.task_id.as_deref(),
            &r.started_raw,
        ) {
            Some(rate) => {
                let cents = amount_cents(rate.amount_cents, secs);
                let e = acc.by_currency.entry(rate.currency.clone()).or_default();
                e.0 += cents;
                e.1 += secs;
                let t = totals.entry(rate.currency).or_default();
                t.0 += cents;
                t.1 += secs;
            }
            None => {
                acc.unrated_billable_seconds += secs;
                unrated_billable_seconds += secs;
            }
        }
    }

    let by_project = groups
        .into_iter()
        .map(|((project_id, remote_project_name), acc)| ProjectProfit {
            project_id,
            remote_project_name,
            billable_seconds: acc.billable_seconds,
            nonbillable_seconds: acc.nonbillable_seconds,
            unrated_billable_seconds: acc.unrated_billable_seconds,
            amounts: to_amounts(acc.by_currency),
        })
        .collect();

    ProfitabilityReport {
        from,
        to,
        billable_seconds,
        nonbillable_seconds,
        unrated_billable_seconds,
        totals: to_amounts(totals),
        by_project,
    }
}

/// Build the report for `[start_utc, end_utc)`. Loads the rate set once and
/// prices every entry against it in memory (not a query per entry).
pub async fn profitability(
    pool: &SqlitePool,
    start_utc: DateTime<Utc>,
    end_utc: DateTime<Utc>,
    from: String,
    to: String,
    global_rounding: Rounding,
    now: DateTime<Utc>,
) -> Result<ProfitabilityReport, String> {
    let rows = fetch_profit_rows(pool, start_utc, end_utc, now).await?;
    let rates = list_rates(pool).await?;
    Ok(compute(&rows, &rates, global_rounding, from, to))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rounding::RoundMode;
    use crate::test_support::test_db;

    fn ts(day: &str) -> DateTime<Utc> {
        parse_ts(format!("{day}T09:00:00+00:00")).unwrap()
    }

    fn row(
        project_id: Option<&str>,
        client_id: Option<&str>,
        task_id: Option<&str>,
        billable: bool,
        start: &str,
        minutes: i64,
    ) -> ProfitRow {
        let start_dt = ts(start);
        ProfitRow {
            project_id: project_id.map(Into::into),
            client_id: client_id.map(Into::into),
            task_id: task_id.map(Into::into),
            remote_project_name: None,
            billable,
            project_rounding: None,
            started_raw: format!("{start}T09:00:00+00:00"),
            start: start_dt,
            end: start_dt + chrono::Duration::minutes(minutes),
        }
    }

    fn rate(scope_type: &str, scope_id: &str, cents: i64, currency: &str, from: &str) -> Rate {
        Rate {
            id: format!("{scope_type}-{scope_id}-{from}"),
            scope_type: scope_type.into(),
            scope_id: scope_id.into(),
            amount_cents: cents,
            currency: currency.into(),
            effective_from: from.into(),
            created_at: "x".into(),
        }
    }

    fn off() -> Rounding {
        Rounding::off()
    }

    #[test]
    fn prices_billable_time_and_separates_nonbillable() {
        let rows = vec![
            row(Some("p1"), Some("c1"), None, true, "2026-07-01", 60),
            row(Some("p1"), Some("c1"), None, false, "2026-07-02", 30),
        ];
        let rates = vec![rate("project", "p1", 12000, "USD", "2026-01-01")];
        let rep = compute(&rows, &rates, off(), "a".into(), "b".into());

        assert_eq!(rep.billable_seconds, 3600);
        assert_eq!(rep.nonbillable_seconds, 1800);
        assert_eq!(rep.unrated_billable_seconds, 0);
        assert_eq!(rep.totals.len(), 1);
        assert_eq!(rep.totals[0].currency, "USD");
        assert_eq!(rep.totals[0].amount_cents, 12000);
        assert_eq!(rep.by_project.len(), 1);
        let p = &rep.by_project[0];
        assert_eq!(p.project_id.as_deref(), Some("p1"));
        assert_eq!(p.billable_seconds, 3600);
        assert_eq!(p.nonbillable_seconds, 1800);
        assert_eq!(p.amounts[0].amount_cents, 12000);
    }

    #[test]
    fn billable_time_with_no_rate_is_unrated_not_zero() {
        let rows = vec![row(Some("p1"), None, None, true, "2026-07-01", 60)];
        let rep = compute(&rows, &[], off(), "a".into(), "b".into());
        assert_eq!(rep.billable_seconds, 3600);
        assert_eq!(rep.unrated_billable_seconds, 3600);
        assert!(rep.totals.is_empty(), "nothing priced");
        assert_eq!(rep.by_project[0].unrated_billable_seconds, 3600);
    }

    #[test]
    fn uses_the_rate_effective_on_the_entry_date() {
        let rows = vec![
            row(Some("p1"), None, None, true, "2026-05-15", 60),
            row(Some("p1"), None, None, true, "2026-08-15", 60),
        ];
        let rates = vec![
            rate("project", "p1", 10000, "USD", "2026-01-01"),
            rate("project", "p1", 12000, "USD", "2026-07-01"),
        ];
        let rep = compute(&rows, &rates, off(), "a".into(), "b".into());
        // Spring hour billed at 100, summer hour at 120 → 220 total.
        assert_eq!(rep.totals[0].amount_cents, 22000);
    }

    #[test]
    fn never_sums_across_currencies() {
        let rows = vec![
            row(Some("p1"), None, None, true, "2026-07-01", 60),
            row(Some("p2"), None, None, true, "2026-07-01", 60),
        ];
        let rates = vec![
            rate("project", "p1", 10000, "USD", "2026-01-01"),
            rate("project", "p2", 9000, "EUR", "2026-01-01"),
        ];
        let rep = compute(&rows, &rates, off(), "a".into(), "b".into());
        assert_eq!(rep.totals.len(), 2, "one bucket per currency");
        let usd = rep.totals.iter().find(|t| t.currency == "USD").unwrap();
        let eur = rep.totals.iter().find(|t| t.currency == "EUR").unwrap();
        assert_eq!(usd.amount_cents, 10000);
        assert_eq!(eur.amount_cents, 9000);
    }

    #[test]
    fn rounding_applies_before_pricing() {
        // 8 real minutes, nearest-15 → 15 min billed; $120/hr → $30.00.
        let rows = vec![row(Some("p1"), None, None, true, "2026-07-01", 8)];
        let rates = vec![rate("project", "p1", 12000, "USD", "2026-01-01")];
        let nearest_15 = Rounding {
            interval_minutes: 15,
            mode: RoundMode::Nearest,
        };
        let rep = compute(&rows, &rates, nearest_15, "a".into(), "b".into());
        assert_eq!(rep.billable_seconds, 900);
        assert_eq!(rep.totals[0].amount_cents, 3000);
    }

    #[test]
    fn skips_entries_that_round_away_to_zero() {
        // 5 min under nearest-15 rounds to 0: no phantom project, no $0 total.
        let rows = vec![row(Some("p1"), None, None, true, "2026-07-01", 5)];
        let rates = vec![rate("project", "p1", 12000, "USD", "2026-01-01")];
        let nearest_15 = Rounding {
            interval_minutes: 15,
            mode: RoundMode::Nearest,
        };
        let rep = compute(&rows, &rates, nearest_15, "a".into(), "b".into());
        assert_eq!(rep.billable_seconds, 0);
        assert!(rep.totals.is_empty(), "no phantom $0 currency total");
        assert!(rep.by_project.is_empty(), "no phantom project slice");
    }

    #[test]
    fn groups_entries_without_a_project_into_their_own_bucket() {
        let rows = vec![row(None, None, None, true, "2026-07-01", 60)];
        let rep = compute(&rows, &[], off(), "a".into(), "b".into());
        assert_eq!(rep.by_project.len(), 1);
        assert!(rep.by_project[0].project_id.is_none());
        assert!(rep.by_project[0].remote_project_name.is_none());
    }

    #[tokio::test]
    async fn profitability_reads_seeded_entries_end_to_end() {
        let (_dir, db) = test_db().await;
        let now = "2026-07-01T00:00:00+00:00";
        sqlx::query(
            "INSERT INTO clients (id, name, created_at, updated_at) VALUES ('c1','Acme',?1,?1)",
        )
        .bind(now)
        .execute(&db.pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO projects (id, name, client_id, color, archived, billable_default, created_at, updated_at) \
             VALUES ('p1','Site','c1','#000',0,1,?1,?1)",
        ).bind(now).execute(&db.pool).await.unwrap();
        sqlx::query(
            "INSERT INTO entries (id, project_id, task_id, description, started_at, ended_at, source, billable, created_at, updated_at) \
             VALUES ('e1','p1',NULL,'work','2026-07-01T09:00:00+00:00','2026-07-01T10:00:00+00:00','manual',1,?1,?1)",
        ).bind(now).execute(&db.pool).await.unwrap();
        super::super::rates::set_rate(&db.pool, "client", "c1", 15000, "USD", "2026-01-01")
            .await
            .unwrap();

        let start = ts("2026-07-01");
        let end = ts("2026-07-31");
        let rep = profitability(
            &db.pool,
            start,
            end,
            "2026-07-01".into(),
            "2026-07-31".into(),
            off(),
            Utc::now(),
        )
        .await
        .unwrap();

        // One billable hour at the client's $150 rate.
        assert_eq!(rep.billable_seconds, 3600);
        assert_eq!(rep.totals[0].amount_cents, 15000);
        assert_eq!(rep.by_project[0].project_id.as_deref(), Some("p1"));
    }

    #[test]
    fn groups_remote_task_entries_by_project_name() {
        let start = ts("2026-07-01");
        let remote = ProfitRow {
            project_id: None,
            client_id: None,
            task_id: Some("t1".into()),
            remote_project_name: Some("GitHub: cairn".into()),
            billable: false,
            project_rounding: None,
            started_raw: "2026-07-01T09:00:00+00:00".into(),
            start,
            end: start + chrono::Duration::minutes(30),
        };
        let rep = compute(&[remote], &[], off(), "a".into(), "b".into());
        assert_eq!(rep.by_project.len(), 1);
        assert!(rep.by_project[0].project_id.is_none());
        assert_eq!(
            rep.by_project[0].remote_project_name.as_deref(),
            Some("GitHub: cairn")
        );
        assert_eq!(rep.by_project[0].nonbillable_seconds, 1800);
    }

    #[tokio::test]
    async fn profitability_measures_an_open_entry_to_now() {
        let (_dir, db) = test_db().await;
        let now = Utc::now();
        let started = (now - chrono::Duration::minutes(45)).to_rfc3339();
        sqlx::query(
            "INSERT INTO entries (id, project_id, task_id, description, started_at, ended_at, source, billable, created_at, updated_at) \
             VALUES ('open', NULL, NULL, '', ?1, NULL, 'manual', 0, ?1, ?1)",
        )
        .bind(&started)
        .execute(&db.pool)
        .await
        .unwrap();

        // A window wide enough to contain `now`; the open entry measures to it.
        let rep = profitability(
            &db.pool,
            ts("2020-01-01"),
            ts("2100-01-01"),
            "a".into(),
            "b".into(),
            off(),
            now,
        )
        .await
        .unwrap();
        assert_eq!(rep.nonbillable_seconds, 2700);
    }
}
