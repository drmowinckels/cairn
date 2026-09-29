import { afterEach, describe, expect, it } from "vitest";
import {
  coerceFormatPrefs,
  DATETIME_FORMAT_DEFAULT,
  formatClockParts,
  formatDayLabel,
  formatNumericDate,
  isoDate,
  clockPlaceholder,
  datePlaceholder,
  parseClock,
  parseNumericDate,
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

describe("parseClock", () => {
  const h24 = prefs({ time: "24h" });
  const h12 = prefs({ time: "12h" });

  it("accepts the shapes people actually type", () => {
    for (const text of ["14:05", "14.05", "1405", "14 05", " 14:05 "]) {
      expect(parseClock(text, h24, "en-US")).toBe(14 * 60 + 5);
    }
  });

  it("accepts a leading-zero and a bare hour", () => {
    expect(parseClock("09:05", h24, "en-US")).toBe(9 * 60 + 5);
    expect(parseClock("905", h24, "en-US")).toBe(9 * 60 + 5);
    expect(parseClock("9", h24, "en-US")).toBe(9 * 60);
  });

  it("reads a day-period marker in any of its written forms", () => {
    for (const text of ["9:05 pm", "9:05PM", "9:05 p.m.", "9.05 pm"]) {
      expect(parseClock(text, h12, "en-US")).toBe(21 * 60 + 5);
    }
  });

  it("maps 12 AM to midnight and 12 PM to noon", () => {
    expect(parseClock("12:00 am", h12, "en-US")).toBe(0);
    expect(parseClock("12:00 pm", h12, "en-US")).toBe(12 * 60);
  });

  it("lets a typed marker override a 24-hour preference", () => {
    // Someone typing "pm" means the afternoon whatever the field is set to.
    expect(parseClock("9:05 pm", h24, "en-US")).toBe(21 * 60 + 5);
  });

  it("rejects impossible times instead of clamping them", () => {
    // Silently turning a typo into a different valid time is worse than
    // saying so — the user would file hours against a time they never chose.
    for (const text of ["25:00", "10:75", "13:00 pm", "0:30 am"]) {
      expect(parseClock(text, h24, "en-US")).toBeNull();
    }
  });

  it("rejects empty and non-numeric input", () => {
    for (const text of ["", "   ", "lunch", "--:--"]) {
      expect(parseClock(text, h24, "en-US")).toBeNull();
    }
  });

  it("round-trips whatever formatClockParts renders", () => {
    for (const p of [h12, h24]) {
      for (const [h, m] of [
        [0, 0],
        [9, 5],
        [12, 0],
        [13, 30],
        [23, 59],
      ] as const) {
        const rendered = formatClockParts(h, m, p, "en-US");
        expect(parseClock(rendered, p, "en-US")).toBe(h * 60 + m);
      }
    }
  });
});

describe("parseNumericDate", () => {
  it("respects the field order — the whole point of the setting", () => {
    // 03/04/2026 is 3 April to a D/M/Y user and 4 March to an M/D/Y one.
    const dmy = parseNumericDate(
      "03/04/2026",
      prefs({ date: "dmy" }),
      "en-US",
    )!;
    expect([dmy.getDate(), dmy.getMonth() + 1]).toEqual([3, 4]);

    const mdy = parseNumericDate(
      "03/04/2026",
      prefs({ date: "mdy" }),
      "en-US",
    )!;
    expect([mdy.getDate(), mdy.getMonth() + 1]).toEqual([4, 3]);
  });

  it("accepts any common separator", () => {
    for (const text of ["25/12/2026", "25-12-2026", "25.12.2026"]) {
      const d = parseNumericDate(text, prefs({ date: "dmy" }), "en-US")!;
      expect(isoDate(d)).toBe("2026-12-25");
    }
  });

  it("reads a 4-digit group as the year wherever it lands", () => {
    // Typing an ISO date into a D/M/Y field still means what it says.
    const d = parseNumericDate("2026-03-04", prefs({ date: "dmy" }), "en-US")!;
    expect(isoDate(d)).toBe("2026-03-04");
  });

  it("reads a two-digit year as this century", () => {
    const d = parseNumericDate("25/12/26", prefs({ date: "dmy" }), "en-US")!;
    expect(d.getFullYear()).toBe(2026);
  });

  it("rejects a date that doesn't exist rather than rolling it over", () => {
    // `new Date(2026, 1, 31)` would silently become 3 March — time logged
    // against a day the user never picked.
    expect(
      parseNumericDate("31/02/2026", prefs({ date: "dmy" }), "en-US"),
    ).toBeNull();
    expect(
      parseNumericDate("32/01/2026", prefs({ date: "dmy" }), "en-US"),
    ).toBeNull();
    // Month-first, so a 13 in the month slot is the impossible one.
    expect(
      parseNumericDate("13/01/2026", prefs({ date: "mdy" }), "en-US"),
    ).toBeNull();
    // …while the same digits under M/D/Y are simply 13 January.
    expect(
      isoDate(parseNumericDate("01/13/2026", prefs({ date: "mdy" }), "en-US")!),
    ).toBe("2026-01-13");
  });

  it("accepts a real leap day and rejects a fake one", () => {
    expect(
      parseNumericDate("29/02/2028", prefs({ date: "dmy" }), "en-US"),
    ).not.toBeNull();
    expect(
      parseNumericDate("29/02/2026", prefs({ date: "dmy" }), "en-US"),
    ).toBeNull();
  });

  it("rejects input that isn't three numbers", () => {
    for (const text of ["", "25/12", "25/12/2026/11", "tomorrow"]) {
      expect(
        parseNumericDate(text, prefs({ date: "dmy" }), "en-US"),
      ).toBeNull();
    }
  });

  it("round-trips whatever formatNumericDate renders", () => {
    for (const d of ["dmy", "mdy", "ymd", "system"] as const) {
      const p = prefs({ date: d });
      const date = new Date(2026, 11, 25);
      const parsed = parseNumericDate(
        formatNumericDate(date, p, "en-US"),
        p,
        "en-US",
      );
      expect(parsed && isoDate(parsed)).toBe("2026-12-25");
    }
  });
});

describe("placeholders", () => {
  it("describe the clock the field expects", () => {
    expect(clockPlaceholder(prefs({ time: "24h" }), "en-US")).toBe("hh:mm");
    expect(clockPlaceholder(prefs({ time: "12h" }), "en-US")).toMatch(
      /h:mm\s*PM/i,
    );
  });

  it("describe the date order the field expects", () => {
    expect(datePlaceholder(prefs({ date: "dmy" }), "en-US")).toBe("dd/mm/yyyy");
    expect(datePlaceholder(prefs({ date: "mdy" }), "en-US")).toBe("mm/dd/yyyy");
    expect(datePlaceholder(prefs({ date: "ymd" }), "en-US")).toBe("yyyy-mm-dd");
  });
});

describe("parseNumericDate — a typed 4-digit year", () => {
  it("is read as ISO under every field order", () => {
    // A leading 4-digit group means the user typed an ISO date, which is
    // year-month-day. Reading it as year-day-month (by naively swapping the
    // year into place) turned 2026-09-29 into month 29 under M/D/Y.
    for (const d of ["dmy", "mdy", "ymd"] as const) {
      const parsed = parseNumericDate(
        "2026-09-29",
        prefs({ date: d }),
        "en-US",
      );
      expect(isoDate(parsed!)).toBe("2026-09-29");
    }
  });

  it("keeps the configured order when the year is last", () => {
    expect(
      isoDate(parseNumericDate("03/04/2026", prefs({ date: "dmy" }), "en-US")!),
    ).toBe("2026-04-03");
    expect(
      isoDate(parseNumericDate("03/04/2026", prefs({ date: "mdy" }), "en-US")!),
    ).toBe("2026-03-04");
  });

  it("rejects a year in the middle, which matches no convention", () => {
    expect(
      parseNumericDate("03/2026/04", prefs({ date: "dmy" }), "en-US"),
    ).toBeNull();
  });
});

describe("degrading when Intl misbehaves", () => {
  // These guards exist because `Intl` is the one dependency of this module
  // and a throw from it lands mid-render. Reaching them needs `Intl` itself
  // stubbed — that is the condition they were written for.
  const RealDTF = Intl.DateTimeFormat;

  afterEach(() => {
    Intl.DateTimeFormat = RealDTF;
  });

  function stubDTF(impl: Partial<Intl.DateTimeFormat>): void {
    Intl.DateTimeFormat = function () {
      return impl as Intl.DateTimeFormat;
    } as unknown as typeof Intl.DateTimeFormat;
  }

  function throwingDTF(): void {
    Intl.DateTimeFormat = function () {
      throw new RangeError("no");
    } as unknown as typeof Intl.DateTimeFormat;
  }

  it("falls back to hourCycle when the engine omits hour12", () => {
    stubDTF({
      resolvedOptions: () =>
        ({ hourCycle: "h12" }) as unknown as Intl.ResolvedDateTimeFormatOptions,
    });
    expect(resolveHour12(prefs({ time: "system" }), "en-US")).toBe(true);

    stubDTF({
      resolvedOptions: () =>
        ({ hourCycle: "h23" }) as unknown as Intl.ResolvedDateTimeFormatOptions,
    });
    expect(resolveHour12(prefs({ time: "system" }), "en-US")).toBe(false);
  });

  it("falls back to the ISO date when a system-format date throws", () => {
    throwingDTF();
    expect(
      formatNumericDate(new Date(2026, 11, 25), prefs({ date: "system" }), "x"),
    ).toBe("2026-12-25");
  });

  it("still produces a day label when every name lookup throws", () => {
    throwingDTF();
    // No weekday or month name available, but the date itself must survive.
    expect(
      formatDayLabel(new Date(2026, 11, 25), prefs({ date: "ymd" }), "x"),
    ).toBe("2026-12-25");
    expect(
      formatDayLabel(new Date(2026, 11, 25), prefs({ date: "dmy" }), "x"),
    ).toBe("25 ");
  });

  it("falls back to a bare day label when the system format yields nothing", () => {
    // `format` returning "" (rather than throwing) must not render an empty
    // heading where the date should be.
    stubDTF({ format: () => "" });
    expect(
      formatDayLabel(new Date(2026, 11, 25), prefs({ date: "system" }), "x"),
    ).toBe("25 ");
  });

  it("still offers a PM placeholder when the marker lookup throws", () => {
    throwingDTF();
    // `resolveHour12` also falls back to 24h here, so ask for 12h explicitly.
    expect(clockPlaceholder(prefs({ time: "12h" }), "x")).toBe("h:mm PM");
  });

  it("still parses am/pm when the marker lookup throws", () => {
    throwingDTF();
    expect(parseClock("9:05 pm", prefs({ time: "12h" }), "x")).toBe(
      21 * 60 + 5,
    );
  });
});

describe("parseClock rejects what can't be a time", () => {
  it("rejects a bare hour above 23", () => {
    expect(parseClock("24", prefs({ time: "24h" }), "en-US")).toBeNull();
    expect(parseClock("99", prefs({ time: "24h" }), "en-US")).toBeNull();
  });

  it("rejects 24:00 under a 12-hour preference", () => {
    // A 12-hour clock has no 24 o'clock.
    expect(parseClock("24:00", prefs({ time: "12h" }), "en-US")).toBeNull();
  });

  it("rejects digit runs that are too long to be a time", () => {
    expect(parseClock("123456", prefs({ time: "24h" }), "en-US")).toBeNull();
  });
});

describe("remaining format paths", () => {
  it("uses the locale's own short date style under `system`", () => {
    // The happy path for the `system` day label: a real locale gives a
    // complete short form and it's used verbatim.
    const label = formatDayLabel(
      new Date(2026, 11, 25),
      prefs({ date: "system" }),
      "en-US",
    );
    expect(label).toMatch(/Fri/);
    expect(label).toMatch(/Dec/);
    expect(label).toMatch(/25/);
  });

  it("copes with a locale that reports no day-period part", () => {
    const real = Intl.DateTimeFormat;
    Intl.DateTimeFormat = function () {
      return {
        // A 12-hour format with no dayPeriod part at all.
        formatToParts: () => [{ type: "hour", value: "9" }],
        format: () => "9",
        resolvedOptions: () => ({ hour12: true }),
      } as unknown as Intl.DateTimeFormat;
    } as unknown as typeof Intl.DateTimeFormat;
    try {
      expect(clockPlaceholder(prefs({ time: "12h" }), "en-US")).toBe("h:mm PM");
    } finally {
      Intl.DateTimeFormat = real;
    }
  });
});
