import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";

const isEnabled = vi.fn();
const enable = vi.fn();
const disable = vi.fn();

vi.mock("@tauri-apps/plugin-autostart", () => ({
  isEnabled: (...args: unknown[]) => isEnabled(...args),
  enable: (...args: unknown[]) => enable(...args),
  disable: (...args: unknown[]) => disable(...args),
}));

// Force the in-Tauri code path so the hook drives the plugin. The hook
// imports `inTauri` from `./ipc`; this test sits in the same directory,
// so the mock path is `./ipc` too.
vi.mock("./ipc", async () => {
  const actual = await vi.importActual<typeof import("./ipc")>("./ipc");
  return { ...actual, inTauri: true };
});

import { useAutostart } from "./use-autostart";

beforeEach(() => {
  isEnabled.mockReset().mockResolvedValue(false);
  enable.mockReset().mockResolvedValue(undefined);
  disable.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("useAutostart", () => {
  it("probes the plugin on mount and reflects the enabled state", async () => {
    isEnabled.mockResolvedValue(true);
    const { result } = renderHook(() => useAutostart());
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(isEnabled).toHaveBeenCalledOnce();
    expect(result.current.enabled).toBe(true);
    expect(result.current.error).toBeNull();
  });

  it("enables autostart on toggle(true)", async () => {
    const { result } = renderHook(() => useAutostart());
    await waitFor(() => expect(result.current.ready).toBe(true));
    await act(async () => {
      await result.current.toggle(true);
    });
    expect(enable).toHaveBeenCalledOnce();
    expect(disable).not.toHaveBeenCalled();
    expect(result.current.enabled).toBe(true);
    expect(result.current.busy).toBe(false);
  });

  it("disables autostart on toggle(false)", async () => {
    isEnabled.mockResolvedValue(true);
    const { result } = renderHook(() => useAutostart());
    await waitFor(() => expect(result.current.ready).toBe(true));
    await act(async () => {
      await result.current.toggle(false);
    });
    expect(disable).toHaveBeenCalledOnce();
    expect(result.current.enabled).toBe(false);
  });

  it("surfaces a probe error and still becomes ready", async () => {
    isEnabled.mockRejectedValue(new Error("no autostart here"));
    const { result } = renderHook(() => useAutostart());
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(result.current.error).toContain("no autostart here");
  });

  it("surfaces a toggle error and clears busy", async () => {
    enable.mockRejectedValue(new Error("registry locked"));
    const { result } = renderHook(() => useAutostart());
    await waitFor(() => expect(result.current.ready).toBe(true));
    await act(async () => {
      await result.current.toggle(true);
    });
    expect(result.current.error).toContain("registry locked");
    expect(result.current.busy).toBe(false);
    expect(result.current.enabled).toBe(false);
  });
});
