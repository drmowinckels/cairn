import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";

const invokeMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

type WithInternals = { __TAURI_INTERNALS__?: unknown };

afterEach(() => {
  invokeMock.mockReset();
});

describe("useUpcoming (outside Tauri)", () => {
  beforeEach(() => {
    delete (globalThis as WithInternals).__TAURI_INTERNALS__;
    vi.resetModules();
  });

  it("returns empty events and does not call the backend", async () => {
    const { useUpcoming } = await import("./use-upcoming");
    const { result } = renderHook(() => useUpcoming());
    expect(result.current.events).toEqual([]);
    expect(result.current.loading).toBe(false);
    expect(invokeMock).not.toHaveBeenCalled();
  });
});

describe("useUpcoming (inside Tauri)", () => {
  let original: unknown;

  beforeEach(() => {
    original = (globalThis as WithInternals).__TAURI_INTERNALS__;
    (globalThis as WithInternals).__TAURI_INTERNALS__ = {};
    vi.resetModules();
  });

  afterEach(() => {
    if (original === undefined) {
      delete (globalThis as WithInternals).__TAURI_INTERNALS__;
    } else {
      (globalThis as WithInternals).__TAURI_INTERNALS__ = original;
    }
  });

  function makeEvent(uid: string, startMinutesFromNow: number): unknown {
    const start = new Date(Date.now() + startMinutesFromNow * 60_000);
    const end = new Date(start.getTime() + 30 * 60_000);
    return {
      sourceId: "s1",
      sourceLabel: "Work",
      uid,
      summary: `event ${uid}`,
      start: start.toISOString(),
      end: end.toISOString(),
      allDay: false,
      attendees: [],
    };
  }

  it("calls upcoming_calendar_events with the limit on mount", async () => {
    invokeMock.mockResolvedValue([makeEvent("a", 15)]);
    const { useUpcoming } = await import("./use-upcoming");
    const { result } = renderHook(() => useUpcoming(2));
    await waitFor(() => expect(result.current.events.length).toBe(1));
    expect(invokeMock).toHaveBeenCalledWith("upcoming_calendar_events", {
      limit: 2,
    });
  });

  it("defaults to limit=3 when none is given", async () => {
    invokeMock.mockResolvedValue([]);
    const { useUpcoming } = await import("./use-upcoming");
    renderHook(() => useUpcoming());
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("upcoming_calendar_events", {
        limit: 3,
      }),
    );
  });

  it("surfaces an error string when the IPC rejects", async () => {
    invokeMock.mockRejectedValue(new Error("offline"));
    const { useUpcoming } = await import("./use-upcoming");
    const { result } = renderHook(() => useUpcoming());
    await waitFor(() => expect(result.current.error).toBeTruthy());
    expect(result.current.error).toContain("offline");
  });
});
