import { describe, it, expect, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";

// No `./ipc` mock here: in the test env `inTauri` is false, so the real
// ipc wrappers short-circuit and the hook tracks state in-memory. Assert
// the backend `invoke` is never reached on this path.
const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));

import { useAutostart } from "./use-autostart";

describe("useAutostart outside Tauri", () => {
  it("becomes ready without calling the backend", async () => {
    const { result } = renderHook(() => useAutostart());
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(result.current.enabled).toBe(false);
    expect(result.current.error).toBeNull();
    expect(invoke).not.toHaveBeenCalled();
  });

  it("toggles in-memory without calling the backend", async () => {
    const { result } = renderHook(() => useAutostart());
    await waitFor(() => expect(result.current.ready).toBe(true));
    await act(async () => {
      await result.current.toggle(true);
    });
    expect(result.current.enabled).toBe(true);
    expect(result.current.busy).toBe(false);
    expect(invoke).not.toHaveBeenCalled();
  });
});
