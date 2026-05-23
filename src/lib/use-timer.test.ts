import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
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
      await result.current.start({ projectId: "p1", description: "Rule preview UI" });
    });

    expect(result.current.running?.id).toBe("e1");
    expect(invokeMock).toHaveBeenCalledWith("start_entry", {
      input: { projectId: "p1", description: "Rule preview UI" },
    });
  });

  it("stop() is a no-op when no entry is running", async () => {
    invokeMock.mockResolvedValue(null); // current_running
    const { useTimer } = await import("./use-timer");
    const { result } = renderHook(() => useTimer());
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.stop();
    });

    // current_running was the only call
    expect(invokeMock).toHaveBeenCalledTimes(1);
  });

  it("stop() calls stop_entry with the running id and clears state", async () => {
    invokeMock.mockResolvedValueOnce(ENTRY); // current_running
    invokeMock.mockResolvedValueOnce({ ...ENTRY, endedAt: "2026-05-23T11:00:00Z" }); // stop_entry
    const { useTimer } = await import("./use-timer");
    const { result } = renderHook(() => useTimer());
    await waitFor(() => expect(result.current.running).not.toBeNull());

    await act(async () => {
      await result.current.stop();
    });

    expect(result.current.running).toBeNull();
    expect(invokeMock).toHaveBeenCalledWith("stop_entry", { id: "e1" });
  });
});
