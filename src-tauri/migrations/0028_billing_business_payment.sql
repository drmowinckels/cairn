-- Invoice payment instructions (#1). Free text — bank / IBAN / SWIFT / "how to
-- pay me" — shown as a "Payment" block on the invoice so the client knows how
-- to settle it. Not a "From" field. Plugin-owned; empty renders no block.
ALTER TABLE billing_business ADD COLUMN payment_details TEXT NOT NULL DEFAULT '';
