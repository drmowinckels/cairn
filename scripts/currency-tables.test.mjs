import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The currency-scale tables exist twice — once in Rust for invoice rendering,
 * once in TypeScript for display and rate entry — because one process can't
 * read the other's constants. A code present on one side only would mean a
 * rate stored at 100x its intended value or an invoice showing decimals the
 * currency doesn't have, and nothing else in the suite would notice. So this
 * compares the two sources directly.
 */
const rust = readFileSync("src-tauri/src/plugins/billing/currency.rs", "utf8");
const ts = readFileSync("src/lib/money.ts", "utf8");

/** The currency codes in a named array declaration. Anchored on the `= [ ... ]`
 *  assignment rather than the name's first appearance, so neither a mention in
 *  a doc comment nor Rust's `[&str; N]` type annotation is mistaken for the
 *  array body. */
function codes(source, name) {
  const body = source.match(
    new RegExp(`${name}[^=]*=\\s*\\[([^\\]]*)\\]`),
  )?.[1];
  if (body === undefined) throw new Error(`no ${name} array found`);
  return [...body.matchAll(/"([A-Z]{3})"/g)].map((m) => m[1]);
}

describe("currency scale tables (#109)", () => {
  for (const table of ["ZERO_DECIMAL", "THREE_DECIMAL"]) {
    it(`${table} holds the same codes in Rust and TypeScript`, () => {
      const fromRust = codes(rust, table);
      const fromTs = codes(ts, table);
      expect(fromRust.length).toBeGreaterThan(0);
      expect([...fromTs].sort()).toEqual([...fromRust].sort());
    });
  }

  it("declares the Rust array lengths the tables actually have", () => {
    // `[&str; N]` is a fixed-size array, so a code added without bumping N
    // fails to compile — but a wrong N with a matching count would silently
    // pass, so pin the declared length to the codes present.
    for (const table of ["ZERO_DECIMAL", "THREE_DECIMAL"]) {
      const declared = rust.match(
        new RegExp(`${table}: \\[&str; (\\d+)\\]`),
      )?.[1];
      expect(Number(declared)).toBe(codes(rust, table).length);
    }
  });

  it("keeps the two scale lists disjoint", () => {
    const zero = codes(rust, "ZERO_DECIMAL");
    const three = codes(rust, "THREE_DECIMAL");
    expect(zero.filter((c) => three.includes(c))).toEqual([]);
  });
});
