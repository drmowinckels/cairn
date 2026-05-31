import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

type WithInternals = { __TAURI_INTERNALS__?: unknown };

afterEach(() => {
  invokeMock.mockReset();
});

describe("ipc helpers (inside Tauri)", () => {
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

  it("updateEntry forwards the input under an `input` key", async () => {
    invokeMock.mockResolvedValue({ id: "e1" });
    const { updateEntry } = await import("./ipc");
    const input = { id: "e1", description: "x" };
    const result = await updateEntry(input);
    expect(invokeMock).toHaveBeenCalledWith("update_entry", { input });
    expect(result).toEqual({ id: "e1" });
  });

  it("createEntry forwards the input under an `input` key", async () => {
    invokeMock.mockResolvedValue({ id: "e2" });
    const { createEntry } = await import("./ipc");
    const input = {
      startedAt: "2026-05-26T09:00:00Z",
      endedAt: "2026-05-26T10:00:00Z",
      description: "manual",
      source: "manual",
    };
    const result = await createEntry(input);
    expect(invokeMock).toHaveBeenCalledWith("create_entry", { input });
    expect(result).toEqual({ id: "e2" });
  });

  it("idleSeconds invokes the command and returns the count", async () => {
    invokeMock.mockResolvedValue(420);
    const { idleSeconds } = await import("./ipc");
    expect(await idleSeconds()).toBe(420);
    expect(invokeMock).toHaveBeenCalledWith("idle_seconds");
  });

  it("deleteEntry forwards the id and ignores the response", async () => {
    invokeMock.mockResolvedValue(null);
    const { deleteEntry } = await import("./ipc");
    await deleteEntry("entry-7");
    expect(invokeMock).toHaveBeenCalledWith("delete_entry", { id: "entry-7" });
  });

  it("upcomingCalendarEvents passes the default limit when none is given", async () => {
    invokeMock.mockResolvedValue([]);
    const { upcomingCalendarEvents } = await import("./ipc");
    const events = await upcomingCalendarEvents();
    expect(invokeMock).toHaveBeenCalledWith("upcoming_calendar_events", {
      limit: 3,
    });
    expect(events).toEqual([]);
  });

  it("upcomingCalendarEvents forwards an explicit limit", async () => {
    invokeMock.mockResolvedValue([{ uid: "u1" }]);
    const { upcomingCalendarEvents } = await import("./ipc");
    const events = await upcomingCalendarEvents(7);
    expect(invokeMock).toHaveBeenCalledWith("upcoming_calendar_events", {
      limit: 7,
    });
    expect(events).toEqual([{ uid: "u1" }]);
  });

  it("startSignalCapture returns the absolute file path from the backend", async () => {
    invokeMock.mockResolvedValue("/tmp/cairn/debug-signals.ndjson");
    const { startSignalCapture } = await import("./ipc");
    const path = await startSignalCapture();
    expect(invokeMock).toHaveBeenCalledWith("start_signal_capture");
    expect(path).toBe("/tmp/cairn/debug-signals.ndjson");
  });

  it("stopSignalCapture invokes the command and ignores the response", async () => {
    invokeMock.mockResolvedValue(null);
    const { stopSignalCapture } = await import("./ipc");
    await stopSignalCapture();
    expect(invokeMock).toHaveBeenCalledWith("stop_signal_capture");
  });

  it("signalCaptureStatus passes the backend payload through", async () => {
    invokeMock.mockResolvedValue({
      active: true,
      path: "/tmp/cairn/debug-signals.ndjson",
      bytesWritten: 123,
    });
    const { signalCaptureStatus } = await import("./ipc");
    const status = await signalCaptureStatus();
    expect(invokeMock).toHaveBeenCalledWith("signal_capture_status");
    expect(status).toEqual({
      active: true,
      path: "/tmp/cairn/debug-signals.ndjson",
      bytesWritten: 123,
    });
  });

  it("getGitDiscoveryRoots returns the backend list", async () => {
    invokeMock.mockResolvedValue(["~/code", "~/work"]);
    const { getGitDiscoveryRoots } = await import("./ipc");
    const roots = await getGitDiscoveryRoots();
    expect(invokeMock).toHaveBeenCalledWith("get_git_discovery_roots");
    expect(roots).toEqual(["~/code", "~/work"]);
  });

  it("setGitDiscoveryRoots forwards roots and returns the updated status", async () => {
    invokeMock.mockResolvedValue({ discoveryRoots: ["~/code"], watchedCount: 3 });
    const { setGitDiscoveryRoots } = await import("./ipc");
    const status = await setGitDiscoveryRoots(["~/code"]);
    expect(invokeMock).toHaveBeenCalledWith("set_git_discovery_roots", {
      roots: ["~/code"],
    });
    expect(status).toEqual({ discoveryRoots: ["~/code"], watchedCount: 3 });
  });

  it("setPopoverSize forwards width/height", async () => {
    invokeMock.mockResolvedValue(null);
    const { setPopoverSize } = await import("./ipc");
    await setPopoverSize(680, 900);
    expect(invokeMock).toHaveBeenCalledWith("set_popover_size", {
      width: 680,
      height: 900,
    });
  });
});

describe("ipc helpers (outside Tauri)", () => {
  beforeEach(() => {
    delete (globalThis as WithInternals).__TAURI_INTERNALS__;
    vi.resetModules();
  });

  it("upcomingCalendarEvents short-circuits to [] without calling the backend", async () => {
    const { upcomingCalendarEvents } = await import("./ipc");
    const events = await upcomingCalendarEvents(5);
    expect(events).toEqual([]);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("signalCaptureStatus short-circuits to inactive without calling the backend", async () => {
    const { signalCaptureStatus } = await import("./ipc");
    const status = await signalCaptureStatus();
    expect(status).toEqual({ active: false, path: null, bytesWritten: 0 });
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("getGitDiscoveryRoots returns the dev default without the backend", async () => {
    const { getGitDiscoveryRoots } = await import("./ipc");
    expect(await getGitDiscoveryRoots()).toEqual(["~/code"]);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("setGitDiscoveryRoots echoes a synthetic status without the backend", async () => {
    const { setGitDiscoveryRoots } = await import("./ipc");
    const status = await setGitDiscoveryRoots(["~/x"]);
    expect(status).toEqual({ discoveryRoots: ["~/x"], watchedCount: 0 });
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("setPopoverSize short-circuits without the backend", async () => {
    const { setPopoverSize } = await import("./ipc");
    await setPopoverSize(560, 760);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("idleSeconds short-circuits to null without the backend", async () => {
    const { idleSeconds } = await import("./ipc");
    expect(await idleSeconds()).toBeNull();
    expect(invokeMock).not.toHaveBeenCalled();
  });
});
