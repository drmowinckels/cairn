import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { trackingOf, useIdleWindow } from "./use-idle-window";
import type { BackendEntry } from "./ipc";
import type { IdleResumeEvent, Project } from "./types";

const RESUME: IdleResumeEvent = {
  since: "2026-05-30T10:00:00Z",
  until: "2026-05-30T10:12:00Z",
  durationSeconds: 720,
};

const RUNNING: BackendEntry = {
  id: "e1",
  projectId: "p1",
  taskId: null,
  description: "x",
  startedAt: "2026-05-30T09:00:00Z",
  endedAt: null,
  source: "manual",
  ruleId: null,
};

const PROJECT: Project = {
  id: "p1",
  name: "Aurora",
  clientId: null,
  color: "#000",
  archived: false,
  estimateHours: null,
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

  it("exposes the tracking project once a prompt arrives", async () => {
    const { result } = renderHook(() =>
      useIdleWindow({
        enabled: true,
        listen: noopListen(),
        pendingIdle: vi.fn().mockResolvedValue(RESUME) as never,
        currentRunning: vi.fn().mockResolvedValue(RUNNING) as never,
        listProjects: vi.fn().mockResolvedValue([PROJECT]) as never,
      }),
    );
    await waitFor(() =>
      expect(result.current.tracking).toEqual({
        projectName: "Aurora",
        description: "x",
      }),
    );
  });

  it("logs and leaves tracking null if the lookup rejects", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const { result } = renderHook(() =>
      useIdleWindow({
        enabled: true,
        listen: noopListen(),
        pendingIdle: vi.fn().mockResolvedValue(RESUME) as never,
        currentRunning: vi.fn().mockRejectedValue(new Error("boom")) as never,
        listProjects: vi.fn().mockResolvedValue([PROJECT]) as never,
      }),
    );
    await waitFor(() =>
      expect(err).toHaveBeenCalledWith(
        "idle tracking lookup failed",
        expect.any(Error),
      ),
    );
    expect(result.current.tracking).toBeNull();
    err.mockRestore();
  });

  it("leaves tracking null when nothing is running", async () => {
    const { result } = renderHook(() =>
      useIdleWindow({
        enabled: true,
        listen: noopListen(),
        pendingIdle: vi.fn().mockResolvedValue(RESUME) as never,
        currentRunning: vi.fn().mockResolvedValue(null) as never,
        listProjects: vi.fn().mockResolvedValue([PROJECT]) as never,
      }),
    );
    await waitFor(() => expect(result.current.prompt).toEqual(RESUME));
    expect(result.current.tracking).toBeNull();
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

  it("acks paint to the backend once a prompt is shown (#261)", async () => {
    const idleWindowPainted = vi.fn().mockResolvedValue(undefined);
    renderHook(() =>
      useIdleWindow({
        enabled: true,
        listen: noopListen(),
        pendingIdle: vi.fn().mockResolvedValue(RESUME) as never,
        idleWindowPainted: idleWindowPainted as never,
      }),
    );
    await waitFor(() => expect(idleWindowPainted).toHaveBeenCalled());
  });

  it("does not ack paint while disabled", async () => {
    const idleWindowPainted = vi.fn();
    renderHook(() =>
      useIdleWindow({
        enabled: false,
        listen: noopListen(),
        pendingIdle: vi.fn().mockResolvedValue(RESUME) as never,
        idleWindowPainted: idleWindowPainted as never,
      }),
    );
    await new Promise((r) => setTimeout(r, 0));
    expect(idleWindowPainted).not.toHaveBeenCalled();
  });

  it("logs but does not throw if the paint ack fails", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const idleWindowPainted = vi.fn().mockRejectedValue(new Error("nope"));
    renderHook(() =>
      useIdleWindow({
        enabled: true,
        listen: noopListen(),
        pendingIdle: vi.fn().mockResolvedValue(RESUME) as never,
        idleWindowPainted: idleWindowPainted as never,
      }),
    );
    await waitFor(() =>
      expect(err).toHaveBeenCalledWith(
        "idle_window_painted failed",
        expect.any(Error),
      ),
    );
    err.mockRestore();
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

describe("trackingOf", () => {
  it("resolves the project name when the entry has a known project", () => {
    expect(trackingOf(RUNNING, [PROJECT])).toEqual({
      projectName: "Aurora",
      description: "x",
    });
  });

  it("falls back to null when the project is not in the list", () => {
    expect(trackingOf(RUNNING, [])).toEqual({
      projectName: null,
      description: "x",
    });
  });

  it("reports no project when the entry has none", () => {
    const noProject: BackendEntry = { ...RUNNING, projectId: null };
    expect(trackingOf(noProject, [PROJECT])).toEqual({
      projectName: null,
      description: "x",
    });
  });
});
