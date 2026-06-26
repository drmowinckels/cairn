import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";

const autostartEnabled = vi.fn();
const setAutostart = vi.fn();

vi.mock("./ipc", () => ({
  autostartEnabled: (...args: unknown[]) => autostartEnabled(...args),
  setAutostart: (...args: unknown[]) => setAutostart(...args),
}));

import { useAutostart } from "./use-autostart";

beforeEach(() => {
  autostartEnabled.mockReset().mockResolvedValue(false);
  // Default: the backend honors the request and echoes the resulting state.
  setAutostart.mockReset().mockImplementation(async (next: boolean) => next);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("useAutostart", () => {
  it("probes the backend on mount and reflects the enabled state", async () => {
    autostartEnabled.mockResolvedValue(true);
    const { result } = renderHook(() => useAutostart());
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(autostartEnabled).toHaveBeenCalledOnce();
    expect(result.current.enabled).toBe(true);
    expect(result.current.error).toBeNull();
  });

  it("enables autostart on toggle(true)", async () => {
    const { result } = renderHook(() => useAutostart());
    await waitFor(() => expect(result.current.ready).toBe(true));
    await act(async () => {
      await result.current.toggle(true);
    });
    expect(setAutostart).toHaveBeenCalledWith(true);
    expect(result.current.enabled).toBe(true);
    expect(result.current.busy).toBe(false);
  });

  it("disables autostart on toggle(false)", async () => {
    autostartEnabled.mockResolvedValue(true);
    const { result } = renderHook(() => useAutostart());
    await waitFor(() => expect(result.current.ready).toBe(true));
    await act(async () => {
      await result.current.toggle(false);
    });
    expect(setAutostart).toHaveBeenCalledWith(false);
    expect(result.current.enabled).toBe(false);
  });

  it("coerces an undefined probe result to false (no aria-checked drop)", async () => {
    // A stubbed backend (e.g. the a11y-audit shim) can resolve `undefined`;
    // `enabled` must stay a real boolean so the consuming `aria-checked`
    // attribute is never omitted.
    autostartEnabled.mockResolvedValue(undefined);
    const { result } = renderHook(() => useAutostart());
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(result.current.enabled).toBe(false);
  });

  it("surfaces a probe error and still becomes ready", async () => {
    autostartEnabled.mockRejectedValue(new Error("no autostart here"));
    const { result } = renderHook(() => useAutostart());
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(result.current.error).toContain("no autostart here");
  });

  it("leaves the switch off and surfaces the reason when a dev build is refused (#261)", async () => {
    setAutostart.mockRejectedValue(
      new Error("Won't enable launch-at-login for a development build"),
    );
    const { result } = renderHook(() => useAutostart());
    await waitFor(() => expect(result.current.ready).toBe(true));
    await act(async () => {
      await result.current.toggle(true);
    });
    expect(result.current.error).toContain("development build");
    expect(result.current.busy).toBe(false);
    // Refused → the registration never happened, so the switch stays off.
    expect(result.current.enabled).toBe(false);
  });
});
