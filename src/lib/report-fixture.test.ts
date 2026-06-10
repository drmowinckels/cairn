import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("fixtureReportSummary", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.resetModules();
  });

  it("returns a week-shaped summary with sorted projects and a source split that sums to total", async () => {
    const { fixtureReportSummary } = await import("./report-fixture");
    const summary = fixtureReportSummary("week");
    expect(summary.byDay).toHaveLength(7);
    expect(summary.byProject.length).toBeGreaterThan(0);
    const sorted = [...summary.byProject].sort((a, b) => b.seconds - a.seconds);
    expect(summary.byProject).toEqual(sorted);
    expect(
      summary.bySource.rule +
        summary.bySource.calendar +
        summary.bySource.manual,
    ).toBe(summary.totalSeconds);
    expect(summary.prevTotalSeconds).toBe(
      Math.round(summary.totalSeconds * 0.85),
    );
  });

  it("quarter range fans out to one bucket per day across the quarter", async () => {
    const { fixtureReportSummary } = await import("./report-fixture");
    const q = fixtureReportSummary("quarter");
    const today = new Date();
    const qStartMonth = Math.floor(today.getMonth() / 3) * 3;
    const start = new Date(today.getFullYear(), qStartMonth, 1);
    const end = new Date(today.getFullYear(), qStartMonth + 3, 1);
    const days = Math.round(
      (end.getTime() - start.getTime()) / (24 * 3600 * 1000),
    );
    expect(q.byDay).toHaveLength(days);
    expect(q.byDay[0]!.date).toBe(
      `${start.getFullYear()}-${String(qStartMonth + 1).padStart(2, "0")}-01`,
    );
    expect(q.prevTotalSeconds).toBe(Math.round(q.totalSeconds * 0.95));
  });

  it("year range fans out to every day of the calendar year", async () => {
    const { fixtureReportSummary } = await import("./report-fixture");
    const y = fixtureReportSummary("year");
    const year = new Date().getFullYear();
    const isLeap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
    expect(y.byDay).toHaveLength(isLeap ? 366 : 365);
    expect(y.byDay[0]!.date).toBe(`${year}-01-01`);
    expect(y.prevTotalSeconds).toBe(Math.round(y.totalSeconds * 0.97));
  });

  it("month range fans out to one bucket per day in the current month", async () => {
    const { fixtureReportSummary } = await import("./report-fixture");
    const month = fixtureReportSummary("month");
    const today = new Date();
    const first = new Date(today.getFullYear(), today.getMonth(), 1);
    const nextFirst = new Date(today.getFullYear(), today.getMonth() + 1, 1);
    const daysInMonth = Math.round(
      (nextFirst.getTime() - first.getTime()) / (24 * 3600 * 1000),
    );
    expect(month.byDay).toHaveLength(daysInMonth);
    expect(month.prevTotalSeconds).toBe(Math.round(month.totalSeconds * 0.9));
  });

  it("treats Sunday as the wrap-around case when computing mondayOf", async () => {
    const sunday = new Date(2026, 4, 24, 12, 0, 0);
    vi.useFakeTimers();
    vi.setSystemTime(sunday);
    const { fixtureReportSummary } = await import("./report-fixture");
    const summary = fixtureReportSummary("week");
    expect(summary.byDay[0]!.date).toBe("2026-05-18");
    expect(summary.byDay[6]!.date).toBe("2026-05-24");
  });
});

describe("fixtureReportSummary with null / empty projectIds", () => {
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    vi.resetModules();
    vi.doUnmock("../test-fixtures/data");
  });

  it("collapses null and empty-string project keys to a single null bucket", async () => {
    vi.doMock("../test-fixtures/data", () => ({
      WEEK: [
        { day: "Mon", hours: 2, segments: [[null, 2]] },
        { day: "Tue", hours: 1, segments: [["", 1]] },
        { day: "Wed", hours: 1, segments: [["acme", 1]] },
        { day: "Thu", hours: 0, segments: [] },
        { day: "Fri", hours: 0, segments: [] },
        { day: "Sat", hours: 0, segments: [] },
        { day: "Sun", hours: 0, segments: [] },
      ],
    }));
    const { fixtureReportSummary } = await import("./report-fixture");
    const summary = fixtureReportSummary("week");
    const nullSlice = summary.byProject.find((p) => p.projectId === null);
    expect(nullSlice).toBeTruthy();
    expect(nullSlice!.seconds).toBe(3 * 3600);
    const acme = summary.byProject.find((p) => p.projectId === "acme");
    expect(acme).toBeTruthy();
    expect(acme!.seconds).toBe(3600);
  });
});
