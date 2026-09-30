/** Currencies with **no** minor unit: the amount is already whole.
 *  Mirrors `ZERO_DECIMAL` in `src-tauri/src/plugins/billing/currency.rs`;
 *  `scripts/currency-tables.test.mjs` fails if the two drift apart. */
const ZERO_DECIMAL = [
  "BIF",
  "CLP",
  "DJF",
  "GNF",
  "ISK",
  "JPY",
  "KMF",
  "KRW",
  "PYG",
  "RWF",
  "UGX",
  "UYI",
  "VND",
  "VUV",
  "XAF",
  "XOF",
  "XPF",
];

/** Currencies whose minor unit is a **thousandth** of the major one.
 *  Mirrors `THREE_DECIMAL` in the same Rust module. */
const THREE_DECIMAL = ["BHD", "IQD", "JOD", "KWD", "LYD", "OMR", "TND"];

/** Decimal places `currency` has — its ISO 4217 minor-unit exponent. Defaults
 *  to 2 for anything unlisted, which is both the commonest scale and what
 *  `Intl` falls back to for a code it doesn't know. */
export function currencyExponent(currency: string): number {
  const code = currency.trim().toUpperCase();
  if (ZERO_DECIMAL.includes(code)) return 0;
  if (THREE_DECIMAL.includes(code)) return 3;
  return 2;
}

/** How many minor units make one major unit — 1, 100, or 1000. The factor
 *  between the amount a user types and the integer that gets stored. */
export function minorUnitsPerMajor(currency: string): number {
  return 10 ** currencyExponent(currency);
}

/** Money for display, from integer minor units. The scale comes from the
 *  currency rather than a hardcoded 100, so ¥150,000 is stored as 150000 and
 *  shown as ¥150,000 — not as ¥1,500.
 *
 *  `Intl` accepts any well-formed 3-letter code (which the backend
 *  guarantees), rendering the code itself when it doesn't name a known
 *  currency — so an unusual code shows through rather than throwing. */
export function formatMoney(minorUnits: number, currency: string): string {
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency,
  }).format(minorUnits / minorUnitsPerMajor(currency));
}
