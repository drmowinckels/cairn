import { describe, expect, it } from "vitest";
import {
  currencyExponent,
  formatMoney,
  minorUnitsPerMajor,
  money,
  moneyFromMajor,
} from "./money";

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
    expect(digits(formatMoney(money(150_000, "JPY")))).toMatch(/150[,.\s]?000/);
    expect(digits(formatMoney(money(150_000, "USD")))).toMatch(
      /1[,.\s]?500\.00/,
    );
  });

  it("keeps all three decimals of a thousandth-unit currency", () => {
    expect(digits(formatMoney(money(15_505, "KWD")))).toContain("15.505");
  });

  it("renders an unknown but well-formed code instead of throwing", () => {
    expect(() => formatMoney(money(150, "ZZZ"))).not.toThrow();
    expect(formatMoney(money(150, "ZZZ"))).toContain("ZZZ");
  });
});

describe("money", () => {
  it("canonicalizes the currency code so it matches the Rust constructor", () => {
    expect(money(1, " jpy ")).toEqual({ minorUnits: 1, currency: "JPY" });
  });
});

describe("moneyFromMajor", () => {
  it("scales a typed major amount by the currency's own minor unit", () => {
    expect(moneyFromMajor(150, "USD")).toEqual({
      minorUnits: 15_000,
      currency: "USD",
    });
    // A yen amount is already whole — the factor is 1, not 100.
    expect(moneyFromMajor(15_000, "jpy")).toEqual({
      minorUnits: 15_000,
      currency: "JPY",
    });
    // And a dinar keeps its third decimal, which binary float nearly loses.
    expect(moneyFromMajor(15.505, "KWD")).toEqual({
      minorUnits: 15_505,
      currency: "KWD",
    });
  });

  it("rounds to a whole minor unit rather than storing a fraction", () => {
    // The rate form refuses an amount finer than the currency can hold, so
    // this only ever rounds away binary-float dust — never a real decimal.
    expect(moneyFromMajor(1.006, "USD").minorUnits).toBe(101);
    expect(moneyFromMajor(150.4, "JPY").minorUnits).toBe(150);
  });
});
