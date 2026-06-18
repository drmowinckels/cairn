import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render } from "@testing-library/react";
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

/** Pin a segment's rect so the cursor-to-minute mapping is deterministic in
 *  jsdom (which otherwise reports a zero-size rect). 90px tall over a 90-min
 *  09:00–10:30 block ⇒ 1px = 1min from the top. */
function pinSegRect(seg: Element, top = 100, height = 90) {
  vi.spyOn(seg, "getBoundingClientRect").mockReturnValue({
    top,
    height,
    bottom: top + height,
    left: 0,
    right: 0,
    width: 0,
    x: 0,
    y: top,
    toJSON: () => ({}),
  } as DOMRect);
}

describe("TimelineStrip split (#188)", () => {
  it("right-click opens a 'Split here' menu at the snapped cursor time", () => {
    const onSplit = vi.fn();
    const { container } = renderStrip({ onSplit, onEntryClick: vi.fn() });
    const seg = container.querySelector(".vt-seg")!;
    pinSegRect(seg);
    // 47px from the top of a 09:00 block ⇒ 09:47 → snaps to 09:45.
    fireEvent.contextMenu(seg, { clientY: 147 });
    const item = container.querySelector(".vt-split-item")!;
    expect(item.textContent).toContain("09:45");
    fireEvent.click(item);
    expect(onSplit).toHaveBeenCalledWith(
      expect.objectContaining({ id: "e1" }),
      9 * 60 + 45,
    );
  });

  it("does not open a menu when the cursor snaps to an edge", () => {
    const onSplit = vi.fn();
    const { container } = renderStrip({ onSplit, onEntryClick: vi.fn() });
    const seg = container.querySelector(".vt-seg")!;
    pinSegRect(seg);
    // 1px from the top ⇒ 09:01 → snaps to 09:00 (the start edge) → rejected.
    fireEvent.contextMenu(seg, { clientY: 101 });
    expect(container.querySelector(".vt-split-menu")).toBeNull();
    expect(onSplit).not.toHaveBeenCalled();
  });

  it("renders no split affordance on a running entry", () => {
    const onSplit = vi.fn();
    const { container } = renderStrip({
      onSplit,
      onEntryClick: vi.fn(),
      entries: [entry({ endedAt: null })],
      showNow: true,
    });
    const seg = container.querySelector(".vt-seg")!;
    pinSegRect(seg);
    fireEvent.contextMenu(seg, { clientY: 147 });
    expect(container.querySelector(".vt-split-menu")).toBeNull();
  });

  it("Escape closes the split menu", () => {
    const onSplit = vi.fn();
    const { container } = renderStrip({ onSplit, onEntryClick: vi.fn() });
    const seg = container.querySelector(".vt-seg")!;
    pinSegRect(seg);
    fireEvent.contextMenu(seg, { clientY: 147 });
    expect(container.querySelector(".vt-split-menu")).toBeTruthy();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(container.querySelector(".vt-split-menu")).toBeNull();
  });

  it("a pointer-down outside the menu dismisses it", () => {
    const onSplit = vi.fn();
    const { container } = renderStrip({ onSplit, onEntryClick: vi.fn() });
    const seg = container.querySelector(".vt-seg")!;
    pinSegRect(seg);
    fireEvent.contextMenu(seg, { clientY: 147 });
    expect(container.querySelector(".vt-split-menu")).toBeTruthy();
    fireEvent.pointerDown(document.body);
    expect(container.querySelector(".vt-split-menu")).toBeNull();
  });

  it("a non-Escape key leaves the split menu open", () => {
    const onSplit = vi.fn();
    const { container } = renderStrip({ onSplit, onEntryClick: vi.fn() });
    const seg = container.querySelector(".vt-seg")!;
    pinSegRect(seg);
    fireEvent.contextMenu(seg, { clientY: 147 });
    expect(container.querySelector(".vt-split-menu")).toBeTruthy();
    fireEvent.keyDown(document, { key: "ArrowDown" });
    expect(container.querySelector(".vt-split-menu")).toBeTruthy();
  });

  it("a pointer-down inside the menu keeps it open", () => {
    const onSplit = vi.fn();
    const { container } = renderStrip({ onSplit, onEntryClick: vi.fn() });
    const seg = container.querySelector(".vt-seg")!;
    pinSegRect(seg);
    fireEvent.contextMenu(seg, { clientY: 147 });
    const menu = container.querySelector(".vt-split-menu")!;
    fireEvent.pointerDown(menu);
    expect(container.querySelector(".vt-split-menu")).toBeTruthy();
  });

  it("a long-press (touch) opens the split menu after the delay", () => {
    vi.useFakeTimers();
    const onSplit = vi.fn();
    const { container } = renderStrip({ onSplit, onEntryClick: vi.fn() });
    const seg = container.querySelector(".vt-seg")!;
    pinSegRect(seg);
    fireEvent.pointerDown(seg, { pointerType: "touch", clientY: 147 });
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(container.querySelector(".vt-split-item")?.textContent).toContain(
      "09:45",
    );
    vi.useRealTimers();
  });

  it("a short touch (released before the delay) does not open the menu", () => {
    vi.useFakeTimers();
    const onSplit = vi.fn();
    const { container } = renderStrip({ onSplit, onEntryClick: vi.fn() });
    const seg = container.querySelector(".vt-seg")!;
    pinSegRect(seg);
    fireEvent.pointerDown(seg, { pointerType: "touch", clientY: 147 });
    fireEvent.pointerUp(seg);
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(container.querySelector(".vt-split-menu")).toBeNull();
    vi.useRealTimers();
  });

  it("a mouse pointer-down never starts a long-press", () => {
    vi.useFakeTimers();
    const onSplit = vi.fn();
    const { container } = renderStrip({ onSplit, onEntryClick: vi.fn() });
    const seg = container.querySelector(".vt-seg")!;
    pinSegRect(seg);
    fireEvent.pointerDown(seg, { pointerType: "mouse", clientY: 147 });
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(container.querySelector(".vt-split-menu")).toBeNull();
    vi.useRealTimers();
  });
});

const PROJECTS2: Project[] = [
  ...PROJECTS,
  {
    id: "p2",
    name: "Ops",
    clientId: null,
    color: "#e07a5f",
    archived: false,
    estimateHours: null,
  },
];

describe("TimelineStrip merge (#188)", () => {
  const adjacent: BackendEntry[] = [
    entry({
      id: "e1",
      startedAt: "2026-05-26T09:00:00",
      endedAt: "2026-05-26T10:00:00",
    }),
    entry({
      id: "e2",
      startedAt: "2026-05-26T10:00:00",
      endedAt: "2026-05-26T11:00:00",
    }),
  ];

  function renderMerge(
    over: Partial<Parameters<typeof TimelineStrip>[0]> = {},
  ) {
    return renderStrip({
      onEntryClick: vi.fn(),
      entries: adjacent,
      projects: PROJECTS2,
      ...over,
    });
  }

  it("shows no merge toolbar without an onMerge callback", () => {
    const { container } = renderMerge();
    expect(container.querySelector(".vt-toolbar")).toBeNull();
  });

  it("entering select mode shows the pick-two hint and toggles aria-pressed", () => {
    const onMerge = vi.fn();
    const { container, getByText } = renderMerge({ onMerge });
    fireEvent.click(getByText("Select to merge"));
    expect(getByText(/Pick two adjacent blocks/)).toBeTruthy();
    const blocks = container.querySelectorAll<HTMLButtonElement>(".vt-seg");
    fireEvent.click(blocks[0]!);
    expect(blocks[0]!.getAttribute("aria-pressed")).toBe("true");
    expect(getByText("Pick one more to merge")).toBeTruthy();
  });

  it("a running block can't be selected for merge (disabled + labelled)", () => {
    const onMerge = vi.fn();
    const { container, getByText } = renderMerge({
      onMerge,
      entries: [
        adjacent[0]!, // closed 09:00–10:00 → selectable
        entry({ id: "run", startedAt: "2026-05-26T10:00:00", endedAt: null }),
      ],
    });
    fireEvent.click(getByText("Select to merge"));
    const running =
      container.querySelector<HTMLButtonElement>(".vt-seg.is-running")!;
    expect(running.disabled).toBe(true);
    expect(running.getAttribute("aria-label")).toMatch(/can't be merged/i);
    expect(running.getAttribute("aria-pressed")).toBeNull();
    const closed = container.querySelector<HTMLButtonElement>(
      ".vt-seg:not(.is-running)",
    )!;
    expect(closed.disabled).toBe(false);
    expect(closed.getAttribute("aria-label")).toMatch(/^select /i);
    expect(closed.getAttribute("aria-pressed")).toBe("false");
  });

  it("selecting two adjacent same-project blocks enables Merge and calls onMerge", () => {
    const onMerge = vi.fn();
    const { container, getByText } = renderMerge({ onMerge });
    fireEvent.click(getByText("Select to merge"));
    const blocks = container.querySelectorAll<HTMLButtonElement>(".vt-seg");
    fireEvent.click(blocks[0]!);
    fireEvent.click(blocks[1]!);
    const mergeBtn = getByText("Merge").closest("button")!;
    expect(mergeBtn.disabled).toBe(false);
    fireEvent.click(mergeBtn);
    expect(onMerge).toHaveBeenCalledWith(
      expect.objectContaining({ id: "e1" }),
      expect.objectContaining({ id: "e2" }),
    );
    // Merging leaves select mode.
    expect(container.querySelector(".vt-toolbar-hint")).toBeNull();
  });

  it("keeps Merge disabled for two different-project blocks", () => {
    const onMerge = vi.fn();
    const { container, getByText } = renderMerge({
      onMerge,
      entries: [
        adjacent[0]!,
        entry({
          id: "e2",
          projectId: "p2",
          startedAt: "2026-05-26T10:00:00",
          endedAt: "2026-05-26T11:00:00",
        }),
      ],
    });
    fireEvent.click(getByText("Select to merge"));
    const blocks = container.querySelectorAll<HTMLButtonElement>(".vt-seg");
    fireEvent.click(blocks[0]!);
    fireEvent.click(blocks[1]!);
    expect(getByText(/can't merge/)).toBeTruthy();
    expect(getByText("Merge").closest("button")!.disabled).toBe(true);
  });

  it("a third selection drops the oldest mark", () => {
    const onMerge = vi.fn();
    const far = entry({
      id: "e3",
      startedAt: "2026-05-26T14:00:00",
      endedAt: "2026-05-26T15:00:00",
    });
    const { container, getByText } = renderMerge({
      onMerge,
      entries: [...adjacent, far],
    });
    fireEvent.click(getByText("Select to merge"));
    const blocks = container.querySelectorAll<HTMLButtonElement>(".vt-seg");
    fireEvent.click(blocks[0]!);
    fireEvent.click(blocks[1]!);
    fireEvent.click(blocks[2]!);
    expect(blocks[0]!.getAttribute("aria-pressed")).toBe("false");
    expect(blocks[1]!.getAttribute("aria-pressed")).toBe("true");
    expect(blocks[2]!.getAttribute("aria-pressed")).toBe("true");
  });

  it("clicking a selected block again deselects it", () => {
    const onMerge = vi.fn();
    const { container, getByText } = renderMerge({ onMerge });
    fireEvent.click(getByText("Select to merge"));
    const block = container.querySelector<HTMLButtonElement>(".vt-seg")!;
    fireEvent.click(block);
    expect(block.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(block);
    expect(block.getAttribute("aria-pressed")).toBe("false");
  });

  it("Cancel exits select mode and clears the selection", () => {
    const onMerge = vi.fn();
    const { container, getByText, queryByText } = renderMerge({ onMerge });
    fireEvent.click(getByText("Select to merge"));
    fireEvent.click(container.querySelector(".vt-seg")!);
    fireEvent.click(getByText("Cancel"));
    expect(queryByText("Cancel")).toBeNull();
    expect(getByText("Select to merge")).toBeTruthy();
    expect(
      container.querySelector(".vt-seg")!.getAttribute("aria-pressed"),
    ).toBeNull();
  });

  it("does not open the editor for a block clicked in select mode", () => {
    const onEntryClick = vi.fn();
    const onMerge = vi.fn();
    const { container, getByText } = renderMerge({ onMerge, onEntryClick });
    fireEvent.click(getByText("Select to merge"));
    fireEvent.click(container.querySelector(".vt-seg")!);
    expect(onEntryClick).not.toHaveBeenCalled();
  });

  it("hides edge handles while in select mode", () => {
    const onMerge = vi.fn();
    const { container, getByText } = renderMerge({
      onMerge,
      onResize: vi.fn(),
    });
    expect(container.querySelectorAll(".vt-handle").length).toBeGreaterThan(0);
    fireEvent.click(getByText("Select to merge"));
    expect(container.querySelectorAll(".vt-handle")).toHaveLength(0);
  });

  it("drops the pair when a selected entry vanishes on a refresh", () => {
    const onMerge = vi.fn();
    const { container, getByText, rerender } = render(
      <TimelineStrip
        entries={adjacent}
        projects={PROJECTS2}
        announce={false}
        cbEnabled={false}
        showNow={false}
        onEntryClick={vi.fn()}
        onMerge={onMerge}
      />,
    );
    fireEvent.click(getByText("Select to merge"));
    const blocks = container.querySelectorAll<HTMLButtonElement>(".vt-seg");
    fireEvent.click(blocks[0]!);
    fireEvent.click(blocks[1]!);
    expect(getByText("Merge").closest("button")!.disabled).toBe(false);
    // The day reloads and the second entry is gone — the pair must dissolve.
    rerender(
      <TimelineStrip
        entries={[adjacent[0]!]}
        projects={PROJECTS2}
        announce={false}
        cbEnabled={false}
        showNow={false}
        onEntryClick={vi.fn()}
        onMerge={onMerge}
      />,
    );
    expect(getByText("Merge").closest("button")!.disabled).toBe(true);
  });
});
