import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";

vi.mock("./ipc", () => {
  let active = false;
  let path: string | null = null;
  let bytes = 0;
  return {
    inTauri: true,
    signalCaptureStatus: vi.fn(async () => ({
      active,
      path,
      bytesWritten: bytes,
    })),
    startSignalCapture: vi.fn(async () => {
      active = true;
      path = "/tmp/cairn/debug-signals.ndjson";
      bytes = 0;
      return path;
    }),
    stopSignalCapture: vi.fn(async () => {
      active = false;
      path = null;
      bytes = 0;
    }),
    __setState(next: { active: boolean; path: string | null; bytes: number }) {
      active = next.active;
      path = next.path;
      bytes = next.bytes;
    },
    __reset() {
      active = false;
      path = null;
      bytes = 0;
    },
  };
});

import * as ipc from "./ipc";
import { useSignalCapture } from "./use-signal-capture";

const ipcMock = ipc as typeof ipc & {
  __reset: () => void;
  __setState: (s: {
    active: boolean;
    path: string | null;
    bytes: number;
  }) => void;
};

beforeEach(() => {
  ipcMock.__reset();
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("useSignalCapture", () => {
  it("starts inactive and reflects status from the backend", async () => {
    const { result } = renderHook(() => useSignalCapture());
    await waitFor(() => {
      expect(result.current.status.active).toBe(false);
    });
    expect(result.current.status.path).toBeNull();
    expect(result.current.status.bytesWritten).toBe(0);
  });

  it("transitions to active after start() and back after stop()", async () => {
    const { result } = renderHook(() => useSignalCapture());
    await waitFor(() => expect(result.current.status.active).toBe(false));

    await act(async () => {
      await result.current.start();
    });
    expect(result.current.status.active).toBe(true);
    expect(result.current.status.path).toBe("/tmp/cairn/debug-signals.ndjson");

    await act(async () => {
      await result.current.stop();
    });
    expect(result.current.status.active).toBe(false);
    expect(result.current.status.path).toBeNull();
  });

  it("captures errors from start() instead of crashing", async () => {
    (
      ipc.startSignalCapture as unknown as ReturnType<typeof vi.fn>
    ).mockRejectedValueOnce(new Error("nope"));
    const { result } = renderHook(() => useSignalCapture());
    await waitFor(() => expect(result.current.status.active).toBe(false));

    await act(async () => {
      await expect(result.current.start()).rejects.toThrow("nope");
    });
    expect(result.current.error).toContain("nope");
  });

  it("polls status so the banner can reflect bytes-written growth", async () => {
    vi.useFakeTimers();
    const { result, unmount } = renderHook(() => useSignalCapture());
    await vi.waitFor(() => expect(result.current.status.active).toBe(false));

    ipcMock.__setState({ active: true, path: "/tmp/x.ndjson", bytes: 42 });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1100);
    });
    expect(result.current.status.active).toBe(true);
    expect(result.current.status.bytesWritten).toBe(42);
    unmount();
  });

  it("ignores transient polling errors so the banner doesn't flicker off", async () => {
    vi.useFakeTimers();
    const { result, unmount } = renderHook(() => useSignalCapture());
    ipcMock.__setState({ active: true, path: "/tmp/x.ndjson", bytes: 1 });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1100);
    });
    expect(result.current.status.active).toBe(true);

    (
      ipc.signalCaptureStatus as unknown as ReturnType<typeof vi.fn>
    ).mockRejectedValueOnce(new Error("blip"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1100);
    });
    expect(result.current.status.active).toBe(true);
    unmount();
  });

  it("refresh() updates state from the backend on demand", async () => {
    const { result } = renderHook(() => useSignalCapture());
    await waitFor(() => expect(result.current.status.active).toBe(false));
    ipcMock.__setState({ active: true, path: "/tmp/y.ndjson", bytes: 99 });
    await act(async () => {
      await result.current.refresh();
    });
    expect(result.current.status.active).toBe(true);
    expect(result.current.status.bytesWritten).toBe(99);
  });
});
