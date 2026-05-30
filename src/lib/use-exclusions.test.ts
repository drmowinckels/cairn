import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { BackendExclusion } from "./ipc";

const invokeMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

type WithInternals = { __TAURI_INTERNALS__?: unknown };

const ROWS: BackendExclusion[] = [
  { id: "x1", kind: "app", value: "1Password" },
  { id: "x2", kind: "domain", value: "*.bank.com" },
];

afterEach(() => {
  invokeMock.mockReset();
});

describe("guessExclusionKind", () => {
  it("classifies whitespace as a window-title pattern", async () => {
    const { guessExclusionKind } = await import("./use-exclusions");
    expect(guessExclusionKind("Secret Chat — Signal")).toBe("window");
  });

  it("classifies dotted / wildcard tokens as domains", async () => {
    const { guessExclusionKind } = await import("./use-exclusions");
    expect(guessExclusionKind("*.bank.com")).toBe("domain");
    expect(guessExclusionKind("mail.proton.me")).toBe("domain");
  });

  it("classifies a bare token as an app", async () => {
    const { guessExclusionKind } = await import("./use-exclusions");
    expect(guessExclusionKind("1Password")).toBe("app");
  });
});

describe("useExclusions (inside Tauri)", () => {
  beforeEach(() => {
    (globalThis as WithInternals).__TAURI_INTERNALS__ = {};
    vi.resetModules();
  });
  afterEach(() => {
    delete (globalThis as WithInternals).__TAURI_INTERNALS__;
  });

  it("loads the exclusion list on mount", async () => {
    invokeMock.mockImplementation(async (cmd: string) =>
      cmd === "list_exclusions" ? ROWS : null,
    );
    const { useExclusions } = await import("./use-exclusions");
    const { result } = renderHook(() => useExclusions());
    await waitFor(() => expect(result.current.exclusions).toHaveLength(2));
    expect(result.current.loading).toBe(false);
  });

  it("add() saves with the inferred kind then refreshes", async () => {
    invokeMock.mockImplementation(async (cmd: string) =>
      cmd === "list_exclusions" ? ROWS : { id: "new", kind: "domain", value: "x.com" },
    );
    const { useExclusions } = await import("./use-exclusions");
    const { result } = renderHook(() => useExclusions());
    await waitFor(() => expect(result.current.exclusions).toHaveLength(2));
    await act(async () => {
      await result.current.add("domain", "x.com");
    });
    expect(invokeMock).toHaveBeenCalledWith("save_exclusion", {
      input: { kind: "domain", value: "x.com" },
    });
  });

  it("remove() deletes by id then refreshes", async () => {
    invokeMock.mockImplementation(async (cmd: string) =>
      cmd === "list_exclusions" ? ROWS : null,
    );
    const { useExclusions } = await import("./use-exclusions");
    const { result } = renderHook(() => useExclusions());
    await waitFor(() => expect(result.current.exclusions).toHaveLength(2));
    await act(async () => {
      await result.current.remove("x1");
    });
    expect(invokeMock).toHaveBeenCalledWith("delete_exclusion", { id: "x1" });
  });

  it("surfaces a load error without throwing", async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "list_exclusions") throw new Error("db gone");
      return null;
    });
    const { useExclusions } = await import("./use-exclusions");
    const { result } = renderHook(() => useExclusions());
    await waitFor(() => expect(result.current.error).toContain("db gone"));
  });
});
