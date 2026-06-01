import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useDataViewPrefs } from "./use-data-view-prefs";

const STORAGE_KEY = "cairn:data-view:v1";

afterEach(() => window.localStorage.clear());

describe("useDataViewPrefs", () => {
  it("defaults to sections mode", () => {
    const { result } = renderHook(() => useDataViewPrefs());
    expect(result.current.mode).toBe("sections");
  });

  it("switches to tree mode and persists", () => {
    const { result } = renderHook(() => useDataViewPrefs());
    act(() => result.current.setMode("tree"));
    expect(result.current.mode).toBe("tree");
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe("tree");
  });

  it("reads a persisted 'tree' preference on mount", () => {
    window.localStorage.setItem(STORAGE_KEY, "tree");
    const { result } = renderHook(() => useDataViewPrefs());
    expect(result.current.mode).toBe("tree");
  });

  it("falls back to sections for unrecognised stored value", () => {
    window.localStorage.setItem(STORAGE_KEY, "unknown");
    const { result } = renderHook(() => useDataViewPrefs());
    expect(result.current.mode).toBe("sections");
  });

  it("falls back to sections when storage throws on read", () => {
    const spy = vi
      .spyOn(Storage.prototype, "getItem")
      .mockImplementation(() => {
        throw new Error("denied");
      });
    const { result } = renderHook(() => useDataViewPrefs());
    expect(result.current.mode).toBe("sections");
    spy.mockRestore();
  });

  it("keeps in-memory state when storage throws on write", () => {
    const spy = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(() => {
        throw new Error("denied");
      });
    const { result } = renderHook(() => useDataViewPrefs());
    act(() => result.current.setMode("tree"));
    expect(result.current.mode).toBe("tree");
    spy.mockRestore();
  });

  it("switches back to sections mode", () => {
    window.localStorage.setItem(STORAGE_KEY, "tree");
    const { result } = renderHook(() => useDataViewPrefs());
    act(() => result.current.setMode("sections"));
    expect(result.current.mode).toBe("sections");
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe("sections");
  });
});
