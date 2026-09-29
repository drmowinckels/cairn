import { describe, expect, it } from "vitest";
import {
  coerceFormatPrefs,
  DATETIME_FORMAT_DEFAULT,
  formatClockParts,
  formatDayLabel,
  formatNumericDate,
  isoDate,
  resolveDateOrder,
  resolveHour12,
  type DateTimeFormatPrefs,
} from "./datetime-format";

const prefs = (p: Partial<DateTimeFormatPrefs> = {}): DateTimeFormatPrefs => ({
  ...DATETIME_FORMAT_DEFAULT,
  ...p,
});

describe("resolveHour12", () => {
  it("honours an explicit choice regardless of locale", () => {
    // The whole point of the setting: a Norwegian user who wants a 12-hour
    // clock gets one, and an American who wants 24-hour gets that.
    expect(resolveHour12(prefs({ time: "12h" }), "nb-NO")).toBe(true);
    expect(resolveHour12(prefs({ time: "24h" }), "en-US")).toBe(false);
  });

  it("follows the locale's own convention under `system`", () => {
    expect(resolveHour12(prefs({ time: "system" }), "en-US")).toBe(true);
    expect(resolveHour12(prefs({ time: "system" }), "nb-NO")).toBe(false);
    expect(resolveHour12(prefs({ time: "system" }), "de-DE")).toBe(false);
  });

  it("falls back to 24-hour on a locale Intl rejects", () => {
    // Cairn's pre-#308 behaviour, so a bad stored locale degrades to what the
    // app always used to render rather than throwing during a render pass.
    expect(resolveHour12(prefs({ time: "system" }), "not a locale")).toBe(
      false,
    );
  });
});

describe("formatClockParts", () => {
  it("zero-pads a 24-hour clock with a colon in every locale", () => {
    // Some locales write 24-hour time as "14.05"; Cairn's timeline axis and
    // design mockups are all "14:05", so the separator is deliberately not
    // locale-dependent.
    expect(formatClockParts(0, 0, prefs({ time: "24h" }), "en-US")).toBe(
      "00:00",
    );
    expect(formatClockParts(9, 5, prefs({ time: "24h" }), "nb-NO")).toBe(
      "09:05",
    );
    expect(formatClockParts(14, 5, prefs({ time: "24h" }), "de-DE")).toBe(
      "14:05",
    );
  });

  it("renders a 12-hour clock with a day-period marker", () => {
    const midnight = formatClockParts(0, 0, prefs({ time: "12h" }), "en-US");
    expect(midnight).toMatch(/^12:00/);
    expect(midnight).toMatch(/AM/i);

    const afternoon = formatClockParts(13, 5, prefs({ time: "12h" }), "en-US");
    expect(afternoon).toMatch(/^1:05/);
    expect(afternoon).toMatch(/PM/i);
  });

  it("distinguishes 1am from 1pm", () => {
    const am = formatClockParts(1, 30, prefs({ time: "12h" }), "en-US");
    const pm = formatClockParts(13, 30, prefs({ time: "12h" }), "en-US");
    expect(am).not.toBe(pm);
  });

  it("falls back to padded 24-hour when Intl rejects the locale", () => {
    expect(
      formatClockParts(13, 5, prefs({ time: "12h" }), "not a locale"),
    ).toBe("13:05");
  });
});

describe("formatNumericDate", () => {
  const date = new Date(2026, 11, 25);

  it("orders the fields as chosen", () => {
    expect(formatNumericDate(date, prefs({ date: "dmy" }), "en-US")).toBe(
      "25/12/2026",
    );
    expect(formatNumericDate(date, prefs({ date: "mdy" }), "en-US")).toBe(
      "12/25/2026",
    );
    expect(formatNumericDate(date, prefs({ date: "ymd" }), "en-US")).toBe(
      "2026-12-25",
    );
  });

  it("follows the locale under `system`", () => {
    // en-US is month-first, so the 25 must land second — that is exactly the
    // ordering #308 was filed about.
    const us = formatNumericDate(date, prefs({ date: "system" }), "en-US");
    expect(us.indexOf("12")).toBeLessThan(us.indexOf("25"));
  });

  it("degrades to an em dash on an invalid date", () => {
    expect(
      formatNumericDate(new Date("nope"), prefs({ date: "dmy" }), "en-US"),
    ).toBe("—");
  });
});

describe("resolveDateOrder", () => {
  it("returns the chosen order verbatim", () => {
    expect(resolveDateOrder(prefs({ date: "ymd" }), "en-US")).toEqual([
      "year",
      "month",
      "day",
    ]);
    expect(resolveDateOrder(prefs({ date: "mdy" }), "nb-NO")).toEqual([
      "month",
      "day",
      "year",
    ]);
  });

  it("derives the locale's order under `system`", () => {
    expect(resolveDateOrder(prefs({ date: "system" }), "en-US")).toEqual([
      "month",
      "day",
      "year",
    ]);
    expect(resolveDateOrder(prefs({ date: "system" }), "nb-NO")).toEqual([
      "day",
      "month",
      "year",
    ]);
  });

  it("always yields all three fields, even for a bad locale", () => {
    // A short list would render a date input missing a segment.
    expect(resolveDateOrder(prefs({ date: "system" }), "not a locale")).toEqual(
      ["day", "month", "year"],
    );
  });
});

describe("formatDayLabel", () => {
  const date = new Date(2026, 11, 25);

  it("puts the day before the month under dmy and after it under mdy", () => {
    const dmy = formatDayLabel(date, prefs({ date: "dmy" }), "en-US");
    const mdy = formatDayLabel(date, prefs({ date: "mdy" }), "en-US");
    expect(dmy).toContain("25 Dec");
    expect(mdy).toContain("Dec 25");
  });

  it("uses the full ISO date under ymd", () => {
    expect(formatDayLabel(date, prefs({ date: "ymd" }), "en-US")).toContain(
      "2026-12-25",
    );
  });

  it("keeps a localized weekday prefix", () => {
    // 2026-12-25 is a Friday.
    expect(formatDayLabel(date, prefs({ date: "dmy" }), "en-US")).toMatch(
      /^Fri/,
    );
  });

  it("degrades to an em dash on an invalid date", () => {
    expect(formatDayLabel(new Date("nope"), prefs(), "en-US")).toBe("—");
  });
});

describe("coerceFormatPrefs", () => {
  it("accepts a valid stored preference", () => {
    expect(coerceFormatPrefs({ time: "12h", date: "ymd" })).toEqual({
      time: "12h",
      date: "ymd",
    });
  });

  it("falls back per field on junk, rather than discarding the whole blob", () => {
    expect(coerceFormatPrefs({ time: "banana", date: "ymd" })).toEqual({
      time: "system",
      date: "ymd",
    });
  });

  it("survives null, undefined and non-objects", () => {
    for (const junk of [null, undefined, 42, "nope", []]) {
      expect(coerceFormatPrefs(junk)).toEqual(DATETIME_FORMAT_DEFAULT);
    }
  });
});

describe("isoDate", () => {
  it("renders local-time YYYY-MM-DD, not UTC", () => {
    // A late-evening local time must not roll over to the next UTC day.
    expect(isoDate(new Date(2026, 0, 5, 23, 30))).toBe("2026-01-05");
  });

  it("pads single-digit months and days", () => {
    expect(isoDate(new Date(2026, 2, 3))).toBe("2026-03-03");
  });
});
