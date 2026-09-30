-- Store billing money as true ISO 4217 minor units (#109).
--
-- The `*_cents` columns are documented as minor units of their currency, but
-- every write scaled by a hardcoded 100. That only holds for 2-decimal
-- currencies: a JPY rate typed as 15000 was stored as 1500000, which under the
-- documented contract means ¥1,500,000 — a hundredfold error for anything
-- reading the column at face value, including the plugin export contract.
--
-- Rows written under the old assumption are rescaled by 10^(exponent-2): ÷100
-- for currencies with no minor unit, ×10 for those with three, unchanged for
-- the 2-decimal majority (which this migration deliberately never touches).
--
-- Invoices are rebuilt rather than rescaled field by field. An invoice holds
-- three values that must agree — `subtotal = SUM(lines)`, `tax =
-- round(subtotal × rate)`, `total = subtotal + tax` — and rounding each one
-- independently can break that: a ¥1.49 subtotal and ¥1.49 tax (stored 149 and
-- 149, total 298) would round to 1 + 1 alongside a total of 3. So the lines are
-- rescaled first and the invoice's three figures are then recomputed from them
-- exactly the way `invoices.rs` computes them at creation. An invoice document
-- whose own numbers contradict each other is worse than the bug being fixed.

-- The currency lists, named once instead of once per UPDATE. Dropped at the end
-- so they can't outlive the migration on a pooled connection.
CREATE TEMP TABLE zero_decimal_currency (code TEXT PRIMARY KEY);
INSERT INTO zero_decimal_currency (code) VALUES
    ('BIF'),('CLP'),('DJF'),('GNF'),('ISK'),('JPY'),('KMF'),('KRW'),('PYG'),
    ('RWF'),('UGX'),('UYI'),('VND'),('VUV'),('XAF'),('XOF'),('XPF');

CREATE TEMP TABLE three_decimal_currency (code TEXT PRIMARY KEY);
INSERT INTO three_decimal_currency (code) VALUES
    ('BHD'),('IQD'),('JOD'),('KWD'),('LYD'),('OMR'),('TND');

-- Hourly rates. Division rounds half-up (`+ 50`) rather than truncating, so a
-- stray half-unit lands on the nearer whole unit. SQLite's `/` on two integers
-- is integer division, which is what we want here.
UPDATE billing_rates
   SET amount_cents = (amount_cents + 50) / 100
 WHERE UPPER(TRIM(currency)) IN (SELECT code FROM zero_decimal_currency);

UPDATE billing_rates
   SET amount_cents = amount_cents * 10
 WHERE UPPER(TRIM(currency)) IN (SELECT code FROM three_decimal_currency);

-- Invoice lines, which carry no currency of their own and inherit the
-- invoice's. These are rescaled before the invoice figures are rebuilt from
-- them, so the sum below is already in the new scale.
UPDATE billing_invoice_lines
   SET amount_cents = (amount_cents + 50) / 100
 WHERE invoice_id IN (
         SELECT id FROM billing_invoices
          WHERE UPPER(TRIM(currency)) IN (SELECT code FROM zero_decimal_currency));

UPDATE billing_invoice_lines
   SET amount_cents = amount_cents * 10
 WHERE invoice_id IN (
         SELECT id FROM billing_invoices
          WHERE UPPER(TRIM(currency)) IN (SELECT code FROM three_decimal_currency));

-- Invoice figures, recomputed from the rescaled lines. Every `SET` expression
-- in one UPDATE sees the row's OLD values, so the line sum is repeated rather
-- than referenced through `subtotal_cents`. `ROUND()` is half-away-from-zero,
-- matching the `f64::round` the Rust tax calculation uses, and amounts are
-- never negative.
UPDATE billing_invoices
   SET subtotal_cents = COALESCE(
           (SELECT SUM(l.amount_cents) FROM billing_invoice_lines l
             WHERE l.invoice_id = billing_invoices.id), 0),
       tax_cents = CAST(ROUND(
           COALESCE(
             (SELECT SUM(l.amount_cents) FROM billing_invoice_lines l
               WHERE l.invoice_id = billing_invoices.id), 0)
           * tax_rate_bps / 10000.0) AS INTEGER),
       total_cents = COALESCE(
             (SELECT SUM(l.amount_cents) FROM billing_invoice_lines l
               WHERE l.invoice_id = billing_invoices.id), 0)
           + CAST(ROUND(
               COALESCE(
                 (SELECT SUM(l.amount_cents) FROM billing_invoice_lines l
                   WHERE l.invoice_id = billing_invoices.id), 0)
               * tax_rate_bps / 10000.0) AS INTEGER)
 WHERE UPPER(TRIM(currency)) IN (SELECT code FROM zero_decimal_currency)
    OR UPPER(TRIM(currency)) IN (SELECT code FROM three_decimal_currency);

DROP TABLE zero_decimal_currency;
DROP TABLE three_decimal_currency;
