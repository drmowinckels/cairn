import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useTimelineViewPrefs } from "./use-timeline-view-prefs";

afterEach(() => {
  window.localStorage.clear();
});

describe("useTimelineViewPrefs (#188)", () => {
  it("defaults to the list view", () => {
    const { result } = renderHook(() => useTimelineViewPrefs());
    expect(result.current.view).toBe("list");
  });

  it("reads a persisted timeline preference on mount", () => {
    window.localStorage.setItem("cairn:today-entries-view:v1", "timeline");
    const { result } = renderHook(() => useTimelineViewPrefs());
    expect(result.current.view).toBe("timeline");
  });

  it("persists a change and exposes it", () => {
    const { result } = renderHook(() => useTimelineViewPrefs());
    act(() => result.current.setView("timeline"));
    expect(result.current.view).toBe("timeline");
    expect(window.localStorage.getItem("cairn:today-entries-view:v1")).toBe(
      "timeline",
    );
  });

  it("treats an unknown stored value as list", () => {
    window.localStorage.setItem("cairn:today-entries-view:v1", "bogus");
    const { result } = renderHook(() => useTimelineViewPrefs());
    expect(result.current.view).toBe("list");
  });

  it("falls back to list when reading localStorage throws", () => {
    // happy-dom storage methods are own-properties, so spy the instance.
    const spy = vi
      .spyOn(window.localStorage, "getItem")
      .mockImplementation(() => {
        throw new Error("blocked");
      });
    const { result } = renderHook(() => useTimelineViewPrefs());
    expect(result.current.view).toBe("list");
    spy.mockRestore();
  });
});
