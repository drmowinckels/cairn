import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { useWorkingHoursReminder } from "./use-working-hours-reminder";
import { WORKING_HOURS_OFF, type WorkingHours } from "./use-working-hours";

// A working-hours config whose window covers all 24h so `minuteOfDay` (real
// local clock) is always inside it — the tests drive triggering via the
// injected idle/running fetchers, not the wall clock.
const ALL_DAY: WorkingHours = {
  enabled: true,
  startMinute: 0,
  endMinute: 24 * 60,
  throttleMinutes: 30,
  idleMinutes: 5,
};

let nowMs = 1_000_000;
const now = () => nowMs;

beforeEach(() => {
  nowMs = 1_000_000;
});

afterEach(() => {
  vi.clearAllMocks();
});

function setup(over: Partial<Parameters<typeof useWorkingHoursReminder>[0]> = {}) {
  const fetchIdleSeconds = over.fetchIdleSeconds ?? vi.fn().mockResolvedValue(600);
  const fetchRunning = over.fetchRunning ?? vi.fn().mockResolvedValue(null);
  const hook = renderHook(() =>
    useWorkingHoursReminder({
      workingHours: ALL_DAY,
      enabled: true,
      pollMs: 1_000_000,
      now,
      ...over,
      fetchIdleSeconds,
      fetchRunning,
    }),
  );
  return { ...hook, fetchIdleSeconds, fetchRunning };
}

describe("useWorkingHoursReminder", () => {
  it("activates when idle past the threshold in window with no timer", async () => {
    const { result } = setup();
    await act(async () => {});
    await waitFor(() => expect(result.current.active).toBe(true));
  });

  it("stays inactive and skips the backend while disabled", async () => {
    const { result, fetchRunning } = setup({ workingHours: WORKING_HOURS_OFF });
    await act(async () => {});
    expect(result.current.active).toBe(false);
    // Disabled short-circuits before hitting the backend fetchers.
    expect(fetchRunning).not.toHaveBeenCalled();
  });

  it("stays inactive when a timer is already running", async () => {
    const { result } = setup({ fetchRunning: vi.fn().mockResolvedValue({ id: "e1" }) });
    await act(async () => {});
    await waitFor(() => expect(result.current.active).toBe(false));
  });

  it("stays inactive when idle is below the threshold", async () => {
    const { result } = setup({ fetchIdleSeconds: vi.fn().mockResolvedValue(60) });
    await act(async () => {});
    await waitFor(() => expect(result.current.active).toBe(false));
  });

  it("stays inactive when idle can't be reported", async () => {
    const { result } = setup({ fetchIdleSeconds: vi.fn().mockResolvedValue(null) });
    await act(async () => {});
    await waitFor(() => expect(result.current.active).toBe(false));
  });

  it("dismiss arms the throttle so it won't immediately re-prompt", async () => {
    // Short poll so re-evaluation happens on the interval after we advance
    // the injected clock.
    const { result } = setup({ pollMs: 20 });
    await waitFor(() => expect(result.current.active).toBe(true));
    act(() => result.current.dismiss());
    expect(result.current.active).toBe(false);
    // 10 minutes later (< 30-min throttle): the next poll keeps it quiet.
    nowMs += 10 * 60_000;
    await new Promise((r) => setTimeout(r, 40));
    expect(result.current.active).toBe(false);
    // Past the throttle: the next poll re-activates it.
    nowMs += 25 * 60_000;
    await waitFor(() => expect(result.current.active).toBe(true));
  });

  it("acknowledge also arms the throttle", async () => {
    const { result } = setup();
    await waitFor(() => expect(result.current.active).toBe(true));
    act(() => result.current.acknowledge());
    expect(result.current.active).toBe(false);
  });

  it("swallows a running-fetch failure without activating", async () => {
    const { result } = setup({
      fetchRunning: vi.fn().mockRejectedValue(new Error("boom")),
    });
    await act(async () => {});
    expect(result.current.active).toBe(false);
  });

  it("swallows an idle-fetch failure without activating", async () => {
    const { result } = setup({
      fetchIdleSeconds: vi.fn().mockRejectedValue(new Error("boom")),
    });
    await act(async () => {});
    expect(result.current.active).toBe(false);
  });

  it("does nothing when disabled via the inTauri guard", async () => {
    const fetchRunning = vi.fn().mockResolvedValue(null);
    const { result } = renderHook(() =>
      useWorkingHoursReminder({
        workingHours: ALL_DAY,
        enabled: false,
        now,
        fetchIdleSeconds: vi.fn().mockResolvedValue(600),
        fetchRunning,
      }),
    );
    await act(async () => {});
    expect(result.current.active).toBe(false);
    expect(fetchRunning).not.toHaveBeenCalled();
  });

  it("uses default deps (no injected opts) and stays inactive outside Tauri", async () => {
    // No injected enabled/now/fetchers: exercises the `?? inTauri`,
    // `?? Date.now`, and `?? <ipc>` fallbacks. Outside Tauri `enabled`
    // resolves to false, so the effect short-circuits — nothing fetched.
    const { result } = renderHook(() =>
      useWorkingHoursReminder({ workingHours: ALL_DAY }),
    );
    await act(async () => {});
    expect(result.current.active).toBe(false);
  });

  it("re-evaluates on the poll interval", async () => {
    vi.useFakeTimers();
    try {
      const fetchRunning = vi.fn().mockResolvedValue(null);
      const fetchIdleSeconds = vi.fn().mockResolvedValue(600);
      renderHook(() =>
        useWorkingHoursReminder({
          workingHours: ALL_DAY,
          enabled: true,
          pollMs: 1000,
          now,
          fetchIdleSeconds,
          fetchRunning,
        }),
      );
      // Initial tick.
      await vi.advanceTimersByTimeAsync(0);
      const firstCount = fetchRunning.mock.calls.length;
      await vi.advanceTimersByTimeAsync(1000);
      expect(fetchRunning.mock.calls.length).toBeGreaterThan(firstCount);
    } finally {
      vi.useRealTimers();
    }
  });
});
