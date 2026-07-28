-- Optional invoice logo (#1). Stored as a self-contained image data URI
-- (`data:image/png;base64,…`) so the exported invoice HTML stays offline with
-- no external resources. Empty when no logo is set. Plugin-owned.
ALTER TABLE billing_business ADD COLUMN logo TEXT NOT NULL DEFAULT '';
