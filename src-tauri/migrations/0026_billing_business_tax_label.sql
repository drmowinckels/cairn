-- Configurable tax label (#1). The tax regime is a property of the issuer, so
-- the label ("VAT", "GST", "Sales Tax", …) lives on the business details and
-- applies to every invoice; empty falls back to "Tax" at render time.
ALTER TABLE billing_business ADD COLUMN tax_label TEXT NOT NULL DEFAULT '';
