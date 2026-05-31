import { afterEach, describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useRoundingPrefs } from "./use-rounding-prefs";

const STORAGE_KEY = "cairn:rounding:v1";

afterEach(() => window.localStorage.clear());

describe("useRoundingPrefs", () => {
  it("defaults to disabled rounding", () => {
    const { result } = renderHook(() => useRoundingPrefs());
    expect(result.current.rounding).toEqual({
      intervalMinutes: 0,
      mode: "nearest",
    });
  });

  it("persists the interval and mode to localStorage", () => {
    const { result } = renderHook(() => useRoundingPrefs());
    act(() => result.current.setIntervalMinutes(15));
    act(() => result.current.setMode("up"));
    expect(result.current.rounding).toEqual({
      intervalMinutes: 15,
      mode: "up",
    });
    expect(JSON.parse(window.localStorage.getItem(STORAGE_KEY)!)).toEqual({
      intervalMinutes: 15,
      mode: "up",
    });
  });

  it("reads a persisted preference on mount", () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ intervalMinutes: 30, mode: "down" }),
    );
    const { result } = renderHook(() => useRoundingPrefs());
    expect(result.current.rounding).toEqual({
      intervalMinutes: 30,
      mode: "down",
    });
  });

  it("falls back to defaults on malformed storage", () => {
    window.localStorage.setItem(STORAGE_KEY, "not json");
    const { result } = renderHook(() => useRoundingPrefs());
    expect(result.current.rounding).toEqual({
      intervalMinutes: 0,
      mode: "nearest",
    });
  });

  it("coerces a negative interval to disabled", () => {
    const { result } = renderHook(() => useRoundingPrefs());
    act(() => result.current.setIntervalMinutes(-5));
    expect(result.current.rounding.intervalMinutes).toBe(0);
  });
});
