import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

const invokeMock = vi.fn().mockResolvedValue(null);
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

const suggestion = { value: null as unknown };
vi.mock("../../lib/use-suggestion", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../lib/use-suggestion")>();
  return {
    ...actual,
    useSuggestion: () => ({
      suggestion: suggestion.value,
      confirm: vi.fn(),
      dismiss: vi.fn(),
    }),
  };
});

const reminder = { active: false, dismiss: vi.fn(), acknowledge: vi.fn() };
vi.mock("../../lib/use-working-hours-reminder", () => ({
  useWorkingHoursReminder: () => reminder,
}));

const budgets = {
  alert: null as unknown,
  statuses: [] as unknown[],
  dismiss: vi.fn(),
  refresh: vi.fn(),
};
vi.mock("../../lib/use-budget-alerts", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../lib/use-budget-alerts")>();
  return { ...actual, useBudgetAlerts: () => budgets };
});

vi.mock("../../lib/use-timer", () => ({
  useTimer: () => ({
    running: null,
    elapsedMs: 0,
    loading: false,
    error: null,
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn(),
    update: vi.fn(),
    refresh: vi.fn(),
  }),
}));

import { TodayView } from "./index";
import { WORKING_HOURS_OFF } from "../../lib/use-working-hours";

const OVER = {
  budget: {
    id: "b1",
    scopeType: "workspace" as const,
    scopeId: "",
    period: "daily" as const,
    minutes: 480,
    warnPercent: 80,
  },
  usedMinutes: 600,
  percent: 125,
  state: "over" as const,
  periodStart: "2026-09-29T00:00:00+00:00",
};

afterEach(() => {
  vi.clearAllMocks();
  budgets.alert = null;
  reminder.active = false;
  suggestion.value = null;
});

function renderToday() {
  return render(
    <TodayView
      density="comfy"
      layoutVariant="default"
      onOpenRule={vi.fn()}
      detectionPrompts="subtle"
      workingHours={WORKING_HOURS_OFF}
    />,
  );
}

describe("TodayView budget banner (#307)", () => {
  it("shows nothing while no budget is firing", () => {
    renderToday();
    expect(screen.queryByRole("region", { name: /budget/i })).toBeNull();
  });

  it("renders the banner when a budget is over", () => {
    budgets.alert = OVER;
    renderToday();
    expect(screen.getByRole("region", { name: /over budget/i })).toBeTruthy();
  });

  it("dismisses through the hook", () => {
    budgets.alert = OVER;
    renderToday();
    fireEvent.click(screen.getByRole("button", { name: /dismiss budget/i }));
    expect(budgets.dismiss).toHaveBeenCalledTimes(1);
  });

  it("yields to the working-hours reminder", () => {
    // A reminder is about what to do next; a budget warning is information
    // about what already happened, so it can wait a beat rather than stack.
    budgets.alert = OVER;
    reminder.active = true;
    renderToday();
    expect(screen.queryByRole("region", { name: /over budget/i })).toBeNull();
    expect(
      screen.getByRole("region", { name: /start tracking reminder/i }),
    ).toBeTruthy();
  });
});
