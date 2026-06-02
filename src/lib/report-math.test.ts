import { describe, it, expect } from "vitest";
import {
  buildStackedDays,
  computeDelta,
  dayMonthLabel,
  deltaComparisonLabel,
  formatRangeLabel,
  isFuture,
  isoLocalDate,
  isToday,
  percentOf,
  rangeTitle,
  secondsToHours,
  weekdayLabel,
} from "./report-math";
import type { ReportSummary } from "./ipc";

const summaryStub = (
  overrides: Partial<ReportSummary> = {},
): ReportSummary => ({
  totalSeconds: 0,
  prevTotalSeconds: 0,
  byDay: [],
  byProject: [],
  bySource: { rule: 0, calendar: 0, manual: 0 },
  ...overrides,
});

describe("secondsToHours", () => {
  it("converts seconds into fractional hours", () => {
    expect(secondsToHours(3600)).toBe(1);
    expect(secondsToHours(1800)).toBe(0.5);
    expect(secondsToHours(0)).toBe(0);
  });
});

describe("percentOf", () => {
  it("returns 0 when total is non-positive", () => {
    expect(percentOf(10, 0)).toBe(0);
    expect(percentOf(10, -3)).toBe(0);
  });
  it("computes a clamped percentage", () => {
    expect(percentOf(50, 100)).toBe(50);
    expect(percentOf(150, 100)).toBe(100);
    expect(percentOf(-10, 100)).toBe(0);
  });
});

describe("computeDelta", () => {
  it("returns none when both totals are zero", () => {
    expect(computeDelta(0, 0)).toEqual({ kind: "none" });
  });
  it("returns up=100% when previous is zero but current is positive", () => {
    expect(computeDelta(3600, 0)).toEqual({
      kind: "up",
      deltaSeconds: 3600,
      percent: 100,
    });
  });
  it("returns up with the right percent when current > previous", () => {
    const d = computeDelta(2000, 1000);
    expect(d.kind).toBe("up");
    if (d.kind === "up") {
      expect(d.deltaSeconds).toBe(1000);
      expect(d.percent).toBe(100);
    }
  });
  it("returns down when current < previous", () => {
    const d = computeDelta(500, 1000);
    expect(d.kind).toBe("down");
    if (d.kind === "down") {
      expect(d.deltaSeconds).toBe(-500);
      expect(d.percent).toBe(-50);
    }
  });
  it("returns flat when current equals previous", () => {
    expect(computeDelta(1000, 1000)).toEqual({
      kind: "flat",
      deltaSeconds: 0,
      percent: 0,
    });
  });
});

describe("isoLocalDate", () => {
  it("formats year/month/day with zero padding", () => {
    expect(isoLocalDate(new Date(2026, 0, 7))).toBe("2026-01-07");
    expect(isoLocalDate(new Date(2026, 11, 31))).toBe("2026-12-31");
  });
});

describe("isToday / isFuture", () => {
  it("recognises today", () => {
    const now = new Date(2026, 4, 23);
    expect(isToday("2026-05-23", now)).toBe(true);
    expect(isToday("2026-05-22", now)).toBe(false);
  });
  it("recognises future dates", () => {
    const now = new Date(2026, 4, 23);
    expect(isFuture("2026-05-24", now)).toBe(true);
    expect(isFuture("2026-05-22", now)).toBe(false);
  });
});

describe("rangeTitle / deltaComparisonLabel", () => {
  it("uses the day / week / month labels", () => {
    expect(rangeTitle("day")).toBe("Today");
    expect(rangeTitle("week")).toBe("This week");
    expect(rangeTitle("month")).toBe("This month");
    expect(deltaComparisonLabel("day")).toMatch(/yesterday/);
    expect(deltaComparisonLabel("week")).toMatch(/last week/);
    expect(deltaComparisonLabel("month")).toMatch(/last month/);
  });
});

describe("weekdayLabel / dayMonthLabel / formatRangeLabel", () => {
  it("derives weekday names from ISO dates", () => {
    expect(weekdayLabel("2026-05-18")).toBe("Mon");
    expect(weekdayLabel("2026-05-24")).toBe("Sun");
  });
  it("returns an empty string for malformed input", () => {
    expect(weekdayLabel("not-a-date")).toBe("");
    expect(dayMonthLabel("not-a-date")).toBe("");
  });
  it("formats day/month labels", () => {
    expect(dayMonthLabel("2026-05-18")).toBe("May 18");
    expect(dayMonthLabel("2026-12-31")).toBe("Dec 31");
  });
  it("formats a range label", () => {
    const s = summaryStub({
      byDay: [
        { date: "2026-05-18", byProject: [] },
        { date: "2026-05-24", byProject: [] },
      ],
    });
    expect(formatRangeLabel(s)).toBe("May 18 — May 24, 2026");
  });
  it("collapses single-day ranges", () => {
    const s = summaryStub({
      byDay: [{ date: "2026-05-18", byProject: [] }],
    });
    expect(formatRangeLabel(s)).toBe("May 18, 2026");
  });
  it("returns empty when byDay is empty", () => {
    expect(formatRangeLabel(summaryStub())).toBe("");
  });
});

describe("buildStackedDays", () => {
  it("totals segments per day and flags today + future", () => {
    const now = new Date(2026, 4, 21); // Thu May 21 2026
    const s = summaryStub({
      byDay: [
        {
          date: "2026-05-21",
          byProject: [
            { projectId: "cairn", seconds: 3600 },
            { projectId: "acme", seconds: 1800 },
          ],
        },
        { date: "2026-05-22", byProject: [] },
      ],
    });
    const days = buildStackedDays(s, now);
    expect(days).toHaveLength(2);
    expect(days[0]!.totalSeconds).toBe(5400);
    expect(days[0]!.isToday).toBe(true);
    expect(days[0]!.isFuture).toBe(false);
    expect(days[1]!.isFuture).toBe(true);
    expect(days[0]!.weekday).toBe("Thu");
  });
});
