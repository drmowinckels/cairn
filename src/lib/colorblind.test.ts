import { describe, it, expect } from "vitest";
import { cbColor, OKABE_ITO } from "./colorblind";

describe("cbColor", () => {
  it("returns the input unchanged when colourblind mode is off", () => {
    expect(cbColor("#81b29a", false)).toBe("#81b29a");
    expect(cbColor("var(--ink-mute)", false)).toBe("var(--ink-mute)");
  });

  it("swaps each known brand colour to its Okabe-Ito slot when on", () => {
    expect(cbColor("#81b29a", true)).toBe("#009E73");
    expect(cbColor("#f2cc8f", true)).toBe("#E69F00");
    expect(cbColor("#e07a5f", true)).toBe("#D55E00");
    expect(cbColor("#9a9bb0", true)).toBe("#56B4E9");
    expect(cbColor("#c8b8e0", true)).toBe("#CC79A7");
  });

  it("treats short hex (#abc) the same as the equivalent six-digit form", () => {
    expect(cbColor("#abc", true)).toBe(cbColor("#aabbcc", true));
  });

  it("normalises hex case before lookup", () => {
    expect(cbColor("#81B29A", true)).toBe("#009E73");
    expect(cbColor("  #81b29a  ", true)).toBe("#009E73");
  });

  it("falls back to a deterministic Okabe-Ito slot for unknown hex", () => {
    const a = cbColor("#abcdef", true);
    const b = cbColor("#abcdef", true);
    expect(a).toBe(b);
    expect(OKABE_ITO).toContain(a);
  });

  it("falls back deterministically for non-hex CSS values", () => {
    const first = cbColor("var(--ink-mute)", true);
    const second = cbColor("var(--ink-mute)", true);
    expect(first).toBe(second);
    expect(OKABE_ITO).toContain(first);
  });

  it("exposes exactly 8 distinct Okabe-Ito colours", () => {
    expect(new Set(OKABE_ITO).size).toBe(8);
  });
});
