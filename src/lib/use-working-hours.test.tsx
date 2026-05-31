import { afterEach, describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useWorkingHours, WORKING_HOURS_OFF } from "./use-working-hours";

const KEY = "cairn:working-hours:v1";

afterEach(() => window.localStorage.clear());

describe("useWorkingHours", () => {
  it("defaults to off with a sane window and idle threshold", () => {
    const { result } = renderHook(() => useWorkingHours());
    expect(result.current.workingHours).toEqual(WORKING_HOURS_OFF);
    expect(result.current.workingHours.enabled).toBe(false);
  });

  it("persists each setter to localStorage", () => {
    const { result } = renderHook(() => useWorkingHours());
    act(() => result.current.setEnabled(true));
    act(() => result.current.setStartMinute(8 * 60));
    act(() => result.current.setEndMinute(16 * 60));
    act(() => result.current.setThrottleMinutes(45));
    act(() => result.current.setIdleMinutes(15));
    expect(result.current.workingHours).toEqual({
      enabled: true,
      startMinute: 8 * 60,
      endMinute: 16 * 60,
      throttleMinutes: 45,
      idleMinutes: 15,
    });
    const stored = JSON.parse(window.localStorage.getItem(KEY) ?? "{}");
    expect(stored.enabled).toBe(true);
    expect(stored.startMinute).toBe(8 * 60);
  });

  it("rehydrates a stored value on mount", () => {
    window.localStorage.setItem(
      KEY,
      JSON.stringify({
        enabled: true,
        startMinute: 600,
        endMinute: 1000,
        throttleMinutes: 20,
        idleMinutes: 5,
      }),
    );
    const { result } = renderHook(() => useWorkingHours());
    expect(result.current.workingHours.enabled).toBe(true);
    expect(result.current.workingHours.startMinute).toBe(600);
    expect(result.current.workingHours.idleMinutes).toBe(5);
  });

  it("falls back for malformed (valid JSON, invalid fields)", () => {
    window.localStorage.setItem(
      KEY,
      JSON.stringify({
        enabled: "yes",
        startMinute: "nope",
        endMinute: 99_999,
        throttleMinutes: 0,
        idleMinutes: -4,
      }),
    );
    const { result } = renderHook(() => useWorkingHours());
    expect(result.current.workingHours.enabled).toBe(false);
    expect(result.current.workingHours.startMinute).toBe(
      WORKING_HOURS_OFF.startMinute,
    );
    expect(result.current.workingHours.endMinute).toBe(24 * 60);
    expect(result.current.workingHours.throttleMinutes).toBe(
      WORKING_HOURS_OFF.throttleMinutes,
    );
    expect(result.current.workingHours.idleMinutes).toBe(
      WORKING_HOURS_OFF.idleMinutes,
    );
  });

  it("falls back to off when JSON is corrupt", () => {
    window.localStorage.setItem(KEY, "{not json");
    const { result } = renderHook(() => useWorkingHours());
    expect(result.current.workingHours).toEqual(WORKING_HOURS_OFF);
  });

  it("clamps setter inputs", () => {
    const { result } = renderHook(() => useWorkingHours());
    act(() => result.current.setStartMinute(-50));
    act(() => result.current.setEndMinute(99_999));
    act(() => result.current.setThrottleMinutes(0));
    act(() => result.current.setIdleMinutes(0));
    expect(result.current.workingHours.startMinute).toBe(0);
    expect(result.current.workingHours.endMinute).toBe(24 * 60);
    expect(result.current.workingHours.throttleMinutes).toBe(1);
    expect(result.current.workingHours.idleMinutes).toBe(1);
  });
});
