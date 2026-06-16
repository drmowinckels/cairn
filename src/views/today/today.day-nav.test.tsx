import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { BackendEntry } from "../../lib/ipc";

vi.mock("../../lib/use-suggestion", () => ({
  useSuggestion: () => ({
    suggestion: null,
    confirm: vi.fn(),
    dismiss: vi.fn(),
  }),
}));
vi.mock("../../lib/use-task-switch-prompt", () => ({
  useTaskSwitchPrompt: () => ({
    active: null,
    confirm: vi.fn(),
    dismiss: vi.fn(),
  }),
}));

describe("TodayView day navigation (#editing-past-days)", () => {
  type WithInternals = { __TAURI_INTERNALS__?: unknown };

  const closed: BackendEntry = {
    id: "e1",
    projectId: "p1",
    taskId: null,
    description: "Yesterday's work",
    startedAt: "2026-06-09T08:00:00Z",
    endedAt: "2026-06-09T09:30:00Z",
    source: "manual",
    ruleId: null,
  };

  beforeEach(() => {
    (globalThis as WithInternals).__TAURI_INTERNALS__ = {};
    vi.resetModules();
  });
  afterEach(() => {
    delete (globalThis as WithInternals).__TAURI_INTERNALS__;
    vi.clearAllMocks();
  });

  async function renderToday(opts: { entries?: BackendEntry[] } = {}) {
    const entries = opts.entries ?? [closed];
    const invoke = vi.fn(async (cmd: string) => {
      if (cmd === "current_running") return null;
      if (cmd === "list_day") return entries;
      if (cmd === "list_projects")
        return [
          {
            id: "p1",
            name: "Cairn",
            clientId: null,
            color: "#abc",
            archived: false,
          },
        ];
      if (cmd === "list_calendar_sources")
        return [
          {
            id: "cal1",
            kind: "url",
            label: "Work",
            location: "https://example.com/cal.ics",
            pollSeconds: 900,
            enabled: true,
            lastSyncedAt: null,
            lastEtag: null,
            lastModified: null,
            lastError: null,
          },
        ];
      return null;
    });
    vi.doMock("@tauri-apps/api/core", () => ({ invoke }));
    const { TodayView } = await import("./today");
    render(
      <TodayView
        density="comfy"
        layoutVariant="default"
        onOpenRule={vi.fn()}
      />,
    );
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: /previous day/i }),
      ).not.toBeNull(),
    );
    return { invoke };
  }

  it("defaults to today: shows the live sections and a disabled Next button", async () => {
    await renderToday();
    expect(screen.getByText(/^today$/i)).toBeTruthy();
    expect(screen.getByLabelText(/current timer/i)).toBeTruthy();
    expect(
      await screen.findByLabelText(/upcoming calendar events/i),
    ).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: /next day/i }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(screen.queryByRole("button", { name: /^today$/i })).toBeNull();
  });

  it("stepping back hides the live sections and shows the past-day entries", async () => {
    await renderToday();
    fireEvent.click(screen.getByRole("button", { name: /previous day/i }));

    expect(screen.queryByLabelText(/current timer/i)).toBeNull();
    expect(screen.queryByLabelText(/upcoming calendar events/i)).toBeNull();
    expect(screen.getByLabelText(/logged entries/i)).toBeTruthy();
    expect(screen.getByText(/yesterday's work/i)).toBeTruthy();
    // The date label is no longer "Today", and a jump-back affordance appears.
    const label = document.querySelector(".today-date-label");
    expect(label?.textContent?.toLowerCase()).not.toBe("today");
    expect(screen.getByRole("button", { name: /^today$/i })).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: /next day/i }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);

    // Jumping back to today restores the live sections.
    fireEvent.click(screen.getByRole("button", { name: /^today$/i }));
    await waitFor(() =>
      expect(screen.queryByLabelText(/current timer/i)).not.toBeNull(),
    );
  });

  it("Next day steps forward from a past day back toward today", async () => {
    await renderToday();
    fireEvent.click(screen.getByRole("button", { name: /previous day/i }));
    expect(screen.queryByLabelText(/current timer/i)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /next day/i }));
    await waitFor(() =>
      expect(screen.queryByLabelText(/current timer/i)).not.toBeNull(),
    );
  });

  it("an empty past day shows the no-entries-logged empty state", async () => {
    await renderToday({ entries: [] });
    fireEvent.click(screen.getByRole("button", { name: /previous day/i }));

    expect(screen.getByText(/no entries this day/i)).toBeTruthy();
    expect(screen.getByText(/nothing was logged on this day/i)).toBeTruthy();
  });
});
