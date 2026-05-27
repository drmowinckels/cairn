import { describe, it, expect, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useColorblindEnabled } from "./use-colorblind";

beforeEach(() => {
  delete document.documentElement.dataset.colorblind;
});

describe("useColorblindEnabled", () => {
  it("returns false when the attribute is missing", () => {
    const { result } = renderHook(() => useColorblindEnabled());
    expect(result.current).toBe(false);
  });

  it("returns true when html data-colorblind is on at mount", () => {
    document.documentElement.dataset.colorblind = "on";
    const { result } = renderHook(() => useColorblindEnabled());
    expect(result.current).toBe(true);
  });

  it("reacts to mutations of the data attribute", async () => {
    const { result } = renderHook(() => useColorblindEnabled());
    expect(result.current).toBe(false);
    await act(async () => {
      document.documentElement.dataset.colorblind = "on";
      // The MutationObserver delivers asynchronously; flush the queue
      // by awaiting a microtask.
      await Promise.resolve();
    });
    expect(result.current).toBe(true);
    await act(async () => {
      document.documentElement.dataset.colorblind = "off";
      await Promise.resolve();
    });
    expect(result.current).toBe(false);
  });
});
