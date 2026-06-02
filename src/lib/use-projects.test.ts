import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";

const invokeMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

type WithInternals = { __TAURI_INTERNALS__?: unknown };

afterEach(() => {
  invokeMock.mockReset();
});

describe("useProjects (outside Tauri)", () => {
  beforeEach(() => {
    delete (globalThis as WithInternals).__TAURI_INTERNALS__;
    vi.resetModules();
  });

  it("seeds with the fixture projects in browser-dev mode", async () => {
    const { useProjects } = await import("./use-projects");
    const { result } = renderHook(() => useProjects());
    expect(result.current.projects.length).toBeGreaterThan(0);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("create() synthesizes a local project without calling the backend", async () => {
    const { useProjects } = await import("./use-projects");
    const { result } = renderHook(() => useProjects());
    const before = result.current.projects.length;
    let made: { id: string; name: string } | undefined;
    await act(async () => {
      made = await result.current.create({
        name: "Side Quest",
        color: "#81b29a",
      });
    });
    expect(made?.id).toBe("local-side-quest");
    expect(made?.name).toBe("Side Quest");
    expect(invokeMock).not.toHaveBeenCalled();
    expect(result.current.projects).toHaveLength(before + 1);
    expect(
      result.current.projects.some((p) => p.id === "local-side-quest"),
    ).toBe(true);
  });

  it("update() replaces a project in place", async () => {
    const { useProjects } = await import("./use-projects");
    const { result } = renderHook(() => useProjects());
    const target = result.current.projects[0];
    await act(async () => {
      await result.current.update({
        id: target.id,
        name: "Renamed",
        color: "#e07a5f",
        clientId: null,
      });
    });
    const updated = result.current.projects.find((p) => p.id === target.id);
    expect(updated?.name).toBe("Renamed");
    expect(updated?.color).toBe("#e07a5f");
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("remove() drops a project", async () => {
    const { useProjects } = await import("./use-projects");
    const { result } = renderHook(() => useProjects());
    const target = result.current.projects[0];
    await act(async () => {
      await result.current.remove(target.id);
    });
    expect(result.current.projects.some((p) => p.id === target.id)).toBe(false);
  });
});

describe("useProjects (inside Tauri)", () => {
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

  it("starts empty, then replaces with backend projects", async () => {
    invokeMock.mockResolvedValue([
      {
        id: "p1",
        name: "Cairn",
        clientId: null,
        color: "#e07a5f",
        archived: false,
      },
    ]);
    const { useProjects } = await import("./use-projects");
    const { result } = renderHook(() => useProjects());
    expect(result.current.projects).toEqual([]);
    await waitFor(() => expect(result.current.projects).toHaveLength(1));
    expect(result.current.projects[0]?.name).toBe("Cairn");
  });

  it("falls back to fixtures when the backend returns an empty list", async () => {
    invokeMock.mockResolvedValue([]);
    const { useProjects } = await import("./use-projects");
    const { result } = renderHook(() => useProjects());
    await waitFor(() =>
      expect(result.current.projects.length).toBeGreaterThan(0),
    );
  });

  it("falls back to fixtures when the IPC call rejects", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      invokeMock.mockRejectedValue(new Error("boom"));
      const { useProjects } = await import("./use-projects");
      const { result } = renderHook(() => useProjects());
      await waitFor(() =>
        expect(result.current.projects.length).toBeGreaterThan(0),
      );
    } finally {
      errSpy.mockRestore();
    }
  });

  it("create() saves via the backend and adds the returned project", async () => {
    const saved = {
      id: "srv-1",
      name: "New",
      clientId: null,
      color: "#f2cc8f",
      archived: false,
    };
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "list_projects") return Promise.resolve([]);
      if (cmd === "save_project") return Promise.resolve(saved);
      return Promise.resolve(null);
    });
    const { useProjects } = await import("./use-projects");
    const { result } = renderHook(() => useProjects());
    await waitFor(() =>
      expect(result.current.projects.length).toBeGreaterThan(0),
    );
    await act(async () => {
      await result.current.create({ name: "New", color: "#f2cc8f" });
    });
    expect(invokeMock).toHaveBeenCalledWith("save_project", {
      project: { name: "New", color: "#f2cc8f" },
    });
    expect(result.current.projects.some((p) => p.id === "srv-1")).toBe(true);
  });
});
