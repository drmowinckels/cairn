import { describe, expect, it } from "vitest";
import {
  blend,
  hexToRgb,
  luminance,
  parseColor,
  parseVars,
  ratio,
  resolveVar,
} from "./contrast-lib.mjs";

describe("hexToRgb", () => {
  it("parses 6-digit hex", () => {
    expect(hexToRgb("#3d405b")).toEqual({ r: 61, g: 64, b: 91, a: 1 });
  });

  it("ignores a leading #", () => {
    expect(hexToRgb("ffffff")).toEqual({ r: 255, g: 255, b: 255, a: 1 });
  });
});

describe("parseColor", () => {
  it("parses hex", () => {
    expect(parseColor("#000000")).toEqual({ r: 0, g: 0, b: 0, a: 1 });
  });

  it("parses rgb()", () => {
    expect(parseColor("rgb(10, 20, 30)")).toEqual({
      r: 10,
      g: 20,
      b: 30,
      a: 1,
    });
  });

  it("parses rgba() with fractional alpha", () => {
    expect(parseColor("rgba(61, 64, 91, 0.78)")).toEqual({
      r: 61,
      g: 64,
      b: 91,
      a: 0.78,
    });
  });

  it("returns null for unrecognised values", () => {
    expect(parseColor("var(--ink)")).toBeNull();
  });
});

describe("blend", () => {
  it("returns the foreground untouched at alpha 1", () => {
    const fg = { r: 61, g: 64, b: 91, a: 1 };
    const bg = { r: 255, g: 255, b: 255, a: 1 };
    expect(blend(fg, bg)).toEqual({ r: 61, g: 64, b: 91, a: 1 });
  });

  it("returns the background at alpha 0", () => {
    const fg = { r: 61, g: 64, b: 91, a: 0 };
    const bg = { r: 200, g: 200, b: 200, a: 1 };
    expect(blend(fg, bg)).toEqual({ r: 200, g: 200, b: 200, a: 1 });
  });

  it("interpolates linearly at alpha 0.5", () => {
    const fg = { r: 0, g: 0, b: 0, a: 0.5 };
    const bg = { r: 200, g: 200, b: 200, a: 1 };
    expect(blend(fg, bg)).toEqual({ r: 100, g: 100, b: 100, a: 1 });
  });
});

describe("luminance", () => {
  it("returns 1 for pure white", () => {
    expect(luminance({ r: 255, g: 255, b: 255 })).toBeCloseTo(1, 5);
  });

  it("returns 0 for pure black", () => {
    expect(luminance({ r: 0, g: 0, b: 0 })).toBeCloseTo(0, 5);
  });
});

describe("ratio", () => {
  it("returns 21:1 for black on white", () => {
    expect(ratio({ r: 0, g: 0, b: 0, a: 1 }, { r: 255, g: 255, b: 255, a: 1 }))
      .toBeCloseTo(21, 1);
  });

  it("is symmetric", () => {
    const a = { r: 61, g: 64, b: 91, a: 1 };
    const b = { r: 244, g: 241, b: 222, a: 1 };
    expect(ratio(a, b)).toBeCloseTo(ratio(b, a), 6);
  });

  it("flattens an rgba foreground against the opaque surface", () => {
    const fg = { r: 61, g: 64, b: 91, a: 0.78 };
    const bg = { r: 251, g: 249, b: 238, a: 1 };
    expect(ratio(fg, bg)).toBeGreaterThan(4.5);
  });

  it("reports the Cairn light theme --ink contrast on --surface above 9:1", () => {
    const ink = { r: 61, g: 64, b: 91, a: 1 };
    const surface = { r: 251, g: 249, b: 238, a: 1 };
    expect(ratio(ink, surface)).toBeGreaterThan(9);
  });
});

describe("parseVars", () => {
  it("extracts `--token: value;` pairs", () => {
    const css = "  --ink: #3d405b;\n  --ink-soft: rgba(61, 64, 91, 0.78);";
    expect(parseVars(css)).toEqual({
      "--ink": "#3d405b",
      "--ink-soft": "rgba(61, 64, 91, 0.78)",
    });
  });

  it("ignores non-custom-property declarations", () => {
    const css = "color: red; --ink: #3d405b;";
    const vars = parseVars(css);
    expect(vars).toEqual({ "--ink": "#3d405b" });
  });
});

describe("resolveVar", () => {
  it("returns the raw value for a non-var token", () => {
    const scope = { "--ink": "#3d405b" };
    expect(resolveVar("--ink", scope)).toBe("#3d405b");
  });

  it("follows a single var() indirection", () => {
    const scope = { "--accent": "var(--burnt-peach)", "--burnt-peach": "#e07a5f" };
    expect(resolveVar("--accent", scope)).toBe("#e07a5f");
  });

  it("returns null for unknown tokens", () => {
    expect(resolveVar("--missing", {})).toBeNull();
  });

  it("returns null when the var() chain breaks", () => {
    const scope = { "--accent": "var(--missing)" };
    expect(resolveVar("--accent", scope)).toBeNull();
  });
});
