import { describe, expect, it } from "vitest";
import { appTotals, spanSeconds, splitByMinLength } from "./activity-review";
import type { ActivityRow } from "./ipc";

function row(over: Partial<ActivityRow> = {}): ActivityRow {
  return {
    id: 1,
    startedAt: "2026-06-16T09:00:00+00:00",
    endedAt: "2026-06-16T09:30:00+00:00",
    appName: "Zoom",
    titleHint: null,
    source: "window",
    hasEntry: false,
    ...over,
  };
}

describe("spanSeconds", () => {
  it("returns the whole-second duration", () => {
    expect(spanSeconds(row())).toBe(30 * 60);
  });

  it("clamps a negative span to 0 and treats unparseable timestamps as 0", () => {
    expect(
      spanSeconds({
        startedAt: "2026-06-16T10:00:00+00:00",
        endedAt: "2026-06-16T09:00:00+00:00",
      }),
    ).toBe(0);
    expect(spanSeconds({ startedAt: "nope", endedAt: "nope" })).toBe(0);
  });
});

describe("appTotals", () => {
  it("sums seconds per app, highest first", () => {
    const rows = [
      row({ id: 1, appName: "Zoom" }), // 30m
      row({
        id: 2,
        appName: "Code",
        startedAt: "2026-06-16T10:00:00+00:00",
        endedAt: "2026-06-16T11:00:00+00:00", // 60m
      }),
      row({
        id: 3,
        appName: "Zoom",
        startedAt: "2026-06-16T12:00:00+00:00",
        endedAt: "2026-06-16T12:15:00+00:00", // 15m
      }),
    ];
    expect(appTotals(rows)).toEqual([
      { appName: "Code", seconds: 60 * 60 },
      { appName: "Zoom", seconds: 45 * 60 },
    ]);
  });

  it("is empty for no rows", () => {
    expect(appTotals([])).toEqual([]);
  });
});

describe("splitByMinLength (#313)", () => {
  const short = row({
    id: 9,
    appName: "Slack",
    startedAt: "2026-06-16T10:00:00+00:00",
    endedAt: "2026-06-16T10:01:30+00:00", // 90s
  });
  const atFloor = row({
    id: 10,
    appName: "Mail",
    startedAt: "2026-06-16T11:00:00+00:00",
    endedAt: "2026-06-16T11:05:00+00:00", // exactly 5m
  });

  it("holds back spans under the minimum and sums their time", () => {
    const { reviewable, hidden, hiddenSeconds } = splitByMinLength(
      [row(), short, atFloor],
      5,
    );
    // The 30m span and the 5m boundary span are reviewable; the blip is not.
    expect(reviewable.map((r) => r.id)).toEqual([1, 10]);
    expect(hidden.map((r) => r.id)).toEqual([9]);
    expect(hiddenSeconds).toBe(90);
  });

  it("raising the minimum holds back more spans", () => {
    const { reviewable, hidden } = splitByMinLength([row(), atFloor], 15);
    expect(reviewable.map((r) => r.id)).toEqual([1]);
    expect(hidden.map((r) => r.id)).toEqual([10]);
  });

  it("hides nothing at a minimum of 0", () => {
    const { reviewable, hidden, hiddenSeconds } = splitByMinLength(
      [row(), short],
      0,
    );
    expect(reviewable).toHaveLength(2);
    expect(hidden).toEqual([]);
    expect(hiddenSeconds).toBe(0);
  });

  it("treats a negative minimum as 0", () => {
    expect(splitByMinLength([short], -10).hidden).toEqual([]);
  });
});
