import { afterEach, describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useTrayDetail } from "./use-tray-detail";

const KEY = "cairn:tray-show-project:v1";

afterEach(() => window.localStorage.clear());

describe("useTrayDetail", () => {
  it("defaults to off", () => {
    const { result } = renderHook(() => useTrayDetail());
    expect(result.current.enabled).toBe(false);
  });

  it("setEnabled persists to localStorage", () => {
    const { result } = renderHook(() => useTrayDetail());
    act(() => result.current.setEnabled(true));
    expect(result.current.enabled).toBe(true);
    expect(window.localStorage.getItem(KEY)).toBe("true");
    act(() => result.current.setEnabled(false));
    expect(window.localStorage.getItem(KEY)).toBe("false");
  });

  it("rehydrates the stored value on mount", () => {
    window.localStorage.setItem(KEY, "true");
    const { result } = renderHook(() => useTrayDetail());
    expect(result.current.enabled).toBe(true);
  });
});
