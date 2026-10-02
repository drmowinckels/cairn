-- Rename the billing money columns from `*_cents` to `*_minor_units` (#321).
--
-- Migration 0034 made these columns hold true ISO 4217 minor units, which for
-- the two dozen currencies that aren't hundredth-based are not cents: a JPY
-- amount is whole yen, a KWD amount is fils. The name was the last thing still
-- inviting the hardcoded "÷100" 0034 removed.
--
-- Pure rename: no value is read, written, or rescaled. SQLite rewrites the
-- column's name inside the table's own CHECK constraints, so `billing_rates`'
-- non-negative guard follows it.

ALTER TABLE billing_rates RENAME COLUMN amount_cents TO amount_minor_units;

ALTER TABLE billing_invoices RENAME COLUMN subtotal_cents TO subtotal_minor_units;
ALTER TABLE billing_invoices RENAME COLUMN tax_cents TO tax_minor_units;
ALTER TABLE billing_invoices RENAME COLUMN total_cents TO total_minor_units;

ALTER TABLE billing_invoice_lines RENAME COLUMN amount_cents TO amount_minor_units;
