import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";

const billingListRates = vi.fn();
const billingSetRate = vi.fn();
const billingDeleteRate = vi.fn();

vi.mock("./ipc", async () => {
  const actual = await vi.importActual<typeof import("./ipc")>("./ipc");
  return {
    ...actual,
    billingListRates: (...a: unknown[]) => billingListRates(...a),
    billingSetRate: (...a: unknown[]) => billingSetRate(...a),
    billingDeleteRate: (...a: unknown[]) => billingDeleteRate(...a),
  };
});

import { useRates } from "./use-rates";

const rate = (over: Record<string, unknown> = {}) => ({
  id: "r1",
  scopeType: "workspace" as const,
  scopeId: "",
  amountCents: 12000,
  currency: "USD",
  effectiveFrom: "2026-01-01",
  createdAt: "2026-01-01T00:00:00Z",
  ...over,
});

const wsInput = {
  scopeType: "workspace" as const,
  scopeId: "",
  amountCents: 12000,
  currency: "USD",
  effectiveFrom: "2026-01-01",
};

beforeEach(() => {
  billingListRates.mockReset();
  billingSetRate.mockReset();
  billingDeleteRate.mockReset();
});

describe("useRates", () => {
  it("loads the rate list on mount", async () => {
    billingListRates.mockResolvedValue([rate()]);
    const { result } = renderHook(() => useRates());
    await waitFor(() => expect(result.current.rates).toHaveLength(1));
    expect(result.current.error).toBeNull();
  });

  it("surfaces a load failure and leaves rates null", async () => {
    billingListRates.mockRejectedValue(new Error("the billing plugin is off"));
    const { result } = renderHook(() => useRates());
    await waitFor(() =>
      expect(result.current.error).toContain("plugin is off"),
    );
    expect(result.current.rates).toBeNull();
  });

  it("addRate stores and returns true with the fresh list", async () => {
    billingListRates.mockResolvedValue([]);
    billingSetRate.mockResolvedValue([rate()]);
    const { result } = renderHook(() => useRates());
    await waitFor(() => expect(result.current.rates).toEqual([]));

    let ok = false;
    await act(async () => {
      ok = await result.current.addRate(wsInput);
    });
    expect(ok).toBe(true);
    expect(billingSetRate).toHaveBeenCalledWith(wsInput);
    expect(result.current.rates).toHaveLength(1);
  });

  it("a rejected addRate resolves false and surfaces the reason", async () => {
    billingListRates.mockResolvedValue([]);
    billingSetRate.mockRejectedValue("Cairn Pro isn't active");
    const { result } = renderHook(() => useRates());
    await waitFor(() => expect(result.current.rates).toEqual([]));

    let ok = true;
    await act(async () => {
      ok = await result.current.addRate({ ...wsInput, amountCents: 1 });
    });
    expect(ok).toBe(false);
    expect(result.current.error).toContain("isn't active");
    expect(result.current.busy).toBe(false);
  });

  it("deleteRate removes and returns the fresh list", async () => {
    billingListRates.mockResolvedValue([rate()]);
    billingDeleteRate.mockResolvedValue([]);
    const { result } = renderHook(() => useRates());
    await waitFor(() => expect(result.current.rates).toHaveLength(1));

    let ok = false;
    await act(async () => {
      ok = await result.current.deleteRate("r1");
    });
    expect(ok).toBe(true);
    expect(billingDeleteRate).toHaveBeenCalledWith("r1");
    expect(result.current.rates).toEqual([]);
  });

  it("ignores a load that settles after unmount", async () => {
    let resolve!: (v: unknown) => void;
    billingListRates.mockReturnValue(
      new Promise((r) => {
        resolve = r;
      }),
    );
    const { unmount } = renderHook(() => useRates());
    unmount();
    resolve([rate()]);
    await Promise.resolve();
  });

  it("ignores a load that rejects after unmount", async () => {
    let reject!: (e: unknown) => void;
    billingListRates.mockReturnValue(
      new Promise((_r, rej) => {
        reject = rej;
      }),
    );
    const { unmount } = renderHook(() => useRates());
    unmount();
    reject(new Error("late"));
    await Promise.resolve();
  });
});
