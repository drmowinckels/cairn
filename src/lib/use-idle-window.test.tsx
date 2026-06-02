import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { useIdleWindow } from "./use-idle-window";
import type { IdleResumeEvent } from "./types";

const RESUME: IdleResumeEvent = {
  since: "2026-05-30T10:00:00Z",
  until: "2026-05-30T10:12:00Z",
  durationSeconds: 720,
};

const RUNNING = {
  id: "e1",
  projectId: "p1",
  taskId: null,
  description: "x",
  startedAt: "2026-05-30T09:00:00Z",
  endedAt: null,
  source: "manual",
  ruleId: null,
};

function noopListen() {
  return vi.fn(async () => () => {}) as never;
}

afterEach(() => vi.clearAllMocks());

describe("useIdleWindow", () => {
  it("seeds the prompt from pending_idle on mount", async () => {
    const { result } = renderHook(() =>
      useIdleWindow({
        enabled: true,
        listen: noopListen(),
        pendingIdle: vi.fn().mockResolvedValue(RESUME) as never,
      }),
    );
    await waitFor(() => expect(result.current.prompt).toEqual(RESUME));
  });

  it("updates the prompt from a live idle-resume event", async () => {
    let emit: ((e: { payload: IdleResumeEvent }) => void) | undefined;
    const listen = vi.fn(
      async (_name: string, cb: (e: { payload: IdleResumeEvent }) => void) => {
        emit = cb;
        return () => {};
      },
    );
    const { result } = renderHook(() =>
      useIdleWindow({
        enabled: true,
        listen: listen as never,
        pendingIdle: vi.fn().mockResolvedValue(null) as never,
      }),
    );
    await waitFor(() => expect(emit).toBeTypeOf("function"));
    act(() => emit!({ payload: RESUME }));
    expect(result.current.prompt).toEqual(RESUME);
  });

  it("resolve() looks up the running entry, resolves, and dismisses", async () => {
    const currentRunning = vi.fn().mockResolvedValue(RUNNING);
    const resolveIdle = vi.fn().mockResolvedValue(null);
    const dismissIdle = vi.fn().mockResolvedValue(undefined);
    // Stable opts — a fresh vi.fn() per render would re-fire the mount
    // effect and re-seed the prompt after we clear it.
    const opts = {
      enabled: true,
      listen: noopListen(),
      pendingIdle: vi.fn().mockResolvedValue(RESUME) as never,
      currentRunning: currentRunning as never,
      resolveIdle: resolveIdle as never,
      dismissIdle: dismissIdle as never,
    };
    const { result } = renderHook(() => useIdleWindow(opts));
    await waitFor(() => expect(result.current.prompt).toEqual(RESUME));

    await act(async () => {
      await result.current.resolve("discard-continue");
    });

    expect(resolveIdle).toHaveBeenCalledWith({
      entryId: "e1",
      since: RESUME.since,
      until: RESUME.until,
      choice: "discard-continue",
    });
    expect(dismissIdle).toHaveBeenCalled();
    expect(result.current.prompt).toBeNull();
  });

  it("resolve() still dismisses when no timer is running (nothing to resolve)", async () => {
    const resolveIdle = vi.fn().mockResolvedValue(null);
    const dismissIdle = vi.fn().mockResolvedValue(undefined);
    const { result } = renderHook(() =>
      useIdleWindow({
        enabled: true,
        listen: noopListen(),
        pendingIdle: vi.fn().mockResolvedValue(RESUME) as never,
        currentRunning: vi.fn().mockResolvedValue(null) as never,
        resolveIdle: resolveIdle as never,
        dismissIdle: dismissIdle as never,
      }),
    );
    await waitFor(() => expect(result.current.prompt).toEqual(RESUME));

    await act(async () => {
      await result.current.resolve("keep");
    });
    expect(resolveIdle).not.toHaveBeenCalled();
    expect(dismissIdle).toHaveBeenCalled();
  });

  it("dismiss() clears the prompt and calls dismiss_idle", async () => {
    const dismissIdle = vi.fn().mockResolvedValue(undefined);
    const opts = {
      enabled: true,
      listen: noopListen(),
      pendingIdle: vi.fn().mockResolvedValue(RESUME) as never,
      dismissIdle: dismissIdle as never,
    };
    const { result } = renderHook(() => useIdleWindow(opts));
    await waitFor(() => expect(result.current.prompt).toEqual(RESUME));
    await act(async () => {
      await result.current.dismiss();
    });
    expect(dismissIdle).toHaveBeenCalled();
    expect(result.current.prompt).toBeNull();
  });

  it("is inert when disabled (outside Tauri)", async () => {
    const pending = vi.fn();
    renderHook(() =>
      useIdleWindow({
        enabled: false,
        listen: noopListen(),
        pendingIdle: pending as never,
      }),
    );
    expect(pending).not.toHaveBeenCalled();
  });
});
