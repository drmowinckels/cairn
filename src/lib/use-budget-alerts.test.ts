import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { alertKey, pickAlert, useBudgetAlerts } from "./use-budget-alerts";
import type { Budget, BudgetState, BudgetStatus } from "./ipc";

function status(
  over: Partial<Budget> & { state?: BudgetState; percent?: number } = {},
): BudgetStatus {
  const { state = "over", percent = 120, ...budget } = over;
  return {
    budget: {
      id: budget.id ?? "b1",
      scopeType: budget.scopeType ?? "workspace",
      scopeId: budget.scopeId ?? "",
      period: budget.period ?? "daily",
      minutes: budget.minutes ?? 480,
      warnPercent: budget.warnPercent ?? 80,
    },
    usedMinutes: Math.round(((budget.minutes ?? 480) * percent) / 100),
    percent,
    state,
    periodStart: "2026-09-29T00:00:00+00:00",
  };
}

describe("pickAlert", () => {
  it("says nothing when every budget is under its threshold", () => {
    expect(
      pickAlert([
        status({ state: "under", percent: 10 }),
        status({ id: "b2", state: "under", percent: 50 }),
      ]),
    ).toBeNull();
  });

  it("returns null for an empty list", () => {
    expect(pickAlert([])).toBeNull();
  });

  it("prefers a breach over an approaching warning", () => {
    const picked = pickAlert([
      status({ id: "warn", state: "approaching", percent: 90 }),
      status({ id: "breach", state: "over", percent: 101 }),
    ]);
    expect(picked?.budget.id).toBe("breach");
  });

  it("prefers the most specific scope at equal severity", () => {
    // A project cap names something actionable; the workspace cap just says
    // "you've worked a lot".
    const picked = pickAlert([
      status({ id: "ws", scopeType: "workspace", percent: 130 }),
      status({ id: "cl", scopeType: "client", scopeId: "c1", percent: 120 }),
      status({ id: "pr", scopeType: "project", scopeId: "p1", percent: 110 }),
    ]);
    expect(picked?.budget.id).toBe("pr");
  });

  it("breaks a tie on how far past the cap it is", () => {
    const picked = pickAlert([
      status({ id: "a", percent: 105 }),
      status({ id: "b", percent: 180 }),
    ]);
    expect(picked?.budget.id).toBe("b");
  });

  it("surfaces exactly one budget when several fire at once", () => {
    // Several caps breaching is one situation, not three notifications.
    const picked = pickAlert([
      status({ id: "a", percent: 105 }),
      status({ id: "b", percent: 110 }),
      status({ id: "c", state: "approaching", percent: 85 }),
    ]);
    expect(picked).not.toBeNull();
    expect(["a", "b"]).toContain(picked?.budget.id);
  });
});

describe("alertKey", () => {
  it("changes when the budget gets worse", () => {
    const approaching = status({ state: "approaching", percent: 85 });
    const over = status({ state: "over", percent: 101 });
    expect(alertKey(approaching)).not.toBe(alertKey(over));
  });

  it("changes when a new period starts", () => {
    const today = status();
    const tomorrow = {
      ...today,
      periodStart: "2026-09-30T00:00:00+00:00",
    };
    expect(alertKey(today)).not.toBe(alertKey(tomorrow));
  });

  it("is stable across polls of the same situation", () => {
    // Otherwise a dismissed alert would come straight back every minute.
    expect(alertKey(status({ percent: 120 }))).toBe(
      alertKey(status({ percent: 125 })),
    );
  });
});

describe("useBudgetAlerts", () => {
  it("surfaces a breaching budget", async () => {
    const { result } = renderHook(() =>
      useBudgetAlerts({
        enabled: true,
        fetchStatus: vi.fn().mockResolvedValue([status()]),
      }),
    );
    await waitFor(() => expect(result.current.alert?.budget.id).toBe("b1"));
    expect(result.current.statuses).toHaveLength(1);
  });

  it("stays quiet while everything is under budget", async () => {
    const { result } = renderHook(() =>
      useBudgetAlerts({
        enabled: true,
        fetchStatus: vi
          .fn()
          .mockResolvedValue([status({ state: "under", percent: 20 })]),
      }),
    );
    await waitFor(() => expect(result.current.statuses).toHaveLength(1));
    expect(result.current.alert).toBeNull();
  });

  it("does nothing when disabled", async () => {
    const fetchStatus = vi.fn().mockResolvedValue([status()]);
    const { result } = renderHook(() =>
      useBudgetAlerts({ enabled: false, fetchStatus }),
    );
    await Promise.resolve();
    expect(fetchStatus).not.toHaveBeenCalled();
    expect(result.current.alert).toBeNull();
  });

  it("keeps the last known state when a poll fails", async () => {
    // Clearing an alert the user hasn't dealt with because one request
    // failed would be worse than showing a slightly stale one.
    const fetchStatus = vi
      .fn()
      .mockResolvedValueOnce([status()])
      .mockRejectedValueOnce(new Error("db locked"));
    const { result } = renderHook(() =>
      useBudgetAlerts({ enabled: true, fetchStatus }),
    );
    await waitFor(() => expect(result.current.alert).not.toBeNull());

    await act(async () => {
      await result.current.refresh();
    });
    expect(result.current.alert).not.toBeNull();
  });

  it("dismissing hides it and it doesn't come back on the next poll", async () => {
    const fetchStatus = vi.fn().mockResolvedValue([status()]);
    const { result } = renderHook(() =>
      useBudgetAlerts({ enabled: true, fetchStatus }),
    );
    await waitFor(() => expect(result.current.alert).not.toBeNull());

    act(() => result.current.dismiss());
    expect(result.current.alert).toBeNull();

    await act(async () => {
      await result.current.refresh();
    });
    expect(result.current.alert).toBeNull();
  });

  it("speaks again when a dismissed budget gets worse", async () => {
    const fetchStatus = vi
      .fn()
      .mockResolvedValueOnce([status({ state: "approaching", percent: 85 })])
      .mockResolvedValue([status({ state: "over", percent: 101 })]);
    const { result } = renderHook(() =>
      useBudgetAlerts({ enabled: true, fetchStatus }),
    );
    await waitFor(() =>
      expect(result.current.alert?.state).toBe("approaching"),
    );

    act(() => result.current.dismiss());
    expect(result.current.alert).toBeNull();

    // Crossing the cap is new information, not a repeat.
    await act(async () => {
      await result.current.refresh();
    });
    expect(result.current.alert?.state).toBe("over");
  });

  it("speaks again in a new period", async () => {
    const today = status();
    const fetchStatus = vi
      .fn()
      .mockResolvedValueOnce([today])
      .mockResolvedValue([
        { ...today, periodStart: "2026-09-30T00:00:00+00:00" },
      ]);
    const { result } = renderHook(() =>
      useBudgetAlerts({ enabled: true, fetchStatus }),
    );
    await waitFor(() => expect(result.current.alert).not.toBeNull());
    act(() => result.current.dismiss());

    await act(async () => {
      await result.current.refresh();
    });
    expect(result.current.alert).not.toBeNull();
  });

  it("polls on an interval", async () => {
    vi.useFakeTimers();
    try {
      const fetchStatus = vi.fn().mockResolvedValue([]);
      renderHook(() =>
        useBudgetAlerts({ enabled: true, pollMs: 1000, fetchStatus }),
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(fetchStatus).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(2000);
      expect(fetchStatus).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops polling on unmount", async () => {
    vi.useFakeTimers();
    try {
      const fetchStatus = vi.fn().mockResolvedValue([]);
      const { unmount } = renderHook(() =>
        useBudgetAlerts({ enabled: true, pollMs: 1000, fetchStatus }),
      );
      await vi.advanceTimersByTimeAsync(0);
      unmount();
      await vi.advanceTimersByTimeAsync(5000);
      expect(fetchStatus).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("a malformed backend reply", () => {
  it("pickAlert says nothing rather than throwing", () => {
    // This ran during a render, so a `null` reply crashed the whole view —
    // 90 unhandled rejections in CI while every test still passed.
    expect(pickAlert(null as unknown as BudgetStatus[])).toBeNull();
    expect(pickAlert(undefined as unknown as BudgetStatus[])).toBeNull();
  });

  it("the hook degrades to no alert and an empty list", async () => {
    const { result } = renderHook(() =>
      useBudgetAlerts({
        enabled: true,
        fetchStatus: vi
          .fn()
          .mockResolvedValue(null as unknown as BudgetStatus[]),
      }),
    );
    await waitFor(() => expect(result.current.statuses).toEqual([]));
    expect(result.current.alert).toBeNull();
  });
});

describe("pickAlert comparison ordering", () => {
  // The reduce compares in both directions depending on input order, and its
  // lookups fall back for values that aren't in the tables. Drive each.

  it("picks the breach whichever order it arrives in", () => {
    const warn = status({ id: "warn", state: "approaching", percent: 90 });
    const breach = status({ id: "breach", state: "over", percent: 101 });
    expect(pickAlert([warn, breach])?.budget.id).toBe("breach");
    expect(pickAlert([breach, warn])?.budget.id).toBe("breach");
  });

  it("picks the most specific scope whichever order it arrives in", () => {
    const ws = status({ id: "ws", scopeType: "workspace", percent: 130 });
    const pr = status({
      id: "pr",
      scopeType: "project",
      scopeId: "p1",
      percent: 110,
    });
    expect(pickAlert([ws, pr])?.budget.id).toBe("pr");
    expect(pickAlert([pr, ws])?.budget.id).toBe("pr");
  });

  it("picks the furthest past whichever order it arrives in", () => {
    const a = status({ id: "a", percent: 105 });
    const b = status({ id: "b", percent: 180 });
    expect(pickAlert([a, b])?.budget.id).toBe("b");
    expect(pickAlert([b, a])?.budget.id).toBe("b");
  });

  it("treats an unrecognised state or scope as the lowest rank", () => {
    // Defensive: a value that escaped the backend's CHECK constraints must
    // not out-rank a real one, and must not make the comparison NaN.
    const odd = status({
      id: "odd",
      state: "sideways" as never,
      scopeType: "galaxy" as never,
      percent: 999,
    });
    const real = status({ id: "real", state: "over", percent: 101 });
    expect(pickAlert([odd, real])?.budget.id).toBe("real");
    expect(pickAlert([real, odd])?.budget.id).toBe("real");
  });
});

describe("dismissing with nothing shown", () => {
  it("is a no-op rather than recording an empty key", async () => {
    const { result } = renderHook(() =>
      useBudgetAlerts({
        enabled: true,
        fetchStatus: vi
          .fn()
          .mockResolvedValue([status({ state: "under", percent: 10 })]),
      }),
    );
    await waitFor(() => expect(result.current.statuses).toHaveLength(1));
    expect(result.current.alert).toBeNull();

    act(() => result.current.dismiss());
    expect(result.current.alert).toBeNull();
  });
});

describe("default options", () => {
  it("uses the real IPC and poll interval when none are injected", () => {
    // Outside Tauri `enabled` defaults false, so nothing is fetched — this
    // exercises the defaults without touching the backend.
    const { result } = renderHook(() => useBudgetAlerts());
    expect(result.current.alert).toBeNull();
    expect(result.current.statuses).toEqual([]);
  });
});
