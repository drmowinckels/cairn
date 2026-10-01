//! Currency scale for the billing plugin (#109).
//!
//! Money is stored as integer **minor units** of an ISO 4217 currency, and how
//! many minor units make a major one is a property of the currency, not a
//! constant: most have 100 (cents), but the yen and the Korean won have **1**
//! (there is no sub-yen unit), and the Kuwaiti dinar has **1000** (fils).
//!
//! Assuming 100 everywhere breaks both ends of that range. A JPY rate entered
//! as 15000 would be stored as 1500000 and mean ¥1,500,000 under the
//! minor-units contract, and a KWD rate of 15.505 would be rounded to 15.51
//! before it was ever saved — the third decimal that currency actually has,
//! silently dropped. This module is the one place that knows the scale, so
//! entry, arithmetic, and display all agree on what a stored integer means.
//! It is the scale table only — an amount and its currency travel together as
//! [`super::money::Money`], which is the one thing that reads it. Entry happens
//! in the UI, against the mirrored table in `src/lib/money.ts`.
//!
//! Unknown or malformed codes fall back to 2, which is the commonest scale and
//! matches what `Intl.NumberFormat` does with a code it doesn't recognise (see
//! the mirrored table in `src/lib/money.ts`, kept in step by
//! `scripts/currency-tables.test.mjs`).

/// Currencies with **no** minor unit: the amount is already whole.
const ZERO_DECIMAL: [&str; 17] = [
    "BIF", "CLP", "DJF", "GNF", "ISK", "JPY", "KMF", "KRW", "PYG", "RWF", "UGX", "UYI", "VND",
    "VUV", "XAF", "XOF", "XPF",
];

/// Currencies whose minor unit is a **thousandth** of the major one.
const THREE_DECIMAL: [&str; 7] = ["BHD", "IQD", "JOD", "KWD", "LYD", "OMR", "TND"];

/// Decimal places `currency` has — its ISO 4217 "minor unit" exponent.
/// Defaults to 2 for anything not listed, including a malformed code.
pub fn exponent(currency: &str) -> u32 {
    let code = currency.trim().to_ascii_uppercase();
    if ZERO_DECIMAL.contains(&code.as_str()) {
        0
    } else if THREE_DECIMAL.contains(&code.as_str()) {
        3
    } else {
        2
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::{historical_db, test_db, TempDir};
    use sqlx::{Row, SqlitePool};

    /// Migration 0034 rescaled money written under the old "always 100"
    /// assumption. Tested by executing the migration file itself against rows
    /// in the pre-migration shape, so the assertions can't drift from the SQL
    /// that actually ships.
    const RESCALE_SQL: &str =
        include_str!("../../../migrations/0034_billing_currency_minor_units.sql");

    /// Migration 0035, which renames the `*_cents` columns 0034 operates on.
    const RENAME_SQL: &str =
        include_str!("../../../migrations/0035_billing_amount_minor_units.sql");

    /// The schema 0034 was written against — everything up to, but not
    /// including, 0034 itself.
    async fn legacy_db() -> (TempDir, SqlitePool) {
        historical_db("0034").await
    }

    #[test]
    fn exponent_knows_the_three_scales() {
        assert_eq!(exponent("USD"), 2);
        assert_eq!(exponent("NOK"), 2);
        assert_eq!(exponent("JPY"), 0);
        assert_eq!(exponent("KRW"), 0);
        assert_eq!(exponent("ISK"), 0);
        assert_eq!(exponent("KWD"), 3);
        assert_eq!(exponent("BHD"), 3);
    }

    #[test]
    fn exponent_is_case_and_space_insensitive_and_defaults_to_two() {
        assert_eq!(exponent("jpy"), 0);
        assert_eq!(exponent(" Kwd "), 3);
        // Unknown and malformed codes take the common scale rather than panic.
        assert_eq!(exponent("ZZZ"), 2);
        assert_eq!(exponent(""), 2);
    }

    async fn insert_rate(pool: &sqlx::SqlitePool, id: &str, minor: i64, currency: &str) {
        sqlx::query(
            "INSERT INTO billing_rates \
               (id, scope_type, scope_id, amount_cents, currency, effective_from) \
             VALUES (?1, 'workspace', ?2, ?3, ?4, '2026-01-01')",
        )
        .bind(id)
        .bind(id)
        .bind(minor)
        .bind(currency)
        .execute(pool)
        .await
        .unwrap();
    }

    async fn rate_amount(pool: &sqlx::SqlitePool, id: &str) -> i64 {
        sqlx::query("SELECT amount_cents FROM billing_rates WHERE id = ?1")
            .bind(id)
            .fetch_one(pool)
            .await
            .unwrap()
            .get::<i64, _>("amount_cents")
    }

    /// Runs the migration file as one script, the way the migrator does —
    /// splitting on `;` would break on a semicolon inside a comment.
    async fn run_rescale(pool: &sqlx::SqlitePool) {
        sqlx::raw_sql(RESCALE_SQL).execute(pool).await.unwrap();
    }

    /// Every column migration 0035 renames, read from the live schema the app
    /// actually migrates to — and no `*_cents` column left anywhere in it, so
    /// this doubles as a standing guard against a new one being introduced.
    #[tokio::test]
    async fn migration_renames_the_money_columns_to_minor_units() {
        let (_dir, db) = test_db().await;
        let columns: Vec<String> = sqlx::query(
            "SELECT m.name || '.' || p.name AS col \
               FROM sqlite_master m JOIN pragma_table_info(m.name) p \
              WHERE m.type = 'table'",
        )
        .fetch_all(&db.pool)
        .await
        .unwrap()
        .into_iter()
        .map(|r| r.get::<String, _>("col"))
        .collect();

        for renamed in [
            "billing_rates.amount_minor_units",
            "billing_invoices.subtotal_minor_units",
            "billing_invoices.tax_minor_units",
            "billing_invoices.total_minor_units",
            "billing_invoice_lines.amount_minor_units",
        ] {
            assert!(columns.iter().any(|c| c == renamed), "{renamed} missing");
        }
        let stragglers: Vec<&String> = columns.iter().filter(|c| c.ends_with("_cents")).collect();
        assert!(
            stragglers.is_empty(),
            "a *_cents column is still in the schema: {stragglers:?}",
        );
    }

    /// `RENAME COLUMN` rewrites the column's name inside the table's own CHECK
    /// constraints, so the non-negative guard on a rate amount must still bite
    /// — and must name the new column, which is what proves it was rewritten.
    #[tokio::test]
    async fn the_rate_non_negative_check_survived_the_rename() {
        let (_dir, db) = test_db().await;
        let err = sqlx::query(
            "INSERT INTO billing_rates \
               (id, scope_type, scope_id, amount_minor_units, currency, effective_from) \
             VALUES ('neg', 'workspace', '', -1, 'USD', '2026-01-01')",
        )
        .execute(&db.pool)
        .await
        .expect_err("a negative rate must still violate the CHECK");
        assert!(
            err.to_string().contains("amount_minor_units"),
            "the CHECK must name the renamed column, got: {err}",
        );
    }

    /// A smoke test that the two money migrations compose in the order they
    /// ship in, on populated tables: 0034 rescales the old-scale values, then
    /// 0035 renames the columns it just wrote, and the rescaled figures read
    /// back under the new names. The rescale itself is covered above.
    #[tokio::test]
    async fn the_rename_composes_after_the_rescale() {
        let (_dir, pool) = legacy_db().await;
        insert_rate(&pool, "jpy", 1_500_000, "JPY").await; // ¥15,000/hr
        insert_invoice(&pool, "inv", "JPY", 0, 1_000_000, 0).await;
        insert_line(&pool, "l1", "inv", 1_000_000).await;

        run_rescale(&pool).await;
        sqlx::raw_sql(RENAME_SQL).execute(&pool).await.unwrap();

        let row = sqlx::query(
            "SELECT r.amount_minor_units AS rate, i.total_minor_units AS total \
               FROM billing_rates r, billing_invoices i \
              WHERE r.id = 'jpy' AND i.id = 'inv'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(row.get::<i64, _>("rate"), 15_000);
        assert_eq!(row.get::<i64, _>("total"), 10_000);
    }

    #[tokio::test]
    async fn migration_rescales_only_the_currencies_that_need_it() {
        let (_dir, pool) = legacy_db().await;
        // Amounts as the old code would have written them: major units × 100.
        insert_rate(&pool, "jpy", 1_500_000, "JPY").await; // ¥15,000/hr
        insert_rate(&pool, "kwd", 1_550, "KWD").await; // 15.500 KWD/hr
        insert_rate(&pool, "usd", 15_000, "USD").await; // $150.00/hr
        insert_rate(&pool, "lower", 1_500_000, "jpy").await; // case-insensitive

        run_rescale(&pool).await;

        assert_eq!(rate_amount(&pool, "jpy").await, 15_000); // ¥15,000
        assert_eq!(rate_amount(&pool, "kwd").await, 15_500); // 15.500 KWD
        assert_eq!(rate_amount(&pool, "usd").await, 15_000); // untouched
        assert_eq!(rate_amount(&pool, "lower").await, 15_000);
    }

    #[tokio::test]
    async fn migration_rounds_a_half_unit_up_rather_than_truncating() {
        let (_dir, pool) = legacy_db().await;
        // 15000.5 yen in the old scale — must land on ¥15,001, not ¥15,000.
        insert_rate(&pool, "half", 1_500_050, "JPY").await;
        run_rescale(&pool).await;
        assert_eq!(rate_amount(&pool, "half").await, 15_001);
    }

    async fn insert_invoice(
        pool: &sqlx::SqlitePool,
        id: &str,
        currency: &str,
        tax_rate_bps: i64,
        subtotal: i64,
        tax: i64,
    ) {
        sqlx::query(
            "INSERT INTO billing_invoices \
               (id, seq, number, client_id, client_name, currency, issue_date, \
                from_date, to_date, tax_rate_bps, subtotal_cents, tax_cents, \
                total_cents, unrated_seconds, created_at) \
             VALUES (?1, 1, 'A1', 'c1', 'Acme', ?2, '2026-07-15', \
                     '2026-07-01', '2026-08-01', ?3, ?4, ?5, ?6, 0, 'x')",
        )
        .bind(id)
        .bind(currency)
        .bind(tax_rate_bps)
        .bind(subtotal)
        .bind(tax)
        .bind(subtotal + tax)
        .execute(pool)
        .await
        .unwrap();
    }

    async fn insert_line(pool: &sqlx::SqlitePool, id: &str, invoice: &str, amount: i64) {
        sqlx::query(
            "INSERT INTO billing_invoice_lines \
               (id, invoice_id, description, seconds, amount_cents, sort) \
             VALUES (?1, ?2, 'Work', 3600, ?3, 0)",
        )
        .bind(id)
        .bind(invoice)
        .bind(amount)
        .execute(pool)
        .await
        .unwrap();
    }

    /// An invoice's three figures after the migration: subtotal, tax, total.
    async fn invoice_figures(pool: &sqlx::SqlitePool, id: &str) -> (i64, i64, i64) {
        let r = sqlx::query(
            "SELECT subtotal_cents, tax_cents, total_cents \
               FROM billing_invoices WHERE id = ?1",
        )
        .bind(id)
        .fetch_one(pool)
        .await
        .unwrap();
        (
            r.get("subtotal_cents"),
            r.get("tax_cents"),
            r.get("total_cents"),
        )
    }

    #[tokio::test]
    async fn migration_keeps_an_invoices_own_figures_consistent() {
        let (_dir, pool) = legacy_db().await;
        // The case that independent per-field rounding gets wrong: ¥1.49 of
        // work plus ¥1.49 of tax in the old scale. Rounding subtotal, tax and
        // total separately yields 1 + 1 next to a total of 3.
        insert_invoice(&pool, "inv", "JPY", 10_000, 149, 149).await;
        insert_line(&pool, "l1", "inv", 149).await;

        run_rescale(&pool).await;

        let (subtotal, tax, total) = invoice_figures(&pool, "inv").await;
        assert_eq!(
            total,
            subtotal + tax,
            "an invoice must never contradict its own arithmetic",
        );
        // Rebuilt from the rescaled line: ¥1 of work, taxed at 100%.
        assert_eq!((subtotal, tax, total), (1, 1, 2));
    }

    #[tokio::test]
    async fn migration_keeps_the_subtotal_equal_to_the_sum_of_its_lines() {
        let (_dir, pool) = legacy_db().await;
        insert_invoice(&pool, "inv", "JPY", 0, 447, 0).await;
        // Three ¥1.49 lines. Each rounds to ¥1 on its own, so the lines add to
        // ¥3 — while rescaling the stored subtotal (447 → 4) would have left a
        // subtotal a yen larger than the lines printed beneath it.
        for (i, amount) in [149_i64, 149, 149].iter().enumerate() {
            insert_line(&pool, &format!("l{i}"), "inv", *amount).await;
        }

        run_rescale(&pool).await;

        let lines: i64 = sqlx::query(
            "SELECT SUM(amount_cents) AS n FROM billing_invoice_lines WHERE invoice_id = 'inv'",
        )
        .fetch_one(&pool)
        .await
        .unwrap()
        .get("n");
        let (subtotal, _, total) = invoice_figures(&pool, "inv").await;
        assert_eq!(
            subtotal, lines,
            "the subtotal must be what the lines add to"
        );
        assert_eq!((subtotal, total), (3, 3));
    }

    #[tokio::test]
    async fn migration_rescales_invoice_totals_and_their_lines() {
        let (_dir, pool) = legacy_db().await;
        sqlx::query(
            "INSERT INTO billing_invoices \
               (id, seq, number, client_id, client_name, currency, issue_date, \
                from_date, to_date, tax_rate_bps, subtotal_cents, tax_cents, \
                total_cents, unrated_seconds, created_at) \
             VALUES ('inv', 1, 'A1', 'c1', 'Acme', 'JPY', '2026-07-15', \
                     '2026-07-01', '2026-08-01', 0, 1000000, 0, 1000000, 0, 'x')",
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO billing_invoice_lines \
               (id, invoice_id, description, seconds, amount_cents, sort) \
             VALUES ('l1', 'inv', 'Work', 3600, 1000000, 0)",
        )
        .execute(&pool)
        .await
        .unwrap();

        run_rescale(&pool).await;

        let inv = sqlx::query(
            "SELECT subtotal_cents, total_cents FROM billing_invoices WHERE id = 'inv'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(inv.get::<i64, _>("subtotal_cents"), 10_000);
        assert_eq!(inv.get::<i64, _>("total_cents"), 10_000);
        // The line inherits the invoice's currency — it stores none of its own.
        let line = sqlx::query("SELECT amount_cents FROM billing_invoice_lines WHERE id = 'l1'")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(line.get::<i64, _>("amount_cents"), 10_000);
    }
}
