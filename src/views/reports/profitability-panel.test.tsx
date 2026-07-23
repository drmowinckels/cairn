import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";

const useProfitability = vi.fn();
vi.mock("../../lib/use-profitability", () => ({
  useProfitability: (...a: unknown[]) => useProfitability(...a),
}));

import { ProfitabilityPanel } from "./profitability-panel";
import { ROUNDING_OFF } from "../../lib/rounding";
import type { Project } from "../../lib/types";
import type { ProfitabilityReport } from "../../lib/ipc";

const projectsById = {
  p1: { id: "p1", name: "Website" },
} as unknown as Record<string, Project>;

function state(over: Partial<ReturnType<typeof useProfitability>> = {}) {
  return { data: null, loading: false, error: null, refresh: vi.fn(), ...over };
}

const report: ProfitabilityReport = {
  from: "2026-07-01",
  to: "2026-07-31",
  billableSeconds: 3600 * 10,
  nonbillableSeconds: 3600 * 2,
  unratedBillableSeconds: 3600,
  totals: [
    { currency: "USD", amountCents: 150000, billableSeconds: 3600 * 10 },
  ],
  byProject: [
    {
      projectId: "p1",
      remoteProjectName: null,
      billableSeconds: 3600 * 10,
      nonbillableSeconds: 0,
      unratedBillableSeconds: 0,
      amounts: [
        { currency: "USD", amountCents: 150000, billableSeconds: 3600 * 10 },
      ],
    },
    {
      projectId: "missing",
      remoteProjectName: null,
      billableSeconds: 0,
      nonbillableSeconds: 3600 * 2,
      unratedBillableSeconds: 0,
      amounts: [],
    },
    {
      projectId: null,
      remoteProjectName: "GitHub: cairn",
      billableSeconds: 3600,
      nonbillableSeconds: 0,
      unratedBillableSeconds: 3600,
      amounts: [],
    },
    {
      projectId: null,
      remoteProjectName: null,
      billableSeconds: 0,
      nonbillableSeconds: 1800,
      unratedBillableSeconds: 0,
      amounts: [],
    },
  ],
};

function renderPanel() {
  return render(
    <ProfitabilityPanel
      range="month"
      rounding={ROUNDING_OFF}
      projectsById={projectsById}
    />,
  );
}

beforeEach(() => useProfitability.mockReset());

describe("ProfitabilityPanel", () => {
  it("shows a loading state before data arrives", () => {
    useProfitability.mockReturnValue(state({ loading: true }));
    renderPanel();
    expect(screen.getByText(/loading/i)).toBeTruthy();
  });

  it("renders nothing once loading finishes with no data", () => {
    useProfitability.mockReturnValue(state({ loading: false, data: null }));
    const { container } = renderPanel();
    expect(container.firstChild).toBeNull();
  });

  it("surfaces the backend gate error", () => {
    useProfitability.mockReturnValue(
      state({ error: "Cairn Pro isn't active" }),
    );
    renderPanel();
    expect(screen.getByText(/isn't active/i)).toBeTruthy();
  });

  it("shows an empty state when there is no tracked time", () => {
    useProfitability.mockReturnValue(
      state({ data: { ...report, byProject: [] } }),
    );
    renderPanel();
    expect(screen.getByText(/no time tracked/i)).toBeTruthy();
  });

  it("renders totals, the unrated note, and a row per project", () => {
    useProfitability.mockReturnValue(state({ data: report }));
    renderPanel();

    // Currency total + hours totals (scoped — the amount also appears in a row).
    const totals = screen.getByLabelText("Billable totals");
    expect(within(totals).getByText(/\$1,500\.00/)).toBeTruthy();
    expect(screen.getByText("USD billable")).toBeTruthy();
    expect(screen.getByText("billable")).toBeTruthy();
    expect(screen.getByText("non-billable")).toBeTruthy();

    // Unpriced billable time is flagged.
    expect(screen.getByText(/billable but/i).textContent).toMatch(/1\.0/);

    // Scope-name resolution: local name, raw id fallback, remote name, none.
    expect(screen.getByText("Website")).toBeTruthy();
    expect(screen.getByText("missing")).toBeTruthy();
    expect(screen.getByText("GitHub: cairn")).toBeTruthy();
    expect(screen.getByText("No project")).toBeTruthy();

    // The priced project shows its amount; an unpriced row shows a dash.
    const websiteRow = screen.getByText("Website").closest("tr")!;
    expect(within(websiteRow).getByText(/\$1,500\.00/)).toBeTruthy();
    const noneRow = screen.getByText("No project").closest("tr")!;
    expect(within(noneRow).getByText("—")).toBeTruthy();
  });

  it("omits the unrated note when everything billable is priced", () => {
    useProfitability.mockReturnValue(
      state({ data: { ...report, unratedBillableSeconds: 0 } }),
    );
    renderPanel();
    expect(screen.queryByText(/billable but/i)).toBeNull();
  });
});
