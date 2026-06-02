import { beforeEach, describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useUpdatePrefs } from "./use-update-prefs";

const KEY = "cairn:update-check:v1";

beforeEach(() => {
  window.localStorage?.clear?.();
});

describe("useUpdatePrefs", () => {
  it("defaults to off (opt-in)", () => {
    const { result } = renderHook(() => useUpdatePrefs());
    expect(result.current.enabled).toBe(false);
    expect(window.localStorage.getItem(KEY)).toBeNull();
  });

  it("setEnabled persists the choice", () => {
    const { result } = renderHook(() => useUpdatePrefs());
    act(() => result.current.setEnabled(true));
    expect(result.current.enabled).toBe(true);
    expect(window.localStorage.getItem(KEY)).toBe(
      JSON.stringify({ enabled: true }),
    );
    act(() => result.current.setEnabled(false));
    expect(result.current.enabled).toBe(false);
    expect(window.localStorage.getItem(KEY)).toBe(
      JSON.stringify({ enabled: false }),
    );
  });

  it("reads a previously-enabled preference at mount", () => {
    window.localStorage.setItem(KEY, JSON.stringify({ enabled: true }));
    const { result } = renderHook(() => useUpdatePrefs());
    expect(result.current.enabled).toBe(true);
  });

  it("treats malformed storage as off", () => {
    window.localStorage.setItem(KEY, "{not json");
    const { result } = renderHook(() => useUpdatePrefs());
    expect(result.current.enabled).toBe(false);
  });
});
