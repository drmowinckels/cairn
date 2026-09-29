import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { DATETIME_FORMAT_DEFAULT } from "./datetime-format";
import {
  DATETIME_FORMAT_STORAGE_KEY,
  dateTimeFormatPrefs,
  resetDateTimeFormatPrefsForTest,
  setDateTimeFormatPrefs,
  syncDateTimeFormatPrefs,
  useDateTimeFormat,
  useDateTimeFormatSubscription,
} from "./use-datetime-format";

beforeEach(() => {
  localStorage.clear();
  resetDateTimeFormatPrefsForTest();
});

describe("useDateTimeFormat", () => {
  it("starts at the default (follow the OS)", () => {
    const { result } = renderHook(() => useDateTimeFormat());
    expect(result.current.prefs).toEqual(DATETIME_FORMAT_DEFAULT);
  });

  it("persists a time-format change", () => {
    const { result } = renderHook(() => useDateTimeFormat());
    act(() => result.current.setTimeFormat("12h"));

    expect(result.current.prefs.time).toBe("12h");
    expect(
      JSON.parse(localStorage.getItem(DATETIME_FORMAT_STORAGE_KEY)!),
    ).toEqual({ time: "12h", date: "system" });
  });

  it("persists a date-format change without clobbering the time format", () => {
    const { result } = renderHook(() => useDateTimeFormat());
    act(() => result.current.setTimeFormat("24h"));
    act(() => result.current.setDateFormat("ymd"));

    expect(result.current.prefs).toEqual({ time: "24h", date: "ymd" });
  });

  it("re-renders every subscriber, not just the one that changed it", () => {
    // The preference is read imperatively by `lib/time.ts`, so a component
    // that only subscribes still has to repaint when another one switches it.
    const a = renderHook(() => useDateTimeFormat());
    const b = renderHook(() => useDateTimeFormat());

    act(() => a.result.current.setTimeFormat("12h"));

    expect(b.result.current.prefs.time).toBe("12h");
  });

  it("exposes the change to non-React readers", () => {
    const { result } = renderHook(() => useDateTimeFormat());
    act(() => result.current.setDateFormat("mdy"));
    expect(dateTimeFormatPrefs().date).toBe("mdy");
  });
});

describe("useDateTimeFormatSubscription", () => {
  it("re-renders on a change without returning the preference", () => {
    let renders = 0;
    renderHook(() => {
      renders += 1;
      return useDateTimeFormatSubscription();
    });
    const before = renders;

    act(() => setDateTimeFormatPrefs({ time: "12h", date: "dmy" }));

    expect(renders).toBeGreaterThan(before);
  });
});

describe("stored preference", () => {
  it("is read back on load", () => {
    localStorage.setItem(
      DATETIME_FORMAT_STORAGE_KEY,
      JSON.stringify({ time: "12h", date: "ymd" }),
    );
    act(() => syncDateTimeFormatPrefs());
    expect(dateTimeFormatPrefs()).toEqual({ time: "12h", date: "ymd" });
  });

  it("degrades to the default on a corrupt blob rather than throwing", () => {
    localStorage.setItem(DATETIME_FORMAT_STORAGE_KEY, "{not json");
    act(() => syncDateTimeFormatPrefs());
    expect(dateTimeFormatPrefs()).toEqual(DATETIME_FORMAT_DEFAULT);
  });

  it("repairs a partially-invalid blob field by field", () => {
    localStorage.setItem(
      DATETIME_FORMAT_STORAGE_KEY,
      JSON.stringify({ time: "elevenses", date: "mdy" }),
    );
    act(() => syncDateTimeFormatPrefs());
    expect(dateTimeFormatPrefs()).toEqual({ time: "system", date: "mdy" });
  });
});

describe("cross-window sync", () => {
  it("picks up a change another webview wrote", () => {
    // Cairn runs the popover, idle, notify and about windows against one
    // origin. A change in Settings has to reach the idle prompt's clock.
    const { result } = renderHook(() => useDateTimeFormat());
    expect(result.current.prefs.time).toBe("system");

    localStorage.setItem(
      DATETIME_FORMAT_STORAGE_KEY,
      JSON.stringify({ time: "12h", date: "mdy" }),
    );
    act(() => {
      window.dispatchEvent(
        new StorageEvent("storage", { key: DATETIME_FORMAT_STORAGE_KEY }),
      );
    });

    expect(result.current.prefs).toEqual({ time: "12h", date: "mdy" });
  });

  it("responds to a whole-storage clear (key === null)", () => {
    setDateTimeFormatPrefs({ time: "12h", date: "ymd" });
    localStorage.clear();
    act(() => {
      window.dispatchEvent(new StorageEvent("storage", { key: null }));
    });
    expect(dateTimeFormatPrefs()).toEqual(DATETIME_FORMAT_DEFAULT);
  });

  it("ignores an unrelated key", () => {
    setDateTimeFormatPrefs({ time: "12h", date: "ymd" });
    localStorage.setItem("cairn:something-else", "x");
    act(() => {
      window.dispatchEvent(
        new StorageEvent("storage", { key: "cairn:something-else" }),
      );
    });
    expect(dateTimeFormatPrefs()).toEqual({ time: "12h", date: "ymd" });
  });
});
