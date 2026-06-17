import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { minutesNow, useMinuteClock } from "./use-minute-clock";

afterEach(() => {
  vi.useRealTimers();
});

describe("minutesNow", () => {
  it("returns the current local minute-of-day", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 0, 1, 9, 30, 0));
    expect(minutesNow()).toBeCloseTo(9 * 60 + 30, 5);
  });
});

describe("useMinuteClock", () => {
  it("returns the minute-of-day and advances on each 60s tick, then stops on unmount", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 0, 1, 9, 0, 0));
    const { result, unmount } = renderHook(() => useMinuteClock());
    expect(result.current).toBeCloseTo(9 * 60, 5);

    // advanceTimersByTime moves the faked Date too, so the interval's
    // minutesNow() reads 09:01.
    act(() => vi.advanceTimersByTime(60_000));
    expect(result.current).toBeCloseTo(9 * 60 + 1, 5);

    // After unmount the interval is cleared — a further tick doesn't update.
    unmount();
    act(() => vi.advanceTimersByTime(60_000));
    expect(result.current).toBeCloseTo(9 * 60 + 1, 5);
  });
});
