import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";

const billingGetBusiness = vi.fn();
const billingSetBusiness = vi.fn();

vi.mock("./ipc", async () => {
  const actual = await vi.importActual<typeof import("./ipc")>("./ipc");
  return {
    ...actual,
    billingGetBusiness: (...a: unknown[]) => billingGetBusiness(...a),
    billingSetBusiness: (...a: unknown[]) => billingSetBusiness(...a),
  };
});

import { useBusiness } from "./use-business";

const biz = (over: Record<string, unknown> = {}) => ({
  name: "Acme AS",
  address: "123 Main",
  email: "hi@acme.no",
  taxId: "NO 1",
  logo: "",
  ...over,
});

beforeEach(() => {
  billingGetBusiness.mockReset();
  billingSetBusiness.mockReset();
});

describe("useBusiness", () => {
  it("loads the stored details on mount", async () => {
    billingGetBusiness.mockResolvedValue(biz());
    const { result } = renderHook(() => useBusiness());
    await waitFor(() => expect(result.current.details).not.toBeNull());
    expect(result.current.details?.name).toBe("Acme AS");
    expect(result.current.error).toBeNull();
  });

  it("surfaces a load failure and leaves details null", async () => {
    billingGetBusiness.mockRejectedValue(
      new Error("the billing plugin is off"),
    );
    const { result } = renderHook(() => useBusiness());
    await waitFor(() =>
      expect(result.current.error).toContain("plugin is off"),
    );
    expect(result.current.details).toBeNull();
  });

  it("save stores, flags saved, and returns the stored details", async () => {
    billingGetBusiness.mockResolvedValue(biz());
    billingSetBusiness.mockResolvedValue(biz({ name: "New Co" }));
    const { result } = renderHook(() => useBusiness());
    await waitFor(() => expect(result.current.details).not.toBeNull());

    let stored: unknown;
    await act(async () => {
      stored = await result.current.save(biz({ name: "New Co" }));
    });
    expect(stored).toMatchObject({ name: "New Co" });
    expect(result.current.saved).toBe(true);
    expect(result.current.details?.name).toBe("New Co");

    // clearSaved drops the confirmation.
    act(() => result.current.clearSaved());
    expect(result.current.saved).toBe(false);
  });

  it("a rejected save resolves false and surfaces the reason", async () => {
    billingGetBusiness.mockResolvedValue(biz());
    billingSetBusiness.mockRejectedValue("Cairn Pro isn't active");
    const { result } = renderHook(() => useBusiness());
    await waitFor(() => expect(result.current.details).not.toBeNull());

    let stored: unknown = "sentinel";
    await act(async () => {
      stored = await result.current.save(biz());
    });
    expect(stored).toBeNull();
    expect(result.current.error).toContain("isn't active");
    expect(result.current.busy).toBe(false);
    expect(result.current.saved).toBe(false);
  });

  it("ignores a load that settles after unmount", async () => {
    let resolve!: (v: unknown) => void;
    billingGetBusiness.mockReturnValue(
      new Promise((r) => {
        resolve = r;
      }),
    );
    const { unmount } = renderHook(() => useBusiness());
    unmount();
    resolve(biz());
    await Promise.resolve();
  });

  it("ignores a load failure that settles after unmount", async () => {
    let reject!: (e: unknown) => void;
    billingGetBusiness.mockReturnValue(
      new Promise((_r, rej) => {
        reject = rej;
      }),
    );
    const { result, unmount } = renderHook(() => useBusiness());
    unmount();
    reject(new Error("too late"));
    await Promise.resolve();
    // The post-unmount rejection is swallowed — no error set.
    expect(result.current.error).toBeNull();
  });
});
