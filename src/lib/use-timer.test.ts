import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";

const invokeMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

type WithInternals = { __TAURI_INTERNALS__?: unknown };

const ENTRY = {
  id: "e1",
  projectId: "p1",
  taskId: null,
  description: "Rule preview UI",
  startedAt: "2026-05-23T10:00:00Z",
  endedAt: null,
  source: "manual",
  ruleId: null,
};

afterEach(() => {
  invokeMock.mockReset();
});

describe("useTimer (outside Tauri)", () => {
  beforeEach(() => {
    delete (globalThis as WithInternals).__TAURI_INTERNALS__;
    vi.resetModules();
  });

  it("loads=false and running=null without any IPC calls", async () => {
    const { useTimer } = await import("./use-timer");
    const { result } = renderHook(() => useTimer());
    expect(result.current.running).toBeNull();
    expect(result.current.loading).toBe(false);
    expect(result.current.elapsedMs).toBe(0);
    expect(invokeMock).not.toHaveBeenCalled();
  });
});

describe("useTimer (inside Tauri)", () => {
  let original: unknown;

  beforeEach(() => {
    original = (globalThis as WithInternals).__TAURI_INTERNALS__;
    (globalThis as WithInternals).__TAURI_INTERNALS__ = {};
    vi.resetModules();
  });

  afterEach(() => {
    if (original === undefined) {
      delete (globalThis as WithInternals).__TAURI_INTERNALS__;
    } else {
      (globalThis as WithInternals).__TAURI_INTERNALS__ = original;
    }
  });

  it("refreshes the running entry on mount", async () => {
    invokeMock.mockResolvedValue(ENTRY);
    const { useTimer } = await import("./use-timer");
    const { result } = renderHook(() => useTimer());
    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.running?.id).toBe("e1");
    expect(invokeMock).toHaveBeenCalledWith("current_running");
  });

  it("handles 'no entry running' (null response)", async () => {
    invokeMock.mockResolvedValue(null);
    const { useTimer } = await import("./use-timer");
    const { result } = renderHook(() => useTimer());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.running).toBeNull();
    expect(result.current.error).toBeNull();
  });

  it("captures errors from current_running", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      invokeMock.mockRejectedValueOnce(new Error("backend down"));
      const { useTimer } = await import("./use-timer");
      const { result } = renderHook(() => useTimer());
      await waitFor(() => expect(result.current.loading).toBe(false));
      expect(result.current.error).toContain("backend down");
    } finally {
      errSpy.mockRestore();
    }
  });

  it("start() calls start_entry and sets the running entry", async () => {
    invokeMock.mockResolvedValueOnce(null); // current_running on mount
    invokeMock.mockResolvedValueOnce(ENTRY); // start_entry call
    const { useTimer } = await import("./use-timer");
    const { result } = renderHook(() => useTimer());
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.start({
        projectId: "p1",
        description: "Rule preview UI",
      });
    });

    expect(result.current.running?.id).toBe("e1");
    expect(invokeMock).toHaveBeenCalledWith("start_entry", {
      input: { projectId: "p1", description: "Rule preview UI" },
    });
  });

  it("stop() is a no-op when no entry is running", async () => {
    invokeMock.mockResolvedValue(null);
    const { useTimer } = await import("./use-timer");
    const { result } = renderHook(() => useTimer());
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.stop();
    });

    expect(invokeMock).toHaveBeenCalledTimes(1);
  });

  it("stop() calls stop_entry with the running id and clears state", async () => {
    invokeMock.mockResolvedValueOnce(ENTRY);
    invokeMock.mockResolvedValueOnce({
      ...ENTRY,
      endedAt: "2026-05-23T11:00:00Z",
    });
    const { useTimer } = await import("./use-timer");
    const { result } = renderHook(() => useTimer());
    await waitFor(() => expect(result.current.running).not.toBeNull());

    await act(async () => {
      await result.current.stop();
    });

    expect(result.current.running).toBeNull();
    expect(invokeMock).toHaveBeenCalledWith("stop_entry", { id: "e1" });
  });

  it("stop() clears running optimistically before stop_entry resolves", async () => {
    let resolveStop: ((e: import("./ipc").BackendEntry) => void) | undefined;
    const stopEntry = vi.fn(
      () =>
        new Promise<import("./ipc").BackendEntry>((res) => {
          resolveStop = res;
        }),
    );
    const fetchCurrent = vi.fn(async () => ENTRY);
    const { useTimer } = await import("./use-timer");
    const { result } = renderHook(() =>
      useTimer({
        enabled: true,
        listen: vi.fn(
          async () => () => {},
        ) as unknown as typeof import("@tauri-apps/api/event").listen,
        fetchCurrent:
          fetchCurrent as unknown as typeof import("./ipc").currentRunning,
        stopEntry: stopEntry as unknown as typeof import("./ipc").stopEntry,
        tickMs: 60_000,
      }),
    );
    await waitFor(() => expect(result.current.running).not.toBeNull());

    let stopPromise: Promise<unknown> = Promise.resolve();
    act(() => {
      stopPromise = result.current.stop();
    });
    // Cleared instantly — the backend promise is still pending.
    expect(result.current.running).toBeNull();

    await act(async () => {
      resolveStop?.({ ...ENTRY, endedAt: "2026-05-23T11:00:00Z" });
      await stopPromise;
    });
    expect(result.current.running).toBeNull();
  });

  it("stop() restores state and surfaces an error when stop_entry fails", async () => {
    const stopEntry = vi.fn(async () => {
      throw new Error("backend down");
    });
    const fetchCurrent = vi.fn(async () => ENTRY);
    const { useTimer } = await import("./use-timer");
    const { result } = renderHook(() =>
      useTimer({
        enabled: true,
        listen: vi.fn(
          async () => () => {},
        ) as unknown as typeof import("@tauri-apps/api/event").listen,
        fetchCurrent:
          fetchCurrent as unknown as typeof import("./ipc").currentRunning,
        stopEntry: stopEntry as unknown as typeof import("./ipc").stopEntry,
        tickMs: 60_000,
      }),
    );
    await waitFor(() => expect(result.current.running).not.toBeNull());

    await act(async () => {
      await result.current.stop();
    });

    // Optimistic clear rolled back by the failure-path refresh; error shown.
    expect(result.current.error).toMatch(/backend down/i);
    await waitFor(() => expect(result.current.running).not.toBeNull());
  });

  it("a refresh mid-stop does not resurrect the stopping entry", async () => {
    let resolveStop: ((e: import("./ipc").BackendEntry) => void) | undefined;
    const stopEntry = vi.fn(
      () =>
        new Promise<import("./ipc").BackendEntry>((res) => {
          resolveStop = res;
        }),
    );
    // current_running keeps returning the entry until the stop commits.
    const fetchCurrent = vi.fn(async () => ENTRY);
    const { useTimer } = await import("./use-timer");
    const { result } = renderHook(() =>
      useTimer({
        enabled: true,
        listen: vi.fn(
          async () => () => {},
        ) as unknown as typeof import("@tauri-apps/api/event").listen,
        fetchCurrent:
          fetchCurrent as unknown as typeof import("./ipc").currentRunning,
        stopEntry: stopEntry as unknown as typeof import("./ipc").stopEntry,
        tickMs: 60_000,
      }),
    );
    await waitFor(() => expect(result.current.running).not.toBeNull());

    let stopPromise: Promise<unknown> = Promise.resolve();
    act(() => {
      stopPromise = result.current.stop();
    });
    expect(result.current.running).toBeNull();

    // A refresh fires mid-stop and reads the still-running entry — it must
    // NOT bring the timer back.
    await act(async () => {
      await result.current.refresh();
    });
    expect(result.current.running).toBeNull();

    await act(async () => {
      resolveStop?.({ ...ENTRY, endedAt: "2026-05-23T11:00:00Z" });
      await stopPromise;
    });
    expect(result.current.running).toBeNull();
  });
});

describe("useTimer elapsed + tick", () => {
  it("computes elapsedMs from started_at on first read", async () => {
    const nowSpy = vi
      .spyOn(Date, "now")
      .mockReturnValue(new Date("2026-01-01T10:00:30Z").getTime());
    try {
      const { useTimer } = await import("./use-timer");
      const fetchCurrent = vi.fn(async () => ({
        ...ENTRY,
        startedAt: "2026-01-01T10:00:00Z",
      }));
      const { result } = renderHook(() =>
        useTimer({
          enabled: true,
          listen: vi.fn(
            async () => () => {},
          ) as unknown as typeof import("@tauri-apps/api/event").listen,
          fetchCurrent:
            fetchCurrent as unknown as typeof import("./ipc").currentRunning,
          tickMs: 60_000,
        }),
      );
      await waitFor(() => expect(result.current.running).not.toBeNull());
      expect(result.current.elapsedMs).toBe(30_000);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("does not drift across long hide/show gaps (reads Date.now() on each tick)", async () => {
    const startedAtMs = new Date("2026-01-01T10:00:00Z").getTime();
    vi.useFakeTimers({ now: startedAtMs + 10_000 });
    try {
      const { useTimer } = await import("./use-timer");
      const fetchCurrent = vi.fn(async () => ({
        ...ENTRY,
        startedAt: "2026-01-01T10:00:00Z",
      }));
      const { result } = renderHook(() =>
        useTimer({
          enabled: true,
          listen: vi.fn(
            async () => () => {},
          ) as unknown as typeof import("@tauri-apps/api/event").listen,
          fetchCurrent:
            fetchCurrent as unknown as typeof import("./ipc").currentRunning,
          tickMs: 1000,
        }),
      );
      await vi.waitFor(() => expect(result.current.running).not.toBeNull());
      expect(result.current.elapsedMs).toBe(10_000);

      vi.setSystemTime(startedAtMs + 600_000);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });
      // After a 10-minute jump the next tick reads Date.now() afresh
      // and reports the real elapsed (~600s, ±a tick's worth of slack).
      expect(result.current.elapsedMs).toBeGreaterThanOrEqual(600_000);
      expect(result.current.elapsedMs).toBeLessThan(602_000);
    } finally {
      vi.useRealTimers();
    }
  });

  it("elapsedMs is 0 when no entry is running (idle)", async () => {
    const { useTimer } = await import("./use-timer");
    const fetchCurrent = vi.fn(async () => null);
    const { result } = renderHook(() =>
      useTimer({
        enabled: true,
        listen: vi.fn(
          async () => () => {},
        ) as unknown as typeof import("@tauri-apps/api/event").listen,
        fetchCurrent:
          fetchCurrent as unknown as typeof import("./ipc").currentRunning,
      }),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.elapsedMs).toBe(0);
  });
});

describe("useTimer snapshot subscription + update + onStopped", () => {
  it("refetches current_running when signal:snapshot fires", async () => {
    type SnapshotListener = (event: { payload: unknown }) => void;
    let handler: SnapshotListener | null = null;
    const listenFn = vi.fn(async (_event: string, cb: SnapshotListener) => {
      handler = cb;
      return () => {};
    });
    type Entry = typeof ENTRY | null;
    const fetchCurrent = vi.fn<() => Promise<Entry>>(async () => null);
    const { useTimer } = await import("./use-timer");
    renderHook(() =>
      useTimer({
        enabled: true,
        listen:
          listenFn as unknown as typeof import("@tauri-apps/api/event").listen,
        fetchCurrent:
          fetchCurrent as unknown as typeof import("./ipc").currentRunning,
      }),
    );
    await waitFor(() => expect(handler).not.toBeNull());
    fetchCurrent.mockClear();
    fetchCurrent.mockResolvedValueOnce(ENTRY);
    act(() => {
      handler!({ payload: {} });
    });
    await waitFor(() => expect(fetchCurrent).toHaveBeenCalledTimes(1));
  });

  it("throttles snapshot-driven refetches to ≥ 2s apart", async () => {
    type SnapshotListener = (event: { payload: unknown }) => void;
    let snapshotHandler: SnapshotListener | null = null;
    const listenFn = vi.fn(async (event: string, cb: SnapshotListener) => {
      if (event === "signal:snapshot") snapshotHandler = cb;
      return () => {};
    });
    const fetchCurrent = vi.fn(async () => null);
    const { useTimer } = await import("./use-timer");
    renderHook(() =>
      useTimer({
        enabled: true,
        listen:
          listenFn as unknown as typeof import("@tauri-apps/api/event").listen,
        fetchCurrent:
          fetchCurrent as unknown as typeof import("./ipc").currentRunning,
      }),
    );
    await waitFor(() => expect(snapshotHandler).not.toBeNull());
    fetchCurrent.mockClear();
    act(() => {
      snapshotHandler!({ payload: {} });
      snapshotHandler!({ payload: {} });
      snapshotHandler!({ payload: {} });
    });
    await waitFor(() => expect(fetchCurrent).toHaveBeenCalledTimes(1));
  });

  it("refreshes immediately on entry:changed (no throttle) (#tray-lag)", async () => {
    type Listener = (event: { payload: unknown }) => void;
    let entryHandler: Listener | null = null;
    const listenFn = vi.fn(async (event: string, cb: Listener) => {
      if (event === "entry:changed") entryHandler = cb;
      return () => {};
    });
    const fetchCurrent = vi.fn(async () => null);
    const { useTimer } = await import("./use-timer");
    renderHook(() =>
      useTimer({
        enabled: true,
        listen:
          listenFn as unknown as typeof import("@tauri-apps/api/event").listen,
        fetchCurrent:
          fetchCurrent as unknown as typeof import("./ipc").currentRunning,
      }),
    );
    await waitFor(() => expect(entryHandler).not.toBeNull());
    fetchCurrent.mockClear();
    // Two back-to-back events both refetch — no 2s throttle on this path.
    act(() => {
      entryHandler!({ payload: {} });
      entryHandler!({ payload: {} });
    });
    await waitFor(() => expect(fetchCurrent).toHaveBeenCalledTimes(2));
  });

  it("setError stringifies non-Error rejections via String(e)", async () => {
    const fetchCurrent = vi.fn(async () => {
      throw "string-rejection";
    });
    const { useTimer } = await import("./use-timer");
    const { result } = renderHook(() =>
      useTimer({
        enabled: true,
        listen: vi.fn(
          async () => () => {},
        ) as unknown as typeof import("@tauri-apps/api/event").listen,
        fetchCurrent:
          fetchCurrent as unknown as typeof import("./ipc").currentRunning,
      }),
    );
    await waitFor(() => expect(result.current.error).toBe("string-rejection"));
  });

  it("update() patches the running entry via update_entry IPC", async () => {
    const fetchCurrent = vi.fn(async () => ENTRY);
    const updateFn = vi.fn(async () => ({ ...ENTRY, description: "patched" }));
    const { useTimer } = await import("./use-timer");
    const { result } = renderHook(() =>
      useTimer({
        enabled: true,
        listen: vi.fn(
          async () => () => {},
        ) as unknown as typeof import("@tauri-apps/api/event").listen,
        fetchCurrent:
          fetchCurrent as unknown as typeof import("./ipc").currentRunning,
        updateEntry: updateFn as unknown as typeof import("./ipc").updateEntry,
      }),
    );
    await waitFor(() => expect(result.current.running?.id).toBe("e1"));
    await act(async () => {
      await result.current.update({ description: "patched" });
    });
    expect(updateFn).toHaveBeenCalledWith({ id: "e1", description: "patched" });
    expect(result.current.running?.description).toBe("patched");
  });

  it("update() is a no-op when nothing is running", async () => {
    const fetchCurrent = vi.fn(async () => null);
    const updateFn = vi.fn();
    const { useTimer } = await import("./use-timer");
    const { result } = renderHook(() =>
      useTimer({
        enabled: true,
        listen: vi.fn(
          async () => () => {},
        ) as unknown as typeof import("@tauri-apps/api/event").listen,
        fetchCurrent:
          fetchCurrent as unknown as typeof import("./ipc").currentRunning,
        updateEntry: updateFn as unknown as typeof import("./ipc").updateEntry,
      }),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(async () => {
      await result.current.update({ description: "ghost" });
    });
    expect(updateFn).not.toHaveBeenCalled();
  });

  it("stop() invokes onStopped with the stopped entry", async () => {
    const stopped = { ...ENTRY, endedAt: "2026-05-23T11:00:00Z" };
    const fetchCurrent = vi.fn(async () => ENTRY);
    const stopFn = vi.fn(async () => stopped);
    const onStopped = vi.fn();
    const { useTimer } = await import("./use-timer");
    const { result } = renderHook(() =>
      useTimer({
        enabled: true,
        listen: vi.fn(
          async () => () => {},
        ) as unknown as typeof import("@tauri-apps/api/event").listen,
        fetchCurrent:
          fetchCurrent as unknown as typeof import("./ipc").currentRunning,
        stopEntry: stopFn as unknown as typeof import("./ipc").stopEntry,
        onStopped,
      }),
    );
    await waitFor(() => expect(result.current.running?.id).toBe("e1"));
    await act(async () => {
      await result.current.stop();
    });
    expect(onStopped).toHaveBeenCalledWith(stopped);
  });

  it("start() returns the entry and updates state", async () => {
    const fetchCurrent = vi.fn(async () => null);
    const startFn = vi.fn(async () => ENTRY);
    const { useTimer } = await import("./use-timer");
    const { result } = renderHook(() =>
      useTimer({
        enabled: true,
        listen: vi.fn(
          async () => () => {},
        ) as unknown as typeof import("@tauri-apps/api/event").listen,
        fetchCurrent:
          fetchCurrent as unknown as typeof import("./ipc").currentRunning,
        startEntry: startFn as unknown as typeof import("./ipc").startEntry,
      }),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    let returned: unknown = null;
    await act(async () => {
      returned = await result.current.start({ projectId: "p1" });
    });
    expect(returned).toEqual(ENTRY);
    expect(result.current.running?.id).toBe("e1");
  });

  it("calls unlisten on unmount when the listen promise resolved before unmount", async () => {
    const unlistenSpy = vi.fn();
    const listenFn = vi.fn(async () => unlistenSpy);
    const fetchCurrent = vi.fn(async () => null);
    const { useTimer } = await import("./use-timer");
    const { unmount, result } = renderHook(() =>
      useTimer({
        enabled: true,
        listen:
          listenFn as unknown as typeof import("@tauri-apps/api/event").listen,
        fetchCurrent:
          fetchCurrent as unknown as typeof import("./ipc").currentRunning,
      }),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    await waitFor(() => expect(listenFn).toHaveBeenCalled());
    unmount();
    // Two subscriptions now (snapshot + entry:changed), each torn down.
    expect(unlistenSpy).toHaveBeenCalledTimes(2);
  });

  it("unmounting before listen resolves still tears down the subscription", async () => {
    const unlistenSpy = vi.fn();
    let resolveListen: ((un: () => void) => void) | null = null;
    const listenFn = vi.fn(
      () =>
        new Promise<() => void>((resolve) => {
          resolveListen = resolve;
        }),
    );
    const fetchCurrent = vi.fn(async () => null);
    const { useTimer } = await import("./use-timer");
    const { unmount, result } = renderHook(() =>
      useTimer({
        enabled: true,
        listen:
          listenFn as unknown as typeof import("@tauri-apps/api/event").listen,
        fetchCurrent:
          fetchCurrent as unknown as typeof import("./ipc").currentRunning,
      }),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    await waitFor(() => expect(listenFn).toHaveBeenCalled());
    unmount();
    await act(async () => {
      resolveListen!(unlistenSpy);
    });
    expect(unlistenSpy).toHaveBeenCalledTimes(1);
  });
});
