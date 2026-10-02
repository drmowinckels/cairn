-- Invoice immutability for the buyer side (#331), the counterpart to
-- `issuer_snapshot` (0031): freeze the client's address and tax id onto each
-- invoice at creation so editing the client later never rewrites an already-
-- issued document. The client's *name* is already frozen in `client_name`, so
-- it is deliberately not duplicated here. Holds a `ClientSnapshot` as JSON,
-- read back as one atomic value only when rendering, never queried piecemeal.
-- Empty string on pre-existing rows deserializes to an empty snapshot (the
-- "Billed to" block then shows the name alone, as it did before).
ALTER TABLE billing_invoices ADD COLUMN client_snapshot TEXT NOT NULL DEFAULT '';
