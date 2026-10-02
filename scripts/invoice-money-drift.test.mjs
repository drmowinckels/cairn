/**
 * The invoice document renders money Rust-side (`money_locale.rs`), because the
 * Rust process has no `Intl`. That makes two money formatters in one app — the
 * drift #320 and #321 each cost a round of rework — so the Rust one is pinned
 * against `Intl` rather than trusted.
 *
 * `scripts/money-locale-table.mjs` derives both committed artefacts from
 * `Intl`: the `PATTERNS` table in `money_locale.rs` and the per-currency
 * `money_locale_fixture.json`. This file re-runs that generator and asserts the
 * committed copies still match what it produces — so a stale table, a
 * hand-edited row, or an ICU change under the app all turn a build red. The
 * Rust test `matches_the_pinned_intl_output` closes the loop from the other
 * side: that the renderer actually reproduces the fixture.
 *
 * The pin covers **non-negative** amounts only. Cairn renders one leading
 * ASCII sign at every scale on purpose, where `Intl` follows each locale's own
 * sign quirks (U+2212 in nb-NO/sv-SE, sign-after-symbol in de-CH/es-CL); see
 * `money_locale::format`, which pins sign-carried-once directly instead.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { currencyExponent } from "../src/lib/money.ts";
import { FALLBACK, HOME, fixtureData, rustTable } from "./money-locale-table.mjs";

const FIXTURE_PATH = "src-tauri/src/plugins/billing/money_locale_fixture.json";
const RUST_PATH = "src-tauri/src/plugins/billing/money_locale.rs";

const fixture = JSON.parse(readFileSync(FIXTURE_PATH, "utf8"));
const rust = readFileSync(RUST_PATH, "utf8");

/** The committed `PATTERNS` block, verbatim, for comparison against the
 *  generator's output. */
function committedTable() {
  const block = rust.match(/const PATTERNS: \[\(&str, Pattern\); \d+\] = \[\n[\s\S]*?\n\];\n/);
  if (block === null) throw new Error("no PATTERNS table found in money_locale.rs");
  return block[0];
}

/** Collapse the space variants ICU moves between (no-break, narrow no-break,
 *  thin) to a plain space, in both literal and Rust-escaped form. Which one a
 *  locale uses as its group separator is typographic churn that shifts between
 *  ICU releases and would otherwise redden CI on a Node bump; the symbol, the
 *  separators, the grouping and the decimal count are what must not drift, and
 *  they stay compared exactly. */
function normalize(s) {
  return s
    .replace(/\\u\{(a0|202f|2009|2007)\}/g, " ")
    .replace(/[    ]/g, " ");
}

describe("invoice money formatting vs Intl (#330)", () => {
  it("has the Rust pattern table the generator produces from Intl", () => {
    // Catches a hand-edited or stale row even where the fixture's five pinned
    // amounts wouldn't print the difference — a wrong decimal separator on a
    // currency with no minor unit, say. Also pins the table's declared length,
    // since that is part of the generated text.
    expect(normalize(committedTable())).toBe(normalize(rustTable()));
  });

  it("has the fixture a live Intl produces", () => {
    const expected = fixtureData();
    const strip = (data) => ({
      currencies: data.currencies.map((c) => ({
        ...c,
        amounts: c.amounts.map((a) => ({ ...a, formatted: normalize(a.formatted) })),
      })),
    });
    expect(strip(fixture)).toEqual(strip(expected));
  });

  it("pins every currency the Rust table renders, plus the unlisted fallback", () => {
    const pinned = new Set(fixture.currencies.map((c) => c.currency));
    const listed = HOME.map(([currency]) => currency);
    expect(listed.filter((currency) => !pinned.has(currency))).toEqual([]);
    // The fallback rows must be absent from the table — they exist to prove an
    // *unlisted* currency still renders, as the ISO code plus en-US grouping.
    // `fixtureData` throws if Intl stops rendering one of them as a code.
    expect(FALLBACK.filter((currency) => listed.includes(currency))).toEqual([]);
    for (const currency of FALLBACK) {
      expect(pinned.has(currency), `${currency} must be pinned`).toBe(true);
    }
  });

  it("keeps the deliberate currency-to-locale decisions", () => {
    // Nothing else would notice this being re-decided: regenerating with
    // EUR -> en-IE leaves both artefacts self-consistent and both tests green
    // while every eurozone invoice silently changes convention. So the choices
    // that were actually argued live here, next to nothing else — changing one
    // has to be an explicit edit to a test.
    const home = new Map(HOME);
    expect(home.get("EUR")).toBe("de-DE"); // no single home; largest eurozone economy
    expect(home.get("USD")).toBe("en-US");
    expect(home.get("NOK")).toBe("nb-NO");
    expect(home.get("INR")).toBe("en-IN"); // the Indic-grouping row
    expect(home.get("ILS")).toBe("en-US"); // RTL home locale; takes the Latin form
    // One row per currency, or a later row would shadow an earlier one.
    expect(home.size).toBe(HOME.length);
  });

  it("covers both ends of the minor-unit scale, and grouping past a thousand", () => {
    const pinned = fixture.currencies.map((c) => c.currency);
    // JPY has no minor unit and BHD has three; both must keep working.
    expect(pinned.filter((c) => currencyExponent(c) === 0).length).toBeGreaterThan(0);
    expect(pinned.filter((c) => currencyExponent(c) === 3).length).toBeGreaterThan(0);
    // Every currency needs an amount large enough that a dropped group
    // separator would show up in its pinned rendering.
    for (const { currency, amounts } of fixture.currencies) {
      const big = amounts.some((a) => a.minorUnits >= 10 ** (currencyExponent(currency) + 4));
      expect(big, `${currency} needs an amount above a thousand major units`).toBe(true);
    }
  });
});
