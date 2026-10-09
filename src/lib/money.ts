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

/** `Intl.NumberFormat` options for rendering an amount in `currency`, with the
 *  fraction digits **forced** to the ISO 4217 exponent.
 *
 *  Forcing them is the point of this helper. Left to its own devices `Intl`
 *  uses CLDR's exponent, which disagrees with ISO 4217 for a handful of
 *  currencies — it renders HUF with no decimals — while the stored integer is
 *  always in ISO minor units. Unforced, the same stored `150000` HUF would read
 *  `1500 Ft` in-app and `1.500,00 Ft` on the invoice: not two conventions but
 *  two *scales*, which looks like money going missing (#336).
 *
 *  Locale is deliberately not a parameter: who picks it is the caller's
 *  decision and differs by audience — [`formatMoney`] follows the operator's
 *  machine, while the exported document follows the amount's own currency (see
 *  `money_locale.rs`). This helper is only the part both must agree on, and is
 *  shared with `scripts/money-locale-table.mjs` so the Rust table and fixture
 *  are generated at the same forced scale.
 *
 *  `exponent` overrides the currency's own, which only the generator needs: it
 *  reads a locale's decimal separator off a two-decimal rendering of a currency
 *  that has no minor unit at all.
 *
 *  The code is canonicalized because `Intl` throws on one that is not
 *  well-formed. It accepts any well-formed 3-letter code (which the backend
 *  guarantees), rendering the code itself when it doesn't name a known
 *  currency — so an unusual code shows through rather than throwing. */
export function currencyFormatOptions(
  currency: string,
  exponent: number = currencyExponent(currency),
): Intl.NumberFormatOptions {
  return {
    style: "currency",
    currency: currency.trim().toUpperCase(),
    minimumFractionDigits: exponent,
    maximumFractionDigits: exponent,
  };
}

/** Money as the **operator** sees it in-app: the machine's own conventions,
 *  because the reader here is the person running Cairn. The exported invoice
 *  renders the same amount in the currency's conventions instead, because its
 *  reader is the client — a deliberate split, pinned by
 *  `scripts/money-rendering-split.test.mjs`.
 *
 *  The scale comes from the amount's own currency rather than a hardcoded 100,
 *  so ¥150,000 is stored as 150000 and shown as ¥150,000 — not as ¥1,500 — and
 *  the fraction digits are ISO 4217's, so in-app and document never differ on
 *  how much an amount is. */
export function formatMoney(amount: Money): string {
  return new Intl.NumberFormat(
    undefined,
    currencyFormatOptions(amount.currency),
  ).format(amount.minorUnits / minorUnitsPerMajor(amount.currency));
}
