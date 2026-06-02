import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

type WithInternals = { __TAURI_INTERNALS__?: unknown };

afterEach(() => invokeMock.mockReset());

describe("useClients (browser-dev)", () => {
  beforeEach(() => {
    delete (globalThis as WithInternals).__TAURI_INTERNALS__;
    vi.resetModules();
  });

  it("seeds with fixture clients and never calls the backend", async () => {
    const { useClients } = await import("./use-clients");
    const { result } = renderHook(() => useClients());
    expect(result.current.clients.length).toBeGreaterThan(0);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("create adds a local client", async () => {
    const { useClients } = await import("./use-clients");
    const { result } = renderHook(() => useClients());
    const before = result.current.clients.length;
    await act(async () => {
      await result.current.create({ name: "New Co" });
    });
    expect(result.current.clients).toHaveLength(before + 1);
    expect(result.current.clients.some((c) => c.name === "New Co")).toBe(true);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("update replaces a client in place", async () => {
    const { useClients } = await import("./use-clients");
    const { result } = renderHook(() => useClients());
    const target = result.current.clients[0];
    await act(async () => {
      await result.current.update({ id: target.id, name: "Renamed" });
    });
    expect(result.current.clients.find((c) => c.id === target.id)?.name).toBe(
      "Renamed",
    );
  });

  it("remove drops a client", async () => {
    const { useClients } = await import("./use-clients");
    const { result } = renderHook(() => useClients());
    const target = result.current.clients[0];
    await act(async () => {
      await result.current.remove(target.id);
    });
    expect(result.current.clients.some((c) => c.id === target.id)).toBe(false);
  });
});

describe("useClients (inside Tauri)", () => {
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

  it("loads clients from the backend and create persists via save_client", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "list_clients") return Promise.resolve([]);
      if (cmd === "save_client")
        return Promise.resolve({
          id: "c9",
          name: "Acme",
          color: null,
          archived: false,
        });
      return Promise.resolve(null);
    });
    const { useClients } = await import("./use-clients");
    const { result } = renderHook(() => useClients());
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("list_clients"),
    );
    await act(async () => {
      await result.current.create({ name: "Acme" });
    });
    expect(invokeMock).toHaveBeenCalledWith("save_client", {
      client: { name: "Acme" },
    });
    expect(result.current.clients.some((c) => c.id === "c9")).toBe(true);
  });

  it("remove calls delete_client", async () => {
    invokeMock.mockResolvedValue([]);
    const { useClients } = await import("./use-clients");
    const { result } = renderHook(() => useClients());
    await act(async () => {
      await result.current.remove("c1");
    });
    expect(invokeMock).toHaveBeenCalledWith("delete_client", { id: "c1" });
  });
});
