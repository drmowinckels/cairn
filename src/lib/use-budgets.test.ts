import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const listBudgets = vi.fn();
const setBudget = vi.fn();
const deleteBudget = vi.fn();

vi.mock("./ipc", async () => {
  const actual = await vi.importActual<typeof import("./ipc")>("./ipc");
  return {
    ...actual,
    listBudgets: (...a: unknown[]) => listBudgets(...a),
    setBudget: (...a: unknown[]) => setBudget(...a),
    deleteBudget: (...a: unknown[]) => deleteBudget(...a),
  };
});

import { useBudgets } from "./use-budgets";

const budget = (over: Record<string, unknown> = {}) => ({
  id: "b1",
  scopeType: "workspace" as const,
  scopeId: "",
  period: "weekly" as const,
  minutes: 2400,
  warnPercent: 80,
  ...over,
});

const input = {
  scopeType: "workspace" as const,
  scopeId: "",
  period: "weekly" as const,
  minutes: 2400,
  warnPercent: 80,
};

beforeEach(() => {
  listBudgets.mockReset().mockResolvedValue([]);
  setBudget.mockReset().mockResolvedValue([]);
  deleteBudget.mockReset().mockResolvedValue([]);
});

describe("useBudgets", () => {
  it("starts null and loads the configured budgets", async () => {
    listBudgets.mockResolvedValue([budget()]);
    const { result } = renderHook(() => useBudgets());
    expect(result.current.budgets).toBeNull();
    await waitFor(() => expect(result.current.budgets).toHaveLength(1));
  });

  it("surfaces a load failure", async () => {
    listBudgets.mockRejectedValue(new Error("db locked"));
    const { result } = renderHook(() => useBudgets());
    await waitFor(() => expect(result.current.error).toMatch(/db locked/));
  });

  it("renders the backend's list after a save rather than patching locally", async () => {
    // Setting a budget for a scope+period that already has one *replaces*
    // it, so only the server knows what exists afterwards.
    setBudget.mockResolvedValue([budget({ minutes: 1800 })]);
    const { result } = renderHook(() => useBudgets());
    await waitFor(() => expect(result.current.budgets).toEqual([]));

    let ok = false;
    await act(async () => {
      ok = await result.current.saveBudget(input);
    });
    expect(ok).toBe(true);
    expect(result.current.budgets).toEqual([budget({ minutes: 1800 })]);
  });

  it("reports a save failure and keeps the previous list", async () => {
    listBudgets.mockResolvedValue([budget()]);
    setBudget.mockRejectedValue("a budget must be at least one minute");
    const { result } = renderHook(() => useBudgets());
    await waitFor(() => expect(result.current.budgets).toHaveLength(1));

    let ok = true;
    await act(async () => {
      ok = await result.current.saveBudget({ ...input, minutes: 0 });
    });
    expect(ok).toBe(false);
    expect(result.current.error).toMatch(/at least one minute/);
    expect(result.current.budgets).toHaveLength(1);
  });

  it("clears a stale error on the next attempt", async () => {
    setBudget.mockRejectedValueOnce("nope").mockResolvedValueOnce([budget()]);
    const { result } = renderHook(() => useBudgets());
    await waitFor(() => expect(result.current.budgets).toEqual([]));

    await act(async () => {
      await result.current.saveBudget(input);
    });
    expect(result.current.error).not.toBeNull();

    await act(async () => {
      await result.current.saveBudget(input);
    });
    expect(result.current.error).toBeNull();
  });

  it("removes a budget and renders what's left", async () => {
    listBudgets.mockResolvedValue([budget(), budget({ id: "b2" })]);
    deleteBudget.mockResolvedValue([budget({ id: "b2" })]);
    const { result } = renderHook(() => useBudgets());
    await waitFor(() => expect(result.current.budgets).toHaveLength(2));

    await act(async () => {
      await result.current.removeBudget("b1");
    });
    expect(deleteBudget).toHaveBeenCalledWith("b1");
    expect(result.current.budgets).toEqual([budget({ id: "b2" })]);
  });

  it("marks itself busy while a mutation is in flight", async () => {
    let release!: (v: unknown) => void;
    setBudget.mockReturnValue(
      new Promise((r) => {
        release = r;
      }),
    );
    const { result } = renderHook(() => useBudgets());
    await waitFor(() => expect(result.current.budgets).toEqual([]));

    let done!: Promise<boolean>;
    act(() => {
      done = result.current.saveBudget(input);
    });
    await waitFor(() => expect(result.current.busy).toBe(true));

    await act(async () => {
      release([]);
      await done;
    });
    expect(result.current.busy).toBe(false);
  });

  it("ignores a load that settles after unmount", async () => {
    let resolve!: (v: unknown) => void;
    listBudgets.mockReturnValue(
      new Promise((r) => {
        resolve = r;
      }),
    );
    const { unmount } = renderHook(() => useBudgets());
    unmount();
    resolve([budget()]);
    await Promise.resolve();
  });
});
