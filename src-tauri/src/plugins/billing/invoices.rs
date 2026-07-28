//! Pro invoices (#1): turn a client's billable, priced time over a date
//! range into a stored document. One line per project, priced at each
//! entry's historical rate, in a single currency. The client name and all
//! amounts are snapshotted so a past invoice stays reproducible. All money
//! lives here; core has none.

use std::collections::BTreeMap;

use chrono::{DateTime, Utc};
use serde::Serialize;
use sqlx::{Row, SqlitePool};

use super::err;
use super::rates::{amount_cents, list_rates, resolve_from, Rate};
use crate::ipc::parse_ts;
use crate::rounding::{effective_rounding, project_rounding_from_row, Rounding};

/// One invoice line: a project's billable time and what it bills to.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InvoiceLine {
    pub id: String,
    pub description: String,
    pub seconds: i64,
    pub amount_cents: i64,
    pub sort: i64,
}

/// A stored invoice with its lines.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Invoice {
    pub id: String,
    pub number: String,
    pub client_id: String,
    pub client_name: String,
    pub currency: String,
    pub issue_date: String,
    pub from_date: String,
    pub to_date: String,
    pub tax_rate_bps: i64,
    pub subtotal_cents: i64,
    pub tax_cents: i64,
    pub total_cents: i64,
    /// Billable time in range that had no rate — uninvoiced, flagged for the UI.
    pub unrated_seconds: i64,
    pub status: String,
    pub notes: Option<String>,
    pub created_at: String,
    pub lines: Vec<InvoiceLine>,
}

/// The list row — an invoice without its lines.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InvoiceSummary {
    pub id: String,
    pub number: String,
    pub client_name: String,
    pub currency: String,
    pub issue_date: String,
    pub total_cents: i64,
    pub status: String,
}

/// One billable entry reduced to what pricing a line needs.
struct InvoiceRow {
    entry_id: String,
    project_id: String,
    task_id: Option<String>,
    project_name: String,
    project_rounding: Option<Rounding>,
    started_raw: String,
    start: DateTime<Utc>,
    end: DateTime<Utc>,
}

struct DraftLine {
    description: String,
    seconds: i64,
    amount_cents: i64,
}

struct Built {
    currency: String,
    lines: Vec<DraftLine>,
    unrated_seconds: i64,
    /// The entries that landed on a priced line — recorded against the
    /// invoice so an overlapping range never bills them twice. Unrated and
    /// zero-rounded entries are deliberately absent: they weren't billed, so
    /// they stay available to a future (priced) invoice.
    billed_entry_ids: Vec<String>,
}

/// Price a client's billable rows into one line per project, in a single
/// currency. Errors if the priced time spans more than one currency — an
/// invoice is a single currency. Billable time with no rate is set aside as
/// `unrated_seconds` (it can't be priced, so it never lands on the invoice).
fn build_lines_from(
    rows: &[InvoiceRow],
    client_id: &str,
    rates: &[Rate],
    global_rounding: Rounding,
) -> Result<Built, String> {
    // Preserve project order by name for a stable invoice.
    let mut by_project: BTreeMap<String, (i64, i64)> = BTreeMap::new();
    let mut currency: Option<String> = None;
    let mut unrated_seconds = 0;
    let mut billed_entry_ids = Vec::new();

    for r in rows {
        let secs = effective_rounding(r.project_rounding, global_rounding)
            .round_secs((r.end - r.start).num_seconds());
        if secs == 0 {
            continue;
        }
        match resolve_from(
            rates,
            Some(client_id),
            Some(&r.project_id),
            r.task_id.as_deref(),
            &r.started_raw,
        ) {
            Some(rate) => {
                match &currency {
                    Some(c) if c != &rate.currency => {
                        return Err(format!(
                            "this range mixes currencies ({c} and {}); \
                             invoice one currency at a time",
                            rate.currency
                        ));
                    }
                    None => currency = Some(rate.currency.clone()),
                    _ => {}
                }
                let entry = by_project.entry(r.project_name.clone()).or_insert((0, 0));
                entry.0 += secs;
                entry.1 += amount_cents(rate.amount_cents, secs);
                billed_entry_ids.push(r.entry_id.clone());
            }
            None => unrated_seconds += secs,
        }
    }

    let lines = by_project
        .into_iter()
        .map(|(description, (seconds, amount_cents))| DraftLine {
            description,
            seconds,
            amount_cents,
        })
        .collect();
    Ok(Built {
        currency: currency.unwrap_or_default(),
        lines,
        unrated_seconds,
        billed_entry_ids,
    })
}

fn tax_cents(subtotal_cents: i64, tax_rate_bps: i64) -> i64 {
    (subtotal_cents as f64 * tax_rate_bps as f64 / 10_000.0).round() as i64
}

/// The `FROM`/`WHERE` selecting a client's completed, billable entries in
/// `[?2, ?3)` (bind `?1`=client, `?2`=from, `?3`=to). Shared by the exclusion
/// fetch and the "was it all already invoiced?" count so the two can't drift —
/// if they did, the diagnostic message would lie. It is a compile-time
/// constant, never user input, so interpolating it is injection-safe.
const BILLABLE_IN_RANGE: &str = "\
    FROM entries e \
    JOIN projects p ON p.id = e.project_id \
    WHERE p.client_id = ?1 AND e.billable = 1 AND e.ended_at IS NOT NULL \
      AND e.started_at >= ?2 AND e.started_at < ?3";

async fn fetch_invoice_rows(
    pool: &SqlitePool,
    client_id: &str,
    from_utc: DateTime<Utc>,
    to_utc: DateTime<Utc>,
) -> Result<Vec<InvoiceRow>, String> {
    // Only completed entries: a still-running timer isn't final work, so it
    // isn't invoiced (and can't be double-billed as it grows). Entries already
    // billed by an existing invoice are excluded, so overlapping ranges never
    // re-bill them; deleting that invoice cascades its ledger rows and frees
    // them again. The `NOT IN` is NULL-safe because `entry_id` is `NOT NULL`.
    let sql = format!(
        "SELECT e.id AS entry_id, e.project_id, e.task_id, e.started_at, e.ended_at, \
                p.name AS project_name, p.rounding_interval_minutes, p.rounding_mode \
         {BILLABLE_IN_RANGE} \
           AND e.id NOT IN (SELECT entry_id FROM billing_invoice_entries)"
    );
    let sqlrows = sqlx::query(&sql)
        .bind(client_id)
        .bind(from_utc.to_rfc3339())
        .bind(to_utc.to_rfc3339())
        .fetch_all(pool)
        .await
        .map_err(err)?;

    let mut rows = Vec::with_capacity(sqlrows.len());
    for row in sqlrows {
        let started_raw: String = row.get("started_at");
        let start = parse_ts(&started_raw)?;
        let ended_raw: String = row.get("ended_at");
        let end = parse_ts(&ended_raw)?;
        rows.push(InvoiceRow {
            entry_id: row.get("entry_id"),
            project_id: row.get("project_id"),
            task_id: row.get("task_id"),
            project_name: row.get("project_name"),
            project_rounding: project_rounding_from_row(&row),
            started_raw,
            start,
            end,
        });
    }
    Ok(rows)
}

/// Count the client's completed billable entries in range **ignoring** the
/// invoiced ledger — used only to explain an empty result: if there are some
/// but none were fetchable, they were all already invoiced.
async fn count_billable_in_range(
    pool: &SqlitePool,
    client_id: &str,
    from_utc: DateTime<Utc>,
    to_utc: DateTime<Utc>,
) -> Result<i64, String> {
    let sql = format!("SELECT COUNT(*) AS n {BILLABLE_IN_RANGE}");
    let n: i64 = sqlx::query(&sql)
        .bind(client_id)
        .bind(from_utc.to_rfc3339())
        .bind(to_utc.to_rfc3339())
        .fetch_one(pool)
        .await
        .map_err(err)?
        .get("n");
    Ok(n)
}

async fn client_name(pool: &SqlitePool, client_id: &str) -> Result<String, String> {
    sqlx::query("SELECT name FROM clients WHERE id = ?1")
        .bind(client_id)
        .fetch_optional(pool)
        .await
        .map_err(err)?
        .map(|r| r.get::<String, _>("name"))
        .ok_or_else(|| "unknown client".to_string())
}

/// Record each billed entry against the invoice on the given connection.
/// `entry_id` is the ledger's primary key, so a uniqueness violation means a
/// concurrent invoice already claimed that entry between the exclusion read
/// and now — surfaced as `already_invoiced` (identical to a serial retry over
/// an invoiced range) rather than a raw DB error, while the caller's
/// transaction rolls back. Any other DB error propagates unchanged.
async fn record_billed_entries(
    conn: &mut sqlx::SqliteConnection,
    invoice_id: &str,
    entry_ids: &[String],
    already_invoiced: String,
) -> Result<(), String> {
    for entry_id in entry_ids {
        if let Err(e) = sqlx::query(
            "INSERT INTO billing_invoice_entries (entry_id, invoice_id) VALUES (?1, ?2)",
        )
        .bind(entry_id)
        .bind(invoice_id)
        .execute(&mut *conn)
        .await
        {
            if e.as_database_error()
                .is_some_and(|d| d.is_unique_violation())
            {
                return Err(already_invoiced);
            }
            return Err(err(e));
        }
    }
    Ok(())
}

/// Generate and store an invoice for a client's billable, priced time in
/// `[from_utc, to_utc)`. Errors if that range has no priced time or mixes
/// currencies. `issue_date`/`from_date`/`to_date` are stored verbatim for
/// display; the UTC bounds drive the query.
#[allow(clippy::too_many_arguments)]
pub async fn create_invoice(
    pool: &SqlitePool,
    client_id: &str,
    from_date: &str,
    to_date: &str,
    from_utc: DateTime<Utc>,
    to_utc: DateTime<Utc>,
    issue_date: &str,
    tax_rate_bps: i64,
    notes: Option<&str>,
    global_rounding: Rounding,
    now: DateTime<Utc>,
) -> Result<Invoice, String> {
    if tax_rate_bps < 0 {
        return Err("tax rate can't be negative".into());
    }
    let name = client_name(pool, client_id).await?;
    let already_invoiced = || {
        format!(
            "all billable time for {name} between {from_date} and {to_date} \
             is already on an invoice"
        )
    };
    let rows = fetch_invoice_rows(pool, client_id, from_utc, to_utc).await?;
    let rates = list_rates(pool).await?;
    let built = build_lines_from(&rows, client_id, &rates, global_rounding)?;
    if built.lines.is_empty() {
        // Distinguish "nothing left to bill because it's all already invoiced"
        // from "no priced time here at all", so a retry over an invoiced range
        // doesn't read as if the time went missing.
        if rows.is_empty() && count_billable_in_range(pool, client_id, from_utc, to_utc).await? > 0
        {
            return Err(already_invoiced());
        }
        return Err(format!(
            "no billable, priced time for {name} between {from_date} and {to_date}"
        ));
    }

    let subtotal_cents: i64 = built.lines.iter().map(|l| l.amount_cents).sum();
    let tax = tax_cents(subtotal_cents, tax_rate_bps);
    let total_cents = subtotal_cents + tax;
    let id = uuid::Uuid::new_v4().to_string();
    let created_at = now.to_rfc3339();

    let mut tx = pool.begin().await.map_err(err)?;
    // Take the next number from the monotonic counter inside the transaction:
    // atomic against concurrent creates, and rolled back with the invoice on
    // failure, so a number is consumed only when its invoice is committed.
    let seq: i64 = sqlx::query(
        "UPDATE billing_invoice_seq SET next = next + 1 WHERE singleton = 1 \
         RETURNING next - 1 AS seq",
    )
    .fetch_one(&mut *tx)
    .await
    .map_err(err)?
    .get("seq");
    let number = format!("INV-{seq:04}");
    sqlx::query(
        "INSERT INTO billing_invoices \
           (id, seq, number, client_id, client_name, currency, issue_date, \
            from_date, to_date, tax_rate_bps, subtotal_cents, tax_cents, \
            total_cents, unrated_seconds, notes, created_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)",
    )
    .bind(&id)
    .bind(seq)
    .bind(&number)
    .bind(client_id)
    .bind(&name)
    .bind(&built.currency)
    .bind(issue_date)
    .bind(from_date)
    .bind(to_date)
    .bind(tax_rate_bps)
    .bind(subtotal_cents)
    .bind(tax)
    .bind(total_cents)
    .bind(built.unrated_seconds)
    .bind(notes)
    .bind(&created_at)
    .execute(&mut *tx)
    .await
    .map_err(err)?;

    // Build the returned lines as we insert, so the invoice is assembled from
    // exactly what was written — no re-read (and no unreachable "vanished").
    let mut lines = Vec::with_capacity(built.lines.len());
    for (i, line) in built.lines.iter().enumerate() {
        let sort = i as i64;
        let line_id = uuid::Uuid::new_v4().to_string();
        sqlx::query(
            "INSERT INTO billing_invoice_lines \
               (id, invoice_id, description, seconds, amount_cents, sort) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        )
        .bind(&line_id)
        .bind(&id)
        .bind(&line.description)
        .bind(line.seconds)
        .bind(line.amount_cents)
        .bind(sort)
        .execute(&mut *tx)
        .await
        .map_err(err)?;
        lines.push(InvoiceLine {
            id: line_id,
            description: line.description.clone(),
            seconds: line.seconds,
            amount_cents: line.amount_cents,
            sort,
        });
    }

    // Record which entries this invoice billed, in the same transaction, so a
    // later overlapping range excludes them. Rolled back with the invoice on
    // any failure, so the ledger never claims an entry for an uncommitted one.
    record_billed_entries(&mut tx, &id, &built.billed_entry_ids, already_invoiced()).await?;
    tx.commit().await.map_err(err)?;

    Ok(Invoice {
        id,
        number,
        client_id: client_id.to_string(),
        client_name: name,
        currency: built.currency,
        issue_date: issue_date.to_string(),
        from_date: from_date.to_string(),
        to_date: to_date.to_string(),
        tax_rate_bps,
        subtotal_cents,
        tax_cents: tax,
        total_cents,
        unrated_seconds: built.unrated_seconds,
        status: "draft".to_string(),
        notes: notes.map(str::to_string),
        created_at,
        lines,
    })
}

pub async fn list_invoices(pool: &SqlitePool) -> Result<Vec<InvoiceSummary>, String> {
    let rows = sqlx::query(
        "SELECT id, number, client_name, currency, issue_date, total_cents, status \
           FROM billing_invoices ORDER BY seq DESC",
    )
    .fetch_all(pool)
    .await
    .map_err(err)?;
    Ok(rows
        .iter()
        .map(|r| InvoiceSummary {
            id: r.get("id"),
            number: r.get("number"),
            client_name: r.get("client_name"),
            currency: r.get("currency"),
            issue_date: r.get("issue_date"),
            total_cents: r.get("total_cents"),
            status: r.get("status"),
        })
        .collect())
}

pub async fn get_invoice(pool: &SqlitePool, id: &str) -> Result<Option<Invoice>, String> {
    let Some(head) = sqlx::query(
        "SELECT id, number, client_id, client_name, currency, issue_date, \
                from_date, to_date, tax_rate_bps, subtotal_cents, tax_cents, \
                total_cents, unrated_seconds, status, notes, created_at \
           FROM billing_invoices WHERE id = ?1",
    )
    .bind(id)
    .fetch_optional(pool)
    .await
    .map_err(err)?
    else {
        return Ok(None);
    };

    let lines = sqlx::query(
        "SELECT id, description, seconds, amount_cents, sort \
           FROM billing_invoice_lines WHERE invoice_id = ?1 ORDER BY sort",
    )
    .bind(id)
    .fetch_all(pool)
    .await
    .map_err(err)?
    .iter()
    .map(|r| InvoiceLine {
        id: r.get("id"),
        description: r.get("description"),
        seconds: r.get("seconds"),
        amount_cents: r.get("amount_cents"),
        sort: r.get("sort"),
    })
    .collect();

    Ok(Some(Invoice {
        id: head.get("id"),
        number: head.get("number"),
        client_id: head.get("client_id"),
        client_name: head.get("client_name"),
        currency: head.get("currency"),
        issue_date: head.get("issue_date"),
        from_date: head.get("from_date"),
        to_date: head.get("to_date"),
        tax_rate_bps: head.get("tax_rate_bps"),
        subtotal_cents: head.get("subtotal_cents"),
        tax_cents: head.get("tax_cents"),
        total_cents: head.get("total_cents"),
        unrated_seconds: head.get("unrated_seconds"),
        status: head.get("status"),
        notes: head.get("notes"),
        created_at: head.get("created_at"),
        lines,
    }))
}

pub async fn delete_invoice(pool: &SqlitePool, id: &str) -> Result<(), String> {
    // The lines go with it: `billing_invoice_lines.invoice_id` is ON DELETE
    // CASCADE and the pool runs with foreign keys on.
    sqlx::query("DELETE FROM billing_invoices WHERE id = ?1")
        .bind(id)
        .execute(pool)
        .await
        .map_err(err)?;
    Ok(())
}

pub async fn set_invoice_status(
    pool: &SqlitePool,
    id: &str,
    status: &str,
) -> Result<Invoice, String> {
    if !matches!(status, "draft" | "sent" | "paid") {
        return Err(format!("unknown invoice status: {status}"));
    }
    let Some(mut invoice) = get_invoice(pool, id).await? else {
        return Err("unknown invoice".into());
    };
    sqlx::query("UPDATE billing_invoices SET status = ?1 WHERE id = ?2")
        .bind(status)
        .bind(id)
        .execute(pool)
        .await
        .map_err(err)?;
    invoice.status = status.to_string();
    Ok(invoice)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rounding::RoundMode;
    use crate::test_support::test_db;

    fn ts(day: &str) -> DateTime<Utc> {
        parse_ts(format!("{day}T09:00:00+00:00")).unwrap()
    }

    fn row(project_id: &str, name: &str, start: &str, minutes: i64) -> InvoiceRow {
        let start_dt = ts(start);
        InvoiceRow {
            entry_id: format!("{project_id}-{start}-{minutes}"),
            project_id: project_id.into(),
            task_id: None,
            project_name: name.into(),
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
    fn tax_is_bps_of_subtotal() {
        assert_eq!(tax_cents(10000, 2500), 2500); // 25% of $100 = $25
        assert_eq!(tax_cents(10000, 0), 0);
    }

    #[test]
    fn build_groups_by_project_and_prices_at_the_rate() {
        let rows = vec![
            row("p1", "Website", "2026-07-01", 60),
            row("p1", "Website", "2026-07-02", 30),
            row("p2", "Audit", "2026-07-03", 120),
        ];
        let rates = vec![
            rate("project", "p1", 10000, "USD", "2026-01-01"),
            rate("project", "p2", 20000, "USD", "2026-01-01"),
        ];
        let built = build_lines_from(&rows, "c1", &rates, off()).unwrap();
        assert_eq!(built.currency, "USD");
        assert_eq!(built.lines.len(), 2);
        // Alphabetical: Audit then Website.
        assert_eq!(built.lines[0].description, "Audit");
        assert_eq!(built.lines[0].seconds, 7200);
        assert_eq!(built.lines[0].amount_cents, 40000); // 2h @ $200
        assert_eq!(built.lines[1].description, "Website");
        assert_eq!(built.lines[1].seconds, 5400); // 90 min
        assert_eq!(built.lines[1].amount_cents, 15000); // 1.5h @ $100
        assert_eq!(built.unrated_seconds, 0);
        // Every priced row is recorded as billed, so it can't be re-invoiced.
        assert_eq!(built.billed_entry_ids.len(), 3);
        assert!(built
            .billed_entry_ids
            .contains(&"p2-2026-07-03-120".to_string()));
    }

    #[test]
    fn build_sets_aside_unrated_billable_time() {
        let rows = vec![row("p1", "Website", "2026-07-01", 60)];
        let built = build_lines_from(&rows, "c1", &[], off()).unwrap();
        assert!(built.lines.is_empty());
        assert_eq!(built.unrated_seconds, 3600);
        assert_eq!(built.currency, "");
        // Unrated time isn't billed, so it's not recorded — a future invoice
        // (once a rate exists) can still pick it up.
        assert!(built.billed_entry_ids.is_empty());
    }

    #[test]
    fn build_rejects_mixed_currencies() {
        let rows = vec![
            row("p1", "Website", "2026-07-01", 60),
            row("p2", "Audit", "2026-07-01", 60),
        ];
        let rates = vec![
            rate("project", "p1", 10000, "USD", "2026-01-01"),
            rate("project", "p2", 9000, "EUR", "2026-01-01"),
        ];
        let e = build_lines_from(&rows, "c1", &rates, off())
            .err()
            .expect("expected a mixed-currency error");
        assert!(e.contains("mixes currencies"), "{e}");
    }

    #[test]
    fn build_rounds_before_pricing_and_skips_zeroed_time() {
        // 5 min under nearest-15 rounds to 0 → dropped; 8 min → 15 min billed.
        let rows = vec![
            row("p1", "Website", "2026-07-01", 5),
            row("p1", "Website", "2026-07-02", 8),
        ];
        let rates = vec![rate("project", "p1", 12000, "USD", "2026-01-01")];
        let nearest_15 = Rounding {
            interval_minutes: 15,
            mode: RoundMode::Nearest,
        };
        let built = build_lines_from(&rows, "c1", &rates, nearest_15).unwrap();
        assert_eq!(built.lines.len(), 1);
        assert_eq!(built.lines[0].seconds, 900);
        assert_eq!(built.lines[0].amount_cents, 3000); // 15 min @ $120
                                                       // Only the row that survived rounding is billed; the zeroed one isn't.
        assert_eq!(built.billed_entry_ids, vec!["p1-2026-07-02-8".to_string()]);
    }

    async fn seed_client_and_rate(pool: &SqlitePool) {
        let now = "2026-07-01T00:00:00+00:00";
        sqlx::query(
            "INSERT INTO clients (id, name, created_at, updated_at) VALUES ('c1','Acme',?1,?1)",
        )
        .bind(now)
        .execute(pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO projects (id, name, client_id, color, archived, billable_default, created_at, updated_at) \
             VALUES ('p1','Website','c1','#000',0,1,?1,?1)",
        ).bind(now).execute(pool).await.unwrap();
        super::super::rates::set_rate(pool, "project", "p1", 15000, "USD", "2020-01-01")
            .await
            .unwrap();
    }

    /// Insert one completed, billable hour on `p1` on `day` (09:00–10:00).
    async fn insert_billable_hour(pool: &SqlitePool, id: &str, day: &str) {
        sqlx::query(
            "INSERT INTO entries (id, project_id, task_id, description, started_at, ended_at, source, billable, created_at, updated_at) \
             VALUES (?1,'p1',NULL,'work',?2,?3,'manual',1,'x','x')",
        )
        .bind(id)
        .bind(format!("{day}T09:00:00+00:00"))
        .bind(format!("{day}T10:00:00+00:00"))
        .execute(pool)
        .await
        .unwrap();
    }

    async fn seed_billable_hour(pool: &SqlitePool) {
        insert_billable_hour(pool, "e1", "2026-07-10").await;
    }

    async fn create(pool: &SqlitePool, tax_bps: i64) -> Invoice {
        create_invoice(
            pool,
            "c1",
            "2026-07-01",
            "2026-08-01",
            ts("2026-07-01"),
            ts("2026-08-01"),
            "2026-07-15",
            tax_bps,
            Some("thanks"),
            off(),
            Utc::now(),
        )
        .await
        .unwrap()
    }

    async fn ledger_count(pool: &SqlitePool) -> i64 {
        sqlx::query("SELECT COUNT(*) AS n FROM billing_invoice_entries")
            .fetch_one(pool)
            .await
            .unwrap()
            .get("n")
    }

    #[tokio::test]
    async fn create_persists_a_numbered_invoice_with_lines_and_tax() {
        let (_dir, db) = test_db().await;
        seed_client_and_rate(&db.pool).await;
        seed_billable_hour(&db.pool).await;
        // A second project for the same client with NO rate → its billable
        // hour is unpriced, so it's recorded as unrated, not billed.
        sqlx::query(
            "INSERT INTO projects (id, name, client_id, color, archived, billable_default, created_at, updated_at) \
             VALUES ('p2','Research','c1','#111',0,1,'x','x')",
        ).execute(&db.pool).await.unwrap();
        sqlx::query(
            "INSERT INTO entries (id, project_id, task_id, description, started_at, ended_at, source, billable, created_at, updated_at) \
             VALUES ('e2','p2',NULL,'','2026-07-11T09:00:00+00:00','2026-07-11T10:00:00+00:00','manual',1,'x','x')",
        ).execute(&db.pool).await.unwrap();

        let inv = create(&db.pool, 2500).await;
        assert_eq!(inv.number, "INV-0001");
        assert_eq!(inv.client_name, "Acme");
        assert_eq!(inv.currency, "USD");
        assert_eq!(inv.subtotal_cents, 15000);
        assert_eq!(inv.tax_cents, 3750); // 25%
        assert_eq!(inv.total_cents, 18750);
        assert_eq!(inv.status, "draft");
        assert_eq!(inv.notes.as_deref(), Some("thanks"));
        // Only the priced project is a line; the unpriced hour is recorded.
        assert_eq!(inv.lines.len(), 1);
        assert_eq!(inv.lines[0].description, "Website");
        assert_eq!(inv.lines[0].amount_cents, 15000);
        assert_eq!(inv.unrated_seconds, 3600);

        // Numbers increment monotonically — a fresh hour, since the first is
        // now recorded as billed and can't be invoiced again.
        insert_billable_hour(&db.pool, "e3", "2026-07-20").await;
        let inv2 = create(&db.pool, 0).await;
        assert_eq!(inv2.number, "INV-0002");
        assert_eq!(inv2.tax_cents, 0);
        // Only the fresh hour — a regressed exclusion would re-bill e1 (30000).
        assert_eq!(inv2.subtotal_cents, 15000);
    }

    #[tokio::test]
    async fn create_rejects_an_empty_range_and_unknown_client() {
        let (_dir, db) = test_db().await;
        seed_client_and_rate(&db.pool).await;
        // No entries → nothing to bill.
        let err = create_invoice(
            &db.pool,
            "c1",
            "2026-07-01",
            "2026-08-01",
            ts("2026-07-01"),
            ts("2026-08-01"),
            "2026-07-15",
            0,
            None,
            off(),
            Utc::now(),
        )
        .await
        .unwrap_err();
        assert!(err.contains("no billable, priced time"), "{err}");

        let err = create_invoice(
            &db.pool,
            "ghost",
            "2026-07-01",
            "2026-08-01",
            ts("2026-07-01"),
            ts("2026-08-01"),
            "2026-07-15",
            0,
            None,
            off(),
            Utc::now(),
        )
        .await
        .unwrap_err();
        assert!(err.contains("unknown client"), "{err}");

        let err = create_invoice(
            &db.pool,
            "c1",
            "2026-07-01",
            "2026-08-01",
            ts("2026-07-01"),
            ts("2026-08-01"),
            "2026-07-15",
            -1,
            None,
            off(),
            Utc::now(),
        )
        .await
        .unwrap_err();
        assert!(err.contains("negative"), "{err}");
    }

    #[tokio::test]
    async fn create_excludes_still_running_entries() {
        let (_dir, db) = test_db().await;
        seed_client_and_rate(&db.pool).await;
        seed_billable_hour(&db.pool).await; // one completed hour on p1
                                            // A still-running billable entry on the same project — not final, so
                                            // it must NOT be billed.
        sqlx::query(
            "INSERT INTO entries (id, project_id, task_id, description, started_at, ended_at, source, billable, created_at, updated_at) \
             VALUES ('open','p1',NULL,'','2026-07-12T09:00:00+00:00',NULL,'manual',1,'x','x')",
        )
        .execute(&db.pool)
        .await
        .unwrap();

        let inv = create(&db.pool, 0).await;
        // Only the completed hour is on the invoice.
        assert_eq!(inv.lines.len(), 1);
        assert_eq!(inv.lines[0].seconds, 3600);
        assert_eq!(inv.subtotal_cents, 15000);
    }

    #[tokio::test]
    async fn invoice_numbers_never_reuse_after_deleting_the_latest() {
        let (_dir, db) = test_db().await;
        seed_client_and_rate(&db.pool).await;
        // A fresh hour per invoice, since an already-billed one can't be re-billed.
        insert_billable_hour(&db.pool, "e1", "2026-07-10").await;
        let a = create(&db.pool, 0).await;
        assert_eq!(a.number, "INV-0001");
        insert_billable_hour(&db.pool, "e2", "2026-07-11").await;
        let b = create(&db.pool, 0).await;
        assert_eq!(b.number, "INV-0002");
        // Deleting the latest must not free its number.
        delete_invoice(&db.pool, &b.id).await.unwrap();
        insert_billable_hour(&db.pool, "e3", "2026-07-12").await;
        let c = create(&db.pool, 0).await;
        assert_eq!(c.number, "INV-0003");
    }

    #[tokio::test]
    async fn overlapping_ranges_never_double_bill_and_delete_frees_entries() {
        let (_dir, db) = test_db().await;
        seed_client_and_rate(&db.pool).await;
        seed_billable_hour(&db.pool).await; // one completed hour on p1

        let a = create(&db.pool, 0).await;
        assert_eq!(a.number, "INV-0001");
        assert_eq!(a.subtotal_cents, 15000);
        // The billed entry is recorded against the invoice.
        assert_eq!(ledger_count(&db.pool).await, 1);

        // A second invoice over the SAME range has nothing left to bill —
        // the one hour was already invoiced, so it isn't billed twice.
        let err = create_invoice(
            &db.pool,
            "c1",
            "2026-07-01",
            "2026-08-01",
            ts("2026-07-01"),
            ts("2026-08-01"),
            "2026-07-15",
            0,
            None,
            off(),
            Utc::now(),
        )
        .await
        .unwrap_err();
        assert!(err.contains("already on an invoice"), "{err}");

        // Deleting the first invoice cascades its ledger rows away, freeing
        // the entry so the same range can be invoiced again.
        delete_invoice(&db.pool, &a.id).await.unwrap();
        assert_eq!(ledger_count(&db.pool).await, 0);
        let b = create(&db.pool, 0).await;
        assert_eq!(b.number, "INV-0002");
        assert_eq!(b.subtotal_cents, 15000);
    }

    #[tokio::test]
    async fn an_entry_can_only_be_recorded_on_one_invoice() {
        // The schema-level guard behind the exclusion SELECT: `entry_id` is the
        // ledger's primary key, so an entry can't be recorded on two invoices.
        // This is what stops a concurrent create — one that read the entry as
        // unbilled before the other committed — from double-billing it: the
        // losing INSERT violates uniqueness and rolls its whole transaction back.
        let (_dir, db) = test_db().await;
        seed_client_and_rate(&db.pool).await;
        insert_billable_hour(&db.pool, "e1", "2026-07-10").await;
        insert_billable_hour(&db.pool, "e2", "2026-08-10").await;

        // Two invoices over non-overlapping ranges: A bills e1, B bills e2.
        let a = create(&db.pool, 0).await;
        let b = create_invoice(
            &db.pool,
            "c1",
            "2026-08-01",
            "2026-09-01",
            ts("2026-08-01"),
            ts("2026-09-01"),
            "2026-08-15",
            0,
            None,
            off(),
            Utc::now(),
        )
        .await
        .unwrap();
        assert_ne!(a.id, b.id);

        // Recording e1 (already on A) against B must fail — a composite
        // (invoice_id, entry_id) key would wrongly allow this and double-bill.
        let dup = sqlx::query(
            "INSERT INTO billing_invoice_entries (entry_id, invoice_id) VALUES ('e1', ?1)",
        )
        .bind(&b.id)
        .execute(&db.pool)
        .await;
        assert!(
            dup.as_ref()
                .err()
                .and_then(|e| e.as_database_error())
                .is_some_and(|d| d.is_unique_violation()),
            "recording an entry on a second invoice must violate uniqueness: {dup:?}"
        );
    }

    #[tokio::test]
    async fn record_billed_entries_reports_a_claimed_entry() {
        let (_dir, db) = test_db().await;
        seed_client_and_rate(&db.pool).await;
        seed_billable_hour(&db.pool).await;
        let a = create(&db.pool, 0).await; // ledger now holds (e1, a.id)

        // Re-recording e1 collides on the unique entry_id → the friendly message
        // (this is the concurrent-loser path, forced deterministically).
        let mut tx = db.pool.begin().await.unwrap();
        let e = record_billed_entries(&mut tx, &a.id, &["e1".to_string()], "already billed".into())
            .await
            .unwrap_err();
        assert_eq!(e, "already billed");
    }

    #[tokio::test]
    async fn record_billed_entries_propagates_non_unique_errors() {
        let (_dir, db) = test_db().await;
        // A nonexistent invoice_id violates the FK — not a uniqueness error, so
        // the raw DB error propagates instead of the friendly message.
        let mut tx = db.pool.begin().await.unwrap();
        let e = record_billed_entries(&mut tx, "ghost", &["e1".to_string()], "friendly".into())
            .await
            .unwrap_err();
        assert_ne!(e, "friendly");
        assert!(e.to_lowercase().contains("foreign key"), "{e}");
    }

    #[tokio::test]
    async fn previously_unrated_time_invoices_once_a_rate_exists() {
        let (_dir, db) = test_db().await;
        seed_client_and_rate(&db.pool).await; // p1 is priced
        seed_billable_hour(&db.pool).await; // one completed hour on p1
                                            // A second project for the same client with NO rate: its billable
                                            // hour is unrated on the first invoice, so it isn't recorded as billed.
        let now = "2026-07-01T00:00:00+00:00";
        sqlx::query(
            "INSERT INTO projects (id, name, client_id, color, archived, billable_default, created_at, updated_at) \
             VALUES ('p2','Research','c1','#111',0,1,?1,?1)",
        ).bind(now).execute(&db.pool).await.unwrap();
        sqlx::query(
            "INSERT INTO entries (id, project_id, task_id, description, started_at, ended_at, source, billable, created_at, updated_at) \
             VALUES ('e2','p2',NULL,'','2026-07-11T09:00:00+00:00','2026-07-11T10:00:00+00:00','manual',1,'x','x')",
        ).execute(&db.pool).await.unwrap();

        let a = create(&db.pool, 0).await;
        assert_eq!(a.lines.len(), 1); // only p1 is priced
        assert_eq!(a.unrated_seconds, 3600); // p2's hour set aside, not billed

        // Add a rate for p2, then invoice the same range again. p1's entry is
        // already billed (excluded); p2's — never billed — now prices onto a line.
        super::super::rates::set_rate(&db.pool, "project", "p2", 9000, "USD", "2020-01-01")
            .await
            .unwrap();
        let b = create(&db.pool, 0).await;
        assert_eq!(b.lines.len(), 1);
        assert_eq!(b.lines[0].description, "Research");
        assert_eq!(b.subtotal_cents, 9000); // 1h @ $90
        assert_eq!(b.unrated_seconds, 0);
    }

    #[tokio::test]
    async fn list_get_status_and_delete_round_trip() {
        let (_dir, db) = test_db().await;
        seed_client_and_rate(&db.pool).await;
        seed_billable_hour(&db.pool).await;
        let inv = create(&db.pool, 0).await;

        let list = list_invoices(&db.pool).await.unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].number, "INV-0001");
        assert_eq!(list[0].total_cents, 15000);

        let got = get_invoice(&db.pool, &inv.id).await.unwrap().unwrap();
        assert_eq!(got.lines.len(), 1);

        let sent = set_invoice_status(&db.pool, &inv.id, "sent").await.unwrap();
        assert_eq!(sent.status, "sent");
        assert!(set_invoice_status(&db.pool, &inv.id, "bogus")
            .await
            .unwrap_err()
            .contains("unknown invoice status"));
        assert!(set_invoice_status(&db.pool, "nope", "paid")
            .await
            .unwrap_err()
            .contains("unknown invoice"));

        delete_invoice(&db.pool, &inv.id).await.unwrap();
        assert!(list_invoices(&db.pool).await.unwrap().is_empty());
        assert!(get_invoice(&db.pool, &inv.id).await.unwrap().is_none());
        // The lines went with it.
        let orphans: i64 =
            sqlx::query("SELECT COUNT(*) AS n FROM billing_invoice_lines WHERE invoice_id = ?1")
                .bind(&inv.id)
                .fetch_one(&db.pool)
                .await
                .unwrap()
                .get("n");
        assert_eq!(orphans, 0);
    }
}
