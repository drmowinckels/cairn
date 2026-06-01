import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

const invokeMock = vi.fn().mockResolvedValue(null);
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

vi.mock("../../lib/use-suggestion", () => ({
  useSuggestion: () => ({
    suggestion: null,
    confirm: vi.fn(),
    dismiss: vi.fn(),
  }),
}));

const reminder = {
  active: true,
  dismiss: vi.fn(),
  acknowledge: vi.fn(),
};
vi.mock("../../lib/use-working-hours-reminder", () => ({
  useWorkingHoursReminder: () => reminder,
}));

const startMock = vi.fn().mockResolvedValue(undefined);
vi.mock("../../lib/use-timer", () => ({
  useTimer: () => ({
    running: null,
    elapsedMs: 0,
    loading: false,
    error: null,
    start: startMock,
    stop: vi.fn(),
    update: vi.fn(),
    refresh: vi.fn(),
  }),
}));

import { TodayView } from "./index";
import { WORKING_HOURS_OFF } from "../../lib/use-working-hours";

afterEach(() => {
  vi.clearAllMocks();
  reminder.active = true;
});

function renderToday(detectionPrompts: "subtle" | "modal" = "subtle") {
  return render(
    <TodayView
      density="comfy"
      layoutVariant="default"
      onOpenRule={vi.fn()}
      detectionPrompts={detectionPrompts}
      workingHours={{ ...WORKING_HOURS_OFF, enabled: true }}
    />,
  );
}

describe("TodayView working-hours reminder (#99)", () => {
  it("renders the reminder when active with no timer and no suggestion", () => {
    renderToday();
    expect(
      screen.getByRole("region", { name: /start tracking reminder/i }),
    ).toBeTruthy();
  });

  it("starts a blank timer and acknowledges on Start tracking", async () => {
    renderToday();
    fireEvent.click(screen.getByRole("button", { name: /start tracking/i }));
    expect(reminder.acknowledge).toHaveBeenCalledTimes(1);
    await waitFor(() =>
      expect(startMock).toHaveBeenCalledWith({
        projectId: null,
        description: "",
      }),
    );
  });

  it("logs and recovers when starting the timer fails", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    startMock.mockRejectedValueOnce(new Error("boom"));
    renderToday();
    fireEvent.click(screen.getByRole("button", { name: /start tracking/i }));
    expect(reminder.acknowledge).toHaveBeenCalledTimes(1);
    await waitFor(() =>
      expect(err).toHaveBeenCalledWith("start failed", expect.any(Error)),
    );
    err.mockRestore();
  });

  it("dismisses the reminder", () => {
    renderToday();
    fireEvent.click(screen.getByRole("button", { name: /^dismiss$/i }));
    expect(reminder.dismiss).toHaveBeenCalledTimes(1);
  });

  it("uses the modal presentation when detection prompts are modal", () => {
    renderToday("modal");
    expect(screen.getByRole("alertdialog")).toBeTruthy();
  });

  it("hides the reminder when inactive", () => {
    reminder.active = false;
    renderToday();
    expect(
      screen.queryByRole("region", { name: /start tracking reminder/i }),
    ).toBeNull();
  });
});
