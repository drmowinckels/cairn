import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { BackendEntry } from "../../lib/ipc";
import type { RuleMatchEvent } from "../../lib/types";
import type { SuggestionFeedbackEvent } from "../../lib/review-insights";

const FEEDBACK_KEY = "cairn:suggestion-feedback:v1";
const DISMISSED_KEY = "cairn:rule-learning:dismissed:v1";

const h = vi.hoisted(() => ({
  confirm: vi.fn(async () => {}),
  dismiss: vi.fn(async () => {}),
  rulesAdd: vi.fn(async () => "new-rule"),
  rulesUpdate: vi.fn(async () => {}),
  suggestion: null as RuleMatchEvent | null,
}));

vi.mock("../../lib/use-suggestion", () => ({
  useSuggestion: () => ({
    suggestion: h.suggestion,
    confirm: h.confirm,
    dismiss: h.dismiss,
  }),
}));
vi.mock("../../lib/use-task-switch-prompt", () => ({
  useTaskSwitchPrompt: () => ({
    active: null,
    confirm: vi.fn(),
    dismiss: vi.fn(),
  }),
}));
vi.mock("../../lib/use-rules", async () => {
  const actual = await vi.importActual<typeof import("../../lib/use-rules")>(
    "../../lib/use-rules",
  );
  return {
    ...actual,
    useRules: () => ({ add: h.rulesAdd, update: h.rulesUpdate }),
  };
});

const PROJECTS = [
  { id: "p1", name: "Cairn", clientId: null, color: "#abc", archived: false },
  { id: "p2", name: "Atlas", clientId: null, color: "#def", archived: false },
];

const SUGGESTION: RuleMatchEvent = {
  ruleId: "r1",
  ruleName: "Cairn dev",
  confidence: "suggestive",
  ambiguityBehavior: "prompt",
  project: "p1",
  tags: [],
  description: "",
  matchedSignals: [{ signal: "git.branch", value: "feat/x" }],
};

function entry(over: Partial<BackendEntry>): BackendEntry {
  return {
    id: "e",
    projectId: null,
    taskId: null,
    description: "",
    startedAt: "2026-06-06T08:00:00Z",
    endedAt: "2026-06-06T08:30:00Z",
    source: "manual",
    ruleId: null,
    ...over,
  };
}

function feedback(
  over: Partial<SuggestionFeedbackEvent> = {},
): SuggestionFeedbackEvent {
  return {
    timestamp: new Date().toISOString(),
    ruleId: "r1",
    ruleName: "Cairn dev",
    sourceProjectId: "p1",
    selectedProjectId: null,
    matchedSignals: [{ signal: "git.branch", value: "feat/x" }],
    outcome: "confirmed",
    ...over,
  };
}

type WithInternals = { __TAURI_INTERNALS__?: unknown };

interface RenderOpts {
  suggestion?: RuleMatchEvent | null;
  entries?: BackendEntry[];
  feedbackEvents?: SuggestionFeedbackEvent[];
  updateError?: unknown;
}

async function renderToday({
  suggestion = null,
  entries = [],
  feedbackEvents,
  updateError,
}: RenderOpts = {}) {
  h.suggestion = suggestion;
  if (feedbackEvents) {
    window.localStorage.setItem(FEEDBACK_KEY, JSON.stringify(feedbackEvents));
  }
  const invoke = vi.fn(async (cmd: string, _args?: unknown) => {
    if (cmd === "list_day") return entries;
    if (cmd === "list_projects") return PROJECTS;
    if (cmd === "current_running") return null;
    if (cmd === "update_entry") {
      if (updateError !== undefined) throw updateError;
      return null;
    }
    return null;
  });
  vi.doMock("@tauri-apps/api/core", () => ({ invoke }));
  const { TodayView } = await import("./today");
  const onOpenRule = vi.fn();
  const utils = render(
    <TodayView
      density="comfy"
      layoutVariant="default"
      onOpenRule={onOpenRule}
    />,
  );
  await waitFor(() =>
    expect(screen.getByLabelText(/review inbox/i)).toBeTruthy(),
  );
  return { ...utils, onOpenRule, invoke };
}

function storedFeedback(): SuggestionFeedbackEvent[] {
  return JSON.parse(window.localStorage.getItem(FEEDBACK_KEY) ?? "[]");
}

function lastFeedback(): SuggestionFeedbackEvent | undefined {
  const events = storedFeedback();
  return events[events.length - 1];
}

describe("TodayView review/insight surfaces (#191)", () => {
  beforeEach(() => {
    (globalThis as WithInternals).__TAURI_INTERNALS__ = {};
    vi.resetModules();
    window.localStorage.clear();
    h.suggestion = null;
    h.rulesAdd.mockResolvedValue("new-rule");
    h.rulesUpdate.mockResolvedValue(undefined);
  });
  afterEach(() => {
    delete (globalThis as WithInternals).__TAURI_INTERNALS__;
    vi.clearAllMocks();
  });

  describe("learned-rule prompt", () => {
    const candidateFeedback = [feedback(), feedback(), feedback()];

    it("offers to save a repeated pattern as an explicit rule", async () => {
      await renderToday({ feedbackEvents: candidateFeedback });
      expect(screen.getByLabelText(/rule learning prompt/i)).toBeTruthy();
      expect(screen.getByText(/git\.branch: feat\/x/i)).toBeTruthy();
      expect(screen.getByText(/3 confirms, 0 corrections/i)).toBeTruthy();
    });

    it("creates the rule, opens it, and clears the prompt on save", async () => {
      const { onOpenRule } = await renderToday({
        feedbackEvents: candidateFeedback,
      });
      fireEvent.click(screen.getByRole("button", { name: /save as rule/i }));

      await waitFor(() => expect(h.rulesAdd).toHaveBeenCalledTimes(1));
      expect(h.rulesUpdate).toHaveBeenCalledWith("new-rule", {
        name: "Learned: Cairn dev",
        confidence: "suggestive",
        when: [{ signal: "git.branch", op: "contains", value: "feat/x" }],
        then: { project: "p1" },
      });
      expect(onOpenRule).toHaveBeenCalledWith("new-rule");
      await waitFor(() =>
        expect(screen.queryByLabelText(/rule learning prompt/i)).toBeNull(),
      );
      expect(window.localStorage.getItem(DISMISSED_KEY)).toBe(
        "r1|git.branch:feat/x",
      );
    });

    it("dismisses the prompt without creating a rule", async () => {
      await renderToday({ feedbackEvents: candidateFeedback });
      fireEvent.click(screen.getByRole("button", { name: /^dismiss$/i }));

      await waitFor(() =>
        expect(screen.queryByLabelText(/rule learning prompt/i)).toBeNull(),
      );
      expect(h.rulesAdd).not.toHaveBeenCalled();
      expect(window.localStorage.getItem(DISMISSED_KEY)).toBe(
        "r1|git.branch:feat/x",
      );
    });

    it("surfaces an error and keeps the prompt when saving fails", async () => {
      h.rulesAdd.mockRejectedValue(new Error("boom"));
      const { onOpenRule } = await renderToday({
        feedbackEvents: candidateFeedback,
      });
      fireEvent.click(screen.getByRole("button", { name: /save as rule/i }));

      await waitFor(() =>
        expect(screen.getByRole("alert").textContent).toMatch(
          /couldn't save the rule/i,
        ),
      );
      expect(onOpenRule).not.toHaveBeenCalled();
      expect(screen.getByLabelText(/rule learning prompt/i)).toBeTruthy();
      expect(
        (
          screen.getByRole("button", {
            name: /save as rule/i,
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(false);
    });

    it("stringifies a non-Error save failure", async () => {
      h.rulesAdd.mockRejectedValue("raw failure");
      await renderToday({ feedbackEvents: candidateFeedback });
      fireEvent.click(screen.getByRole("button", { name: /save as rule/i }));

      await waitFor(() =>
        expect(screen.getByRole("alert").textContent).toMatch(/raw failure/i),
      );
    });
  });

  describe("review inbox + batch assignment", () => {
    const unassigned = [
      entry({
        id: "e1",
        projectId: null,
        startedAt: "2026-06-06T08:00:00Z",
        endedAt: "2026-06-06T08:30:00Z",
      }),
      entry({
        id: "e2",
        projectId: null,
        startedAt: "2026-06-06T09:00:00Z",
        endedAt: "2026-06-06T10:00:00Z",
      }),
    ];

    it("lists unassigned time and timeline gaps", async () => {
      await renderToday({ entries: unassigned });
      expect(screen.getByText(/unassigned time/i)).toBeTruthy();
      expect(screen.getByText(/timeline gaps/i)).toBeTruthy();
    });

    it("assigns every unassigned entry to the chosen project", async () => {
      const { invoke } = await renderToday({ entries: unassigned });
      const apply = screen.getByRole("button", {
        name: /apply to unassigned/i,
      });
      expect((apply as HTMLButtonElement).disabled).toBe(true);

      fireEvent.change(screen.getByLabelText(/project for batch assignment/i), {
        target: { value: "p2" },
      });
      expect((apply as HTMLButtonElement).disabled).toBe(false);
      fireEvent.click(apply);

      await waitFor(() => {
        const calls = invoke.mock.calls.filter((c) => c[0] === "update_entry");
        expect(calls).toHaveLength(2);
        expect(
          calls.map(
            (c) => (c[1] as { input: { projectId: string } }).input.projectId,
          ),
        ).toEqual(["p2", "p2"]);
      });
    });

    it("shows an error when a batch assignment fails", async () => {
      await renderToday({
        entries: unassigned,
        updateError: new Error("save failed"),
      });
      fireEvent.change(screen.getByLabelText(/project for batch assignment/i), {
        target: { value: "p1" },
      });
      fireEvent.click(
        screen.getByRole("button", { name: /apply to unassigned/i }),
      );

      await waitFor(() =>
        expect(screen.getByRole("alert").textContent).toMatch(
          /couldn't apply batch assignment — save failed/i,
        ),
      );
    });

    it("stringifies a non-Error batch failure", async () => {
      await renderToday({ entries: unassigned, updateError: "raw failure" });
      fireEvent.change(screen.getByLabelText(/project for batch assignment/i), {
        target: { value: "p1" },
      });
      fireEvent.click(
        screen.getByRole("button", { name: /apply to unassigned/i }),
      );

      await waitFor(() =>
        expect(screen.getByRole("alert").textContent).toMatch(/raw failure/i),
      );
    });

    it("clearing the project selection re-disables the apply button", async () => {
      await renderToday({ entries: unassigned });
      const select = screen.getByLabelText(/project for batch assignment/i);
      const apply = screen.getByRole("button", {
        name: /apply to unassigned/i,
      });
      fireEvent.change(select, { target: { value: "p1" } });
      expect((apply as HTMLButtonElement).disabled).toBe(false);
      fireEvent.change(select, { target: { value: "" } });
      expect((apply as HTMLButtonElement).disabled).toBe(true);
    });
  });

  describe("focus + planned-vs-actual", () => {
    it("reports a negative drift when meetings outweigh tracked work", async () => {
      await renderToday({
        entries: [
          entry({
            id: "meeting",
            projectId: "p1",
            source: "calendar",
            startedAt: "2026-06-06T09:00:00Z",
            endedAt: "2026-06-06T10:00:00Z",
          }),
          entry({
            id: "work",
            projectId: "p1",
            startedAt: "2026-06-06T10:00:00Z",
            endedAt: "2026-06-06T10:15:00Z",
          }),
        ],
      });
      const drift = screen
        .getByLabelText(/planned versus actual/i)
        .textContent?.replace(/\s+/g, " ");
      expect(drift).toMatch(/Drift\s*-/);
    });
  });

  describe("suggestion feedback capture", () => {
    it("records a confirmed outcome with the rule's project", async () => {
      await renderToday({ suggestion: SUGGESTION });
      fireEvent.click(screen.getByRole("button", { name: /confirm/i }));
      await waitFor(() => expect(h.confirm).toHaveBeenCalled());
      expect(lastFeedback()).toMatchObject({
        outcome: "confirmed",
        selectedProjectId: "p1",
      });
    });

    it("records a null project when the suggestion has none", async () => {
      await renderToday({ suggestion: { ...SUGGESTION, project: null } });
      fireEvent.click(screen.getByRole("button", { name: /confirm/i }));
      await waitFor(() => expect(h.confirm).toHaveBeenCalled());
      expect(lastFeedback()).toMatchObject({
        outcome: "confirmed",
        selectedProjectId: null,
      });
    });

    it("records a dismissal from the banner's close button", async () => {
      await renderToday({ suggestion: SUGGESTION });
      fireEvent.click(
        screen.getByRole("button", { name: /dismiss suggestion/i }),
      );
      await waitFor(() => expect(h.dismiss).toHaveBeenCalled());
      expect(lastFeedback()).toMatchObject({ outcome: "dismissed" });
    });

    it("records a single changed outcome when 'Change…' reassigns via the picker", async () => {
      await renderToday({ suggestion: SUGGESTION });
      fireEvent.click(screen.getByRole("button", { name: /change/i }));
      fireEvent.click(screen.getByRole("button", { name: /^atlas$/i }));

      await waitFor(() => {
        const changed = storedFeedback().find((e) => e.outcome === "changed");
        expect(changed?.selectedProjectId).toBe("p2");
      });
      // "Change…" must not also record a dismissal — one correction, one event.
      expect(storedFeedback().some((e) => e.outcome === "dismissed")).toBe(
        false,
      );
    });
  });
});
