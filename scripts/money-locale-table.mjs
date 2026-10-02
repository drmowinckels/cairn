/**
 * Generator for the invoice money-formatting table and its pinned fixture
 * (#330).
 *
 * `src-tauri/src/plugins/billing/money_locale.rs` renders invoice amounts
 * locale-aware Rust-side, because the Rust process has no `Intl`. Neither its
 * `PATTERNS` table nor `money_locale_fixture.json` is hand-written: both come
 * from `Intl` through this script, which is also what
 * `scripts/invoice-money-drift.test.mjs` re-runs to assert the two committed
 * artefacts still match a live `Intl`. So this file is the single source of
 * both, and the test is what stops either rotting.
 *
 * Run it to regenerate after adding a currency or taking an ICU bump:
 *
 *   node scripts/money-locale-table.mjs
 *
 * It rewrites the fixture in place and prints the Rust `PATTERNS` block for you
 * to paste over the one in `money_locale.rs` (the Rust file is hand-edited
 * around it, so the script deliberately doesn't rewrite that one).
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { currencyExponent, minorUnitsPerMajor } from "../src/lib/money.ts";

/** Each currency Cairn renders with its own conventions, paired with the locale
 *  those conventions come from. A currency with no single home locale has its
 *  tie broken here: EUR follows `de-DE`, the largest eurozone economy and the
 *  commonest eurozone convention.
 *
 *  A currency whose home locale renders in Arabic-Indic digits or with bidi
 *  control marks is deliberately absent, or listed against `en-US` (ILS): the
 *  invoice is a `lang="en"` LTR document, so those take the Latin fallback.
 *  `assertRenderable` enforces that rather than trusting the list. */
export const HOME = [
  ["USD", "en-US"],
  ["EUR", "de-DE"],
  ["GBP", "en-GB"],
  ["NOK", "nb-NO"],
  ["SEK", "sv-SE"],
  ["DKK", "da-DK"],
  ["CHF", "de-CH"],
  ["ISK", "is-IS"],
  ["PLN", "pl-PL"],
  ["CZK", "cs-CZ"],
  ["HUF", "hu-HU"],
  ["RON", "ro-RO"],
  ["UAH", "uk-UA"],
  ["TRY", "tr-TR"],
  ["RUB", "ru-RU"],
  ["ILS", "en-US"],
  ["JPY", "ja-JP"],
  ["CNY", "zh-CN"],
  ["TWD", "zh-TW"],
  ["KRW", "ko-KR"],
  ["HKD", "en-HK"],
  ["SGD", "en-SG"],
  ["THB", "th-TH"],
  ["VND", "vi-VN"],
  ["IDR", "id-ID"],
  ["MYR", "ms-MY"],
  ["PHP", "en-PH"],
  ["INR", "en-IN"],
  ["AUD", "en-AU"],
  ["NZD", "en-NZ"],
  ["CAD", "en-CA"],
  ["MXN", "es-MX"],
  ["BRL", "pt-BR"],
  ["ARS", "es-AR"],
  ["CLP", "es-CL"],
  ["COP", "es-CO"],
  ["ZAR", "en-ZA"],
  ["NGN", "en-NG"],
  ["KES", "en-KE"],
  ["XOF", "fr-SN"],
  ["XAF", "fr-CM"],
];

/** Currencies pinned to show that an **unlisted** one still renders correctly:
 *  `en-US` conventions with the ISO code in place of a symbol, which is what
 *  `Intl` itself falls back to for a currency it has no symbol for. They must
 *  stay out of `HOME`, and `Intl` must still render them as a code —
 *  `assertCodeFallback` checks both. `ZZZ` is not a real currency, and is here
 *  because an unknown code has to render rather than fail. */
export const FALLBACK = ["BHD", "KWD", "AED", "SAR", "PKR", "ZZZ"];

/** The amounts every currency is pinned at, in its own minor units: zero, one
 *  minor unit, a sub-thousand figure, one that crosses the group boundary, and
 *  one large enough that a dropped separator is unmissable.
 *
 *  All non-negative, deliberately. `Intl`'s negative-currency patterns are
 *  locale-idiosyncratic — `nb-NO`/`sv-SE` use U+2212 and `de-CH`/`es-CL` put the
 *  sign after the symbol — while Cairn renders one leading ASCII sign at every
 *  scale on purpose (see `money_locale::format`). Pinning negatives would mean
 *  reproducing those quirks or carrying an allowlist of rows the pin exempts;
 *  the invariant that matters, sign-carried-once, is pinned Rust-side instead.
 *
 *  `amountsFor` adds a per-currency figure whose integer part is exactly four
 *  digits, so CLDR's `minimumGroupingDigits` boundary is pinned at every scale
 *  rather than only for the two-decimal majority. */
export const AMOUNTS = [0, 1, 1500, 150000, 123456789];

/** `AMOUNTS` plus the four-integer-digit boundary case for this currency's own
 *  scale, de-duplicated and in order. */
export function amountsFor(currency) {
  const boundary = 1000 * minorUnitsPerMajor(currency);
  return [...new Set([...AMOUNTS, boundary])].sort((a, b) => a - b);
}

/** `Intl` at the scale Cairn stores. The fraction digits are forced to the ISO
 *  4217 exponent because CLDR disagrees with ISO for a few currencies (it
 *  renders HUF with none), and the stored integer is in ISO minor units — so
 *  that is the scale to format, and to compare at. */
function formatter(currency, locale, exponent = currencyExponent(currency)) {
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency,
    minimumFractionDigits: exponent,
    maximumFractionDigits: exponent,
  });
}

/** Refuse a rendering the invoice can't carry: the document is `lang="en"` and
 *  LTR, so bidi controls and non-ASCII decimal digits must not reach it. */
function assertRenderable(currency, locale, rendered) {
  if (/[‎‏؜⁦-⁩]/.test(rendered)) {
    throw new Error(`${currency}/${locale}: bidi control in ${JSON.stringify(rendered)}`);
  }
  for (const ch of rendered) {
    if (/\p{Nd}/u.test(ch) && !(ch >= "0" && ch <= "9")) {
      throw new Error(`${currency}/${locale}: non-ASCII digit in ${JSON.stringify(rendered)}`);
    }
  }
}

/** A `PATTERNS` row for one currency, read off `Intl`'s own parts rather than
 *  transcribed: whatever precedes the digits is the prefix, whatever follows
 *  them the suffix, each carrying the locale's own spacing. */
export function pattern(currency, locale) {
  const fmt = formatter(currency, locale);
  assertRenderable(currency, locale, fmt.format(1234567.891));

  let prefix = "";
  let suffix = "";
  let group = null;
  const sizes = [];
  let seenNumber = false;
  for (const part of fmt.formatToParts(1234567.891)) {
    if (part.type === "integer") {
      seenNumber = true;
      sizes.push(part.value.length);
    } else if (part.type === "fraction" || part.type === "decimal") {
      seenNumber = true;
    } else if (part.type === "group") {
      group = part.value;
    } else if (part.type === "currency" || part.type === "literal") {
      if (seenNumber) suffix += part.value;
      else prefix += part.value;
    } else {
      throw new Error(`${currency}/${locale}: unexpected part ${part.type}`);
    }
  }

  return {
    prefix,
    suffix,
    group: group ?? ",",
    // Taken at two decimals even for a currency that has none, so the cell
    // holds the locale's real separator instead of a default the zero-decimal
    // path would never print anyway.
    decimal: decimalSeparator(currency, locale),
    // Three digits then twos is the Indian system; a short leading group of
    // two is what gives it away.
    grouping: sizes.length > 1 && sizes[0] === 2 ? "Indic" : "Western",
    // CLDR's `minimumGroupingDigits`: some locales leave four digits unbroken.
    groupFrom: formatter(currency, locale).formatToParts(1000).some((p) => p.type === "group")
      ? 4
      : 5,
  };
}

/** The locale's decimal separator, from a two-decimal rendering of the same
 *  currency — the one cell `formatToParts` can't supply for a currency with no
 *  minor unit, because there is no decimal part to report. */
function decimalSeparator(currency, locale) {
  const parts = formatter(currency, locale, 2).formatToParts(1.5);
  return parts.find((p) => p.type === "decimal")?.value ?? ".";
}

/** Rust string-literal escapes for anything outside printable ASCII, so the
 *  generated table carries no invisible characters. */
function escapeRust(s) {
  return [...s]
    .map((ch) => (ch.codePointAt(0) > 126 ? `\\u{${ch.codePointAt(0).toString(16)}}` : ch))
    .join("");
}

/** The `PATTERNS` block exactly as it appears in `money_locale.rs`. */
export function rustTable() {
  const rows = HOME.map(([currency, locale]) => {
    const p = pattern(currency, locale);
    return (
      `    ("${currency}", Pattern { prefix: "${escapeRust(p.prefix)}", ` +
      `suffix: "${escapeRust(p.suffix)}", group: "${escapeRust(p.group)}", ` +
      `decimal: "${escapeRust(p.decimal)}", grouping: Grouping::${p.grouping}, ` +
      `group_from: ${p.groupFrom} }),`
    );
  });
  return [
    `const PATTERNS: [(&str, Pattern); ${HOME.length}] = [`,
    ...rows,
    "];",
    "",
  ].join("\n");
}

/** Every currency Cairn renders, each with what `Intl` produces for it. */
export function fixtureData() {
  const rows = [...HOME, ...FALLBACK.map((currency) => [currency, "en-US"])];
  return {
    currencies: rows.map(([currency, locale]) => ({
      currency,
      locale,
      amounts: amountsFor(currency).map((minorUnits) => {
        // `Money` holds minor units as an i64 precisely because a float can't;
        // the division below is exact only while the amount stays inside the
        // double-safe range, so refuse rather than pin a rounded figure.
        if (!Number.isSafeInteger(minorUnits)) {
          throw new Error(`${currency}: ${minorUnits} minor units is past the exact-float range`);
        }
        const formatted = formatter(currency, locale).format(
          minorUnits / minorUnitsPerMajor(currency),
        );
        assertRenderable(currency, locale, formatted);
        if (FALLBACK.includes(currency) && !formatted.startsWith(currency)) {
          throw new Error(
            `${currency} renders as ${JSON.stringify(formatted)}, not a code — it belongs in HOME`,
          );
        }
        return { minorUnits, formatted };
      }),
    })),
  };
}

const FIXTURE_PATH = "src-tauri/src/plugins/billing/money_locale_fixture.json";

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  writeFileSync(FIXTURE_PATH, `${JSON.stringify(fixtureData(), null, 2)}\n`);
  process.stdout.write(
    `${FIXTURE_PATH} rewritten.\n\n` +
      `Paste this over the PATTERNS block in money_locale.rs:\n\n${rustTable()}`,
  );
}
