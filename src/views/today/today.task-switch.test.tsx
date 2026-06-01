import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { BackendEntry } from "../../lib/ipc";
import type { RuleMatchEvent } from "../../lib/types";
import type { TaskSwitchPrefs } from "../../lib/task-switch";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(null),
}));

const RUNNING: BackendEntry = {
  id: "e1",
  projectId: "acme",
  taskId: null,
  description: "",
  startedAt: "2026-06-01T09:00:00Z",
  endedAt: null,
  source: "manual",
  ruleId: "r-acme",
};

let runningOverride: BackendEntry | null = RUNNING;
vi.mock("../../lib/use-timer", () => ({
  useTimer: () => ({
    running: runningOverride,
    loading: false,
    error: null,
    elapsedMs: 0,
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    refresh: vi.fn().mockResolvedValue(undefined),
    update: vi.fn().mockResolvedValue(undefined),
  }),
}));

// A suggestive match for a *different* project than the running timer.
const SUGGESTION: RuleMatchEvent = {
  ruleId: "r-cairn",
  ruleName: "Cairn repo",
  confidence: "suggestive",
  ambiguityBehavior: "prompt",
  project: "cairn",
  tags: [],
  description: "",
};
let suggestionOverride: RuleMatchEvent | null = SUGGESTION;
vi.mock("../../lib/use-suggestion", () => ({
  useSuggestion: () => ({
    suggestion: suggestionOverride,
    confirm: vi.fn(),
    dismiss: vi.fn(),
    snoozeEverything: vi.fn(),
  }),
}));

const switchConfirm = vi.fn();
const switchDismiss = vi.fn();
let activeOverride: RuleMatchEvent | null = null;
vi.mock("../../lib/use-task-switch-prompt", () => ({
  useTaskSwitchPrompt: () => ({
    active: activeOverride,
    confirm: switchConfirm,
    dismiss: switchDismiss,
  }),
}));

import { TodayView } from "./index";

const ON: TaskSwitchPrefs = {
  enabled: true,
  dwellSeconds: 60,
  throttleMinutes: 30,
};
const OFF: TaskSwitchPrefs = {
  enabled: false,
  dwellSeconds: 60,
  throttleMinutes: 30,
};

function renderToday(
  taskSwitch: TaskSwitchPrefs,
  detectionPrompts: "subtle" | "modal" | "off" = "subtle",
) {
  return render(
    <TodayView
      density="comfy"
      layoutVariant="default"
      onOpenRule={vi.fn()}
      detectionPrompts={detectionPrompts}
      taskSwitch={taskSwitch}
    />,
  );
}

afterEach(() => {
  vi.clearAllMocks();
  runningOverride = RUNNING;
  suggestionOverride = SUGGESTION;
  activeOverride = null;
});

describe("TodayView task-switch wiring (#105)", () => {
  it("suppresses the generic suggestion banner for a switch candidate when enabled", () => {
    renderToday(ON);
    expect(
      screen.queryByRole("region", { name: /auto-detected work/i }),
    ).toBeNull();
  });

  it("still shows the generic banner when the feature is off", () => {
    renderToday(OFF);
    expect(
      screen.getByRole("region", { name: /auto-detected work/i }),
    ).toBeTruthy();
  });

  it("still shows the generic banner when the match is the same project as running", () => {
    suggestionOverride = { ...SUGGESTION, project: "acme" };
    renderToday(ON);
    expect(
      screen.getByRole("region", { name: /auto-detected work/i }),
    ).toBeTruthy();
  });

  it("renders the switch banner and wires Switch to confirm", () => {
    activeOverride = SUGGESTION;
    renderToday(ON);
    expect(
      screen.getByRole("region", { name: /task switch detected/i }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /^switch$/i }));
    expect(switchConfirm).toHaveBeenCalledTimes(1);
  });

  it("renders the switch banner as a modal alertdialog in modal style", () => {
    activeOverride = SUGGESTION;
    renderToday(ON, "modal");
    expect(screen.getByRole("alertdialog")).toBeTruthy();
  });

  it("renders no switch banner when detection prompts are off", () => {
    activeOverride = SUGGESTION;
    renderToday(ON, "off");
    expect(
      screen.queryByRole("region", { name: /task switch detected/i }),
    ).toBeNull();
  });
});
