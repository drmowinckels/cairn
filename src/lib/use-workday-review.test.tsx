import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { useWorkdayReview } from "./use-workday-review";
import { WORKING_HOURS_OFF, type WorkingHours } from "./use-working-hours";

// endMinute=0 makes the trigger window [0, 1440) — the whole day — so the
// tests drive triggering via the injected count fetcher, not the wall clock.
const ALL_DAY: WorkingHours = { ...WORKING_HOURS_OFF, endMinute: 0 };

let nowMs = 1_000_000;
const now = () => nowMs;

beforeEach(() => {
  nowMs = 1_000_000;
});

afterEach(() => {
  vi.clearAllMocks();
});

function setup(over: Partial<Parameters<typeof useWorkdayReview>[0]> = {}) {
  const fetchUncategorizedCount =
    over.fetchUncategorizedCount ?? vi.fn().mockResolvedValue(3);
  const hook = renderHook(() =>
    useWorkdayReview({
      workingHours: ALL_DAY,
      enabled: true,
      activityLogEnabled: true,
      pollEnabled: true,
      pollMs: 1_000_000,
      now,
      ...over,
      fetchUncategorizedCount,
    }),
  );
  return { ...hook, fetchUncategorizedCount };
}

describe("useWorkdayReview", () => {
  it("activates when there's uncategorized activity in the trigger window", async () => {
    const { result } = setup();
    await act(async () => {});
    await waitFor(() => expect(result.current.active).toBe(true));
  });

  it("stays inactive and skips the backend when the toggle is off", async () => {
    const { result, fetchUncategorizedCount } = setup({ enabled: false });
    await act(async () => {});
    expect(result.current.active).toBe(false);
    expect(fetchUncategorizedCount).not.toHaveBeenCalled();
  });

  it("stays inactive and skips the backend when the activity log itself is off", async () => {
    const { result, fetchUncategorizedCount } = setup({
      activityLogEnabled: false,
    });
    await act(async () => {});
    expect(result.current.active).toBe(false);
    expect(fetchUncategorizedCount).not.toHaveBeenCalled();
  });

  it("stays inactive and skips the backend outside the trigger window", async () => {
    const { result, fetchUncategorizedCount } = setup({
      workingHours: { ...WORKING_HOURS_OFF, endMinute: 24 * 60 },
    });
    await act(async () => {});
    await waitFor(() => expect(result.current.active).toBe(false));
    // The window check is a cheap in-memory guard ahead of the fetch — an
    // out-of-window poll never needs to hit the backend at all.
    expect(fetchUncategorizedCount).not.toHaveBeenCalled();
  });

  it("stays inactive when there's nothing uncategorized", async () => {
    const { result } = setup({
      fetchUncategorizedCount: vi.fn().mockResolvedValue(0),
    });
    await act(async () => {});
    await waitFor(() => expect(result.current.active).toBe(false));
  });

  it("swallows a fetch failure without activating", async () => {
    const { result } = setup({
      fetchUncategorizedCount: vi.fn().mockRejectedValue(new Error("boom")),
    });
    await act(async () => {});
    expect(result.current.active).toBe(false);
  });

  it("dismiss arms the throttle so it won't immediately re-prompt", async () => {
    const { result } = setup({ pollMs: 20 });
    await waitFor(() => expect(result.current.active).toBe(true));
    act(() => result.current.dismiss());
    expect(result.current.active).toBe(false);
    // 30 minutes later (< 60-min throttle): still quiet.
    nowMs += 30 * 60_000;
    await new Promise((r) => setTimeout(r, 40));
    expect(result.current.active).toBe(false);
    // Past the throttle: the next poll re-activates it.
    nowMs += 35 * 60_000;
    await waitFor(() => expect(result.current.active).toBe(true));
  });

  it("acknowledge also arms the throttle", async () => {
    const { result } = setup();
    await waitFor(() => expect(result.current.active).toBe(true));
    act(() => result.current.acknowledge());
    expect(result.current.active).toBe(false);
  });

  it("does nothing when polling is disabled", async () => {
    const fetchUncategorizedCount = vi.fn().mockResolvedValue(3);
    const { result } = renderHook(() =>
      useWorkdayReview({
        workingHours: ALL_DAY,
        enabled: true,
        activityLogEnabled: true,
        pollEnabled: false,
        now,
        fetchUncategorizedCount,
      }),
    );
    await act(async () => {});
    expect(result.current.active).toBe(false);
    expect(fetchUncategorizedCount).not.toHaveBeenCalled();
  });

  it("uses default deps (no injected opts) and stays inactive outside Tauri", async () => {
    const { result } = renderHook(() =>
      useWorkdayReview({
        workingHours: ALL_DAY,
        enabled: true,
        activityLogEnabled: true,
      }),
    );
    await act(async () => {});
    expect(result.current.active).toBe(false);
  });

  it("re-evaluates on the poll interval", async () => {
    vi.useFakeTimers();
    try {
      const fetchUncategorizedCount = vi.fn().mockResolvedValue(3);
      renderHook(() =>
        useWorkdayReview({
          workingHours: ALL_DAY,
          enabled: true,
          activityLogEnabled: true,
          pollEnabled: true,
          pollMs: 1000,
          now,
          fetchUncategorizedCount,
        }),
      );
      await vi.advanceTimersByTimeAsync(0);
      const firstCount = fetchUncategorizedCount.mock.calls.length;
      await vi.advanceTimersByTimeAsync(1000);
      expect(fetchUncategorizedCount.mock.calls.length).toBeGreaterThan(
        firstCount,
      );
    } finally {
      vi.useRealTimers();
    }
  });
});
