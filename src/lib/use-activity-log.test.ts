import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";

const getMock = vi.fn();
const setMock = vi.fn();
const deleteMock = vi.fn();

vi.mock("./ipc", () => ({
  ACTIVITY_LOG_DEFAULTS: { enabled: false, retentionDays: 7 },
  getActivityLogSettings: () => getMock(),
  setActivityLogSettings: (s: unknown) => setMock(s),
  deleteActivityLog: () => deleteMock(),
}));

afterEach(() => {
  getMock.mockReset();
  setMock.mockReset();
  deleteMock.mockReset();
});

describe("useActivityLog (#190)", () => {
  it("loads settings on mount", async () => {
    getMock.mockResolvedValue({ enabled: true, retentionDays: 30 });
    const { useActivityLog } = await import("./use-activity-log");
    const { result } = renderHook(() => useActivityLog());
    await waitFor(() => expect(result.current.settings.enabled).toBe(true));
    expect(result.current.settings.retentionDays).toBe(30);
  });

  it("setEnabled optimistically updates and writes through", async () => {
    getMock.mockResolvedValue({ enabled: false, retentionDays: 7 });
    setMock.mockResolvedValue(undefined);
    const { useActivityLog } = await import("./use-activity-log");
    const { result } = renderHook(() => useActivityLog());
    await waitFor(() => expect(result.current.settings.enabled).toBe(false));
    await act(async () => {
      await result.current.setEnabled(true);
    });
    expect(result.current.settings.enabled).toBe(true);
    expect(setMock).toHaveBeenCalledWith({ enabled: true, retentionDays: 7 });
  });

  it("setRetentionDays writes the new window", async () => {
    getMock.mockResolvedValue({ enabled: true, retentionDays: 7 });
    setMock.mockResolvedValue(undefined);
    const { useActivityLog } = await import("./use-activity-log");
    const { result } = renderHook(() => useActivityLog());
    await waitFor(() => expect(result.current.settings.enabled).toBe(true));
    await act(async () => {
      await result.current.setRetentionDays(0);
    });
    expect(result.current.settings.retentionDays).toBe(0);
    expect(setMock).toHaveBeenCalledWith({ enabled: true, retentionDays: 0 });
  });

  it("rolls back and surfaces the error when a write fails", async () => {
    getMock.mockResolvedValue({ enabled: false, retentionDays: 7 });
    setMock.mockRejectedValue(new Error("db locked"));
    const { useActivityLog } = await import("./use-activity-log");
    const { result } = renderHook(() => useActivityLog());
    await waitFor(() => expect(result.current.settings.enabled).toBe(false));
    await act(async () => {
      await result.current.setEnabled(true);
    });
    expect(result.current.settings.enabled).toBe(false); // rolled back
    expect(result.current.error).toContain("db locked");
  });

  it("deleteAll calls the backend", async () => {
    getMock.mockResolvedValue({ enabled: true, retentionDays: 7 });
    deleteMock.mockResolvedValue(undefined);
    const { useActivityLog } = await import("./use-activity-log");
    const { result } = renderHook(() => useActivityLog());
    await act(async () => {
      await result.current.deleteAll();
    });
    expect(deleteMock).toHaveBeenCalledTimes(1);
  });

  it("surfaces a load error", async () => {
    getMock.mockRejectedValue(new Error("boom"));
    const { useActivityLog } = await import("./use-activity-log");
    const { result } = renderHook(() => useActivityLog());
    await waitFor(() => expect(result.current.error).toContain("boom"));
  });

  it("surfaces a deleteAll error", async () => {
    getMock.mockResolvedValue({ enabled: true, retentionDays: 7 });
    deleteMock.mockRejectedValue(new Error("nope"));
    const { useActivityLog } = await import("./use-activity-log");
    const { result } = renderHook(() => useActivityLog());
    await act(async () => {
      await result.current.deleteAll();
    });
    expect(result.current.error).toContain("nope");
  });

  it("ignores a load resolving after unmount (no setState on a dead component)", async () => {
    let resolve!: (v: { enabled: boolean; retentionDays: number }) => void;
    getMock.mockReturnValue(
      new Promise((r) => {
        resolve = r;
      }),
    );
    const { useActivityLog } = await import("./use-activity-log");
    const { result, unmount } = renderHook(() => useActivityLog());
    unmount();
    await act(async () => {
      resolve({ enabled: true, retentionDays: 30 });
      await Promise.resolve();
    });
    // The cancelled guard skipped the update — still the default.
    expect(result.current.settings.enabled).toBe(false);
  });

  it("ignores a load rejecting after unmount", async () => {
    let reject!: (e: Error) => void;
    getMock.mockReturnValue(
      new Promise((_r, rej) => {
        reject = rej;
      }),
    );
    const { useActivityLog } = await import("./use-activity-log");
    const { result, unmount } = renderHook(() => useActivityLog());
    unmount();
    await act(async () => {
      reject(new Error("late"));
      await Promise.resolve();
    });
    expect(result.current.error).toBeNull();
  });
});
