import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({
  ask: vi.fn(),
  open: vi.fn(),
  save: vi.fn(),
}));

import {
  SettingsView,
  hhMmToMinutes,
  minutesToHhMm,
} from "./settings";
import type { UseA11yPrefs } from "../../lib/use-a11y-prefs";
import type { UseSignalCapture } from "../../lib/use-signal-capture";
import type { UseWorkingHours, WorkingHours } from "../../lib/use-working-hours";
import { WORKING_HOURS_OFF } from "../../lib/use-working-hours";

function stubA11y(): UseA11yPrefs {
  return {
    theme: "system",
    textScale: "md",
    highContrast: false,
    reduceMotion: false,
    colorblindSafe: false,
    announce: true,
    alwaysFocusRing: false,
    detectionPrompts: "subtle",
    ambiguityDefault: "prompt",
    setTheme: vi.fn(),
    setTextScale: vi.fn(),
    setHighContrast: vi.fn(),
    setReduceMotion: vi.fn(),
    setColorblindSafe: vi.fn(),
    setAnnounce: vi.fn(),
    setAlwaysFocusRing: vi.fn(),
    setDetectionPrompts: vi.fn(),
    setAmbiguityDefault: vi.fn(),
  };
}

function stubCapture(): UseSignalCapture {
  return {
    status: { active: false, path: null, bytesWritten: 0 },
    error: null,
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
    refresh: vi.fn(async () => undefined),
  };
}

function stubWorkingHours(
  cfg: WorkingHours,
  overrides: Partial<UseWorkingHours> = {},
): UseWorkingHours {
  return {
    workingHours: cfg,
    setEnabled: vi.fn(),
    setStartMinute: vi.fn(),
    setEndMinute: vi.fn(),
    setThrottleMinutes: vi.fn(),
    setIdleMinutes: vi.fn(),
    ...overrides,
  };
}

function renderWith(wh: UseWorkingHours) {
  return render(
    <SettingsView
      density="comfy"
      a11y={stubA11y()}
      capture={stubCapture()}
      workingHours={wh}
    />,
  );
}

describe("minutesToHhMm / hhMmToMinutes", () => {
  it("round-trips a time", () => {
    expect(minutesToHhMm(9 * 60 + 30)).toBe("09:30");
    expect(hhMmToMinutes("09:30")).toBe(9 * 60 + 30);
  });

  it("clamps out-of-range minutes", () => {
    expect(minutesToHhMm(-5)).toBe("00:00");
    expect(minutesToHhMm(24 * 60 + 100)).toBe("23:59");
  });

  it("rejects unparseable or out-of-range input", () => {
    expect(hhMmToMinutes("nope")).toBeNull();
    expect(hhMmToMinutes("24:00")).toBeNull();
    expect(hhMmToMinutes("10:99")).toBeNull();
  });
});

describe("WorkingHoursSection", () => {
  it("hides the section when no working-hours prop is given", () => {
    render(
      <SettingsView density="comfy" a11y={stubA11y()} capture={stubCapture()} />,
    );
    expect(
      screen.queryByRole("switch", { name: /remind me to track time/i }),
    ).toBeNull();
  });

  it("shows only the toggle when disabled", () => {
    renderWith(stubWorkingHours(WORKING_HOURS_OFF));
    expect(
      screen.getByRole("switch", { name: /remind me to track time/i }),
    ).toBeTruthy();
    expect(screen.queryByLabelText(/working hours start/i)).toBeNull();
  });

  it("reveals the detail controls when enabled", () => {
    renderWith(
      stubWorkingHours({ ...WORKING_HOURS_OFF, enabled: true, startMinute: 540, endMinute: 1020 }),
    );
    expect(
      (screen.getByLabelText(/working hours start/i) as HTMLInputElement).value,
    ).toBe("09:00");
    expect(
      (screen.getByLabelText(/working hours end/i) as HTMLInputElement).value,
    ).toBe("17:00");
    expect(screen.getByLabelText(/idle before reminding/i)).toBeTruthy();
    expect(screen.getByLabelText(/reminder throttle/i)).toBeTruthy();
  });

  it("toggles the feature on", () => {
    const setEnabled = vi.fn();
    renderWith(stubWorkingHours(WORKING_HOURS_OFF, { setEnabled }));
    fireEvent.click(
      screen.getByRole("switch", { name: /remind me to track time/i }),
    );
    expect(setEnabled).toHaveBeenCalledWith(true);
  });

  it("forwards a valid start-time edit", () => {
    const setStartMinute = vi.fn();
    renderWith(
      stubWorkingHours(
        { ...WORKING_HOURS_OFF, enabled: true },
        { setStartMinute },
      ),
    );
    fireEvent.change(screen.getByLabelText(/working hours start/i), {
      target: { value: "08:15" },
    });
    expect(setStartMinute).toHaveBeenCalledWith(8 * 60 + 15);
  });

  it("forwards a valid end-time edit", () => {
    const setEndMinute = vi.fn();
    renderWith(
      stubWorkingHours(
        { ...WORKING_HOURS_OFF, enabled: true },
        { setEndMinute },
      ),
    );
    fireEvent.change(screen.getByLabelText(/working hours end/i), {
      target: { value: "18:45" },
    });
    expect(setEndMinute).toHaveBeenCalledWith(18 * 60 + 45);
  });

  it("ignores an unparseable end-time edit", () => {
    const setEndMinute = vi.fn();
    renderWith(
      stubWorkingHours(
        { ...WORKING_HOURS_OFF, enabled: true },
        { setEndMinute },
      ),
    );
    fireEvent.change(screen.getByLabelText(/working hours end/i), {
      target: { value: "" },
    });
    expect(setEndMinute).not.toHaveBeenCalled();
  });

  it("forwards idle and throttle selects", () => {
    const setIdleMinutes = vi.fn();
    const setThrottleMinutes = vi.fn();
    renderWith(
      stubWorkingHours(
        { ...WORKING_HOURS_OFF, enabled: true },
        { setIdleMinutes, setThrottleMinutes },
      ),
    );
    fireEvent.change(screen.getByLabelText(/idle before reminding/i), {
      target: { value: "15" },
    });
    expect(setIdleMinutes).toHaveBeenCalledWith(15);
    fireEvent.change(screen.getByLabelText(/reminder throttle/i), {
      target: { value: "60" },
    });
    expect(setThrottleMinutes).toHaveBeenCalledWith(60);
  });
});
