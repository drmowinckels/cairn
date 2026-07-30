-- Payment terms (#1). The issuer's default "Net N days"; an invoice's due date
-- is its issue date plus N. 0 means no due date is shown. Plugin-owned. (The
-- due date is derived at render for now; it snapshots with the rest of the
-- issuer details when invoice immutability lands.)
ALTER TABLE billing_business ADD COLUMN payment_terms_days INTEGER NOT NULL DEFAULT 0;
