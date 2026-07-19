import { describe, expect, it } from "vitest";
import { appTotals, spanSeconds } from "./activity-review";
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
