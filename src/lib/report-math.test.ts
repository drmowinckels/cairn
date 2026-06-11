import { describe, it, expect } from "vitest";
import {
  averageUnitLabel,
  bucketGranularity,
  buildBuckets,
  chartAxis,
  computeDelta,
  dayMonthLabel,
  deltaComparisonLabel,
  formatRangeLabel,
  isFuture,
  isoLocalDate,
  isToday,
  mondayOfIso,
  percentOf,
  rangeTitle,
  reportDigest,
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

describe("chartAxis", () => {
  it("anchors at 8h so a light week shows the spec'd 0/2/4/6/8 gridlines", () => {
    const axis = chartAxis(0);
    expect(axis.maxSeconds).toBe(8 * 3600);
    expect(axis.ticks).toEqual([0, 2, 4, 6, 8]);
  });

  it("keeps the 8h ceiling when the busiest day is under 8h", () => {
    const axis = chartAxis(5 * 3600);
    expect(axis.maxSeconds).toBe(8 * 3600);
    expect(axis.ticks).toEqual([0, 2, 4, 6, 8]);
  });

  it("rounds the ceiling up to the next even hour so bars never overflow", () => {
    const axis = chartAxis(9.3 * 3600);
    expect(axis.maxSeconds).toBe(10 * 3600);
    expect(axis.ticks).toEqual([0, 2, 4, 6, 8, 10]);
  });

  it("treats an exact even-hour max as its own ceiling", () => {
    const axis = chartAxis(12 * 3600);
    expect(axis.maxSeconds).toBe(12 * 3600);
    expect(axis.ticks).toEqual([0, 2, 4, 6, 8, 10, 12]);
  });

  it("treats negative or non-finite input as zero", () => {
    expect(chartAxis(-100).maxSeconds).toBe(8 * 3600);
    expect(chartAxis(Number.NaN).ticks).toEqual([0, 2, 4, 6, 8]);
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
  it("uses week / month / quarter / year labels", () => {
    expect(rangeTitle("week")).toBe("This week");
    expect(rangeTitle("month")).toBe("This month");
    expect(rangeTitle("quarter")).toBe("This quarter");
    expect(rangeTitle("year")).toBe("This year");
    expect(deltaComparisonLabel("week")).toMatch(/last week/);
    expect(deltaComparisonLabel("month")).toMatch(/last month/);
    expect(deltaComparisonLabel("quarter")).toMatch(/last quarter/);
    expect(deltaComparisonLabel("year")).toMatch(/last year/);
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
  it("shows both years when the range straddles a year boundary", () => {
    const s = summaryStub({
      byDay: [
        { date: "2025-12-28", byProject: [] },
        { date: "2026-01-03", byProject: [] },
      ],
    });
    expect(formatRangeLabel(s)).toBe("Dec 28, 2025 — Jan 3, 2026");
  });
  it("returns empty when byDay is empty", () => {
    expect(formatRangeLabel(summaryStub())).toBe("");
  });
});

describe("bucketGranularity / averageUnitLabel / mondayOfIso", () => {
  it("maps each range to its bucket granularity", () => {
    expect(bucketGranularity("week")).toBe("day");
    expect(bucketGranularity("month")).toBe("week");
    expect(bucketGranularity("quarter")).toBe("month");
    expect(bucketGranularity("year")).toBe("month");
  });
  it("labels the average unit", () => {
    expect(averageUnitLabel("day")).toBe("/day");
    expect(averageUnitLabel("week")).toBe("/wk");
    expect(averageUnitLabel("month")).toBe("/mo");
  });
  it("finds the Monday of a week", () => {
    expect(mondayOfIso("2026-05-21")).toBe("2026-05-18"); // Thu → Mon
    expect(mondayOfIso("2026-05-18")).toBe("2026-05-18"); // Mon → itself
    expect(mondayOfIso("2026-05-24")).toBe("2026-05-18"); // Sun → that Mon
    expect(mondayOfIso("not-a-date")).toBe("not-a-date");
  });
});

describe("buildBuckets", () => {
  it("for a week keeps one daily bucket each, flagging current + future", () => {
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
    const b = buildBuckets(s, "week", now);
    expect(b).toHaveLength(2);
    expect(b[0]!.label).toBe("Thu");
    expect(b[0]!.totalSeconds).toBe(5400);
    // segments sorted largest-first
    expect(b[0]!.segments[0]!.projectId).toBe("cairn");
    expect(b[0]!.isCurrent).toBe(true);
    expect(b[0]!.isFuture).toBe(false);
    expect(b[1]!.isFuture).toBe(true);
  });

  it("for a month rolls days up into weekly buckets, summing per project", () => {
    const now = new Date(2026, 5, 30);
    const s = summaryStub({
      byDay: [
        { date: "2026-06-01", byProject: [{ projectId: "a", seconds: 100 }] }, // Mon wk1
        { date: "2026-06-03", byProject: [{ projectId: "a", seconds: 200 }] }, // Wed wk1
        { date: "2026-06-08", byProject: [{ projectId: "a", seconds: 50 }] }, // Mon wk2
      ],
    });
    const b = buildBuckets(s, "month", now);
    expect(b).toHaveLength(2);
    expect(b[0]!.key).toBe("2026-06-01");
    expect(b[0]!.totalSeconds).toBe(300);
    expect(b[1]!.key).toBe("2026-06-08");
    expect(b[1]!.totalSeconds).toBe(50);
  });

  it("for a quarter/year rolls days up into monthly buckets", () => {
    const now = new Date(2026, 2, 31);
    const s = summaryStub({
      byDay: [
        { date: "2026-01-10", byProject: [{ projectId: "a", seconds: 60 }] },
        { date: "2026-01-20", byProject: [{ projectId: "a", seconds: 40 }] },
        { date: "2026-02-05", byProject: [{ projectId: "a", seconds: 30 }] },
      ],
    });
    const b = buildBuckets(s, "quarter", now);
    expect(b.map((x) => x.label)).toEqual(["Jan", "Feb"]);
    expect(b[0]!.totalSeconds).toBe(100);
  });
});

describe("reportDigest", () => {
  const now = new Date(2026, 5, 10); // Wed Jun 10 2026
  const s = summaryStub({
    totalSeconds: 360,
    byProject: [
      { projectId: "a", seconds: 240 },
      { projectId: "b", seconds: 120 },
    ],
    byDay: [
      { date: "2026-06-08", byProject: [{ projectId: "a", seconds: 240 }] },
      { date: "2026-06-09", byProject: [{ projectId: "b", seconds: 120 }] },
      { date: "2026-06-10", byProject: [] },
      { date: "2026-06-11", byProject: [] }, // future
    ],
  });

  it("averages over elapsed buckets and names the busiest + top project", () => {
    const buckets = buildBuckets(s, "week", now);
    const d = reportDigest(s, buckets, "week", now);
    // 3 elapsed daily buckets (08, 09, 10); 11 is future
    expect(d.averageSeconds).toBe(120);
    expect(d.averageUnit).toBe("day");
    expect(d.busiest).toEqual({ label: "Mon", seconds: 240 });
    expect(d.topProject!.slice.projectId).toBe("a");
    expect(d.topProject!.percent).toBeCloseTo(66.67, 1);
    expect(d.daysTracked).toBe(2);
    expect(d.daysElapsed).toBe(3);
  });

  it("picks the largest project even when byProject isn't sorted by size", () => {
    // The backend groups byProject by project id, not by seconds, so the
    // digest must find the max itself rather than take index 0.
    const unsorted = summaryStub({
      totalSeconds: 360,
      byProject: [
        { projectId: "b", seconds: 120 },
        { projectId: "a", seconds: 240 },
      ],
    });
    const d = reportDigest(
      unsorted,
      buildBuckets(unsorted, "week", now),
      "week",
      now,
    );
    expect(d.topProject!.slice.projectId).toBe("a");
  });

  it("is empty-safe with no data", () => {
    const empty = summaryStub();
    const d = reportDigest(
      empty,
      buildBuckets(empty, "week", now),
      "week",
      now,
    );
    expect(d.averageSeconds).toBe(0);
    expect(d.busiest).toBeNull();
    expect(d.topProject).toBeNull();
  });
});
