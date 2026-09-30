import { describe, expect, it } from "vitest";
import { currencyExponent, formatMoney, minorUnitsPerMajor } from "./money";

describe("currencyExponent", () => {
  it("knows the three ISO 4217 scales", () => {
    expect(currencyExponent("USD")).toBe(2);
    expect(currencyExponent("NOK")).toBe(2);
    expect(currencyExponent("JPY")).toBe(0);
    expect(currencyExponent("KRW")).toBe(0);
    expect(currencyExponent("KWD")).toBe(3);
  });

  it("ignores case and surrounding space, and defaults to 2", () => {
    expect(currencyExponent("jpy")).toBe(0);
    expect(currencyExponent(" kwd ")).toBe(3);
    expect(currencyExponent("ZZZ")).toBe(2);
    expect(currencyExponent("")).toBe(2);
  });
});

describe("minorUnitsPerMajor", () => {
  it("is the factor between a typed amount and the stored integer", () => {
    expect(minorUnitsPerMajor("USD")).toBe(100);
    expect(minorUnitsPerMajor("JPY")).toBe(1);
    expect(minorUnitsPerMajor("KWD")).toBe(1000);
  });
});

describe("formatMoney", () => {
  // Intl's grouping separators and symbol placement are locale-dependent, so
  // these assert on the digits rather than the exact glyphs around them.
  const digits = (s: string) => s.replace(/[^\d.,]/g, "");

  it("scales by the currency's own minor unit, not a hardcoded 100", () => {
    // ¥150,000 is stored as 150000 minor units — showing "1,500" would be the
    // 100x bug this scaling exists to prevent.
    expect(digits(formatMoney(150_000, "JPY"))).toMatch(/150[,.\s]?000/);
    expect(digits(formatMoney(150_000, "USD"))).toMatch(/1[,.\s]?500\.00/);
  });

  it("keeps all three decimals of a thousandth-unit currency", () => {
    expect(digits(formatMoney(15_505, "KWD"))).toContain("15.505");
  });

  it("renders an unknown but well-formed code instead of throwing", () => {
    expect(() => formatMoney(150, "ZZZ")).not.toThrow();
    expect(formatMoney(150, "ZZZ")).toContain("ZZZ");
  });
});
