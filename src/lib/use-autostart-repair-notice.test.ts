import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";

const invokeMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

type WithInternals = { __TAURI_INTERNALS__?: unknown };

afterEach(() => {
  invokeMock.mockReset();
});

describe("useAutostartRepairNotice (outside Tauri)", () => {
  it("stays null and never calls invoke", async () => {
    delete (globalThis as WithInternals).__TAURI_INTERNALS__;
    vi.resetModules();
    const { useAutostartRepairNotice } =
      await import("./use-autostart-repair-notice");
    const { result } = renderHook(() => useAutostartRepairNotice());
    await waitFor(() => expect(result.current.message).toBeNull());
    expect(invokeMock).not.toHaveBeenCalled();
  });
});

describe("useAutostartRepairNotice (inside Tauri)", () => {
  let original: unknown;

  const withTauri = async () => {
    original = (globalThis as WithInternals).__TAURI_INTERNALS__;
    (globalThis as WithInternals).__TAURI_INTERNALS__ = {};
    vi.resetModules();
    return import("./use-autostart-repair-notice");
  };

  afterEach(() => {
    if (original === undefined) {
      delete (globalThis as WithInternals).__TAURI_INTERNALS__;
    } else {
      (globalThis as WithInternals).__TAURI_INTERNALS__ = original;
    }
  });

  it("reads get_autostart_repair_notice on mount and surfaces a pending message", async () => {
    invokeMock.mockResolvedValueOnce({
      message:
        "Launch-at-login was reset because it pointed at a removed/dev build.",
    });
    const { useAutostartRepairNotice } = await withTauri();
    const { result } = renderHook(() => useAutostartRepairNotice());
    await waitFor(() => expect(result.current.message).not.toBeNull());
    expect(invokeMock).toHaveBeenCalledWith("get_autostart_repair_notice");
    expect(result.current.message).toBe(
      "Launch-at-login was reset because it pointed at a removed/dev build.",
    );
  });

  it("surfaces null when nothing was ever repaired", async () => {
    invokeMock.mockResolvedValueOnce({ message: null });
    const { useAutostartRepairNotice } = await withTauri();
    const { result } = renderHook(() => useAutostartRepairNotice());
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("get_autostart_repair_notice"),
    );
    expect(result.current.message).toBeNull();
  });

  it("a failed read leaves the message null rather than throwing", async () => {
    invokeMock.mockRejectedValueOnce(new Error("DB locked"));
    const { useAutostartRepairNotice } = await withTauri();
    const { result } = renderHook(() => useAutostartRepairNotice());
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("get_autostart_repair_notice"),
    );
    expect(result.current.message).toBeNull();
  });

  it("dismiss() clears the message and calls dismiss_autostart_repair_notice", async () => {
    invokeMock
      .mockResolvedValueOnce({ message: "repaired" }) // initial get
      .mockResolvedValueOnce(undefined); // dismiss
    const { useAutostartRepairNotice } = await withTauri();
    const { result } = renderHook(() => useAutostartRepairNotice());
    await waitFor(() => expect(result.current.message).toBe("repaired"));

    await act(async () => {
      await result.current.dismiss();
    });

    expect(invokeMock).toHaveBeenCalledWith("dismiss_autostart_repair_notice");
    expect(result.current.message).toBeNull();
  });

  it("dismiss() still clears the local message even if the backend call fails", async () => {
    invokeMock
      .mockResolvedValueOnce({ message: "repaired" }) // initial get
      .mockRejectedValueOnce(new Error("write failed")); // dismiss
    const { useAutostartRepairNotice } = await withTauri();
    const { result } = renderHook(() => useAutostartRepairNotice());
    await waitFor(() => expect(result.current.message).toBe("repaired"));

    await act(async () => {
      await result.current.dismiss();
    });

    expect(result.current.message).toBeNull();
  });
});
