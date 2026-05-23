import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { renderHook, waitFor } from "@testing-library/react";

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
    expect(result.current.length).toBeGreaterThan(0);
    expect(invokeMock).not.toHaveBeenCalled();
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
      { id: "p1", name: "Cairn", client: null, color: "#e07a5f" },
    ]);
    const { useProjects } = await import("./use-projects");
    const { result } = renderHook(() => useProjects());
    expect(result.current).toEqual([]);
    await waitFor(() => expect(result.current).toHaveLength(1));
    expect(result.current[0]?.name).toBe("Cairn");
  });

  it("falls back to fixtures when the backend returns an empty list", async () => {
    invokeMock.mockResolvedValue([]);
    const { useProjects } = await import("./use-projects");
    const { result } = renderHook(() => useProjects());
    await waitFor(() => expect(result.current.length).toBeGreaterThan(0));
  });

  it("falls back to fixtures when the IPC call rejects", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      invokeMock.mockRejectedValue(new Error("boom"));
      const { useProjects } = await import("./use-projects");
      const { result } = renderHook(() => useProjects());
      await waitFor(() => expect(result.current.length).toBeGreaterThan(0));
    } finally {
      errSpy.mockRestore();
    }
  });
});
