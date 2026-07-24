-- Pro invoices (#1). A generated document: a client's billable time over a
-- date range, priced at the historical rate, one line per project, in a
-- single currency. Plugin-owned; core has no money. The client name and all
-- amounts are snapshotted so a past invoice stays reproducible even if the
-- client is later renamed or a rate changes. `seq` drives the human
-- `number`; it comes from the monotonic counter below (incremented in the
-- create transaction), so it only ever increases — deleting an invoice
-- never frees its number, and a client never sees a reused invoice number.
CREATE TABLE IF NOT EXISTS billing_invoice_seq (
    singleton INTEGER PRIMARY KEY NOT NULL CHECK (singleton = 1),
    next      INTEGER NOT NULL
);
INSERT INTO billing_invoice_seq (singleton, next) VALUES (1, 1);

CREATE TABLE IF NOT EXISTS billing_invoices (
    id             TEXT PRIMARY KEY NOT NULL,
    seq            INTEGER NOT NULL UNIQUE,
    number         TEXT NOT NULL UNIQUE,
    client_id      TEXT NOT NULL,
    client_name    TEXT NOT NULL,
    currency       TEXT NOT NULL,
    issue_date     TEXT NOT NULL,
    from_date      TEXT NOT NULL,
    to_date        TEXT NOT NULL,
    tax_rate_bps   INTEGER NOT NULL DEFAULT 0 CHECK (tax_rate_bps >= 0),
    subtotal_cents INTEGER NOT NULL,
    tax_cents      INTEGER NOT NULL,
    total_cents    INTEGER NOT NULL,
    -- Billable time in range that had no rate, so it couldn't be priced onto
    -- the invoice — recorded so the UI can flag the uninvoiced hours.
    unrated_seconds INTEGER NOT NULL DEFAULT 0,
    status         TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'sent', 'paid')),
    notes          TEXT,
    created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS billing_invoice_lines (
    id           TEXT PRIMARY KEY NOT NULL,
    invoice_id   TEXT NOT NULL REFERENCES billing_invoices(id) ON DELETE CASCADE,
    description  TEXT NOT NULL,
    seconds      INTEGER NOT NULL,
    amount_cents INTEGER NOT NULL,
    sort         INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_invoice_lines_invoice ON billing_invoice_lines (invoice_id);
