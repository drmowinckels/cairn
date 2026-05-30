import { describe, it, expect, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";

// No `./ipc` mock here: in the test env `inTauri` is false, so this
// file exercises the non-Tauri branches of the hook (the early-return
// probe and the in-memory toggle that skips the plugin import).

const pluginImported = vi.fn();
vi.mock("@tauri-apps/plugin-autostart", () => {
  pluginImported();
  return {
    isEnabled: vi.fn(),
    enable: vi.fn(),
    disable: vi.fn(),
  };
});

import { useAutostart } from "./use-autostart";

describe("useAutostart outside Tauri", () => {
  it("becomes ready without probing the plugin", async () => {
    const { result } = renderHook(() => useAutostart());
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(result.current.enabled).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it("toggles in-memory without importing the plugin", async () => {
    const { result } = renderHook(() => useAutostart());
    await waitFor(() => expect(result.current.ready).toBe(true));
    await act(async () => {
      await result.current.toggle(true);
    });
    expect(result.current.enabled).toBe(true);
    expect(result.current.busy).toBe(false);
    // The plugin module must never have been imported on this path.
    expect(pluginImported).not.toHaveBeenCalled();
  });
});
