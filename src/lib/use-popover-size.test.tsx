import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";

const setPopoverSize = vi.fn().mockResolvedValue(undefined);
let tauri = true;

vi.mock("./ipc", () => ({
  get inTauri() {
    return tauri;
  },
  setPopoverSize: (...args: unknown[]) => setPopoverSize(...args),
}));

import {
  usePopoverSize,
  POPOVER_DIMENSIONS,
} from "./use-popover-size";

beforeEach(() => {
  setPopoverSize.mockClear();
  tauri = true;
  window.localStorage?.clear?.();
  delete document.documentElement.dataset.popoverSize;
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("usePopoverSize", () => {
  it("defaults to compact and reflects it on the root dataset", () => {
    const { result } = renderHook(() => usePopoverSize());
    expect(result.current.size).toBe("compact");
    expect(document.documentElement.dataset.popoverSize).toBe("compact");
  });

  it("applies the compact dimensions to the window on mount under Tauri", () => {
    renderHook(() => usePopoverSize());
    expect(setPopoverSize).toHaveBeenCalledWith(
      POPOVER_DIMENSIONS.compact.width,
      POPOVER_DIMENSIONS.compact.height,
    );
  });

  it("setSize('large') persists, updates the dataset, and resizes the window", () => {
    const { result } = renderHook(() => usePopoverSize());
    act(() => result.current.setSize("large"));
    expect(result.current.size).toBe("large");
    expect(document.documentElement.dataset.popoverSize).toBe("large");
    expect(window.localStorage.getItem("cairn:popover-size:v1")).toBe("large");
    expect(setPopoverSize).toHaveBeenLastCalledWith(
      POPOVER_DIMENSIONS.large.width,
      POPOVER_DIMENSIONS.large.height,
    );
  });

  it("rehydrates the stored preset on a fresh mount", () => {
    window.localStorage.setItem("cairn:popover-size:v1", "large");
    const { result } = renderHook(() => usePopoverSize());
    expect(result.current.size).toBe("large");
    expect(document.documentElement.dataset.popoverSize).toBe("large");
  });

  it("does not touch the window outside Tauri but still sets the dataset", () => {
    tauri = false;
    const { result } = renderHook(() => usePopoverSize());
    act(() => result.current.setSize("large"));
    expect(setPopoverSize).not.toHaveBeenCalled();
    expect(document.documentElement.dataset.popoverSize).toBe("large");
  });
});
