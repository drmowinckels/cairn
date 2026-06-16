import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";
import { TimelineStrip } from "./timeline-strip";
import type { BackendEntry } from "../../lib/ipc";
import type { Project } from "../../lib/types";

afterEach(() => {
  vi.useRealTimers();
});

const PROJECTS: Project[] = [
  {
    id: "p1",
    name: "Cairn",
    clientId: null,
    color: "#81b29a",
    archived: false,
    estimateHours: null,
  },
];

function entry(over: Partial<BackendEntry> = {}): BackendEntry {
  return {
    id: "e1",
    projectId: "p1",
    taskId: null,
    description: "writing",
    startedAt: "2026-05-26T09:00:00",
    endedAt: "2026-05-26T10:30:00",
    source: "manual",
    ruleId: null,
    ...over,
  };
}

function renderStrip(over: Partial<Parameters<typeof TimelineStrip>[0]> = {}) {
  return render(
    <TimelineStrip
      entries={[entry()]}
      projects={PROJECTS}
      announce={false}
      cbEnabled={false}
      showNow={false}
      {...over}
    />,
  );
}

describe("TimelineStrip (#188)", () => {
  it("renders one block per entry, height proportional to duration", () => {
    const { container } = renderStrip();
    const segs = container.querySelectorAll<HTMLElement>(".vt-seg");
    expect(segs).toHaveLength(1);
    // 90 min at 44px/h ≈ 66px.
    expect(segs[0]!.style.height).toBe("66px");
  });

  it("labels a block with its project name and description", () => {
    const { container } = renderStrip();
    expect(container.querySelector(".vt-seg-name")?.textContent).toBe("Cairn");
    expect(container.querySelector(".vt-seg-desc")?.textContent).toBe(
      "writing",
    );
  });

  it("shows 'Uncategorized' for an entry with no project", () => {
    const { container } = renderStrip({
      entries: [entry({ projectId: null })],
    });
    expect(container.querySelector(".vt-seg-name")?.textContent).toBe(
      "Uncategorized",
    );
  });

  it("omits the description line (and label suffix) when there's no description", () => {
    const { container } = renderStrip({
      entries: [entry({ description: "" })],
    });
    expect(container.querySelector(".vt-seg-desc")).toBeNull();
    expect(
      container.querySelector(".vt-seg")?.getAttribute("aria-label"),
    ).toBe("Cairn");
  });

  it("draws the now-rule only when showNow is set", () => {
    const past = renderStrip({ showNow: false });
    expect(past.container.querySelector(".vt-now")).toBeNull();
    const today = renderStrip({ showNow: true });
    expect(today.container.querySelector(".vt-now")).toBeTruthy();
  });

  it("renders an empty axis (no blocks) for a day with no entries", () => {
    const { container } = renderStrip({ entries: [] });
    expect(container.querySelectorAll(".vt-seg")).toHaveLength(0);
    expect(container.querySelectorAll(".vt-tick").length).toBeGreaterThan(0);
  });

  it("marks the running entry", () => {
    const { container } = renderStrip({
      entries: [entry({ endedAt: null })],
      showNow: true,
    });
    expect(container.querySelector(".vt-seg.is-running")).toBeTruthy();
  });
});
