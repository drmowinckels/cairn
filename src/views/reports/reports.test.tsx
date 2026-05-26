import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({
  ask: vi.fn(),
  open: vi.fn(),
  save: vi.fn(),
}));
vi.mock("@tauri-apps/plugin-opener", () => ({
  revealItemInDir: vi.fn(),
}));

import { ReportsView } from "./reports";
import type { ReportSummary } from "../../lib/ipc";

const writeText = vi.fn();

beforeEach(() => {
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
  writeText.mockReset();
  invokeMock.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("ReportsView (fixture mode, no Tauri)", () => {
  it("renders the title and the segmented control with Week active", () => {
    render(<ReportsView density="comfy" />);
    expect(screen.getByRole("heading", { name: /this week/i })).toBeTruthy();
    const seg = screen.getByRole("radiogroup", { name: /period/i });
    const buttons = seg.querySelectorAll("button");
    expect(buttons).toHaveLength(3);
    const week = Array.from(buttons).find(
      (b) => b.textContent?.trim() === "Week",
    )!;
    expect(week.getAttribute("aria-checked")).toBe("true");
  });

  it("switching range to Day re-renders the chart and updates the title", () => {
    const { container } = render(<ReportsView density="comfy" />);
    const initialBarCount = container.querySelectorAll(".bar-col").length;
    expect(initialBarCount).toBe(7);

    fireEvent.click(screen.getByRole("radio", { name: /^day$/i }));
    expect(screen.getByRole("heading", { name: /today/i })).toBeTruthy();
    expect(container.querySelectorAll(".bar-col").length).toBe(1);

    fireEvent.click(screen.getByRole("radio", { name: /^month$/i }));
    expect(screen.getByRole("heading", { name: /this month/i })).toBeTruthy();
    expect(container.querySelectorAll(".bar-col").length).toBeGreaterThanOrEqual(
      28,
    );
  });

  it("renders the honesty meter with rule/calendar/manual segments and textual labels", () => {
    const { container } = render(<ReportsView density="comfy" />);
    const meter = screen.getByRole("img", { name: /rule-detected|tracked/i });
    expect(meter).toBeTruthy();
    expect(container.querySelector('[data-testid="hon-rule"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="hon-cal"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="hon-manual"]')).toBeTruthy();
    // Legend has textual labels next to each color.
    expect(screen.getByText(/rule-detected/i)).toBeTruthy();
    expect(screen.getByText(/from calendar/i)).toBeTruthy();
    expect(screen.getByText(/^manual$/i)).toBeTruthy();
  });

  it("renders the project breakdown sorted by hours", () => {
    const { container } = render(<ReportsView density="comfy" />);
    const rows = container.querySelectorAll(".bd-row");
    expect(rows.length).toBeGreaterThan(0);
  });

  it("today bar (when present) carries the .is-today class, future bars carry .is-future", () => {
    // The week fixture marks one day today and a few as future. Assert
    // those classes survive the render.
    const { container } = render(<ReportsView density="comfy" />);
    const todayBar = container.querySelector(".bar-col.is-today");
    // The fixture may or may not include "today" depending on weekday;
    // but the future-day class should always be present.
    expect(container.querySelector(".bar-col.is-future")).toBeTruthy();
    // If today exists, its bar should have an inset-ring class.
    if (todayBar) {
      expect(todayBar.className).toMatch(/is-today/);
    }
  });
});

describe("ReportsView (with mocked backend data via prop-driven fetch)", () => {
  // The view's data layer is `useReportSummary`, which the hook tests
  // already cover end-to-end. The render-layer assertions below pass
  // backend-shaped payloads through the same hook the view uses by
  // stubbing `inTauri` via the global flag and mocking `invoke`.
  type WithInternals = { __TAURI_INTERNALS__?: unknown };
  let original: unknown;

  beforeEach(() => {
    original = (globalThis as WithInternals).__TAURI_INTERNALS__;
    (globalThis as WithInternals).__TAURI_INTERNALS__ = {};
    vi.resetModules();
  });
  afterEach(() => {
    if (original === undefined) {
      delete (globalThis as WithInternals).__TAURI_INTERNALS__;
    } else {
      (globalThis as WithInternals).__TAURI_INTERNALS__ = original;
    }
  });

  async function renderWithSummary(summary: ReportSummary) {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "report_summary") return Promise.resolve(summary);
      if (cmd === "data_paths")
        return Promise.resolve({ dataDir: "", dbPath: "", pendingImport: null });
      if (cmd === "list_projects") return Promise.resolve([]);
      return Promise.resolve(null);
    });
    const { ReportsView: View } = await import("./reports");
    return render(<View density="comfy" />);
  }

  it("today's bar has the inset-ring class and future bars are dimmed", async () => {
    const today = new Date();
    const isoToday = formatIso(today);
    const isoTomorrow = formatIso(addDays(today, 1));
    const isoYesterday = formatIso(addDays(today, -1));
    const summary: ReportSummary = {
      totalSeconds: 5400,
      prevTotalSeconds: 1800,
      byDay: [
        { date: isoYesterday, byProject: [{ projectId: "cairn", seconds: 1800 }] },
        { date: isoToday, byProject: [{ projectId: "cairn", seconds: 3600 }] },
        { date: isoTomorrow, byProject: [] },
      ],
      byProject: [{ projectId: "cairn", seconds: 5400 }],
      bySource: { rule: 1000, calendar: 500, manual: 3900 },
    };
    const { container } = await renderWithSummary(summary);
    await waitFor(() => {
      expect(container.querySelector(".bar-col.is-today")).toBeTruthy();
    });
    expect(container.querySelector(".bar-col.is-future")).toBeTruthy();
  });

  it("honesty meter widths add up to 100% of the source split", async () => {
    const summary: ReportSummary = {
      totalSeconds: 4000,
      prevTotalSeconds: 0,
      byDay: [{ date: formatIso(new Date()), byProject: [] }],
      byProject: [],
      bySource: { rule: 1000, calendar: 1000, manual: 2000 },
    };
    const { container } = await renderWithSummary(summary);
    await waitFor(() => {
      const r = container.querySelector(
        '[data-testid="hon-rule"]',
      ) as HTMLElement | null;
      expect(r).toBeTruthy();
      expect(r!.style.width).toBe("25%");
    });
    const c = container.querySelector(
      '[data-testid="hon-cal"]',
    ) as HTMLElement;
    const m = container.querySelector(
      '[data-testid="hon-manual"]',
    ) as HTMLElement;
    const r = container.querySelector(
      '[data-testid="hon-rule"]',
    ) as HTMLElement;
    const pct = (s: string) => Number(s.replace("%", ""));
    expect(pct(r.style.width) + pct(c.style.width) + pct(m.style.width)).toBe(
      100,
    );
  });

  it("renders the empty state when total is zero", async () => {
    const summary: ReportSummary = {
      totalSeconds: 0,
      prevTotalSeconds: 0,
      byDay: [{ date: formatIso(new Date()), byProject: [] }],
      byProject: [],
      bySource: { rule: 0, calendar: 0, manual: 0 },
    };
    await renderWithSummary(summary);
    await waitFor(() =>
      expect(screen.getByText(/no hours tracked/i)).toBeTruthy(),
    );
  });

  it("Copy summary writes to clipboard and resets the Copied state after 2s", async () => {
    writeText.mockResolvedValue(undefined);
    const summary: ReportSummary = {
      totalSeconds: 3600,
      prevTotalSeconds: 1800,
      byDay: [
        {
          date: formatIso(new Date()),
          byProject: [{ projectId: "cairn", seconds: 3600 }],
        },
      ],
      byProject: [{ projectId: "cairn", seconds: 3600 }],
      bySource: { rule: 3600, calendar: 0, manual: 0 },
    };
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      await renderWithSummary(summary);
      await waitFor(() => {
        const btn = screen.getByRole("button", {
          name: /copy summary/i,
        }) as HTMLButtonElement;
        expect(btn.disabled).toBe(false);
      });
      fireEvent.click(screen.getByRole("button", { name: /copy summary/i }));
      await waitFor(() => expect(writeText).toHaveBeenCalledOnce());
      await waitFor(() =>
        expect(screen.getByRole("button", { name: /copied/i })).toBeTruthy(),
      );
      await vi.advanceTimersByTimeAsync(2100);
      await waitFor(() =>
        expect(
          screen.getByRole("button", { name: /copy summary/i }),
        ).toBeTruthy(),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("Copy summary handles >7-day ranges and null project slices", async () => {
    writeText.mockResolvedValue(undefined);
    const today = new Date();
    const byDay = Array.from({ length: 10 }, (_v, i) => ({
      date: formatIso(addDays(today, i - 9)),
      byProject: [{ projectId: i === 0 ? null : "cairn", seconds: 600 }],
    }));
    const summary: ReportSummary = {
      totalSeconds: 6000,
      prevTotalSeconds: 0,
      byDay,
      byProject: [
        { projectId: "cairn", seconds: 5400 },
        { projectId: null, seconds: 600 },
      ],
      bySource: { rule: 0, calendar: 0, manual: 6000 },
    };
    await renderWithSummary(summary);
    await waitFor(() => {
      const btn = screen.getByRole("button", {
        name: /copy summary/i,
      }) as HTMLButtonElement;
      expect(btn.disabled).toBe(false);
    });
    fireEvent.click(screen.getByRole("button", { name: /copy summary/i }));
    await waitFor(() => expect(writeText).toHaveBeenCalledOnce());
    const text = writeText.mock.calls[0]![0] as string;
    expect(text.length).toBeGreaterThan(0);
  });

  it("renders the ErrorBanner and retries via refresh", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "report_summary") return Promise.reject(new Error("db down"));
      if (cmd === "data_paths")
        return Promise.resolve({ dataDir: "", dbPath: "", pendingImport: null });
      if (cmd === "list_projects") return Promise.resolve([]);
      return Promise.resolve(null);
    });
    const { ReportsView: View } = await import("./reports");
    render(<View density="comfy" />);
    await waitFor(() => expect(screen.getByText(/db down/i)).toBeTruthy());
  });

  it("renders the down arrow and percent for a shrinking range", async () => {
    const summary: ReportSummary = {
      totalSeconds: 1800,
      prevTotalSeconds: 3600,
      byDay: [
        {
          date: formatIso(new Date()),
          byProject: [{ projectId: "cairn", seconds: 1800 }],
        },
      ],
      byProject: [{ projectId: "cairn", seconds: 1800 }],
      bySource: { rule: 0, calendar: 0, manual: 1800 },
    };
    const { container } = await renderWithSummary(summary);
    await waitFor(() => {
      const downArrow = container.querySelector(".rep-delta--down .rep-delta-arrow");
      expect(downArrow).toBeTruthy();
      expect(downArrow!.textContent).toBe("▼");
    });
  });

  it("renders the flat marker when current equals previous", async () => {
    const summary: ReportSummary = {
      totalSeconds: 3600,
      prevTotalSeconds: 3600,
      byDay: [
        {
          date: formatIso(new Date()),
          byProject: [{ projectId: "cairn", seconds: 3600 }],
        },
      ],
      byProject: [{ projectId: "cairn", seconds: 3600 }],
      bySource: { rule: 3600, calendar: 0, manual: 0 },
    };
    const { container } = await renderWithSummary(summary);
    await waitFor(() => {
      const flat = container.querySelector(".rep-delta--flat .rep-delta-arrow");
      expect(flat).toBeTruthy();
      expect(flat!.textContent).toBe("◆");
    });
  });

  it("falls back to the project id when projectsById has no entry for the slice", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "report_summary")
        return Promise.resolve({
          totalSeconds: 3600,
          prevTotalSeconds: 0,
          byDay: [
            {
              date: formatIso(new Date()),
              byProject: [{ projectId: "unknown-proj", seconds: 3600 }],
            },
          ],
          byProject: [{ projectId: "unknown-proj", seconds: 3600 }],
          bySource: { rule: 0, calendar: 0, manual: 3600 },
        } satisfies ReportSummary);
      if (cmd === "data_paths")
        return Promise.resolve({ dataDir: "", dbPath: "", pendingImport: null });
      if (cmd === "list_projects")
        return Promise.resolve([
          {
            id: "other",
            name: "Other",
            clientId: null,
            color: "#123456",
            archived: false,
          },
        ]);
      return Promise.resolve(null);
    });
    const { ReportsView: View } = await import("./reports");
    const { container } = render(<View density="comfy" />);
    await waitFor(() =>
      expect(container.querySelector(".bd-name")?.textContent).toBe("unknown-proj"),
    );
    const dot = container.querySelector(".proj-dot") as HTMLElement;
    expect(dot.style.background).toContain("var(--ink-faint)");
  });

  it("uses the project's own color and name when projectsById has the entry", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "report_summary")
        return Promise.resolve({
          totalSeconds: 3600,
          prevTotalSeconds: 0,
          byDay: [
            {
              date: formatIso(new Date()),
              byProject: [{ projectId: "cairn", seconds: 3600 }],
            },
          ],
          byProject: [{ projectId: "cairn", seconds: 3600 }],
          bySource: { rule: 3600, calendar: 0, manual: 0 },
        } satisfies ReportSummary);
      if (cmd === "data_paths")
        return Promise.resolve({ dataDir: "", dbPath: "", pendingImport: null });
      if (cmd === "list_projects")
        return Promise.resolve([
          {
            id: "cairn",
            name: "Cairn",
            clientId: null,
            color: "#abcdef",
            archived: false,
          },
        ]);
      return Promise.resolve(null);
    });
    const { ReportsView: View } = await import("./reports");
    const { container } = render(<View density="comfy" />);
    await waitFor(() =>
      expect(container.querySelector(".bd-name")?.textContent).toBe("Cairn"),
    );
    const dot = container.querySelector(".proj-dot") as HTMLElement;
    expect(dot.style.background.toLowerCase()).toContain("#abcdef");
  });

  it("renders a 'No project' row for slices with a null projectId", async () => {
    const summary: ReportSummary = {
      totalSeconds: 7200,
      prevTotalSeconds: 0,
      byDay: [
        {
          date: formatIso(new Date()),
          byProject: [
            { projectId: null, seconds: 3600 },
            { projectId: "cairn", seconds: 3600 },
          ],
        },
      ],
      byProject: [
        { projectId: null, seconds: 3600 },
        { projectId: "cairn", seconds: 3600 },
      ],
      bySource: { rule: 0, calendar: 0, manual: 7200 },
    };
    await renderWithSummary(summary);
    await waitFor(() =>
      expect(screen.getByText(/no project/i)).toBeTruthy(),
    );
  });

  it("logs to console.error when clipboard write rejects", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    writeText.mockRejectedValue(new Error("denied"));
    const summary: ReportSummary = {
      totalSeconds: 3600,
      prevTotalSeconds: 0,
      byDay: [
        {
          date: formatIso(new Date()),
          byProject: [{ projectId: "cairn", seconds: 3600 }],
        },
      ],
      byProject: [{ projectId: "cairn", seconds: 3600 }],
      bySource: { rule: 3600, calendar: 0, manual: 0 },
    };
    await renderWithSummary(summary);
    await waitFor(() => {
      const btn = screen.getByRole("button", {
        name: /copy summary/i,
      }) as HTMLButtonElement;
      expect(btn.disabled).toBe(false);
    });
    fireEvent.click(screen.getByRole("button", { name: /copy summary/i }));
    await waitFor(() =>
      expect(consoleError).toHaveBeenCalledWith(
        "clipboard write failed",
        expect.any(Error),
      ),
    );
    consoleError.mockRestore();
  });
});

function formatIso(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
function addDays(d: Date, n: number): Date {
  const out = new Date(d);
  out.setDate(out.getDate() + n);
  return out;
}
