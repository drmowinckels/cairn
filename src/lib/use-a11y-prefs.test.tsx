import { describe, it, expect, beforeEach } from "vitest";
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

    const stored = JSON.parse(localStorage.getItem("cairn:a11y-prefs:v1") ?? "{}");
    expect(stored.textScale).toBe("xl");
    expect(stored.highContrast).toBe(true);
    expect(stored.detectionPrompts).toBe("off");
  });

  it("restores stored prefs on remount", () => {
    localStorage.setItem(
      "cairn:a11y-prefs:v1",
      JSON.stringify({ textScale: "lg", colorblindSafe: true, detectionPrompts: "modal" }),
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
    const stored = JSON.parse(localStorage.getItem("cairn:a11y-prefs:v1") ?? "{}");
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
});
