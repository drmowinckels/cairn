import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { RecentList, type RecentEntry } from "./recent-list";
import type { Project } from "../../lib/types";

const PROJECTS_BY_ID: Record<string, Project | undefined> = {
  cairn: {
    id: "cairn",
    name: "Cairn",
    clientId: null,
    color: "#f2cc8f",
    archived: false,
    estimateHours: null,
  },
};

afterEach(() => {
  vi.clearAllMocks();
});

function entry(overrides: Partial<RecentEntry> = {}): RecentEntry {
  return {
    id: "e1",
    projectId: "cairn",
    description: "Rule preview UI",
    startedAt: "2026-05-26T09:00:00Z",
    endedAt: "2026-05-26T09:45:00Z",
    source: "rule:branch=feat/rules",
    ...overrides,
  };
}

describe("RecentList", () => {
  it("renders an empty state when there are no entries", () => {
    render(<RecentList entries={[]} projectsById={PROJECTS_BY_ID} />);
    expect(screen.getByRole("status")).toBeTruthy();
    expect(screen.getByText(/no entries yet today/i)).toBeTruthy();
  });

  it("renders one row per entry with duration in hh/mm form", () => {
    render(
      <RecentList
        entries={[
          entry({}),
          entry({ id: "e2", endedAt: "2026-05-26T11:00:00Z" }),
        ]}
        projectsById={PROJECTS_BY_ID}
      />,
    );
    expect(document.querySelectorAll(".entry").length).toBe(2);
  });

  it("rule source row carries aria-label 'source: rule'", () => {
    render(<RecentList entries={[entry({})]} projectsById={PROJECTS_BY_ID} />);
    expect(
      document.querySelector('[aria-label="source: rule"]'),
    ).not.toBeNull();
  });

  it("shows a remote-task chip only when the entry is linked (#110)", () => {
    const { rerender } = render(
      <RecentList
        entries={[entry({ remoteTaskLabel: "Fix bug #42" })]}
        projectsById={PROJECTS_BY_ID}
      />,
    );
    const chip = document.querySelector(".entry-remote");
    expect(chip).toBeTruthy();
    expect(chip?.textContent).toContain("Fix bug #42");

    rerender(
      <RecentList
        entries={[entry({ remoteTaskLabel: null })]}
        projectsById={PROJECTS_BY_ID}
      />,
    );
    expect(document.querySelector(".entry-remote")).toBeNull();
  });

  it("calendar source row carries aria-label 'source: calendar'", () => {
    render(
      <RecentList
        entries={[entry({ source: "calendar" })]}
        projectsById={PROJECTS_BY_ID}
      />,
    );
    expect(
      document.querySelector('[aria-label="source: calendar"]'),
    ).not.toBeNull();
  });

  it("manual source row renders the edit icon as the non-color signal", () => {
    render(
      <RecentList
        entries={[entry({ source: "manual" })]}
        projectsById={PROJECTS_BY_ID}
      />,
    );
    const span = document.querySelector('[aria-label="source: manual"]');
    expect(span).not.toBeNull();
    expect(span?.querySelector("svg")).not.toBeNull();
  });

  it("each source label is paired with a distinct icon (#30 a11y dual-signal)", () => {
    // Color is not the only signal: rule = sparkle, calendar = calendar,
    // manual = edit. The icon paths differ so the source remains
    // distinguishable in a grayscale render.
    const sources: Array<{ source: string; label: string }> = [
      { source: "rule:branch=foo", label: "rule" },
      { source: "calendar", label: "calendar" },
      { source: "manual", label: "manual" },
    ];
    const seenPaths = new Set<string>();
    for (const { source, label } of sources) {
      const { unmount } = render(
        <RecentList
          entries={[entry({ source })]}
          projectsById={PROJECTS_BY_ID}
        />,
      );
      const span = document.querySelector(`[aria-label="source: ${label}"]`);
      const svg = span?.querySelector("svg");
      expect(svg).not.toBeNull();
      // Serialize the SVG so structurally-distinct icons register as
      // distinct keys, regardless of any class differences.
      seenPaths.add(svg!.outerHTML);
      unmount();
    }
    expect(seenPaths.size).toBe(3);
  });

  it("falls back to the ink-faint dot when the project is unknown", () => {
    render(
      <RecentList
        entries={[entry({ projectId: "ghost-proj" })]}
        projectsById={PROJECTS_BY_ID}
      />,
    );
    const dot = document.querySelector(".entry .proj-dot") as HTMLElement;
    expect(dot.style.background).toBe("var(--ink-faint)");
  });

  it("renders entries as buttons when onEdit is provided", () => {
    const onEdit = vi.fn();
    render(
      <RecentList
        entries={[entry({})]}
        projectsById={PROJECTS_BY_ID}
        onEdit={onEdit}
      />,
    );
    const button = screen.getByRole("button", {
      name: /edit entry: cairn — rule preview ui/i,
    });
    fireEvent.click(button);
    expect(onEdit).toHaveBeenCalledWith("e1");
  });

  it("does not render buttons when onEdit is omitted", () => {
    render(<RecentList entries={[entry({})]} projectsById={PROJECTS_BY_ID} />);
    expect(document.querySelector(".entries .entry-btn")).toBeNull();
  });

  it("renders '(no description)' fallback for empty descriptions", () => {
    const onEdit = vi.fn();
    render(
      <RecentList
        entries={[entry({ description: "" })]}
        projectsById={PROJECTS_BY_ID}
        onEdit={onEdit}
      />,
    );
    expect(screen.getByText(/\(no description\)/i)).toBeTruthy();
    expect(
      screen.getByRole("button", {
        name: /edit entry: cairn — \(no description\)/i,
      }),
    ).toBeTruthy();
  });

  it("renders the project name alongside the description (#102)", () => {
    render(<RecentList entries={[entry({})]} projectsById={PROJECTS_BY_ID} />);
    expect(screen.getByText("Cairn")).toBeTruthy();
    expect(screen.getByText("Rule preview UI")).toBeTruthy();
  });

  it("shows 'No project' when the entry has no project (#102)", () => {
    render(
      <RecentList
        entries={[entry({ projectId: null })]}
        projectsById={PROJECTS_BY_ID}
      />,
    );
    expect(screen.getByText(/no project/i)).toBeTruthy();
  });

  it("shows 'No project' when the project id is unknown (#102)", () => {
    render(
      <RecentList
        entries={[entry({ projectId: "ghost-proj" })]}
        projectsById={PROJECTS_BY_ID}
      />,
    );
    expect(screen.getByText(/no project/i)).toBeTruthy();
  });

  it("treats null endedAt as a running entry and uses Date.now() for duration", () => {
    render(
      <RecentList
        entries={[
          entry({
            endedAt: null,
            startedAt: new Date(Date.now() - 60_000).toISOString(),
          }),
        ]}
        projectsById={PROJECTS_BY_ID}
      />,
    );
    expect(document.querySelectorAll(".entry").length).toBe(1);
  });

  it("renders no project dot color when entry has no projectId (null path)", () => {
    render(
      <RecentList
        entries={[entry({ projectId: null })]}
        projectsById={PROJECTS_BY_ID}
      />,
    );
    const dot = document.querySelector(".entry .proj-dot") as HTMLElement;
    expect(dot.style.background).toBe("var(--ink-faint)");
  });
});
