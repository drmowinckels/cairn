-- Buyer details on invoices (#331): the client's postal address and tax/VAT id.
-- Core, alongside the rest of the client record — an address is not money, and
-- this mirrors `billable` living in core while rates stay plugin-side. The
-- billing plugin reads these when it freezes them onto an invoice; it does not
-- own them.
-- Nullable: both are optional, and NULL means "never set" rather than "blank".
ALTER TABLE clients ADD COLUMN address TEXT;
ALTER TABLE clients ADD COLUMN tax_id TEXT;
