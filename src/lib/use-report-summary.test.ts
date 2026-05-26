import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

import { useReportSummary } from "./use-report-summary";
import type { ReportSummary } from "./ipc";

const sample = (totalSeconds: number): ReportSummary => ({
  totalSeconds,
  prevTotalSeconds: 0,
  byDay: [],
  byProject: [],
  bySource: { rule: 0, calendar: 0, manual: 0 },
});

describe("useReportSummary", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("returns fixture data immediately when not in Tauri", () => {
    const { result } = renderHook(() =>
      useReportSummary("week", { enabled: false }),
    );
    expect(result.current.data).not.toBeNull();
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it("loads, resolves, and exposes data when enabled", async () => {
    const fetchFn = vi.fn().mockResolvedValue(sample(3600));
    const { result } = renderHook(() =>
      useReportSummary("week", { enabled: true, fetch: fetchFn }),
    );
    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.data?.totalSeconds).toBe(3600);
    expect(result.current.error).toBeNull();
    expect(fetchFn).toHaveBeenCalledWith("week");
  });

  it("captures fetch errors", async () => {
    const fetchFn = vi.fn().mockRejectedValue(new Error("boom"));
    const { result } = renderHook(() =>
      useReportSummary("week", { enabled: true, fetch: fetchFn }),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBe("boom");
    expect(result.current.data).toBeNull();
  });

  it("stringifies non-Error rejections", async () => {
    const fetchFn = vi.fn().mockRejectedValue("kaboom");
    const { result } = renderHook(() =>
      useReportSummary("week", { enabled: true, fetch: fetchFn }),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBe("kaboom");
  });

  it("ignores stale rejections when a newer request resolves first", async () => {
    let rejectFirst: (reason: unknown) => void = () => {};
    let resolveSecond: (v: ReportSummary | null) => void = () => {};
    const fetchFn = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<ReportSummary | null>((_res, rej) => (rejectFirst = rej)),
      )
      .mockImplementationOnce(
        () => new Promise<ReportSummary | null>((r) => (resolveSecond = r)),
      );
    const { result } = renderHook(() =>
      useReportSummary("week", { enabled: true, fetch: fetchFn }),
    );
    act(() => result.current.refresh());
    act(() => resolveSecond(sample(42)));
    await waitFor(() => expect(result.current.data?.totalSeconds).toBe(42));
    act(() => rejectFirst(new Error("stale")));
    await Promise.resolve();
    expect(result.current.error).toBeNull();
    expect(result.current.data?.totalSeconds).toBe(42);
  });

  it("refresh() re-invokes the fetch", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(sample(60))
      .mockResolvedValueOnce(sample(120));
    const { result } = renderHook(() =>
      useReportSummary("week", { enabled: true, fetch: fetchFn }),
    );
    await waitFor(() => expect(result.current.data?.totalSeconds).toBe(60));
    act(() => result.current.refresh());
    await waitFor(() => expect(result.current.data?.totalSeconds).toBe(120));
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("switching range re-fetches with the new range", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(sample(10))
      .mockResolvedValueOnce(sample(20));
    type R = "day" | "week" | "month";
    const { result, rerender } = renderHook(
      ({ r }: { r: R }) =>
        useReportSummary(r, { enabled: true, fetch: fetchFn }),
      { initialProps: { r: "week" as R } },
    );
    await waitFor(() => expect(result.current.data?.totalSeconds).toBe(10));
    rerender({ r: "day" as R });
    await waitFor(() => expect(result.current.data?.totalSeconds).toBe(20));
    expect(fetchFn).toHaveBeenNthCalledWith(1, "week");
    expect(fetchFn).toHaveBeenNthCalledWith(2, "day");
  });

  it("ignores stale responses when a newer request resolves first", async () => {
    let resolveFirst: (v: ReportSummary | null) => void = () => {};
    let resolveSecond: (v: ReportSummary | null) => void = () => {};
    const fetchFn = vi
      .fn()
      .mockImplementationOnce(
        () => new Promise<ReportSummary | null>((r) => (resolveFirst = r)),
      )
      .mockImplementationOnce(
        () => new Promise<ReportSummary | null>((r) => (resolveSecond = r)),
      );
    const { result } = renderHook(() =>
      useReportSummary("week", { enabled: true, fetch: fetchFn }),
    );
    act(() => result.current.refresh());
    // Resolve the SECOND request first, then the stale first.
    act(() => resolveSecond(sample(200)));
    await waitFor(() => expect(result.current.data?.totalSeconds).toBe(200));
    act(() => resolveFirst(sample(100)));
    // Stale result should be ignored.
    expect(result.current.data?.totalSeconds).toBe(200);
  });
});
