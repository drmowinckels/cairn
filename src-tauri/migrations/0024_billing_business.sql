-- Pro invoice issuer details (#1). The sender's own business identity —
-- name, address, contact, tax id — printed as the "From" block on generated
-- invoices. Single row (one business per install), plugin-owned; core has no
-- money and no invoice concepts. Every field is optional free text; an
-- all-empty profile renders no block.
CREATE TABLE IF NOT EXISTS billing_business (
    singleton  INTEGER PRIMARY KEY NOT NULL CHECK (singleton = 1),
    name       TEXT NOT NULL DEFAULT '',
    address    TEXT NOT NULL DEFAULT '',
    email      TEXT NOT NULL DEFAULT '',
    tax_id     TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
