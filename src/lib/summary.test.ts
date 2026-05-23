import { describe, it, expect } from "vitest";
import { buildWeekSummary } from "./summary";
import type { Project, WeekDay } from "./types";

const projects: Record<string, Project> = {
  acme:  { id: "acme",  name: "acme-web", client: null, color: "#000" },
  cairn: { id: "cairn", name: "Cairn",    client: null, color: "#111" },
};

const week: WeekDay[] = [
  { day: "Mon", hours: 4, segments: [["acme", 3], ["cairn", 1]] },
  { day: "Tue", hours: 2, segments: [["cairn", 2]] },
  { day: "Wed", hours: 0, segments: [] },
];

describe("buildWeekSummary", () => {
  it("totals, ranks, and percentages match across projects", () => {
    const out = buildWeekSummary({
      weekLabel: "May 18 — May 24",
      week,
      projectsById: projects,
    });
    expect(out).toContain("Cairn — May 18 — May 24");
    expect(out).toContain("6.0h tracked");
    expect(out).toContain("3.0h daily avg"); // total / trackedDays = 6 / 2
    // Cairn (3h) ranks ahead of acme-web (3h)? Tie — order is by insertion in equal case;
    // here Cairn appears after a sort so we check both rows present.
    expect(out).toMatch(/Cairn\s+3\.0h\s+50%/);
    expect(out).toMatch(/acme-web\s+3\.0h\s+50%/);
  });

  it("handles an empty week gracefully", () => {
    const out = buildWeekSummary({
      weekLabel: "Empty",
      week: [{ day: "Mon", hours: 0, segments: [] }],
      projectsById: projects,
    });
    expect(out).toContain("0.0h tracked");
    expect(out).toContain("0 projects");
  });

  it("falls back to the project id when projectsById has no entry", () => {
    const out = buildWeekSummary({
      weekLabel: "Orphan",
      // 'orphaned' is referenced in segments but not in projectsById.
      week: [{ day: "Mon", hours: 2, segments: [["orphaned", 2]] }],
      projectsById: projects,
    });
    // Line label uses the id verbatim — the fallback rendered.
    expect(out).toMatch(/orphaned\s+2\.0h/);
  });

  it("emits 0% per project when totalHours is zero (segment with 0 hours)", () => {
    const out = buildWeekSummary({
      weekLabel: "Zero",
      // A segment with zero hours so the project is ranked but
      // totalHours is 0 — the `totalHours > 0 ? … : 0` ternary takes
      // the else branch.
      week: [{ day: "Mon", hours: 0, segments: [["cairn", 0]] }],
      projectsById: projects,
    });
    expect(out).toMatch(/Cairn\s+0\.0h\s+0%/);
  });
});
