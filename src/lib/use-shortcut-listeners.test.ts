import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(),
}));

import { listen } from "@tauri-apps/api/event";
import {
  handleToggleTimer,
  usePaletteShortcut,
  useToggleTimerShortcut,
} from "./use-shortcut-listeners";
import { PALETTE_OPEN_DOM_EVENT, TOAST_DOM_EVENT } from "./shortcuts";

const ENTRY = {
  id: "e1",
  projectId: "p1",
  taskId: null,
  description: "Cairn dev",
  startedAt: "2026-05-23T10:00:00Z",
  endedAt: null,
  source: "shortcut",
  ruleId: null,
};

afterEach(() => {
  vi.clearAllMocks();
});

describe("handleToggleTimer", () => {
  it("stops the running entry when one exists", async () => {
    const fetchCurrent = vi.fn().mockResolvedValue(ENTRY);
    const fetchToday = vi.fn();
    const startFn = vi.fn();
    const stopFn = vi.fn().mockResolvedValue({ ...ENTRY, endedAt: "now" });

    const result = await handleToggleTimer({
      fetchCurrent,
      fetchToday,
      startFn,
      stopFn,
    });

    expect(stopFn).toHaveBeenCalledWith("e1");
    expect(startFn).not.toHaveBeenCalled();
    expect(fetchToday).not.toHaveBeenCalled();
    expect(result.kind).toBe("stopped");
    expect(result.message).toBe("Timer stopped");
  });

  it("starts a new entry using the most-recent today project when nothing is running", async () => {
    const fetchCurrent = vi.fn().mockResolvedValue(null);
    const fetchToday = vi
      .fn()
      .mockResolvedValue([
        { ...ENTRY, id: "old", projectId: "p7", description: "Last task" },
      ]);
    const startFn = vi.fn().mockResolvedValue({
      ...ENTRY,
      projectId: "p7",
      description: "",
    });
    const stopFn = vi.fn();

    const result = await handleToggleTimer({
      fetchCurrent,
      fetchToday,
      startFn,
      stopFn,
    });

    expect(startFn).toHaveBeenCalledWith({
      projectId: "p7",
      source: "shortcut",
    });
    expect(stopFn).not.toHaveBeenCalled();
    expect(result.kind).toBe("started");
    expect(result.message).toBe("Timer started");
  });

  it("includes the started entry's description in the message when present", async () => {
    const fetchCurrent = vi.fn().mockResolvedValue(null);
    const fetchToday = vi
      .fn()
      .mockResolvedValue([{ ...ENTRY, id: "old", projectId: "p7" }]);
    const startFn = vi
      .fn()
      .mockResolvedValue({ ...ENTRY, description: "Rule preview UI" });

    const result = await handleToggleTimer({
      fetchCurrent,
      fetchToday,
      startFn,
      stopFn: vi.fn(),
    });
    expect(result.message).toBe("Timer started: Rule preview UI");
  });

  it("reports no-project when today has no entries with a project", async () => {
    const fetchCurrent = vi.fn().mockResolvedValue(null);
    const fetchToday = vi.fn().mockResolvedValue([]);
    const startFn = vi.fn();

    const result = await handleToggleTimer({
      fetchCurrent,
      fetchToday,
      startFn,
      stopFn: vi.fn(),
    });

    expect(startFn).not.toHaveBeenCalled();
    expect(result.kind).toBe("no-project");
    expect(result.message).toMatch(/No recent project/i);
  });

  it("skips today entries whose projectId is null when picking the last project", async () => {
    const fetchCurrent = vi.fn().mockResolvedValue(null);
    const fetchToday = vi.fn().mockResolvedValue([
      { ...ENTRY, id: "no-project", projectId: null },
      { ...ENTRY, id: "p7entry", projectId: "p7" },
    ]);
    const startFn = vi.fn().mockResolvedValue(ENTRY);

    await handleToggleTimer({
      fetchCurrent,
      fetchToday,
      startFn,
      stopFn: vi.fn(),
    });
    expect(startFn).toHaveBeenCalledWith({
      projectId: "p7",
      source: "shortcut",
    });
  });
});

describe("useToggleTimerShortcut", () => {
  beforeEach(() => {
    vi.mocked(listen).mockReset();
  });

  it("is a no-op when disabled (outside Tauri)", () => {
    renderHook(() => useToggleTimerShortcut({ enabled: false }));
    expect(listen).not.toHaveBeenCalled();
  });

  it("registers a `shortcut:toggle-timer` listener when enabled", async () => {
    const unlisten = vi.fn();
    vi.mocked(listen).mockResolvedValue(unlisten);

    const { unmount } = renderHook(() =>
      useToggleTimerShortcut({
        enabled: true,
        fetchCurrent: vi.fn(),
        fetchToday: vi.fn(),
        startFn: vi.fn(),
        stopFn: vi.fn(),
      }),
    );

    await waitFor(() => expect(listen).toHaveBeenCalled());
    expect(vi.mocked(listen).mock.calls[0][0]).toBe("shortcut:toggle-timer");

    unmount();
    await waitFor(() => expect(unlisten).toHaveBeenCalled());
  });

  it("on the event, runs handleToggleTimer + announces + toasts", async () => {
    let cb: (() => void) | null = null;
    vi.mocked(listen).mockImplementation((_name, handler) => {
      cb = handler as () => void;
      return Promise.resolve(vi.fn());
    });

    const fetchCurrent = vi.fn().mockResolvedValue(null);
    const fetchToday = vi.fn().mockResolvedValue([{ ...ENTRY, projectId: "p7" }]);
    const startFn = vi.fn().mockResolvedValue(ENTRY);
    const announce = vi.fn();
    const toast = vi.fn();

    renderHook(() =>
      useToggleTimerShortcut({
        enabled: true,
        fetchCurrent,
        fetchToday,
        startFn,
        stopFn: vi.fn(),
        announce,
        toast,
      }),
    );
    await waitFor(() => expect(cb).not.toBeNull());

    await act(async () => {
      cb!();
    });
    await waitFor(() => expect(startFn).toHaveBeenCalled());
    await waitFor(() => expect(announce).toHaveBeenCalledWith("Timer started: Cairn dev"));
    expect(toast).toHaveBeenCalledWith("Timer started: Cairn dev");
  });

  it("surfaces backend errors via announce + toast", async () => {
    let cb: (() => void) | null = null;
    vi.mocked(listen).mockImplementation((_name, handler) => {
      cb = handler as () => void;
      return Promise.resolve(vi.fn());
    });

    const fetchCurrent = vi.fn().mockRejectedValue(new Error("db locked"));
    const announce = vi.fn();
    const toast = vi.fn();

    renderHook(() =>
      useToggleTimerShortcut({
        enabled: true,
        fetchCurrent,
        fetchToday: vi.fn(),
        startFn: vi.fn(),
        stopFn: vi.fn(),
        announce,
        toast,
      }),
    );
    await waitFor(() => expect(cb).not.toBeNull());
    await act(async () => {
      cb!();
    });
    await waitFor(() =>
      expect(announce).toHaveBeenCalledWith(
        expect.stringContaining("db locked"),
      ),
    );
    expect(toast).toHaveBeenCalledWith(expect.stringContaining("db locked"));
  });
});

describe("usePaletteShortcut", () => {
  it("invokes the supplied opener on ⌘K", () => {
    const onOpen = vi.fn();
    renderHook(() => usePaletteShortcut({ onOpen }));
    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "k", metaKey: true }),
    );
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it("invokes the opener on Ctrl+K too (non-Mac convention)", () => {
    const onOpen = vi.fn();
    renderHook(() => usePaletteShortcut({ onOpen }));
    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "K", ctrlKey: true }),
    );
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it("falls back to dispatching the PALETTE_OPEN_DOM_EVENT when no callback is given", () => {
    const handler = vi.fn();
    window.addEventListener(PALETTE_OPEN_DOM_EVENT, handler);
    renderHook(() => usePaletteShortcut());
    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "k", metaKey: true }),
    );
    expect(handler).toHaveBeenCalledTimes(1);
    window.removeEventListener(PALETTE_OPEN_DOM_EVENT, handler);
  });

  it("ignores ⌘K when focus is in an input (so the user can still type 'k' in a search box)", () => {
    const onOpen = vi.fn();
    renderHook(() => usePaletteShortcut({ onOpen }));
    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();
    input.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "k",
        metaKey: true,
        bubbles: true,
      }),
    );
    expect(onOpen).not.toHaveBeenCalled();
    document.body.removeChild(input);
  });

  it("does not fire on plain K without a modifier", () => {
    const onOpen = vi.fn();
    renderHook(() => usePaletteShortcut({ onOpen }));
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "k" }));
    expect(onOpen).not.toHaveBeenCalled();
  });
});

describe("TOAST_DOM_EVENT contract", () => {
  it("custom-event detail typing survives a round trip", () => {
    const handler = vi.fn();
    window.addEventListener(TOAST_DOM_EVENT, handler);
    window.dispatchEvent(
      new CustomEvent<string>(TOAST_DOM_EVENT, { detail: "x" }),
    );
    expect((handler.mock.calls[0][0] as CustomEvent<string>).detail).toBe("x");
    window.removeEventListener(TOAST_DOM_EVENT, handler);
  });
});
