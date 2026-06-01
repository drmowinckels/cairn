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
import type { UseRequiredFieldsPrefs } from "../../lib/use-required-fields-prefs";
import { REQUIRED_FIELDS_OFF, type RequiredFieldsPrefs } from "../../lib/required-fields";

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

function stubRequired(
  prefs: RequiredFieldsPrefs,
  overrides: Partial<UseRequiredFieldsPrefs> = {},
): UseRequiredFieldsPrefs {
  return {
    prefs,
    setRequireProject: vi.fn(),
    setRequireDescription: vi.fn(),
    ...overrides,
  };
}

function renderWith(rf: UseRequiredFieldsPrefs) {
  return render(
    <SettingsView
      density="comfy"
      a11y={stubA11y()}
      capture={stubCapture()}
      requiredFields={rf}
    />,
  );
}

describe("RequiredFieldsSection", () => {
  it("hides the section when no requiredFields prop is given", () => {
    render(
      <SettingsView
        density="comfy"
        a11y={stubA11y()}
        capture={stubCapture()}
      />,
    );
    expect(
      screen.queryByRole("switch", { name: /require a project to stop/i }),
    ).toBeNull();
    expect(
      screen.queryByRole("switch", { name: /require a description to stop/i }),
    ).toBeNull();
  });

  it("renders both toggles when requiredFields prop is provided", () => {
    renderWith(stubRequired(REQUIRED_FIELDS_OFF));
    expect(
      screen.getByRole("switch", { name: /require a project to stop/i }),
    ).toBeTruthy();
    expect(
      screen.getByRole("switch", { name: /require a description to stop/i }),
    ).toBeTruthy();
  });

  it("toggles are off by default (both prefs default false)", () => {
    renderWith(stubRequired(REQUIRED_FIELDS_OFF));
    const projectToggle = screen.getByRole("switch", { name: /require a project to stop/i });
    const descToggle = screen.getByRole("switch", { name: /require a description to stop/i });
    expect(projectToggle.getAttribute("aria-checked")).toBe("false");
    expect(descToggle.getAttribute("aria-checked")).toBe("false");
  });

  it("reflects requireProject: true in the toggle", () => {
    renderWith(stubRequired({ requireProject: true, requireDescription: false }));
    const toggle = screen.getByRole("switch", { name: /require a project to stop/i });
    expect(toggle.getAttribute("aria-checked")).toBe("true");
  });

  it("reflects requireDescription: true in the toggle", () => {
    renderWith(stubRequired({ requireProject: false, requireDescription: true }));
    const toggle = screen.getByRole("switch", { name: /require a description to stop/i });
    expect(toggle.getAttribute("aria-checked")).toBe("true");
  });

  it("clicking the project toggle calls setRequireProject(true) when currently off", () => {
    const setRequireProject = vi.fn();
    renderWith(stubRequired(REQUIRED_FIELDS_OFF, { setRequireProject }));
    fireEvent.click(screen.getByRole("switch", { name: /require a project to stop/i }));
    expect(setRequireProject).toHaveBeenCalledWith(true);
  });

  it("clicking the description toggle calls setRequireDescription(true) when currently off", () => {
    const setRequireDescription = vi.fn();
    renderWith(stubRequired(REQUIRED_FIELDS_OFF, { setRequireDescription }));
    fireEvent.click(screen.getByRole("switch", { name: /require a description to stop/i }));
    expect(setRequireDescription).toHaveBeenCalledWith(true);
  });

  it("clicking the project toggle calls setRequireProject(false) when currently on", () => {
    const setRequireProject = vi.fn();
    renderWith(
      stubRequired({ requireProject: true, requireDescription: false }, { setRequireProject }),
    );
    fireEvent.click(screen.getByRole("switch", { name: /require a project to stop/i }));
    expect(setRequireProject).toHaveBeenCalledWith(false);
  });

  it("clicking the description toggle calls setRequireDescription(false) when currently on", () => {
    const setRequireDescription = vi.fn();
    renderWith(
      stubRequired({ requireProject: false, requireDescription: true }, { setRequireDescription }),
    );
    fireEvent.click(screen.getByRole("switch", { name: /require a description to stop/i }));
    expect(setRequireDescription).toHaveBeenCalledWith(false);
  });
});
