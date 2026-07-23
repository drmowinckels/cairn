import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({
  ask: vi.fn(),
  open: vi.fn(),
  save: vi.fn(),
}));
vi.mock("@tauri-apps/plugin-opener", () => ({ revealItemInDir: vi.fn() }));

const useBilling = vi.fn();
vi.mock("../../lib/use-billing", () => ({ useBilling: () => useBilling() }));

const useProfitability = vi.fn();
vi.mock("../../lib/use-profitability", () => ({
  useProfitability: () => useProfitability(),
}));

import { ReportsView } from "./reports";

const proActive = {
  status: {
    enabled: true,
    license: {
      status: "active",
      active: true,
      customerEmail: null,
      productName: null,
      expiresAt: null,
      lastValidatedAt: "2026-07-23T00:00:00Z",
    },
  },
  busy: false,
  error: null,
  activate: vi.fn(),
  refresh: vi.fn(),
  deactivate: vi.fn(),
};

const emptyReport = {
  from: "2026-07-01",
  to: "2026-07-31",
  billableSeconds: 0,
  nonbillableSeconds: 0,
  unratedBillableSeconds: 0,
  totals: [],
  byProject: [],
};

beforeEach(() => {
  useBilling.mockReturnValue(proActive);
  useProfitability.mockReturnValue({
    data: emptyReport,
    loading: false,
    error: null,
    refresh: vi.fn(),
  });
});
afterEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
});

describe("ReportsView — Profitability tab (#109)", () => {
  it("shows the tab when Pro is active and switches to the panel", () => {
    render(<ReportsView density="comfy" />);
    const tab = screen.getByRole("radio", { name: "Profitability" });
    expect(tab).toBeTruthy();
    // Summary is the default — the profitability panel isn't mounted yet.
    expect(screen.queryByText(/no time tracked/i)).toBeNull();

    fireEvent.click(tab);
    // The Profitability panel mounts (its empty state here).
    expect(screen.getByText(/no time tracked/i)).toBeTruthy();

    // And back to Summary.
    fireEvent.click(screen.getByRole("radio", { name: "Summary" }));
    expect(screen.queryByText(/no time tracked/i)).toBeNull();
  });

  it("hides the tab entirely when Pro is not active", () => {
    useBilling.mockReturnValue({
      ...proActive,
      status: { enabled: false, license: null },
    });
    render(<ReportsView density="comfy" />);
    expect(screen.queryByRole("radio", { name: "Profitability" })).toBeNull();
  });
});
