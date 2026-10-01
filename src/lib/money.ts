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

/** An amount and the currency that says what it means — the mirror of the
 *  Rust `Money` in `src-tauri/src/plugins/billing/money.rs`, and the only
 *  shape a billing amount crosses the IPC boundary in. Pairing them in the
 *  type is what stops an amount from reaching a formatter without the scale
 *  needed to read it.
 *
 *  Being a structural interface, an object literal satisfies it without going
 *  through `money()`, so the canonical-code guarantee the Rust side enforces
 *  holds here only for values built by these constructors or received from the
 *  backend (which always sends canonical codes). Nothing in the frontend does
 *  arithmetic on money — amounts arrive priced and are only formatted — so
 *  there is deliberately no `add`. */
export interface Money {
  readonly minorUnits: number;
  readonly currency: string;
}

/** An amount in `currency`'s minor units. The code is canonicalized, so this
 *  and the Rust constructor agree on what "jpy" means. */
export function money(minorUnits: number, currency: string): Money {
  return { minorUnits, currency: currency.trim().toUpperCase() };
}

/** An amount from what a user typed in major units — 15.505 KWD becomes
 *  15505 fils. Rounds to the nearest whole minor unit, which is the finest the
 *  currency can hold. It rounds whatever it is given: refusing an amount with
 *  more decimals than the currency has is the rate form's job, because only
 *  the form can say so in a message the user can act on. */
export function moneyFromMajor(major: number, currency: string): Money {
  return money(Math.round(major * minorUnitsPerMajor(currency)), currency);
}

/** Money for display. The scale comes from the amount's own currency rather
 *  than a hardcoded 100, so ¥150,000 is stored as 150000 and shown as
 *  ¥150,000 — not as ¥1,500.
 *
 *  `Intl` accepts any well-formed 3-letter code (which the backend
 *  guarantees), rendering the code itself when it doesn't name a known
 *  currency — so an unusual code shows through rather than throwing. */
export function formatMoney(amount: Money): string {
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: amount.currency,
  }).format(amount.minorUnits / minorUnitsPerMajor(amount.currency));
}
