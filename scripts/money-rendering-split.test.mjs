import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { currencyFormatOptions, formatMoney, money } from "../src/lib/money.ts";

/**
 * The same stored amount is rendered twice, by design (#336):
 *
 * - **in-app** by `formatMoney`, in the operator's machine conventions,
 *   because the reader is the person running Cairn;
 * - **on the exported invoice** by `money_locale.rs`, in the amount's own
 *   currency's conventions, because the reader is the client.
 *
 * That is a decision, not an accident, and this file is what makes it one.
 * Without it a future change to either formatter could silently converge the
 * two (losing the client-facing rendering #330 added) or diverge them on
 * *scale* rather than convention, which is the one difference a reader would
 * take for money going missing.
 */
const fixture = JSON.parse(
  readFileSync(
    "src-tauri/src/plugins/billing/money_locale_fixture.json",
    "utf8",
  ),
);

/** Decimal digits in a rendering, whatever separators or symbols surround
 *  them. Counting these rather than parsing the number is what makes the
 *  comparison separator-agnostic: the two sides use different group and
 *  decimal marks on purpose, but an amount at the same scale always has the
 *  same number of digits. */
function digitCount(rendered) {
  return [...rendered].filter((ch) => /\p{Nd}/u.test(ch)).length;
}

describe("in-app vs document money rendering (#336)", () => {
  it("renders every pinned amount at the same scale on both sides", () => {
    // A scale difference is the real defect: unforced, `Intl` would follow
    // CLDR and render HUF with no decimals while the stored integer and the
    // invoice both use ISO 4217's two, so 150000 HUF would read as 1500.
    for (const row of fixture.currencies) {
      for (const { minorUnits, formatted } of row.amounts) {
        expect(
          digitCount(formatMoney(money(minorUnits, row.currency))),
          `${row.currency} ${minorUnits}`,
        ).toBe(digitCount(formatted));
      }
    }
  });

  it("formats in-app in the machine's locale, not the currency's", () => {
    // Asserted against `Intl` at the machine locale rather than an expected
    // string: the point is *which* locale `formatMoney` defers to, and the
    // host's own is whatever the test happens to run on.
    expect(formatMoney(money(150_000, "EUR"))).toBe(
      new Intl.NumberFormat(undefined, currencyFormatOptions("EUR")).format(
        1500,
      ),
    );
  });

  it("formats the document in the currency's locale, not en-US", () => {
    // EUR is the clearest case: `de-DE` writes 150000 minor units as
    // `1.500,00 €`, where `en-US` writes `€1,500.00`. The exact string is
    // pinned against live `Intl` by scripts/invoice-money-drift.test.mjs; what
    // this asserts is that the document side is driven by the currency at all,
    // so a change quietly making it follow the issuer's machine fails here.
    const eur = fixture.currencies.find((c) => c.currency === "EUR");
    expect(eur.locale).toBe("de-DE");
    const pinned = eur.amounts.find((a) => a.minorUnits === 150_000).formatted;
    expect(pinned).not.toBe(
      new Intl.NumberFormat("en-US", currencyFormatOptions("EUR")).format(1500),
    );
  });
});
