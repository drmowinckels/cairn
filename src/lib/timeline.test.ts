import { describe, expect, it } from "vitest";
import {
  MERGE_MAX_GAP_MIN,
  TIMELINE_DAY_END_MIN,
  TIMELINE_DAY_SPAN_MIN,
  TIMELINE_DAY_START_MIN,
  applyMinuteToIso,
  blockGeometry,
  canMerge,
  dayWindow,
  entriesToSegments,
  hourTicks,
  legendFromSegments,
  mergeEntries,
  minutesOfDay,
  resizeSegment,
  splitAt,
  splitMidpoint,
  startToPercent,
  type MergeCandidate,
  type TimelineSegment,
} from "./timeline";
import type { BackendEntry } from "./ipc";
import type { Project } from "./types";

const PROJECTS: Project[] = [
  {
    id: "p1",
    name: "Cairn",
    clientId: null,
    color: "#abc",
    archived: false,
    estimateHours: null,
  },
  {
    id: "p2",
    name: "Ops",
    clientId: null,
    color: "#def",
    archived: false,
    estimateHours: null,
  },
];

describe("startToPercent", () => {
  it("maps 08:00 to 0%", () => {
    expect(startToPercent(TIMELINE_DAY_START_MIN)).toBe(0);
  });

  it("maps 19:00 to 100%", () => {
    expect(startToPercent(TIMELINE_DAY_END_MIN)).toBe(100);
  });

  it("maps midday linearly", () => {
    const mid = TIMELINE_DAY_START_MIN + TIMELINE_DAY_SPAN_MIN / 2;
    expect(startToPercent(mid)).toBeCloseTo(50);
  });

  it("clamps pre-08:00 values to 0", () => {
    expect(startToPercent(0)).toBe(0);
    expect(startToPercent(TIMELINE_DAY_START_MIN - 60)).toBe(0);
  });

  it("clamps post-19:00 values to 100", () => {
    expect(startToPercent(TIMELINE_DAY_END_MIN + 30)).toBe(100);
  });

  it("returns 0 for NaN / non-finite inputs", () => {
    expect(startToPercent(Number.NaN)).toBe(0);
    expect(startToPercent(Number.POSITIVE_INFINITY)).toBe(0);
  });
});

describe("minutesOfDay", () => {
  it("extracts hours+minutes from an ISO string", () => {
    const min = minutesOfDay("2026-05-23T09:30:00");
    expect(min).toBeGreaterThanOrEqual(9 * 60 + 30);
    expect(min).toBeLessThan(9 * 60 + 31);
  });

  it("returns 0 for an unparsable string", () => {
    expect(minutesOfDay("not-a-date")).toBe(0);
  });
});

function entry(
  id: string,
  projectId: string | null,
  start: string,
  end: string | null,
): BackendEntry {
  return {
    id,
    projectId,
    taskId: null,
    description: `${id}-desc`,
    startedAt: start,
    endedAt: end,
    source: "manual",
    ruleId: null,
  };
}

describe("entriesToSegments", () => {
  it("maps each entry to a segment, marking the running one", () => {
    const segments = entriesToSegments(
      [
        entry("a", "p1", "2026-05-23T09:00:00", "2026-05-23T10:00:00"),
        entry("b", "p1", "2026-05-23T14:48:00", null),
      ],
      15 * 60 + 2,
    );
    expect(segments).toHaveLength(2);
    expect(segments[0].running).toBe(false);
    expect(segments[1].running).toBe(true);
    expect(segments[1].endMin).toBe(15 * 60 + 2);
  });

  it("never lets a running endMin fall below its startMin", () => {
    const segments = entriesToSegments(
      [entry("a", "p1", "2026-05-23T14:48:00", null)],
      10 * 60,
    );
    expect(segments[0].endMin).toBe(segments[0].startMin);
  });

  it("clamps a past-midnight entry to end-of-day and flags it", () => {
    // 23:00 → 01:00 next day: minutesOfDay(end) < start, so it would render
    // off-track. Clamp to 24:00 and mark it clamped (not edge-resizable).
    const segments = entriesToSegments(
      [entry("a", "p1", "2026-05-23T23:00:00", "2026-05-24T01:00:00")],
      12 * 60,
    );
    expect(segments[0].startMin).toBe(23 * 60);
    expect(segments[0].endMin).toBe(24 * 60);
    expect(segments[0].clamped).toBe(true);
  });

  it("leaves a normal same-day entry unclamped", () => {
    const segments = entriesToSegments(
      [entry("a", "p1", "2026-05-23T09:00:00", "2026-05-23T10:00:00")],
      12 * 60,
    );
    expect(segments[0].clamped).toBe(false);
  });
});

describe("legendFromSegments", () => {
  it("emits one row per distinct project, in first-seen order", () => {
    const segments = entriesToSegments(
      [
        entry("a", "p1", "2026-05-23T09:00:00", "2026-05-23T10:00:00"),
        entry("b", "p2", "2026-05-23T10:00:00", "2026-05-23T10:30:00"),
        entry("c", "p1", "2026-05-23T11:00:00", "2026-05-23T11:30:00"),
      ],
      12 * 60,
    );
    const legend = legendFromSegments(segments, PROJECTS);
    expect(legend.map((l) => l.projectId)).toEqual(["p1", "p2"]);
    expect(legend[0]).toEqual({
      projectId: "p1",
      color: "#abc",
      name: "Cairn",
    });
  });

  it("skips segments without a project (uncategorized)", () => {
    const segments = entriesToSegments(
      [entry("a", null, "2026-05-23T09:00:00", "2026-05-23T10:00:00")],
      12 * 60,
    );
    expect(legendFromSegments(segments, PROJECTS)).toEqual([]);
  });

  it("skips segments whose projectId isn't in the project list", () => {
    const segments = entriesToSegments(
      [entry("a", "ghost", "2026-05-23T09:00:00", "2026-05-23T10:00:00")],
      12 * 60,
    );
    expect(legendFromSegments(segments, PROJECTS)).toEqual([]);
  });
});

function seg(startMin: number, endMin: number): TimelineSegment {
  return {
    id: `${startMin}-${endMin}`,
    startMin,
    endMin,
    projectId: null,
    description: "",
    running: false,
    source: "manual",
    clamped: false,
  };
}

describe("dayWindow", () => {
  it("defaults to the 08:00–19:00 working floor for a sparse day", () => {
    expect(dayWindow([], 12 * 60, false)).toEqual({
      startMin: TIMELINE_DAY_START_MIN,
      endMin: TIMELINE_DAY_END_MIN,
    });
  });

  it("expands (hour-aligned) to cover early and late entries", () => {
    // 06:20 → 21:40 should widen the window to 06:00–22:00.
    const w = dayWindow([seg(6 * 60 + 20, 21 * 60 + 40)], 12 * 60, false);
    expect(w).toEqual({ startMin: 6 * 60, endMin: 22 * 60 });
  });

  it("extends to the now marker only when showNow is set", () => {
    expect(dayWindow([], 21 * 60 + 5, false).endMin).toBe(TIMELINE_DAY_END_MIN);
    expect(dayWindow([], 21 * 60 + 5, true).endMin).toBe(22 * 60);
  });

  it("never returns a zero-span window", () => {
    const w = dayWindow([seg(8 * 60, 8 * 60)], 8 * 60, false);
    expect(w.endMin).toBeGreaterThan(w.startMin);
  });
});

describe("hourTicks", () => {
  it("emits one mark per hour inclusive of both bounds", () => {
    expect(hourTicks({ startMin: 8 * 60, endMin: 11 * 60 })).toEqual([
      8 * 60,
      9 * 60,
      10 * 60,
      11 * 60,
    ]);
  });
});

describe("blockGeometry", () => {
  const win = { startMin: 8 * 60, endMin: 18 * 60 };

  it("places a block by its true offset and duration", () => {
    // 09:00–10:30 at 40px/h → top 40px, height 60px.
    expect(blockGeometry(9 * 60, 10 * 60 + 30, win, 40, 10)).toEqual({
      topPx: 40,
      heightPx: 60,
    });
  });

  it("clamps very short blocks to the minimum height but keeps the offset", () => {
    const g = blockGeometry(9 * 60, 9 * 60 + 1, win, 40, 18);
    expect(g.topPx).toBe(40);
    expect(g.heightPx).toBe(18);
  });
});

describe("resizeSegment", () => {
  // 09:00–10:30
  const s = 9 * 60;
  const e = 10 * 60 + 30;

  it("moves the start edge and snaps to the grid", () => {
    expect(resizeSegment("start", s, e, -32, 5)).toEqual({
      startMin: 8 * 60 + 30, // 540 - 32 = 508 → snap 5 → 510
      endMin: e,
    });
  });

  it("moves the end edge and leaves the start untouched", () => {
    expect(resizeSegment("end", s, e, 30, 5)).toEqual({
      startMin: s,
      endMin: 11 * 60, // 630 + 30 = 660
    });
  });

  it("won't let the start cross the end (keeps a minimum duration)", () => {
    const r = resizeSegment("start", s, e, 999, 5);
    expect(r.startMin).toBe(e - 5);
  });

  it("won't let the end cross the start (keeps a minimum duration)", () => {
    const r = resizeSegment("end", s, e, -999, 5);
    expect(r.endMin).toBe(s + 5);
  });

  it("clamps the start to the start of day and the end to midnight", () => {
    expect(resizeSegment("start", s, e, -10_000, 5).startMin).toBe(0);
    expect(resizeSegment("end", s, e, 10_000, 5).endMin).toBe(24 * 60);
  });
});

describe("applyMinuteToIso", () => {
  it("re-times an ISO to a new minute-of-day on the same local day", () => {
    const out = applyMinuteToIso("2026-05-26T09:00:00", 11 * 60 + 30);
    expect(minutesOfDay(out)).toBe(11 * 60 + 30);
  });

  it("returns the input unchanged for an invalid timestamp", () => {
    expect(applyMinuteToIso("not-a-date", 600)).toBe("not-a-date");
  });
});

describe("splitAt", () => {
  // 09:00–10:30
  const s = 9 * 60;
  const e = 10 * 60 + 30;

  it("snaps a split point to the grid when it lands strictly inside", () => {
    expect(splitAt(s, e, 9 * 60 + 47, 5)).toBe(9 * 60 + 45);
  });

  it("rejects a split snapping to the start edge", () => {
    expect(splitAt(s, e, s + 1, 5)).toBeNull();
  });

  it("rejects a split snapping to the end edge", () => {
    expect(splitAt(s, e, e - 1, 5)).toBeNull();
  });

  it("rejects a split before the start or after the end", () => {
    expect(splitAt(s, e, s - 30, 5)).toBeNull();
    expect(splitAt(s, e, e + 30, 5)).toBeNull();
  });

  it("rejects when the snapped point coincides with an edge exactly", () => {
    // 09:02 snaps to 09:00 (the start) → no room for a first half.
    expect(splitAt(s, e, s + 2, 5)).toBeNull();
  });
});

describe("splitMidpoint", () => {
  it("returns the snapped midpoint of a block", () => {
    // 09:00–10:30 → midpoint 09:45, already on the grid.
    expect(splitMidpoint(9 * 60, 10 * 60 + 30, 5)).toBe(9 * 60 + 45);
  });

  it("snaps a midpoint that lands off the grid", () => {
    // 09:00–10:12 → midpoint 09:36 → snaps to 09:35.
    expect(splitMidpoint(9 * 60, 10 * 60 + 12, 5)).toBe(9 * 60 + 35);
  });

  it("returns null for a block too short to hold an interior grid point", () => {
    // 09:00–09:05 → no multiple of 5 strictly inside.
    expect(splitMidpoint(9 * 60, 9 * 60 + 5, 5)).toBeNull();
  });

  it("handles fractional (sub-minute) bounds", () => {
    // 09:00:30–10:29:30 → midpoint 09:45, strictly inside.
    expect(splitMidpoint(9 * 60 + 0.5, 10 * 60 + 29.5, 5)).toBe(9 * 60 + 45);
  });
});

function candidate(
  id: string,
  projectId: string | null,
  startedAt: string,
  endedAt: string | null,
): MergeCandidate {
  return { id, projectId, startedAt, endedAt };
}

describe("canMerge", () => {
  it("merges two adjacent same-project closed entries", () => {
    const a = candidate(
      "a",
      "p1",
      "2026-05-26T09:00:00",
      "2026-05-26T10:00:00",
    );
    const b = candidate(
      "b",
      "p1",
      "2026-05-26T10:00:00",
      "2026-05-26T11:00:00",
    );
    expect(canMerge(a, b)).toBe(true);
  });

  it("is order-independent", () => {
    const a = candidate(
      "a",
      "p1",
      "2026-05-26T09:00:00",
      "2026-05-26T10:00:00",
    );
    const b = candidate(
      "b",
      "p1",
      "2026-05-26T10:00:00",
      "2026-05-26T11:00:00",
    );
    expect(canMerge(b, a)).toBe(true);
  });

  it("allows a small gap up to the threshold", () => {
    const a = candidate(
      "a",
      "p1",
      "2026-05-26T09:00:00",
      "2026-05-26T10:00:00",
    );
    const gapEnd = new Date(
      Date.parse("2026-05-26T10:00:00") + MERGE_MAX_GAP_MIN * 60_000,
    ).toISOString();
    const b = candidate("b", "p1", gapEnd, "2026-05-26T11:30:00");
    expect(canMerge(a, b)).toBe(true);
  });

  it("rejects a gap larger than the threshold", () => {
    const a = candidate(
      "a",
      "p1",
      "2026-05-26T09:00:00",
      "2026-05-26T10:00:00",
    );
    const b = candidate(
      "b",
      "p1",
      "2026-05-26T11:00:00",
      "2026-05-26T12:00:00",
    );
    expect(canMerge(a, b)).toBe(false);
  });

  it("rejects different projects", () => {
    const a = candidate(
      "a",
      "p1",
      "2026-05-26T09:00:00",
      "2026-05-26T10:00:00",
    );
    const b = candidate(
      "b",
      "p2",
      "2026-05-26T10:00:00",
      "2026-05-26T11:00:00",
    );
    expect(canMerge(a, b)).toBe(false);
  });

  it("treats two uncategorized (null-project) entries as same project", () => {
    const a = candidate(
      "a",
      null,
      "2026-05-26T09:00:00",
      "2026-05-26T10:00:00",
    );
    const b = candidate(
      "b",
      null,
      "2026-05-26T10:00:00",
      "2026-05-26T11:00:00",
    );
    expect(canMerge(a, b)).toBe(true);
  });

  it("rejects a running entry (open end)", () => {
    const a = candidate(
      "a",
      "p1",
      "2026-05-26T09:00:00",
      "2026-05-26T10:00:00",
    );
    const b = candidate("b", "p1", "2026-05-26T10:00:00", null);
    expect(canMerge(a, b)).toBe(false);
  });

  it("rejects an overlapping pair (later starts before the earlier ends)", () => {
    const a = candidate(
      "a",
      "p1",
      "2026-05-26T09:00:00",
      "2026-05-26T10:30:00",
    );
    const b = candidate(
      "b",
      "p1",
      "2026-05-26T10:00:00",
      "2026-05-26T11:00:00",
    );
    expect(canMerge(a, b)).toBe(false);
  });

  it("rejects merging an entry with itself", () => {
    const a = candidate(
      "a",
      "p1",
      "2026-05-26T09:00:00",
      "2026-05-26T10:00:00",
    );
    expect(canMerge(a, a)).toBe(false);
  });
});

describe("mergeEntries", () => {
  it("keeps the earlier entry and spans to the later end", () => {
    const a = candidate(
      "a",
      "p1",
      "2026-05-26T09:00:00",
      "2026-05-26T10:00:00",
    );
    const b = candidate(
      "b",
      "p1",
      "2026-05-26T10:00:00",
      "2026-05-26T11:00:00",
    );
    expect(mergeEntries(a, b)).toEqual({
      keepId: "a",
      dropId: "b",
      endedAt: "2026-05-26T11:00:00",
    });
  });

  it("is order-independent (same plan whichever way it's called)", () => {
    const a = candidate(
      "a",
      "p1",
      "2026-05-26T09:00:00",
      "2026-05-26T10:00:00",
    );
    const b = candidate(
      "b",
      "p1",
      "2026-05-26T10:00:00",
      "2026-05-26T11:00:00",
    );
    expect(mergeEntries(b, a)).toEqual(mergeEntries(a, b));
  });

  it("takes the latest end even when the earlier entry ends later", () => {
    // a starts first but ends after b — the merged end is a's end.
    const a = candidate(
      "a",
      "p1",
      "2026-05-26T09:00:00",
      "2026-05-26T11:30:00",
    );
    const b = candidate(
      "b",
      "p1",
      "2026-05-26T09:30:00",
      "2026-05-26T10:00:00",
    );
    const plan = mergeEntries(a, b);
    expect(plan.keepId).toBe("a");
    expect(plan.endedAt).toBe("2026-05-26T11:30:00");
  });
});
