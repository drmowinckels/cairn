-- Invoice number format (#1). The issuer's prefix (empty renders the default
-- "INV-") and the zero-pad width of the sequential number (0 renders the
-- default width of 4). Only new invoices use the current format; existing
-- invoices keep their stored number. Plugin-owned.
ALTER TABLE billing_business ADD COLUMN invoice_prefix TEXT NOT NULL DEFAULT '';
ALTER TABLE billing_business ADD COLUMN invoice_number_padding INTEGER NOT NULL DEFAULT 0;
