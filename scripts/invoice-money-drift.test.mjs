/**
 * The invoice document renders money Rust-side (`money_locale.rs`), because the
 * Rust process has no `Intl`. That makes two money formatters in one app — the
 * drift #320 and #321 each cost a round of rework — so the Rust one is pinned
 * against `Intl` rather than trusted.
 *
 * The pin is `money_locale_fixture.json`: per currency, the locale whose
 * conventions Cairn follows for it and what `Intl.NumberFormat` produces for a
 * battery of amounts. The Rust test `matches_the_pinned_intl_output` asserts the
 * renderer reproduces that fixture; this file asserts the fixture is still what
 * a live `Intl` produces, and that no row of the Rust table escapes the pin.
 * Either side moving on its own turns a build red.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/** Minor-unit exponents, from the table `src/lib/money.ts` and `currency.rs`
 *  share (`scripts/currency-tables.test.mjs` keeps those two in step). Imported
 *  rather than re-listed, so there is no third copy of the scale. */
import { currencyExponent } from "../src/lib/money.ts";

const FIXTURE_PATH = "src-tauri/src/plugins/billing/money_locale_fixture.json";
const RUST_PATH = "src-tauri/src/plugins/billing/money_locale.rs";

const fixture = JSON.parse(readFileSync(FIXTURE_PATH, "utf8"));
const rust = readFileSync(RUST_PATH, "utf8");

/** The currency codes the Rust pattern table holds, in declaration order. */
function rustTableCodes() {
  const body = rust.match(/const PATTERNS: \[\(&str, Pattern\); (\d+)\] = \[([\s\S]*?)\n\];/);
  if (body === null) throw new Error("no PATTERNS table found in money_locale.rs");
  const codes = [...body[2].matchAll(/\("([A-Z]{3})", Pattern \{/g)].map((m) => m[1]);
  return { declared: Number(body[1]), codes };
}

/** Collapse the space variants ICU moves between (no-break, narrow no-break,
 *  thin) to a plain space — the same normalization the Rust test applies. Which
 *  one a locale uses as its group separator is typographic churn that shifts
 *  between ICU releases; the symbol, separators, grouping and decimal count are
 *  what must not drift, and they stay compared exactly. */
function normalize(s) {
  return s.replace(/[\u00a0\u202f\u2009\u2007]/g, " ");
}

/** What `Intl` renders for `minorUnits` of `currency` in `locale`. The fraction
 *  digits are forced to Cairn's ISO 4217 exponent: CLDR disagrees with ISO for a
 *  few currencies (it shows HUF with none), and the stored scale is what the
 *  integer in the database means, so that is the scale to compare at. */
function intl(currency, locale, minorUnits) {
  const exponent = currencyExponent(currency);
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency,
    minimumFractionDigits: exponent,
    maximumFractionDigits: exponent,
  }).format(minorUnits / 10 ** exponent);
}

describe("invoice money formatting vs Intl (#330)", () => {
  it("pins what Intl actually produces, for every currency and amount", () => {
    expect(fixture.currencies.length).toBeGreaterThan(0);
    for (const { currency, locale, amounts } of fixture.currencies) {
      expect(amounts.length).toBeGreaterThan(0);
      for (const { minorUnits, formatted } of amounts) {
        expect(normalize(formatted), `${currency} (${locale}) at ${minorUnits}`).toBe(
          normalize(intl(currency, locale, minorUnits)),
        );
      }
    }
  });

  it("pins every currency the Rust table claims to render", () => {
    const { declared, codes } = rustTableCodes();
    // A fixed-size `[(&str, Pattern); N]` won't compile with a row added and N
    // left alone, but a wrong N with a matching count would pass silently.
    expect(codes).toHaveLength(declared);
    const pinned = new Set(fixture.currencies.map((c) => c.currency));
    expect(codes.filter((code) => !pinned.has(code))).toEqual([]);
  });

  it("pins the unlisted-currency fallback as the code-prefixed en-US form", () => {
    const listed = new Set(rustTableCodes().codes);
    const unlisted = fixture.currencies.filter((c) => !listed.has(c.currency));
    // The fallback is only honest while Intl itself renders these as a code —
    // a currency Intl has a symbol for belongs in the table, not here.
    expect(unlisted.length).toBeGreaterThan(0);
    for (const { currency, locale, amounts } of unlisted) {
      expect(locale, `${currency} must be pinned against en-US`).toBe("en-US");
      for (const { formatted } of amounts) {
        expect(formatted.startsWith(currency), `${currency}: ${formatted}`).toBe(true);
      }
    }
  });

  it("covers a 0-decimal and a 3-decimal currency, and grouping past a thousand", () => {
    const pinned = new Set(fixture.currencies.map((c) => c.currency));
    // The two ends of the scale range the invoice has to keep working for.
    expect([...pinned].filter((c) => currencyExponent(c) === 0).length).toBeGreaterThan(0);
    expect([...pinned].filter((c) => currencyExponent(c) === 3).length).toBeGreaterThan(0);
    // An amount big enough that a missing group separator would show up.
    for (const { currency, amounts } of fixture.currencies) {
      const big = amounts.some((a) => a.minorUnits >= 10 ** (currencyExponent(currency) + 4));
      expect(big, `${currency} needs an amount above a thousand major units`).toBe(true);
    }
  });
});
