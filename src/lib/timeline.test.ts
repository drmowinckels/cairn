import { describe, expect, it } from "vitest";
import {
  TIMELINE_DAY_END_MIN,
  TIMELINE_DAY_SPAN_MIN,
  TIMELINE_DAY_START_MIN,
  entriesToSegments,
  legendFromSegments,
  minutesOfDay,
  startToPercent,
} from "./timeline";
import type { BackendEntry } from "./ipc";
import type { Project } from "./types";

const PROJECTS: Project[] = [
  { id: "p1", name: "Cairn", clientId: null, color: "#abc", archived: false },
  { id: "p2", name: "Ops", clientId: null, color: "#def", archived: false },
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

  it("returns 0 for an unparseable string", () => {
    expect(minutesOfDay("not-a-date")).toBe(0);
  });
});

function entry(id: string, projectId: string | null, start: string, end: string | null): BackendEntry {
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
    const segs = entriesToSegments(
      [
        entry("a", "p1", "2026-05-23T09:00:00", "2026-05-23T10:00:00"),
        entry("b", "p1", "2026-05-23T14:48:00", null),
      ],
      15 * 60 + 2,
    );
    expect(segs).toHaveLength(2);
    expect(segs[0].running).toBe(false);
    expect(segs[1].running).toBe(true);
    expect(segs[1].endMin).toBe(15 * 60 + 2);
  });

  it("never lets a running endMin fall below its startMin", () => {
    const segs = entriesToSegments(
      [entry("a", "p1", "2026-05-23T14:48:00", null)],
      10 * 60,
    );
    expect(segs[0].endMin).toBe(segs[0].startMin);
  });
});

describe("legendFromSegments", () => {
  it("emits one row per distinct project, in first-seen order", () => {
    const segs = entriesToSegments(
      [
        entry("a", "p1", "2026-05-23T09:00:00", "2026-05-23T10:00:00"),
        entry("b", "p2", "2026-05-23T10:00:00", "2026-05-23T10:30:00"),
        entry("c", "p1", "2026-05-23T11:00:00", "2026-05-23T11:30:00"),
      ],
      12 * 60,
    );
    const legend = legendFromSegments(segs, PROJECTS);
    expect(legend.map((l) => l.projectId)).toEqual(["p1", "p2"]);
    expect(legend[0]).toEqual({ projectId: "p1", color: "#abc", name: "Cairn" });
  });

  it("skips segments without a project (uncategorized)", () => {
    const segs = entriesToSegments(
      [entry("a", null, "2026-05-23T09:00:00", "2026-05-23T10:00:00")],
      12 * 60,
    );
    expect(legendFromSegments(segs, PROJECTS)).toEqual([]);
  });

  it("skips segments whose projectId isn't in the project list", () => {
    const segs = entriesToSegments(
      [entry("a", "ghost", "2026-05-23T09:00:00", "2026-05-23T10:00:00")],
      12 * 60,
    );
    expect(legendFromSegments(segs, PROJECTS)).toEqual([]);
  });
});
