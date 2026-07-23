import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

import { useProfitability } from "./use-profitability";
import type { ProfitabilityReport } from "./ipc";
import { ROUNDING_OFF } from "./rounding";

const sample = (billableSeconds: number): ProfitabilityReport => ({
  from: "2026-07-01",
  to: "2026-07-31",
  billableSeconds,
  nonbillableSeconds: 0,
  unratedBillableSeconds: 0,
  totals: [],
  byProject: [],
});

describe("useProfitability", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("is inert (no data, not loading, no fetch) when disabled", () => {
    const fetchFn = vi.fn();
    const { result } = renderHook(() =>
      useProfitability("week", { enabled: false, fetch: fetchFn }),
    );
    expect(result.current.data).toBeNull();
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("defaults enabled/fetch from the environment (inert in jsdom)", () => {
    // No opts: `enabled` falls back to `inTauri` (false here) and `fetch`
    // to the real wrapper — the in-app defaults, exercised without a backend.
    const { result } = renderHook(() => useProfitability("week"));
    expect(result.current.data).toBeNull();
    expect(result.current.loading).toBe(false);
  });

  it("loads, resolves, and exposes data when enabled", async () => {
    const fetchFn = vi.fn().mockResolvedValue(sample(3600));
    const { result } = renderHook(() =>
      useProfitability("week", { enabled: true, fetch: fetchFn }),
    );
    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.data?.billableSeconds).toBe(3600);
    expect(result.current.error).toBeNull();
    expect(fetchFn).toHaveBeenCalledWith("week", ROUNDING_OFF);
  });

  it("captures the backend gate error", async () => {
    const fetchFn = vi
      .fn()
      .mockRejectedValue(new Error("Cairn Pro isn't active"));
    const { result } = renderHook(() =>
      useProfitability("week", { enabled: true, fetch: fetchFn }),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toContain("isn't active");
    expect(result.current.data).toBeNull();
  });

  it("stringifies non-Error rejections", async () => {
    const fetchFn = vi.fn().mockRejectedValue("kaboom");
    const { result } = renderHook(() =>
      useProfitability("week", { enabled: true, fetch: fetchFn }),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBe("kaboom");
  });

  it("ignores stale rejections when a newer request resolves first", async () => {
    let rejectFirst: (reason: unknown) => void = () => {};
    let resolveSecond: (v: ProfitabilityReport | null) => void = () => {};
    const fetchFn = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<ProfitabilityReport | null>(
            (_res, rej) => (rejectFirst = rej),
          ),
      )
      .mockImplementationOnce(
        () =>
          new Promise<ProfitabilityReport | null>((r) => (resolveSecond = r)),
      );
    const { result } = renderHook(() =>
      useProfitability("week", { enabled: true, fetch: fetchFn }),
    );
    act(() => result.current.refresh());
    act(() => resolveSecond(sample(42)));
    await waitFor(() => expect(result.current.data?.billableSeconds).toBe(42));
    act(() => rejectFirst(new Error("stale")));
    await Promise.resolve();
    expect(result.current.error).toBeNull();
    expect(result.current.data?.billableSeconds).toBe(42);
  });

  it("refresh() re-invokes the fetch", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(sample(60))
      .mockResolvedValueOnce(sample(120));
    const { result } = renderHook(() =>
      useProfitability("week", { enabled: true, fetch: fetchFn }),
    );
    await waitFor(() => expect(result.current.data?.billableSeconds).toBe(60));
    act(() => result.current.refresh());
    await waitFor(() => expect(result.current.data?.billableSeconds).toBe(120));
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("switching range re-fetches with the new range and rounding", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(sample(10))
      .mockResolvedValueOnce(sample(20));
    type R = "week" | "month" | "quarter" | "year";
    const { result, rerender } = renderHook(
      ({ r }: { r: R }) =>
        useProfitability(r, { enabled: true, fetch: fetchFn }),
      { initialProps: { r: "week" as R } },
    );
    await waitFor(() => expect(result.current.data?.billableSeconds).toBe(10));
    rerender({ r: "month" as R });
    await waitFor(() => expect(result.current.data?.billableSeconds).toBe(20));
    expect(fetchFn).toHaveBeenNthCalledWith(1, "week", ROUNDING_OFF);
    expect(fetchFn).toHaveBeenNthCalledWith(2, "month", ROUNDING_OFF);
  });

  it("forwards the rounding preference to the fetch (#107)", async () => {
    const fetchFn = vi.fn().mockResolvedValue(sample(900));
    const rounding = { intervalMinutes: 15, mode: "nearest" } as const;
    renderHook(() =>
      useProfitability("week", { enabled: true, fetch: fetchFn, rounding }),
    );
    await waitFor(() => expect(fetchFn).toHaveBeenCalledWith("week", rounding));
  });

  it("ignores stale responses when a newer request resolves first", async () => {
    let resolveFirst: (v: ProfitabilityReport | null) => void = () => {};
    let resolveSecond: (v: ProfitabilityReport | null) => void = () => {};
    const fetchFn = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<ProfitabilityReport | null>((r) => (resolveFirst = r)),
      )
      .mockImplementationOnce(
        () =>
          new Promise<ProfitabilityReport | null>((r) => (resolveSecond = r)),
      );
    const { result } = renderHook(() =>
      useProfitability("week", { enabled: true, fetch: fetchFn }),
    );
    act(() => result.current.refresh());
    act(() => resolveSecond(sample(200)));
    await waitFor(() => expect(result.current.data?.billableSeconds).toBe(200));
    act(() => resolveFirst(sample(100)));
    expect(result.current.data?.billableSeconds).toBe(200);
  });
});
