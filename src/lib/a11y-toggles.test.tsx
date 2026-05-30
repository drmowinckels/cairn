import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { useA11yPrefs } from "./use-a11y-prefs";

/**
 * End-to-end "toggle wires to a real effect" tests. Each one asserts:
 *
 *   1. flipping the pref via `useA11yPrefs` writes the expected
 *      `data-*` attribute onto `<html>`
 *   2. at least one CSS rule from `src/brand.css` actually reacts to
 *      that attribute — checked via `getComputedStyle()` on a probe
 *      element styled by the rule under test.
 *
 * The full stylesheet is injected at module load so happy-dom's CSSOM
 * sees the cascade exactly as a browser would. Tests that don't need
 * the stylesheet still benefit from this — the injection is idempotent.
 */

let injected: HTMLStyleElement | null = null;

function injectBrandCss() {
  if (injected) return;
  const css = readFileSync(
    resolve(__dirname, "..", "brand.css"),
    "utf-8",
  );
  const style = document.createElement("style");
  style.dataset.testid = "brand-css";
  style.textContent = css;
  document.head.appendChild(style);
  injected = style;
}

beforeEach(() => {
  injectBrandCss();
  localStorage.clear();
  for (const key of Object.keys(document.documentElement.dataset)) {
    delete document.documentElement.dataset[key];
  }
});

afterEach(() => {
  // Keep the stylesheet across tests; tearing down only the dataset
  // keeps the css-rule cache hot in happy-dom.
});

describe("a11y toggles: data-attribute + CSS reaction", () => {
  // ----- Text size --------------------------------------------------

  it("text size: sets data-text-scale and changes --font-base on root", () => {
    const { result } = renderHook(() => useA11yPrefs());
    const root = document.documentElement;

    act(() => result.current.setTextScale("md"));
    expect(root.dataset.textScale).toBe("md");
    const mdFontBase = getComputedStyle(root)
      .getPropertyValue("--font-base")
      .trim();
    expect(mdFontBase).toBe("17.5px");

    act(() => result.current.setTextScale("xl"));
    expect(root.dataset.textScale).toBe("xl");
    const xlFontBase = getComputedStyle(root)
      .getPropertyValue("--font-base")
      .trim();
    expect(xlFontBase).toBe("23px");
    expect(xlFontBase).not.toBe(mdFontBase);

    act(() => result.current.setTextScale("sm"));
    const smFontBase = getComputedStyle(root)
      .getPropertyValue("--font-base")
      .trim();
    expect(smFontBase).toBe("15.5px");
  });

  it("text size: --font-small and --font-tiny scale alongside --font-base", () => {
    const { result } = renderHook(() => useA11yPrefs());
    const root = document.documentElement;

    act(() => result.current.setTextScale("xl"));
    const cs = getComputedStyle(root);
    expect(cs.getPropertyValue("--font-small").trim()).toBe("19.5px");
    expect(cs.getPropertyValue("--font-tiny").trim()).toBe("16.5px");
    expect(cs.getPropertyValue("--font-display").trim()).toBe("60px");
  });

  // ----- High contrast ---------------------------------------------

  it("high contrast: sets data-high-contrast and overrides --hairline", () => {
    const { result } = renderHook(() => useA11yPrefs());
    const root = document.documentElement;

    const before = getComputedStyle(root)
      .getPropertyValue("--hairline")
      .trim();

    act(() => result.current.setHighContrast(true));
    expect(root.dataset.highContrast).toBe("on");
    const after = getComputedStyle(root)
      .getPropertyValue("--hairline")
      .trim();
    expect(after).not.toBe(before);
    expect(after).toBe("rgba(61, 64, 91, 0.5)");
  });

  it("high contrast off restores the default --hairline", () => {
    const { result } = renderHook(() => useA11yPrefs());
    const root = document.documentElement;
    act(() => result.current.setHighContrast(true));
    act(() => result.current.setHighContrast(false));
    expect(root.dataset.highContrast).toBe("off");
    expect(getComputedStyle(root).getPropertyValue("--hairline").trim()).toBe(
      "rgba(61, 64, 91, 0.12)",
    );
  });

  // ----- Reduce motion ---------------------------------------------

  it("reduce motion: sets data-reduce-motion and zeroes transition-duration", () => {
    const { result } = renderHook(() => useA11yPrefs());
    const root = document.documentElement;

    const probe = document.createElement("div");
    probe.style.transition = "all 250ms linear";
    document.body.appendChild(probe);

    act(() => result.current.setReduceMotion(true));
    expect(root.dataset.reduceMotion).toBe("on");
    const td = getComputedStyle(probe).transitionDuration.trim();
    // Browsers normalise "0ms" / "0s"; either is fine.
    expect(td === "0ms" || td === "0s").toBe(true);

    probe.remove();
  });

  // ----- Focus rings always visible --------------------------------

  it("focus rings always: sets data-focus-ring=always and gives :focus an outline", () => {
    const { result } = renderHook(() => useA11yPrefs());
    const root = document.documentElement;

    act(() => result.current.setAlwaysFocusRing(true));
    expect(root.dataset.focusRing).toBe("always");

    // The CSS rule `:root[data-focus-ring="always"] *:focus` paints
    // an outline; if it's present we can read it via a probe element
    // that's currently focused.
    const btn = document.createElement("button");
    document.body.appendChild(btn);
    btn.focus();
    const outline = getComputedStyle(btn).outlineWidth;
    expect(outline).toBe("2px");
    btn.remove();

    act(() => result.current.setAlwaysFocusRing(false));
    expect(root.dataset.focusRing).toBe("kbd");
  });

  // ----- Colorblind-safe palette -----------------------------------

  it("colorblind: sets data-colorblind and brand.css carries reactive rules for it", () => {
    const { result } = renderHook(() => useA11yPrefs());
    const root = document.documentElement;

    act(() => result.current.setColorblindSafe(true));
    expect(root.dataset.colorblind).toBe("on");

    // happy-dom doesn't fully resolve outline shorthand on compound
    // selectors via getComputedStyle, so assert the cascade-level
    // contract instead: at least one rule in brand.css is keyed on
    // [data-colorblind="on"] and applies a non-trivial style.
    const rules = listAllCssRules();
    const cbRules = rules.filter((r) =>
      r.selectorText?.includes('data-colorblind="on"'),
    );
    expect(cbRules.length).toBeGreaterThan(0);
    expect(cbRules.some((r) => r.cssText.includes("outline"))).toBe(true);

    act(() => result.current.setColorblindSafe(false));
    expect(root.dataset.colorblind).toBe("off");
  });
});

function listAllCssRules(): CSSStyleRule[] {
  const out: CSSStyleRule[] = [];
  for (const sheet of Array.from(document.styleSheets)) {
    let rules: CSSRuleList;
    try {
      rules = sheet.cssRules;
    } catch {
      continue;
    }
    for (const r of Array.from(rules)) {
      if (r instanceof CSSStyleRule) out.push(r);
    }
  }
  return out;
}
