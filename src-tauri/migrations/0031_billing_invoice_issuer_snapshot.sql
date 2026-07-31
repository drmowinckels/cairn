-- Invoice immutability (#1): freeze the issuer's presentation onto each invoice
-- at creation so later edits to the business profile never rewrite an already-
-- issued invoice. Holds the whole `BusinessDetails` as JSON (name, address,
-- logo, tax label, payment instructions, terms, template) — read back as one
-- atomic value only when rendering, never queried piecemeal. Empty string on
-- pre-existing rows deserializes to an empty issuer (renders no "From" block).
ALTER TABLE billing_invoices ADD COLUMN issuer_snapshot TEXT NOT NULL DEFAULT '';
