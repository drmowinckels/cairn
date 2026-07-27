-- Invoiced-entry ledger (#1). Records exactly which time entries each invoice
-- billed, so a later invoice over an overlapping date range can exclude what's
-- already been billed instead of double-billing it. Only *priced* entries are
-- recorded — billable time that had no rate is left out, so adding a rate and
-- re-invoicing later can still pick it up.
--
-- `entry_id` is the PRIMARY KEY: an entry belongs to at most one invoice, so
-- the DB itself enforces "billed at most once". Two invoices racing over the
-- same range can't both record the entry — the second INSERT hits a
-- uniqueness violation and its whole transaction rolls back — which is the
-- real guard against double-billing, not the exclusion SELECT alone.
--
-- Deleting an invoice cascades these rows away, which frees its entries to be
-- invoiced again. `entry_id` deliberately has no FK into core `entries`: the
-- billing plugin never reaches across the plugin boundary into core tables,
-- and a dangling row is harmless — a deleted entry is never fetched, so it's
-- simply never matched. Invoices created before this migration have no rows
-- here; invoicing is unreleased, so there is nothing to back-fill.
CREATE TABLE IF NOT EXISTS billing_invoice_entries (
    entry_id   TEXT PRIMARY KEY NOT NULL,
    invoice_id TEXT NOT NULL REFERENCES billing_invoices(id) ON DELETE CASCADE
);

-- Indexed for the cascade delete's `WHERE invoice_id = ?` lookup; the exclusion
-- SELECT scans `entry_id`, already covered by the primary-key index.
CREATE INDEX IF NOT EXISTS idx_invoice_entries_invoice ON billing_invoice_entries (invoice_id);
