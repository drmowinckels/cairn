import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { CalendarSource } from "./ipc";

const invokeMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

type WithInternals = { __TAURI_INTERNALS__?: unknown };

const URL_SOURCE: CalendarSource = {
  id: "src-url",
  kind: "url",
  label: "Work",
  location: "https://cal.example/…",
  pollSeconds: 900,
  enabled: true,
  lastSyncedAt: null,
  lastEtag: null,
  lastModified: null,
  lastError: null,
};

const FILE_SOURCE: CalendarSource = {
  id: "src-file",
  kind: "file",
  label: "Local",
  location: "/tmp/cal.ics",
  pollSeconds: 60,
  enabled: true,
  lastSyncedAt: null,
  lastEtag: null,
  lastModified: null,
  lastError: null,
};

afterEach(() => {
  invokeMock.mockReset();
});

describe("useCalendars (outside Tauri)", () => {
  beforeEach(() => {
    delete (globalThis as WithInternals).__TAURI_INTERNALS__;
    vi.resetModules();
  });

  it("starts not loading and returns an empty list with no IPC traffic", async () => {
    const { useCalendars } = await import("./use-calendars");
    const { result } = renderHook(() => useCalendars());
    expect(result.current.loading).toBe(false);
    expect(result.current.sources).toEqual([]);
    expect(result.current.error).toBeNull();
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("refresh short-circuits outside Tauri without invoking IPC", async () => {
    const { useCalendars } = await import("./use-calendars");
    const { result } = renderHook(() => useCalendars());
    await act(async () => {
      await result.current.refresh();
    });
    expect(invokeMock).not.toHaveBeenCalled();
  });
});

describe("useCalendars (inside Tauri)", () => {
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

  it("lists sources on mount and clears the loading flag", async () => {
    invokeMock.mockResolvedValueOnce([URL_SOURCE]);
    const { useCalendars } = await import("./use-calendars");
    const { result } = renderHook(() => useCalendars());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.sources).toEqual([URL_SOURCE]);
    expect(result.current.error).toBeNull();
    expect(invokeMock).toHaveBeenCalledWith("list_calendar_sources");
  });

  it("captures errors from list_calendar_sources into the error field", async () => {
    invokeMock.mockRejectedValueOnce(new Error("kaboom"));
    const { useCalendars } = await import("./use-calendars");
    const { result } = renderHook(() => useCalendars());
    await waitFor(() => expect(result.current.error).not.toBeNull());
    expect(result.current.error).toContain("kaboom");
    expect(result.current.loading).toBe(false);
  });

  it("add calls add_calendar_source and refreshes the list", async () => {
    invokeMock
      .mockResolvedValueOnce([]) // initial list
      .mockResolvedValueOnce(FILE_SOURCE) // add
      .mockResolvedValueOnce([FILE_SOURCE]); // refresh
    const { useCalendars } = await import("./use-calendars");
    const { result } = renderHook(() => useCalendars());
    await waitFor(() => expect(result.current.loading).toBe(false));

    let returned: CalendarSource | null = null;
    await act(async () => {
      returned = await result.current.add({
        kind: "file",
        label: "Local",
        raw: "/tmp/cal.ics",
      });
    });
    expect(returned).toEqual(FILE_SOURCE);
    expect(invokeMock).toHaveBeenCalledWith("add_calendar_source", {
      input: { kind: "file", label: "Local", raw: "/tmp/cal.ics" },
    });
    await waitFor(() => expect(result.current.sources).toEqual([FILE_SOURCE]));
  });

  it("update calls update_calendar_source and refreshes the list", async () => {
    const updated = { ...URL_SOURCE, label: "Work (renamed)" };
    invokeMock
      .mockResolvedValueOnce([URL_SOURCE])
      .mockResolvedValueOnce(updated)
      .mockResolvedValueOnce([updated]);
    const { useCalendars } = await import("./use-calendars");
    const { result } = renderHook(() => useCalendars());
    await waitFor(() => expect(result.current.sources).toEqual([URL_SOURCE]));

    await act(async () => {
      await result.current.update({
        id: URL_SOURCE.id,
        label: "Work (renamed)",
      });
    });
    expect(invokeMock).toHaveBeenCalledWith("update_calendar_source", {
      input: { id: URL_SOURCE.id, label: "Work (renamed)" },
    });
    await waitFor(() => expect(result.current.sources[0].label).toBe("Work (renamed)"));
  });

  it("remove calls remove_calendar_source and refreshes the list", async () => {
    invokeMock
      .mockResolvedValueOnce([URL_SOURCE])
      .mockResolvedValueOnce(null) // remove
      .mockResolvedValueOnce([]); // refresh
    const { useCalendars } = await import("./use-calendars");
    const { result } = renderHook(() => useCalendars());
    await waitFor(() => expect(result.current.sources).toEqual([URL_SOURCE]));

    await act(async () => {
      await result.current.remove(URL_SOURCE.id);
    });
    expect(invokeMock).toHaveBeenCalledWith("remove_calendar_source", {
      id: URL_SOURCE.id,
    });
    await waitFor(() => expect(result.current.sources).toEqual([]));
  });

  it("resync calls refresh_calendar_source and refreshes the list", async () => {
    const synced: CalendarSource = {
      ...URL_SOURCE,
      lastSyncedAt: "2026-05-23T10:00:00Z",
    };
    invokeMock
      .mockResolvedValueOnce([URL_SOURCE])
      .mockResolvedValueOnce(synced)
      .mockResolvedValueOnce([synced]);
    const { useCalendars } = await import("./use-calendars");
    const { result } = renderHook(() => useCalendars());
    await waitFor(() => expect(result.current.sources).toEqual([URL_SOURCE]));

    let returned: CalendarSource | null = null;
    await act(async () => {
      returned = await result.current.resync(URL_SOURCE.id);
    });
    expect(returned).toEqual(synced);
    expect(invokeMock).toHaveBeenCalledWith("refresh_calendar_source", {
      id: URL_SOURCE.id,
    });
    await waitFor(() => expect(result.current.sources[0].lastSyncedAt).toBe(
      "2026-05-23T10:00:00Z",
    ));
  });

  it("refresh clears a stale error after the next successful list", async () => {
    invokeMock
      .mockRejectedValueOnce(new Error("temporary glitch"))
      .mockResolvedValueOnce([URL_SOURCE]);
    const { useCalendars } = await import("./use-calendars");
    const { result } = renderHook(() => useCalendars());
    await waitFor(() => expect(result.current.error).toContain("temporary glitch"));
    await act(async () => {
      await result.current.refresh();
    });
    expect(result.current.error).toBeNull();
    expect(result.current.sources).toEqual([URL_SOURCE]);
  });
});

describe("guessCalendarKind", () => {
  it("treats common URL schemes as url sources", async () => {
    const { guessCalendarKind } = await import("./use-calendars");
    for (const raw of [
      "https://cal.example/x.ics",
      "http://cal.example/x.ics",
      "webcal://cal.example/x.ics",
      "webcals://cal.example/x.ics",
      "  HTTPS://CAL.EXAMPLE/X.ICS  ",
    ]) {
      expect(guessCalendarKind(raw)).toBe("url");
    }
  });

  it("treats absolute paths and bare strings as file sources", async () => {
    const { guessCalendarKind } = await import("./use-calendars");
    for (const raw of ["/Users/me/cal.ics", "C:/cal.ics", "cal.ics"]) {
      expect(guessCalendarKind(raw)).toBe("file");
    }
  });
});
