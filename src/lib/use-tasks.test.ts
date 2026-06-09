import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

type WithInternals = { __TAURI_INTERNALS__?: unknown };

afterEach(() => invokeMock.mockReset());

describe("useTasks (browser-dev)", () => {
  beforeEach(() => {
    delete (globalThis as WithInternals).__TAURI_INTERNALS__;
    vi.resetModules();
  });

  it("yields an empty list for a null project", async () => {
    const { useTasks } = await import("./use-tasks");
    const { result } = renderHook(() => useTasks(null));
    expect(result.current.tasks).toEqual([]);
  });

  it("create adds a local task; remove drops it", async () => {
    const { useTasks } = await import("./use-tasks");
    const { result } = renderHook(() => useTasks("p1"));
    let made: { id: string } | null = null;
    await act(async () => {
      made = await result.current.create("Design");
    });
    expect(made).not.toBeNull();
    expect(result.current.tasks.some((t) => t.name === "Design")).toBe(true);
    expect(invokeMock).not.toHaveBeenCalled();
    await act(async () => {
      await result.current.remove(made!.id);
    });
    expect(result.current.tasks.some((t) => t.id === made!.id)).toBe(false);
  });

  it("create is a no-op for a blank name or null project", async () => {
    const { useTasks } = await import("./use-tasks");
    const { result } = renderHook(() => useTasks("p1"));
    await act(async () => {
      expect(await result.current.create("   ")).toBeNull();
    });
    const { result: noProject } = renderHook(() => useTasks(null));
    await act(async () => {
      expect(await noProject.current.create("X")).toBeNull();
    });
  });
});

describe("useTaskMap", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("is empty outside Tauri", async () => {
    delete (globalThis as WithInternals).__TAURI_INTERNALS__;
    const { useTaskMap } = await import("./use-tasks");
    const { result } = renderHook(() => useTaskMap());
    expect(result.current.byId).toEqual({});
  });

  it("keys all tasks by id inside Tauri", async () => {
    (globalThis as WithInternals).__TAURI_INTERNALS__ = {};
    invokeMock.mockResolvedValue([
      { id: "t1", projectId: "p1", name: "Local", archived: false },
      {
        id: "t2",
        projectId: null,
        name: "Fix bug",
        archived: false,
        connectorId: "gh",
        remoteId: "42",
      },
    ]);
    const { useTaskMap } = await import("./use-tasks");
    const { result } = renderHook(() => useTaskMap());
    await waitFor(() => expect(result.current.byId.t2).toBeTruthy());
    expect(invokeMock).toHaveBeenCalledWith("list_tasks", { projectId: null });
    expect(result.current.byId.t2.connectorId).toBe("gh");
    delete (globalThis as WithInternals).__TAURI_INTERNALS__;
  });

  it("falls back to an empty map when the list call throws", async () => {
    (globalThis as WithInternals).__TAURI_INTERNALS__ = {};
    invokeMock.mockRejectedValue(new Error("boom"));
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { useTaskMap } = await import("./use-tasks");
    const { result } = renderHook(() => useTaskMap());
    await waitFor(() => expect(spy).toHaveBeenCalled());
    expect(result.current.byId).toEqual({});
    spy.mockRestore();
    delete (globalThis as WithInternals).__TAURI_INTERNALS__;
  });
});

describe("useTasks (inside Tauri)", () => {
  let original: unknown;
  beforeEach(() => {
    original = (globalThis as WithInternals).__TAURI_INTERNALS__;
    (globalThis as WithInternals).__TAURI_INTERNALS__ = {};
    vi.resetModules();
  });
  afterEach(() => {
    if (original === undefined)
      delete (globalThis as WithInternals).__TAURI_INTERNALS__;
    else (globalThis as WithInternals).__TAURI_INTERNALS__ = original;
  });

  it("loads tasks for the project and create persists via save_task", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "list_tasks") return Promise.resolve([]);
      if (cmd === "save_task")
        return Promise.resolve({
          id: "t9",
          projectId: "p1",
          name: "Build",
          archived: false,
        });
      return Promise.resolve(null);
    });
    const { useTasks } = await import("./use-tasks");
    const { result } = renderHook(() => useTasks("p1"));
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("list_tasks", {
        projectId: "p1",
      }),
    );
    await act(async () => {
      await result.current.create("Build");
    });
    expect(invokeMock).toHaveBeenCalledWith("save_task", {
      task: { projectId: "p1", name: "Build" },
    });
    expect(result.current.tasks.some((t) => t.id === "t9")).toBe(true);
  });
});
