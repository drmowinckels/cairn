import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render } from "@testing-library/react";
import { TimelineStrip } from "./timeline-strip";
import { minutesOfDay } from "../../lib/timeline";
import type { BackendEntry } from "../../lib/ipc";
import type { Project } from "../../lib/types";

afterEach(() => {
  vi.useRealTimers();
});

function pointerMove(clientY: number) {
  window.dispatchEvent(new MouseEvent("pointermove", { clientY }));
}
function pointerUp() {
  window.dispatchEvent(new MouseEvent("pointerup"));
}

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
    const blocks = container.querySelectorAll<HTMLElement>(".vt-seg");
    expect(blocks).toHaveLength(1);
    // 90 min at 44px/h ≈ 66px.
    expect(blocks[0]!.style.height).toBe("66px");
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
    expect(container.querySelector(".vt-seg")?.getAttribute("aria-label")).toBe(
      "Edit Cairn",
    );
  });

  it("clicking a block calls onEntryClick with the entry id", () => {
    const onEntryClick = vi.fn();
    const { container } = renderStrip({ onEntryClick });
    (container.querySelector(".vt-seg") as HTMLButtonElement).click();
    expect(onEntryClick).toHaveBeenCalledWith("e1");
  });

  it("renders blocks disabled (non-interactive) when no onEntryClick is given", () => {
    const { container } = renderStrip();
    expect(
      (container.querySelector(".vt-seg") as HTMLButtonElement).disabled,
    ).toBe(true);
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

  it("renders no edge handles without an onResize callback", () => {
    const { container } = renderStrip();
    expect(container.querySelectorAll(".vt-handle")).toHaveLength(0);
  });

  it("renders no edge handles on the running entry", () => {
    const onResize = vi.fn();
    const { container } = renderStrip({
      entries: [entry({ endedAt: null })],
      showNow: true,
      onResize,
    });
    expect(container.querySelectorAll(".vt-handle")).toHaveLength(0);
  });

  it("renders no edge handles on a clamped (past-midnight) entry", () => {
    const onResize = vi.fn();
    const { container } = renderStrip({
      // 23:00 → 01:00 next day → clamped; its end isn't on this day.
      entries: [
        entry({
          startedAt: "2026-05-26T23:00:00",
          endedAt: "2026-05-27T01:00:00",
        }),
      ],
      onResize,
    });
    expect(container.querySelector(".vt-seg")).toBeTruthy(); // still renders
    expect(container.querySelectorAll(".vt-handle")).toHaveLength(0);
  });

  it("dragging the bottom handle down resizes the end time", () => {
    const onResize = vi.fn();
    const { container } = renderStrip({ onResize }); // entry 09:00–10:30
    const bottom = container.querySelector(".vt-handle--bottom")!;
    fireEvent.pointerDown(bottom, { clientY: 200 });
    pointerMove(244); // +44px = +60min
    pointerUp();
    expect(onResize).toHaveBeenCalledTimes(1);
    const [id, patch] = onResize.mock.calls[0];
    expect(id).toBe("e1");
    expect(minutesOfDay(patch.endedAt)).toBe(11 * 60 + 30); // 10:30 + 60
    expect(patch.startedAt).toBeUndefined();
  });

  it("dragging the top handle up resizes the start time", () => {
    const onResize = vi.fn();
    const { container } = renderStrip({ onResize });
    const top = container.querySelector(".vt-handle--top")!;
    fireEvent.pointerDown(top, { clientY: 200 });
    pointerMove(156); // -44px = -60min
    pointerUp();
    const [, patch] = onResize.mock.calls[0];
    expect(minutesOfDay(patch.startedAt)).toBe(8 * 60); // 09:00 − 60
    expect(patch.endedAt).toBeUndefined();
  });

  it("a click with no movement does not commit a resize (either edge)", () => {
    const onResize = vi.fn();
    const { container } = renderStrip({ onResize });
    fireEvent.pointerDown(container.querySelector(".vt-handle--bottom")!, {
      clientY: 200,
    });
    pointerUp();
    fireEvent.pointerDown(container.querySelector(".vt-handle--top")!, {
      clientY: 200,
    });
    pointerUp();
    expect(onResize).not.toHaveBeenCalled();
  });

  it("ignores stray window pointer events when no drag is in progress", () => {
    const onResize = vi.fn();
    renderStrip({ onResize });
    // No handle was pressed — the live window listeners must no-op.
    pointerMove(300);
    pointerUp();
    expect(onResize).not.toHaveBeenCalled();
  });
});
