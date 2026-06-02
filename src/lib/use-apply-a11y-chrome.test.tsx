import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import {
  A11Y_DEFAULTS,
  A11Y_STORAGE_KEY,
  applyA11yChrome,
  loadA11yPrefs,
  matchesReduceMotion,
  resolveTheme,
  useApplyA11yChrome,
} from "./use-apply-a11y-chrome";

beforeEach(() => {
  localStorage.clear();
  for (const key of Object.keys(document.documentElement.dataset)) {
    delete document.documentElement.dataset[key];
  }
});

describe("loadA11yPrefs", () => {
  it("returns defaults when nothing is stored", () => {
    expect(loadA11yPrefs()).toEqual(A11Y_DEFAULTS);
  });

  it("merges a stored blob over the defaults", () => {
    localStorage.setItem(
      A11Y_STORAGE_KEY,
      JSON.stringify({ textScale: "xl", colorblindSafe: true }),
    );
    const prefs = loadA11yPrefs();
    expect(prefs.textScale).toBe("xl");
    expect(prefs.colorblindSafe).toBe(true);
    expect(prefs.announce).toBe(true);
  });

  it("falls back to defaults on corrupted JSON", () => {
    localStorage.setItem(A11Y_STORAGE_KEY, "{not json");
    expect(loadA11yPrefs().textScale).toBe("md");
  });

  it("coerces a tampered ambiguityDefault to 'prompt'", () => {
    localStorage.setItem(
      A11Y_STORAGE_KEY,
      JSON.stringify({ ambiguityDefault: "yes" }),
    );
    expect(loadA11yPrefs().ambiguityDefault).toBe("prompt");
  });
});

describe("matchesReduceMotion", () => {
  const realMatchMedia = window.matchMedia;
  afterEach(() => {
    window.matchMedia = realMatchMedia;
  });

  it("returns true when the OS prefers reduced motion", () => {
    window.matchMedia = vi.fn().mockReturnValue({
      matches: true,
    }) as unknown as typeof window.matchMedia;
    expect(matchesReduceMotion()).toBe(true);
  });

  it("returns false when matchMedia is unavailable", () => {
    window.matchMedia = undefined as unknown as typeof window.matchMedia;
    expect(matchesReduceMotion()).toBe(false);
  });
});

describe("applyA11yChrome without matchMedia", () => {
  const realMatchMedia = window.matchMedia;
  afterEach(() => {
    window.matchMedia = realMatchMedia;
  });

  it("still paints datasets and returns a no-op cleanup", () => {
    window.matchMedia = undefined as unknown as typeof window.matchMedia;
    const cleanup = applyA11yChrome({ ...A11Y_DEFAULTS, theme: "system" });
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(() => cleanup()).not.toThrow();
  });
});

describe("resolveTheme", () => {
  it("returns the explicit pref unchanged", () => {
    expect(resolveTheme("dark", null)).toBe("dark");
    expect(resolveTheme("light", null)).toBe("light");
  });

  it("resolves 'system' against the media query", () => {
    expect(resolveTheme("system", { matches: true } as MediaQueryList)).toBe(
      "dark",
    );
    expect(resolveTheme("system", { matches: false } as MediaQueryList)).toBe(
      "light",
    );
    expect(resolveTheme("system", null)).toBe("light");
  });
});

describe("applyA11yChrome", () => {
  it("paints every dataset attribute onto the root", () => {
    const cleanup = applyA11yChrome({
      ...A11Y_DEFAULTS,
      theme: "dark",
      textScale: "lg",
      highContrast: true,
      reduceMotion: true,
      colorblindSafe: true,
      alwaysFocusRing: true,
      detectionPrompts: "modal",
    });
    const ds = document.documentElement.dataset;
    expect(ds.theme).toBe("dark");
    expect(ds.textScale).toBe("lg");
    expect(ds.highContrast).toBe("on");
    expect(ds.reduceMotion).toBe("on");
    expect(ds.colorblind).toBe("on");
    expect(ds.focusRing).toBe("always");
    expect(ds.detectionPrompts).toBe("modal");
    cleanup();
  });

  it("writes the off/kbd variants for falsy flags", () => {
    const cleanup = applyA11yChrome(A11Y_DEFAULTS);
    const ds = document.documentElement.dataset;
    expect(ds.highContrast).toBe("off");
    expect(ds.reduceMotion).toBe("off");
    expect(ds.colorblind).toBe("off");
    expect(ds.focusRing).toBe("kbd");
    expect(ds.theme).toBe("light");
    cleanup();
  });

  describe("when the OS prefers dark", () => {
    const realMatchMedia = window.matchMedia;
    afterEach(() => {
      window.matchMedia = realMatchMedia;
    });

    it("tracks live OS changes for the 'system' theme and cleans up", () => {
      let changeHandler: (() => void) | null = null;
      const removeEventListener = vi.fn();
      const mq = {
        matches: true,
        addEventListener: (_: string, cb: () => void) => {
          changeHandler = cb;
        },
        removeEventListener,
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

      const cleanup = applyA11yChrome({ ...A11Y_DEFAULTS, theme: "system" });
      expect(document.documentElement.dataset.theme).toBe("dark");

      mq.matches = false;
      act(() => changeHandler?.());
      expect(document.documentElement.dataset.theme).toBe("light");

      const handler = changeHandler;
      cleanup();
      expect(removeEventListener).toHaveBeenCalledWith("change", handler);
    });
  });
});

describe("useApplyA11yChrome", () => {
  it("applies the stored prefs to the root on mount", () => {
    localStorage.setItem(
      A11Y_STORAGE_KEY,
      JSON.stringify({ theme: "dark", textScale: "xl", reduceMotion: true }),
    );
    renderHook(() => useApplyA11yChrome());
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(document.documentElement.dataset.textScale).toBe("xl");
    expect(document.documentElement.dataset.reduceMotion).toBe("on");
  });

  it("applies defaults when nothing is stored", () => {
    renderHook(() => useApplyA11yChrome());
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(document.documentElement.dataset.textScale).toBe("md");
  });
});
