import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";

const checkForUpdate = vi.fn();
vi.mock("./ipc", () => ({
  checkForUpdate: () => checkForUpdate(),
}));

import { useUpdateCheck, UPDATE_CHECK_INTERVAL_MS } from "./use-update-check";

const UPDATE = {
  version: "0.2.0",
  currentVersion: "0.1.0",
  notes: "Nice things",
  releaseUrl: "https://github.com/drmowinckels/cairn/releases/tag/v0.2.0",
};

beforeEach(() => {
  checkForUpdate.mockReset();
  window.localStorage?.clear?.();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("useUpdateCheck", () => {
  it("does not check when disabled", () => {
    const { result } = renderHook(() => useUpdateCheck(false));
    expect(checkForUpdate).not.toHaveBeenCalled();
    expect(result.current.available).toBeNull();
  });

  it("checks on mount when enabled and surfaces the update", async () => {
    checkForUpdate.mockResolvedValue(UPDATE);
    const { result } = renderHook(() => useUpdateCheck(true));
    await waitFor(() => expect(result.current.available).toEqual(UPDATE));
    expect(checkForUpdate).toHaveBeenCalledTimes(1);
  });

  it("re-checks on the 24h interval", async () => {
    vi.useFakeTimers();
    checkForUpdate.mockResolvedValue(null);
    renderHook(() => useUpdateCheck(true));
    await vi.advanceTimersByTimeAsync(0);
    expect(checkForUpdate).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_INTERVAL_MS);
    expect(checkForUpdate).toHaveBeenCalledTimes(2);
  });

  it("stays silent when the check throws", async () => {
    checkForUpdate.mockRejectedValue(new Error("offline"));
    const { result } = renderHook(() => useUpdateCheck(true));
    await Promise.resolve();
    expect(result.current.available).toBeNull();
  });

  it("dismiss hides the banner and remembers the version", async () => {
    checkForUpdate.mockResolvedValue(UPDATE);
    const { result } = renderHook(() => useUpdateCheck(true));
    await waitFor(() => expect(result.current.available).toEqual(UPDATE));
    act(() => result.current.dismiss());
    expect(result.current.available).toBeNull();
    expect(window.localStorage.getItem("cairn:update-dismissed:v1")).toBe(
      "0.2.0",
    );
  });

  it("keeps an already-dismissed version hidden on the next check", async () => {
    window.localStorage.setItem("cairn:update-dismissed:v1", "0.2.0");
    checkForUpdate.mockResolvedValue(UPDATE);
    const { result } = renderHook(() => useUpdateCheck(true));
    await waitFor(() => expect(checkForUpdate).toHaveBeenCalled());
    expect(result.current.available).toBeNull();
  });
});
