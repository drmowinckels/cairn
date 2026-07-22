import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";

const billingStatus = vi.fn();
const activateBillingLicense = vi.fn();
const refreshBillingLicense = vi.fn();
const deactivateBillingLicense = vi.fn();

vi.mock("./ipc", async () => {
  const actual = await vi.importActual<typeof import("./ipc")>("./ipc");
  return {
    ...actual,
    billingStatus: (...a: unknown[]) => billingStatus(...a),
    activateBillingLicense: (...a: unknown[]) => activateBillingLicense(...a),
    refreshBillingLicense: (...a: unknown[]) => refreshBillingLicense(...a),
    deactivateBillingLicense: (...a: unknown[]) =>
      deactivateBillingLicense(...a),
  };
});

import { useBilling } from "./use-billing";

const locked = { enabled: true, license: null };
const active = {
  enabled: true,
  license: {
    status: "active",
    active: true,
    customerEmail: "dev@example.com",
    productName: "Cairn Pro",
    expiresAt: null,
    lastValidatedAt: "2026-07-22T00:00:00Z",
  },
};

beforeEach(() => {
  billingStatus.mockReset();
  activateBillingLicense.mockReset();
  refreshBillingLicense.mockReset();
  deactivateBillingLicense.mockReset();
});

describe("useBilling", () => {
  it("loads status on mount and does NOT re-check when unlicensed", async () => {
    billingStatus.mockResolvedValue(locked);
    const { result } = renderHook(() => useBilling());
    await waitFor(() => expect(result.current.status).toEqual(locked));
    expect(refreshBillingLicense).not.toHaveBeenCalled();
    expect(result.current.error).toBeNull();
  });

  it("re-checks a stored license against Lemon Squeezy on mount", async () => {
    billingStatus.mockResolvedValue(active);
    const refreshed = {
      ...active,
      license: { ...active.license, lastValidatedAt: "2026-07-22T09:00:00Z" },
    };
    refreshBillingLicense.mockResolvedValue(refreshed);
    const { result } = renderHook(() => useBilling());
    await waitFor(() => expect(refreshBillingLicense).toHaveBeenCalled());
    await waitFor(() =>
      expect(result.current.status?.license?.lastValidatedAt).toBe(
        "2026-07-22T09:00:00Z",
      ),
    );
    expect(result.current.busy).toBe(false);
  });

  it("keeps the last-known status and shows the error when the mount re-check is offline", async () => {
    billingStatus.mockResolvedValue(active);
    refreshBillingLicense.mockRejectedValue("couldn't reach Lemon Squeezy");
    const { result } = renderHook(() => useBilling());
    await waitFor(() => expect(result.current.error).toContain("reach"));
    // Last-known active state survives.
    expect(result.current.status?.license?.active).toBe(true);
  });

  it("activate returns true, stores, and clears the error", async () => {
    billingStatus.mockResolvedValue(locked);
    activateBillingLicense.mockResolvedValue(active);
    const { result } = renderHook(() => useBilling());
    await waitFor(() => expect(result.current.status).toEqual(locked));

    let ok = false;
    await act(async () => {
      ok = await result.current.activate("KEY-1");
    });
    expect(ok).toBe(true);
    expect(activateBillingLicense).toHaveBeenCalledWith("KEY-1");
    expect(result.current.status?.license?.active).toBe(true);
  });

  it("a rejected activate resolves false, keeps status, surfaces the reason", async () => {
    billingStatus.mockResolvedValue(locked);
    activateBillingLicense.mockRejectedValue(
      "license_key has reached its activation limit",
    );
    const { result } = renderHook(() => useBilling());
    await waitFor(() => expect(result.current.status).toEqual(locked));

    let ok = true;
    await act(async () => {
      ok = await result.current.activate("KEY-1");
    });
    expect(ok).toBe(false);
    expect(result.current.status).toEqual(locked);
    expect(result.current.error).toContain("activation limit");
  });

  it("refresh and deactivate call through", async () => {
    billingStatus.mockResolvedValue(active);
    refreshBillingLicense.mockResolvedValue(active);
    deactivateBillingLicense.mockResolvedValue(locked);
    const { result } = renderHook(() => useBilling());
    await waitFor(() => expect(result.current.status?.license).toBeTruthy());

    await act(async () => {
      await result.current.refresh();
    });
    expect(refreshBillingLicense).toHaveBeenCalled();

    let ok = false;
    await act(async () => {
      ok = await result.current.deactivate();
    });
    expect(ok).toBe(true);
    expect(result.current.status).toEqual(locked);
  });

  it("surfaces a load failure", async () => {
    billingStatus.mockRejectedValue(new Error("ipc down"));
    const { result } = renderHook(() => useBilling());
    await waitFor(() => expect(result.current.error).toContain("ipc down"));
    expect(result.current.status).toBeNull();
  });

  it("ignores a load that settles after unmount", async () => {
    let resolve!: (v: unknown) => void;
    billingStatus.mockReturnValue(
      new Promise((r) => {
        resolve = r;
      }),
    );
    const { unmount } = renderHook(() => useBilling());
    unmount();
    resolve(active);
    await Promise.resolve();
  });

  it("ignores a load that rejects after unmount", async () => {
    let reject!: (v: unknown) => void;
    billingStatus.mockReturnValue(
      new Promise((_, r) => {
        reject = r;
      }),
    );
    const { unmount } = renderHook(() => useBilling());
    unmount();
    reject(new Error("late"));
    await Promise.resolve();
  });
});
