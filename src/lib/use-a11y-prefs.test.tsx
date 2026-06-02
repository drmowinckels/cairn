import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useA11yPrefs } from "./use-a11y-prefs";

beforeEach(() => {
  localStorage.clear();
  for (const key of Object.keys(document.documentElement.dataset)) {
    delete document.documentElement.dataset[key];
  }
});

describe("useA11yPrefs", () => {
  it("seeds defaults and writes data attributes on mount", () => {
    const { result } = renderHook(() => useA11yPrefs());
    expect(result.current.textScale).toBe("md");
    expect(result.current.detectionPrompts).toBe("subtle");
    expect(result.current.announce).toBe(true);
    expect(document.documentElement.dataset.textScale).toBe("md");
    expect(document.documentElement.dataset.detectionPrompts).toBe("subtle");
  });

  it("persists changes to localStorage and reflects them on the root element", () => {
    const { result } = renderHook(() => useA11yPrefs());
    act(() => result.current.setTextScale("xl"));
    act(() => result.current.setHighContrast(true));
    act(() => result.current.setDetectionPrompts("off"));

    expect(document.documentElement.dataset.textScale).toBe("xl");
    expect(document.documentElement.dataset.highContrast).toBe("on");
    expect(document.documentElement.dataset.detectionPrompts).toBe("off");

    const stored = JSON.parse(
      localStorage.getItem("cairn:a11y-prefs:v1") ?? "{}",
    );
    expect(stored.textScale).toBe("xl");
    expect(stored.highContrast).toBe(true);
    expect(stored.detectionPrompts).toBe("off");
  });

  it("restores stored prefs on remount", () => {
    localStorage.setItem(
      "cairn:a11y-prefs:v1",
      JSON.stringify({
        textScale: "lg",
        colorblindSafe: true,
        detectionPrompts: "modal",
      }),
    );
    const { result } = renderHook(() => useA11yPrefs());
    expect(result.current.textScale).toBe("lg");
    expect(result.current.colorblindSafe).toBe(true);
    expect(result.current.detectionPrompts).toBe("modal");
    expect(result.current.announce).toBe(true);
  });

  it("ignores corrupted localStorage and falls back to defaults", () => {
    localStorage.setItem("cairn:a11y-prefs:v1", "{not json");
    const { result } = renderHook(() => useA11yPrefs());
    expect(result.current.textScale).toBe("md");
  });

  it("setReduceMotion toggles the data attribute on the root", () => {
    const { result } = renderHook(() => useA11yPrefs());
    act(() => result.current.setReduceMotion(true));
    expect(document.documentElement.dataset.reduceMotion).toBe("on");
    act(() => result.current.setReduceMotion(false));
    expect(document.documentElement.dataset.reduceMotion).toBe("off");
  });

  it("setColorblindSafe toggles the data attribute on the root", () => {
    const { result } = renderHook(() => useA11yPrefs());
    act(() => result.current.setColorblindSafe(true));
    expect(document.documentElement.dataset.colorblind).toBe("on");
    expect(result.current.colorblindSafe).toBe(true);
  });

  it("setAnnounce persists the change to localStorage", () => {
    const { result } = renderHook(() => useA11yPrefs());
    act(() => result.current.setAnnounce(false));
    const stored = JSON.parse(
      localStorage.getItem("cairn:a11y-prefs:v1") ?? "{}",
    );
    expect(stored.announce).toBe(false);
    expect(result.current.announce).toBe(false);
  });

  it("setAlwaysFocusRing flips the root data attribute between kbd and always", () => {
    const { result } = renderHook(() => useA11yPrefs());
    expect(document.documentElement.dataset.focusRing).toBe("kbd");
    act(() => result.current.setAlwaysFocusRing(true));
    expect(document.documentElement.dataset.focusRing).toBe("always");
    act(() => result.current.setAlwaysFocusRing(false));
    expect(document.documentElement.dataset.focusRing).toBe("kbd");
  });

  // ---- #71: global ambiguity default --------------------------------

  it("seeds ambiguityDefault to 'prompt' on first mount", () => {
    const { result } = renderHook(() => useA11yPrefs());
    expect(result.current.ambiguityDefault).toBe("prompt");
  });

  it("setAmbiguityDefault persists the change to localStorage", () => {
    const { result } = renderHook(() => useA11yPrefs());
    act(() => result.current.setAmbiguityDefault("log-to-uncategorized"));
    expect(result.current.ambiguityDefault).toBe("log-to-uncategorized");
    const stored = JSON.parse(
      localStorage.getItem("cairn:a11y-prefs:v1") ?? "{}",
    );
    expect(stored.ambiguityDefault).toBe("log-to-uncategorized");
  });

  it("restores ambiguityDefault from localStorage on remount", () => {
    localStorage.setItem(
      "cairn:a11y-prefs:v1",
      JSON.stringify({ ambiguityDefault: "skip" }),
    );
    const { result } = renderHook(() => useA11yPrefs());
    expect(result.current.ambiguityDefault).toBe("skip");
  });

  it("falls back to 'prompt' when stored ambiguityDefault is missing (legacy a11y blob)", () => {
    // Older localStorage payloads predate #71 and don't carry the
    // field. The defaults merge must fill it in.
    localStorage.setItem(
      "cairn:a11y-prefs:v1",
      JSON.stringify({ textScale: "lg", detectionPrompts: "modal" }),
    );
    const { result } = renderHook(() => useA11yPrefs());
    expect(result.current.ambiguityDefault).toBe("prompt");
  });

  // ---- theme: light / dark / system ---------------------------------

  it("seeds theme to 'system' and resolves it to light on the root", () => {
    const { result } = renderHook(() => useA11yPrefs());
    expect(result.current.theme).toBe("system");
    // happy-dom reports no dark preference, so system → light.
    expect(document.documentElement.dataset.theme).toBe("light");
  });

  it("setTheme writes the resolved theme to the root and persists the pref", () => {
    const { result } = renderHook(() => useA11yPrefs());
    act(() => result.current.setTheme("dark"));
    expect(document.documentElement.dataset.theme).toBe("dark");
    act(() => result.current.setTheme("light"));
    expect(document.documentElement.dataset.theme).toBe("light");
    const stored = JSON.parse(
      localStorage.getItem("cairn:a11y-prefs:v1") ?? "{}",
    );
    expect(stored.theme).toBe("light");
  });

  it("restores an explicit theme from localStorage on remount", () => {
    localStorage.setItem(
      "cairn:a11y-prefs:v1",
      JSON.stringify({ theme: "dark" }),
    );
    const { result } = renderHook(() => useA11yPrefs());
    expect(result.current.theme).toBe("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
  });

  describe("when the OS prefers a dark color scheme", () => {
    const realMatchMedia = window.matchMedia;
    afterEach(() => {
      window.matchMedia = realMatchMedia;
    });

    it("resolves 'system' to dark and follows OS changes", () => {
      let changeHandler: (() => void) | null = null;
      const mq = {
        matches: true,
        addEventListener: (_: string, cb: () => void) => {
          changeHandler = cb;
        },
        removeEventListener: vi.fn(),
      };
      window.matchMedia = vi.fn().mockImplementation((q: string) =>
        q.includes("dark")
          ? mq
          : {
              matches: false,
              addEventListener: vi.fn(),
              removeEventListener: vi.fn(),
            },
      ) as unknown as typeof window.matchMedia;

      const { result } = renderHook(() => useA11yPrefs());
      expect(result.current.theme).toBe("system");
      expect(document.documentElement.dataset.theme).toBe("dark");

      // A live OS flip to light re-resolves without changing the pref.
      mq.matches = false;
      act(() => changeHandler?.());
      expect(document.documentElement.dataset.theme).toBe("light");
      expect(result.current.theme).toBe("system");
    });
  });

  it("coerces a tampered ambiguityDefault to 'prompt' (security-review on #71)", () => {
    // A hand-edited / corrupted blob could carry garbage. Without
    // the load-time coercion, this value would propagate to
    // `useRules.defaultAmbiguity` → `blankRule` → the rule body's
    // `ambiguityBehavior`, ending up persisted via `serializeRule`
    // (which only filters out `"prompt"`, not invalid strings).
    // Pin the boundary coercion so a tampered blob never reaches
    // `blankRule`.
    for (const garbage of [
      '{"ambiguityDefault":"yes"}',
      '{"ambiguityDefault":"LOG-TO-UNCATEGORIZED"}',
      '{"ambiguityDefault":null}',
      '{"ambiguityDefault":[]}',
      '{"ambiguityDefault":42}',
    ]) {
      localStorage.setItem("cairn:a11y-prefs:v1", garbage);
      const { result } = renderHook(() => useA11yPrefs());
      expect(result.current.ambiguityDefault).toBe("prompt");
    }
  });
});
