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
