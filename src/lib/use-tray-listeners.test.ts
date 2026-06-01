import { describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import type { Event, EventCallback, UnlistenFn } from "@tauri-apps/api/event";

import {
  TRAY_START_PROJECT_EVENT,
  TRAY_STOP_EVENT,
  handleTrayStartProject,
  handleTrayStop,
  useTrayListeners,
} from "./use-tray-listeners";
import type { BackendEntry } from "./ipc";

function entry(over: Partial<BackendEntry> = {}): BackendEntry {
  return {
    id: "e1",
    projectId: "p1",
    taskId: null,
    description: "",
    startedAt: new Date().toISOString(),
    endedAt: null,
    source: "tray",
    ruleId: null,
    ...over,
  };
}

describe("handleTrayStartProject", () => {
  it("starts the project with source 'tray' and reports started", async () => {
    const startFn = vi.fn().mockResolvedValue(entry({ description: "" }));
    const result = await handleTrayStartProject("p9", { startFn });
    expect(startFn).toHaveBeenCalledWith({ projectId: "p9", source: "tray" });
    expect(result).toEqual({ kind: "started", message: "Timer started" });
  });

  it("includes the entry description in the message when present", async () => {
    const startFn = vi.fn().mockResolvedValue(entry({ description: "Spec" }));
    const result = await handleTrayStartProject("p9", { startFn });
    expect(result.message).toBe("Timer started: Spec");
  });
});

describe("handleTrayStop", () => {
  it("stops the running entry", async () => {
    const fetchCurrent = vi.fn().mockResolvedValue(entry({ id: "run-1" }));
    const stopFn = vi.fn().mockResolvedValue(entry({ id: "run-1" }));
    const result = await handleTrayStop({ fetchCurrent, stopFn });
    expect(stopFn).toHaveBeenCalledWith("run-1");
    expect(result).toEqual({ kind: "stopped", message: "Timer stopped" });
  });

  it("is a no-op when nothing is running", async () => {
    const fetchCurrent = vi.fn().mockResolvedValue(null);
    const stopFn = vi.fn();
    const result = await handleTrayStop({ fetchCurrent, stopFn });
    expect(stopFn).not.toHaveBeenCalled();
    expect(result).toEqual({ kind: "no-op", message: "No timer running" });
  });
});

type Handlers = Record<string, EventCallback<unknown>>;

function fakeListen(
  handlers: Handlers,
): typeof import("@tauri-apps/api/event").listen {
  return ((event: string, cb: EventCallback<unknown>) => {
    handlers[event] = cb;
    return Promise.resolve((() => {}) as UnlistenFn);
  }) as unknown as typeof import("@tauri-apps/api/event").listen;
}

function emit(handlers: Handlers, event: string, payload: unknown): void {
  handlers[event]?.({ payload } as Event<unknown>);
}

describe("useTrayListeners", () => {
  it("does nothing when disabled", () => {
    const listenFn = vi.fn();
    renderHook(() =>
      useTrayListeners({ enabled: false, listenFn: listenFn as never }),
    );
    expect(listenFn).not.toHaveBeenCalled();
  });

  it("starts a project on the start event", async () => {
    const handlers: Handlers = {};
    const startFn = vi.fn().mockResolvedValue(entry());
    const announce = vi.fn();
    renderHook(() =>
      useTrayListeners({
        enabled: true,
        listenFn: fakeListen(handlers),
        startFn,
        announce,
      }),
    );
    await waitFor(() =>
      expect(handlers[TRAY_START_PROJECT_EVENT]).toBeTruthy(),
    );
    emit(handlers, TRAY_START_PROJECT_EVENT, "proj-7");
    await waitFor(() =>
      expect(startFn).toHaveBeenCalledWith({
        projectId: "proj-7",
        source: "tray",
      }),
    );
    await waitFor(() => expect(announce).toHaveBeenCalledWith("Timer started"));
  });

  it("ignores a start event with a non-string / empty payload", async () => {
    const handlers: Handlers = {};
    const startFn = vi.fn();
    renderHook(() =>
      useTrayListeners({
        enabled: true,
        listenFn: fakeListen(handlers),
        startFn,
      }),
    );
    await waitFor(() =>
      expect(handlers[TRAY_START_PROJECT_EVENT]).toBeTruthy(),
    );
    emit(handlers, TRAY_START_PROJECT_EVENT, "");
    emit(handlers, TRAY_START_PROJECT_EVENT, 42);
    expect(startFn).not.toHaveBeenCalled();
  });

  it("stops the running timer on the stop event", async () => {
    const handlers: Handlers = {};
    const fetchCurrent = vi.fn().mockResolvedValue(entry({ id: "run-1" }));
    const stopFn = vi.fn().mockResolvedValue(entry({ id: "run-1" }));
    const announce = vi.fn();
    renderHook(() =>
      useTrayListeners({
        enabled: true,
        listenFn: fakeListen(handlers),
        fetchCurrent,
        stopFn,
        announce,
      }),
    );
    await waitFor(() => expect(handlers[TRAY_STOP_EVENT]).toBeTruthy());
    emit(handlers, TRAY_STOP_EVENT, null);
    await waitFor(() => expect(stopFn).toHaveBeenCalledWith("run-1"));
    await waitFor(() => expect(announce).toHaveBeenCalledWith("Timer stopped"));
  });

  it("falls back to module defaults and stays inert outside Tauri", () => {
    // No opts: every `?? default` takes its right-hand side, and the
    // default `enabled` (inTauri) is false under vitest, so the effect
    // early-returns without touching the real `listen`.
    expect(() => renderHook(() => useTrayListeners())).not.toThrow();
  });

  it("unlistens on unmount and drops late registrations after cancel", async () => {
    const handlers: Handlers = {};
    const unlisten = vi.fn();
    let resolveListen!: (un: UnlistenFn) => void;
    const listenFn = ((event: string, cb: EventCallback<unknown>) => {
      handlers[event] = cb;
      // First call resolves immediately (registers normally); the
      // second is deferred so we can unmount before it resolves and hit
      // the `cancelled` branch in `register`.
      if (event === TRAY_STOP_EVENT) {
        return new Promise<UnlistenFn>((res) => {
          resolveListen = res;
        });
      }
      return Promise.resolve(unlisten as UnlistenFn);
    }) as unknown as typeof import("@tauri-apps/api/event").listen;

    const { unmount } = renderHook(() =>
      useTrayListeners({ enabled: true, listenFn }),
    );
    await waitFor(() =>
      expect(handlers[TRAY_START_PROJECT_EVENT]).toBeTruthy(),
    );
    unmount();
    // The first listener's unlisten ran on cleanup.
    expect(unlisten).toHaveBeenCalledTimes(1);
    // The deferred (stop) listener resolves after unmount → its unlisten
    // is called immediately via the cancelled-register path.
    const lateUnlisten = vi.fn();
    resolveListen(lateUnlisten as UnlistenFn);
    await waitFor(() => expect(lateUnlisten).toHaveBeenCalledTimes(1));
  });

  it("announces a failure when the action throws", async () => {
    const handlers: Handlers = {};
    const startFn = vi.fn().mockRejectedValue(new Error("boom"));
    const announce = vi.fn();
    renderHook(() =>
      useTrayListeners({
        enabled: true,
        listenFn: fakeListen(handlers),
        startFn,
        announce,
      }),
    );
    await waitFor(() =>
      expect(handlers[TRAY_START_PROJECT_EVENT]).toBeTruthy(),
    );
    emit(handlers, TRAY_START_PROJECT_EVENT, "p1");
    await waitFor(() =>
      expect(announce).toHaveBeenCalledWith("Tray action failed: boom"),
    );
  });

  it("stringifies a non-Error rejection in the failure message", async () => {
    const handlers: Handlers = {};
    const startFn = vi.fn().mockRejectedValue("nope");
    const announce = vi.fn();
    renderHook(() =>
      useTrayListeners({
        enabled: true,
        listenFn: fakeListen(handlers),
        startFn,
        announce,
      }),
    );
    await waitFor(() =>
      expect(handlers[TRAY_START_PROJECT_EVENT]).toBeTruthy(),
    );
    emit(handlers, TRAY_START_PROJECT_EVENT, "p1");
    await waitFor(() =>
      expect(announce).toHaveBeenCalledWith("Tray action failed: nope"),
    );
  });
});
