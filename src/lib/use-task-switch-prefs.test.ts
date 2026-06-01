import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useTaskSwitchPrefs } from "./use-task-switch-prefs";
import { TASK_SWITCH_OFF } from "./task-switch";

const KEY = "cairn:task-switch:v1";

describe("useTaskSwitchPrefs", () => {
  beforeEach(() => window.localStorage.clear());
  afterEach(() => vi.restoreAllMocks());

  it("defaults to off when nothing is stored", () => {
    const { result } = renderHook(() => useTaskSwitchPrefs());
    expect(result.current.prefs).toEqual(TASK_SWITCH_OFF);
  });

  it("reads and clamps stored prefs", () => {
    window.localStorage.setItem(
      KEY,
      JSON.stringify({ enabled: true, dwellSeconds: 90, throttleMinutes: 15 }),
    );
    const { result } = renderHook(() => useTaskSwitchPrefs());
    expect(result.current.prefs).toEqual({
      enabled: true,
      dwellSeconds: 90,
      throttleMinutes: 15,
    });
  });

  it("falls back to defaults for malformed numeric fields", () => {
    window.localStorage.setItem(
      KEY,
      JSON.stringify({
        enabled: true,
        dwellSeconds: -5,
        throttleMinutes: "nope",
      }),
    );
    const { result } = renderHook(() => useTaskSwitchPrefs());
    expect(result.current.prefs).toEqual({
      enabled: true,
      dwellSeconds: 60,
      throttleMinutes: 30,
    });
  });

  it("falls back to off on unparseable JSON", () => {
    window.localStorage.setItem(KEY, "{not json");
    const { result } = renderHook(() => useTaskSwitchPrefs());
    expect(result.current.prefs).toEqual(TASK_SWITCH_OFF);
  });

  it("persists toggle and numeric setters, flooring/clamping", () => {
    const { result } = renderHook(() => useTaskSwitchPrefs());
    act(() => result.current.setEnabled(true));
    act(() => result.current.setDwellSeconds(45.9));
    act(() => result.current.setThrottleMinutes(0));
    expect(result.current.prefs).toEqual({
      enabled: true,
      dwellSeconds: 45,
      throttleMinutes: 1,
    });
    expect(JSON.parse(window.localStorage.getItem(KEY) as string)).toEqual({
      enabled: true,
      dwellSeconds: 45,
      throttleMinutes: 1,
    });
  });

  it("keeps the in-memory change when the write fails (private mode)", () => {
    const spy = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(() => {
        throw new Error("QuotaExceeded");
      });
    const { result } = renderHook(() => useTaskSwitchPrefs());
    act(() => result.current.setEnabled(true));
    expect(result.current.prefs.enabled).toBe(true);
    spy.mockRestore();
  });
});
