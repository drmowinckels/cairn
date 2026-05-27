import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

type WithInternals = { __TAURI_INTERNALS__?: unknown };

afterEach(() => {
  invokeMock.mockReset();
});

describe("ipc helpers (inside Tauri)", () => {
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

  it("updateEntry forwards the input under an `input` key", async () => {
    invokeMock.mockResolvedValue({ id: "e1" });
    const { updateEntry } = await import("./ipc");
    const input = { id: "e1", description: "x" };
    const result = await updateEntry(input);
    expect(invokeMock).toHaveBeenCalledWith("update_entry", { input });
    expect(result).toEqual({ id: "e1" });
  });

  it("createEntry forwards the input under an `input` key", async () => {
    invokeMock.mockResolvedValue({ id: "e2" });
    const { createEntry } = await import("./ipc");
    const input = {
      startedAt: "2026-05-26T09:00:00Z",
      endedAt: "2026-05-26T10:00:00Z",
      description: "manual",
      source: "manual",
    };
    const result = await createEntry(input);
    expect(invokeMock).toHaveBeenCalledWith("create_entry", { input });
    expect(result).toEqual({ id: "e2" });
  });

  it("deleteEntry forwards the id and ignores the response", async () => {
    invokeMock.mockResolvedValue(null);
    const { deleteEntry } = await import("./ipc");
    await deleteEntry("entry-7");
    expect(invokeMock).toHaveBeenCalledWith("delete_entry", { id: "entry-7" });
  });

  it("upcomingCalendarEvents passes the default limit when none is given", async () => {
    invokeMock.mockResolvedValue([]);
    const { upcomingCalendarEvents } = await import("./ipc");
    const events = await upcomingCalendarEvents();
    expect(invokeMock).toHaveBeenCalledWith("upcoming_calendar_events", {
      limit: 3,
    });
    expect(events).toEqual([]);
  });

  it("upcomingCalendarEvents forwards an explicit limit", async () => {
    invokeMock.mockResolvedValue([{ uid: "u1" }]);
    const { upcomingCalendarEvents } = await import("./ipc");
    const events = await upcomingCalendarEvents(7);
    expect(invokeMock).toHaveBeenCalledWith("upcoming_calendar_events", {
      limit: 7,
    });
    expect(events).toEqual([{ uid: "u1" }]);
  });
});

describe("ipc helpers (outside Tauri)", () => {
  beforeEach(() => {
    delete (globalThis as WithInternals).__TAURI_INTERNALS__;
    vi.resetModules();
  });

  it("upcomingCalendarEvents short-circuits to [] without calling the backend", async () => {
    const { upcomingCalendarEvents } = await import("./ipc");
    const events = await upcomingCalendarEvents(5);
    expect(events).toEqual([]);
    expect(invokeMock).not.toHaveBeenCalled();
  });
});
