import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";

const billingStatus = vi.fn();
const setBillingLicense = vi.fn();
const clearBillingLicense = vi.fn();

vi.mock("./ipc", async () => {
  const actual = await vi.importActual<typeof import("./ipc")>("./ipc");
  return {
    ...actual,
    billingStatus: (...args: unknown[]) => billingStatus(...args),
    setBillingLicense: (...args: unknown[]) => setBillingLicense(...args),
    clearBillingLicense: (...args: unknown[]) => clearBillingLicense(...args),
  };
});

import { useBilling } from "./use-billing";

const locked = { enabled: true, keyConfigured: true, license: null };
const licensed = {
  enabled: true,
  keyConfigured: true,
  license: { email: "dev@example.com", orderId: "o1", product: "cairn-pro" },
};

beforeEach(() => {
  billingStatus.mockReset();
  setBillingLicense.mockReset();
  clearBillingLicense.mockReset();
});

describe("useBilling", () => {
  it("loads the status on mount", async () => {
    billingStatus.mockResolvedValue(locked);
    const { result } = renderHook(() => useBilling());
    await waitFor(() => expect(result.current.status).toEqual(locked));
    expect(result.current.error).toBeNull();
  });

  it("activate stores the license, resolves true, and updates status", async () => {
    billingStatus.mockResolvedValue(locked);
    setBillingLicense.mockResolvedValue(licensed);
    const { result } = renderHook(() => useBilling());
    await waitFor(() => expect(result.current.status).toEqual(locked));

    let ok = false;
    await act(async () => {
      ok = await result.current.activate("payload.sig");
    });
    expect(ok).toBe(true);
    expect(setBillingLicense).toHaveBeenCalledWith("payload.sig");
    expect(result.current.status).toEqual(licensed);
    expect(result.current.busy).toBe(false);
  });

  it("a rejected activate resolves false, keeps status, and surfaces the message", async () => {
    billingStatus.mockResolvedValue(locked);
    setBillingLicense.mockRejectedValue("license signature does not match");
    const { result } = renderHook(() => useBilling());
    await waitFor(() => expect(result.current.status).toEqual(locked));

    let ok = true;
    await act(async () => {
      ok = await result.current.activate("bad.key");
    });
    expect(ok).toBe(false);
    expect(result.current.status).toEqual(locked);
    expect(result.current.error).toContain("does not match");
  });

  it("remove clears the license and a later activate resets the error", async () => {
    billingStatus.mockResolvedValue(licensed);
    clearBillingLicense.mockResolvedValue(locked);
    const { result } = renderHook(() => useBilling());
    await waitFor(() => expect(result.current.status).toEqual(licensed));

    await act(async () => {
      await result.current.remove();
    });
    expect(result.current.status).toEqual(locked);

    // A failure leaves an error; the next successful call clears it.
    setBillingLicense.mockRejectedValueOnce("nope");
    await act(async () => {
      await result.current.activate("x");
    });
    expect(result.current.error).toContain("nope");
    setBillingLicense.mockResolvedValue(licensed);
    await act(async () => {
      await result.current.activate("y");
    });
    expect(result.current.error).toBeNull();
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
    resolve(locked);
    // Nothing to assert beyond "no React state-update warning" — the
    // alive guard is the code under test.
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
