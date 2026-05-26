import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { BackendEntry } from "./ipc";
import { useToday } from "./use-today";

const ENTRY: BackendEntry = {
  id: "a",
  projectId: "cairn",
  taskId: null,
  description: "x",
  startedAt: "2026-05-23T08:00:00Z",
  endedAt: "2026-05-23T09:00:00Z",
  source: "manual",
  ruleId: null,
};

afterEach(() => {
  vi.clearAllMocks();
});

describe("useToday", () => {
  it("returns [] and loading=false when disabled", () => {
    const fetcher = vi.fn();
    const { result } = renderHook(() =>
      useToday({ enabled: false, fetcher: fetcher as unknown as typeof import("./ipc").listToday }),
    );
    expect(result.current.entries).toEqual([]);
    expect(result.current.loading).toBe(false);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("fetches today's entries on mount", async () => {
    const fetcher = vi.fn(async () => [ENTRY]);
    const { result } = renderHook(() =>
      useToday({ enabled: true, fetcher: fetcher as unknown as typeof import("./ipc").listToday }),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.entries).toEqual([ENTRY]);
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("captures errors from the fetcher", async () => {
    const fetcher = vi.fn(async () => {
      throw new Error("db gone");
    });
    const { result } = renderHook(() =>
      useToday({ enabled: true, fetcher: fetcher as unknown as typeof import("./ipc").listToday }),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toContain("db gone");
  });

  it("stringifies non-Error rejections via String(e)", async () => {
    const fetcher = vi.fn(async () => {
      throw "string-rejection";
    });
    const { result } = renderHook(() =>
      useToday({ enabled: true, fetcher: fetcher as unknown as typeof import("./ipc").listToday }),
    );
    await waitFor(() => expect(result.current.error).toBe("string-rejection"));
  });

  it("refresh() refetches on demand", async () => {
    const fetcher = vi.fn<() => Promise<BackendEntry[]>>(async () => []);
    const { result } = renderHook(() =>
      useToday({ enabled: true, fetcher: fetcher as unknown as typeof import("./ipc").listToday }),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    fetcher.mockResolvedValueOnce([ENTRY]);
    await act(async () => {
      await result.current.refresh();
    });
    expect(result.current.entries).toEqual([ENTRY]);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
