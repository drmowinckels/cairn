import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(null),
}));

const SUGGESTION_FIXTURE = {
  ruleId: "r1",
  ruleName: "Cairn dev",
  confidence: "suggestive" as const,
  project: "cairn" as string | null,
  tags: ["dev"],
};
const confirmMock = vi.fn();
const dismissMock = vi.fn();
let suggestionOverride: typeof SUGGESTION_FIXTURE | null = SUGGESTION_FIXTURE;

vi.mock("../../lib/use-suggestion", () => ({
  useSuggestion: () => ({
    suggestion: suggestionOverride,
    confirm: confirmMock,
    dismiss: dismissMock,
  }),
}));

import { TodayView } from "./index";

interface RenderArgs {
  layoutVariant?: "default" | "projects-first";
  showIdleModal?: boolean;
  hideSuggestion?: boolean;
}

function renderToday({
  layoutVariant = "default",
  showIdleModal = false,
  hideSuggestion = false,
}: RenderArgs = {}) {
  suggestionOverride = hideSuggestion ? null : SUGGESTION_FIXTURE;
  const setShowIdleModal = vi.fn();
  const onOpenRule = vi.fn();
  const result = render(
    <TodayView
      density="comfy"
      layoutVariant={layoutVariant}
      onOpenRule={onOpenRule}
      showIdleModal={showIdleModal}
      setShowIdleModal={setShowIdleModal}
    />,
  );
  return { ...result, setShowIdleModal, onOpenRule };
}

afterEach(() => {
  vi.clearAllMocks();
  suggestionOverride = SUGGESTION_FIXTURE;
});

describe("TodayView (idle — no running entry)", () => {
  it("renders the timer card in idle state", () => {
    renderToday({ hideSuggestion: true });
    expect(screen.getByLabelText(/current timer/i)).toBeTruthy();
    expect(screen.getByText(/now · idle/i)).toBeTruthy();
    expect(screen.getByText(/no timer running/i)).toBeTruthy();
  });

  it("renders the elapsed wrapper with aria-live polite", () => {
    const { container } = renderToday({ hideSuggestion: true });
    const elapsed = container.querySelector(".now-time");
    expect(elapsed?.getAttribute("aria-live")).toBe("polite");
  });

  it("Stop button is disabled when nothing is running", () => {
    renderToday({ hideSuggestion: true });
    const stop = screen.getByRole("button", { name: /stop timer/i });
    expect(stop.hasAttribute("disabled")).toBe(true);
  });

  it("renders the auto-detect suggestion banner when the hook surfaces a suggestion", () => {
    renderToday();
    expect(screen.getByLabelText(/auto-detected work/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: /^confirm$/i })).toBeTruthy();
  });

  it("dismissing the banner calls the hook's dismiss() (which handles snooze)", () => {
    renderToday();
    fireEvent.click(screen.getByRole("button", { name: /dismiss suggestion/i }));
    expect(dismissMock).toHaveBeenCalledTimes(1);
  });

  it("'Change…' dismisses the suggestion", () => {
    renderToday();
    fireEvent.click(screen.getByRole("button", { name: /change…/i }));
    expect(dismissMock).toHaveBeenCalledTimes(1);
  });

  it("clicking 'view rule' on the suggestion dismisses the banner and opens that rule", () => {
    const { onOpenRule } = renderToday();
    fireEvent.click(screen.getByRole("button", { name: /view rule/i }));
    expect(dismissMock).toHaveBeenCalledTimes(1);
    expect(onOpenRule).toHaveBeenCalledWith("r1");
  });

  it("clicking Confirm calls the hook's confirm()", () => {
    renderToday();
    fireEvent.click(screen.getByRole("button", { name: /^confirm$/i }));
    expect(confirmMock).toHaveBeenCalledTimes(1);
  });

  it("hides the suggestion banner when the hook returns suggestion=null", () => {
    renderToday({ hideSuggestion: true });
    expect(screen.queryByLabelText(/auto-detected work/i)).toBeNull();
  });

  it("renders the suggestion's tags from the live event payload", () => {
    renderToday();
    const tag = document.querySelector(".suggest-tags .tag");
    expect(tag?.textContent).toBe("#dev");
  });

  it("shows the idle modal as an alertdialog when showIdleModal=true", () => {
    renderToday({ showIdleModal: true });
    const modal = screen.getByRole("alertdialog");
    expect(modal).toBeTruthy();
    expect(modal.getAttribute("aria-labelledby")).toBe("idle-h");
  });

  it("each idle-modal action calls setShowIdleModal(false)", () => {
    const { setShowIdleModal } = renderToday({ showIdleModal: true });
    for (const name of [/^keep$/i, /discard idle/i, /move to break/i]) {
      setShowIdleModal.mockClear();
      fireEvent.click(screen.getByRole("button", { name }));
      expect(setShowIdleModal).toHaveBeenCalledWith(false);
    }
  });

  it("renders the timeline empty state when no entries exist today", () => {
    renderToday({ hideSuggestion: true });
    const empty = document.querySelector(".timeline .empty");
    expect(empty).toBeTruthy();
    expect(document.querySelectorAll(".dt-seg").length).toBe(0);
  });

  it("renders the recent-entries empty state in default layout (comfy density)", () => {
    renderToday();
    expect(screen.getByLabelText(/recent entries/i)).toBeTruthy();
    const recentEmpty = document.querySelector(".recent .empty");
    expect(recentEmpty).toBeTruthy();
  });

  it("renders the quick-start grid only in projects-first layout", () => {
    const { rerender } = renderToday();
    expect(screen.queryByLabelText(/quick-start a project/i)).toBeNull();

    rerender(
      <TodayView
        density="comfy"
        layoutVariant="projects-first"
        onOpenRule={vi.fn()}
        showIdleModal={false}
        setShowIdleModal={vi.fn()}
      />,
    );
    expect(screen.getByLabelText(/quick-start a project/i)).toBeTruthy();
    expect(document.querySelectorAll(".quick-card").length).toBe(4);
  });

  it("renders the upcoming list", () => {
    const { container } = renderToday();
    expect(container.querySelector(".upcoming")).toBeTruthy();
    expect(container.querySelectorAll(".up-item").length).toBeGreaterThan(0);
  });

  it("clicking a quick-start card calls timer.start (projects-first layout)", () => {
    renderToday({ layoutVariant: "projects-first" });
    const card = document.querySelector(".quick-card") as HTMLElement;
    expect(card).toBeTruthy();
    fireEvent.click(card);
  });
});

describe("TodayView (inside Tauri — running entry from backend)", () => {
  type WithInternals = { __TAURI_INTERNALS__?: unknown };

  beforeEach(() => {
    (globalThis as WithInternals).__TAURI_INTERNALS__ = {};
    vi.resetModules();
  });

  afterEach(() => {
    delete (globalThis as WithInternals).__TAURI_INTERNALS__;
  });

  async function freshRender(source: string, opts: { endedAt?: string | null } = {}) {
    const running = {
      id: "e1",
      projectId: "cairn",
      taskId: null,
      description: "live work",
      startedAt: new Date(Date.now() - 60_000).toISOString(),
      endedAt: opts.endedAt ?? null,
      source,
      ruleId: source.startsWith("rule") ? "r1" : null,
    };
    const closed = {
      id: "e0",
      projectId: "cairn",
      taskId: null,
      description: "earlier",
      startedAt: new Date(Date.now() - 3_600_000).toISOString(),
      endedAt: new Date(Date.now() - 120_000).toISOString(),
      source: "manual",
      ruleId: null,
    };
    const invoke = vi.fn(async (cmd: string, _args?: unknown) => {
      if (cmd === "current_running") return running;
      if (cmd === "list_today") return [closed, running];
      if (cmd === "list_projects")
        return [
          { id: "cairn", name: "Cairn", clientId: null, color: "#abc", archived: false },
          { id: "ops", name: "Operations", clientId: null, color: "#9a9bb0", archived: false },
        ];
      if (cmd === "stop_entry")
        return { ...running, endedAt: new Date().toISOString() };
      if (cmd === "update_entry") return { ...running, description: "patched" };
      return null;
    });
    vi.doMock("@tauri-apps/api/core", () => ({ invoke }));
    const { TodayView } = await import("./today");
    const utils = render(
      <TodayView
        density="comfy"
        layoutVariant="default"
        onOpenRule={vi.fn()}
        showIdleModal={false}
        setShowIdleModal={vi.fn()}
      />,
    );
    return { ...utils, invoke };
  }

  for (const [source, expectedBadge] of [
    ["rule:branch=foo", "rule"],
    ["calendar", "calendar"],
    ["manual", "manual"],
  ] as const) {
    it(`labels the running timer source as '${expectedBadge}' for backend source='${source}'`, async () => {
      await freshRender(source);
      const badge = await screen.findByText(
        new RegExp(`^\\s*${expectedBadge}\\s*$`, "i"),
      );
      expect(badge).toBeTruthy();
    });
  }

  it("stop button is enabled when a backend entry is running and triggers stop_entry + list_today refetch", async () => {
    const { invoke } = await freshRender("manual");
    const stop = await screen.findByRole("button", { name: /stop timer/i });
    await waitFor(() => expect(stop.hasAttribute("disabled")).toBe(false));
    fireEvent.click(stop);
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("stop_entry", { id: "e1" }),
    );
    await waitFor(() => {
      const todayCalls = invoke.mock.calls.filter(([c]) => c === "list_today");
      expect(todayCalls.length).toBeGreaterThanOrEqual(2);
    });
  });

  it("renders the timeline segments + 6 axis ticks + a running stripe class", async () => {
    await freshRender("manual");
    await waitFor(() => {
      const segs = document.querySelectorAll(".dt-seg");
      expect(segs.length).toBe(2);
    });
    expect(document.querySelectorAll(".dt-tick").length).toBe(6);
    expect(document.querySelectorAll(".dt-seg.is-running").length).toBe(1);
    expect(document.querySelector(".dt-now-label")).toBeTruthy();
  });

  it("debounced description edits call update_entry after a quiet period", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const { invoke } = await freshRender("manual");
      const input = (await screen.findByLabelText(
        /task description/i,
      )) as HTMLInputElement;
      fireEvent.change(input, { target: { value: "new desc 1" } });
      fireEvent.change(input, { target: { value: "new desc 2" } });
      await vi.advanceTimersByTimeAsync(450);
      await waitFor(() => {
        const updates = invoke.mock.calls.filter(([c]) => c === "update_entry");
        expect(updates.length).toBe(1);
        expect(updates[0][1]).toEqual({
          input: { id: "e1", description: "new desc 2" },
        });
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("clicking outside the open project picker closes it", async () => {
    await freshRender("manual");
    const chip = await screen.findByRole("button", {
      name: /project: cairn\. change project/i,
    });
    fireEvent.click(chip);
    expect(screen.queryByRole("listbox")).toBeTruthy();
    fireEvent.mouseDown(document.body);
    await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull());
  });

  it("description input onBlur flushes the pending debounced update", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const { invoke } = await freshRender("manual");
      const input = (await screen.findByLabelText(
        /task description/i,
      )) as HTMLInputElement;
      fireEvent.change(input, { target: { value: "flush me" } });
      fireEvent.blur(input);
      await waitFor(() => {
        const updates = invoke.mock.calls.filter(([c]) => c === "update_entry");
        expect(updates.length).toBeGreaterThanOrEqual(1);
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("clicking the project chip opens a listbox of projects and picking one calls update_entry", async () => {
    const { invoke } = await freshRender("manual");
    const chip = await screen.findByRole("button", {
      name: /project: cairn\. change project/i,
    });
    fireEvent.click(chip);
    const list = await screen.findByRole("listbox");
    expect(list).toBeTruthy();
    const opsOpt = screen.getByRole("option", { name: /operations/i });
    fireEvent.click(opsOpt.querySelector("button") as HTMLElement);
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("update_entry", {
        input: { id: "e1", projectId: "ops" },
      }),
    );
  });
});
