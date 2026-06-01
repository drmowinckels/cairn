import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({
  ask: vi.fn(),
  open: vi.fn(),
  save: vi.fn(),
}));

import { SettingsView } from "./settings";
import type { UseA11yPrefs } from "../../lib/use-a11y-prefs";
import type { UseSignalCapture } from "../../lib/use-signal-capture";
import type { UseTaskSwitchPrefs } from "../../lib/use-task-switch-prefs";
import { TASK_SWITCH_OFF, type TaskSwitchPrefs } from "../../lib/task-switch";

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

function stubTaskSwitch(
  prefs: TaskSwitchPrefs,
  overrides: Partial<UseTaskSwitchPrefs> = {},
): UseTaskSwitchPrefs {
  return {
    prefs,
    setEnabled: vi.fn(),
    setDwellSeconds: vi.fn(),
    setThrottleMinutes: vi.fn(),
    ...overrides,
  };
}

function renderWith(ts: UseTaskSwitchPrefs) {
  return render(
    <SettingsView
      density="comfy"
      a11y={stubA11y()}
      capture={stubCapture()}
      taskSwitch={ts}
    />,
  );
}

describe("TaskSwitchSection", () => {
  it("hides the section when no task-switch prop is given", () => {
    render(
      <SettingsView
        density="comfy"
        a11y={stubA11y()}
        capture={stubCapture()}
      />,
    );
    expect(
      screen.queryByRole("switch", { name: /ask when i switch tasks/i }),
    ).toBeNull();
  });

  it("shows only the toggle when disabled", () => {
    renderWith(stubTaskSwitch(TASK_SWITCH_OFF));
    expect(
      screen.getByRole("switch", { name: /ask when i switch tasks/i }),
    ).toBeTruthy();
    expect(screen.queryByLabelText(/wait before asking/i)).toBeNull();
  });

  it("reveals the dwell + throttle controls when enabled", () => {
    renderWith(stubTaskSwitch({ ...TASK_SWITCH_OFF, enabled: true }));
    expect(
      (screen.getByLabelText(/wait before asking/i) as HTMLSelectElement).value,
    ).toBe("60");
    expect(screen.getByLabelText(/switch prompt throttle/i)).toBeTruthy();
  });

  it("toggles the feature on", () => {
    const setEnabled = vi.fn();
    renderWith(stubTaskSwitch(TASK_SWITCH_OFF, { setEnabled }));
    fireEvent.click(
      screen.getByRole("switch", { name: /ask when i switch tasks/i }),
    );
    expect(setEnabled).toHaveBeenCalledWith(true);
  });

  it("forwards dwell and throttle selects", () => {
    const setDwellSeconds = vi.fn();
    const setThrottleMinutes = vi.fn();
    renderWith(
      stubTaskSwitch(
        { ...TASK_SWITCH_OFF, enabled: true },
        { setDwellSeconds, setThrottleMinutes },
      ),
    );
    fireEvent.change(screen.getByLabelText(/wait before asking/i), {
      target: { value: "30" },
    });
    expect(setDwellSeconds).toHaveBeenCalledWith(30);
    fireEvent.change(screen.getByLabelText(/switch prompt throttle/i), {
      target: { value: "60" },
    });
    expect(setThrottleMinutes).toHaveBeenCalledWith(60);
  });

  it("labels sub-minute dwells in seconds and longer ones in minutes", () => {
    renderWith(stubTaskSwitch({ ...TASK_SWITCH_OFF, enabled: true }));
    const select = screen.getByLabelText(/wait before asking/i);
    expect(screen.getByRole("option", { name: "30 sec" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "1 min" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "5 min" })).toBeTruthy();
    expect(select).toBeTruthy();
  });
});
