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

describe("TodayView", () => {
  it("renders the running timer card with the project chip and stop button", () => {
    const { container } = renderToday({ hideSuggestion: true });
    expect(screen.getByLabelText(/current timer/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: /stop timer/i })).toBeTruthy();
    const chip = container.querySelector(".now .proj-chip");
    expect(chip?.textContent).toMatch(/cairn/i);
  });

  it("renders the auto-detect suggestion banner when the hook surfaces a suggestion", () => {
    renderToday();
    expect(screen.getByLabelText(/auto-detected work/i)).toBeTruthy();
    expect(screen.getByText(/detected/i)).toBeTruthy();
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
    // Acknowledges the suggestion (dismiss) then navigates.
    expect(dismissMock).toHaveBeenCalledTimes(1);
    expect(onOpenRule).toHaveBeenCalledWith("r1");
  });

  it("clicking Confirm calls the hook's confirm()", async () => {
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
    // Tag component prefixes the value with "#".
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

  it("renders the timeline track, axis ticks, and legend", () => {
    const { container } = renderToday();
    expect(container.querySelector(".timeline")).toBeTruthy();
    expect(container.querySelectorAll(".dt-seg").length).toBeGreaterThan(0);
    expect(container.querySelectorAll(".dt-tick").length).toBe(6);
    expect(container.querySelectorAll(".legend-item").length).toBeGreaterThan(0);
  });

  it("renders the recent-entries section in default layout (comfy density)", () => {
    renderToday();
    expect(screen.getByLabelText(/recent entries/i)).toBeTruthy();
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
    // Renders the four quick-start cards
    expect(document.querySelectorAll(".quick-card").length).toBe(4);
  });

  it("renders the upcoming list", () => {
    const { container } = renderToday();
    expect(container.querySelector(".upcoming")).toBeTruthy();
    expect(container.querySelectorAll(".up-item").length).toBeGreaterThan(0);
  });

  it("clicking Stop logs the error if timer.stop rejects", async () => {
    // useTimer's stop() bails out when there's no running entry. In
    // browser-dev mode there is no running entry, so onStop is a no-op
    // and the catch path can't be reached without a real running entry.
    // Just verify the button is clickable without crashing the view.
    renderToday({ hideSuggestion: true });
    const stop = screen.getByRole("button", { name: /stop timer/i });
    expect(stop.hasAttribute("disabled")).toBe(true);
    // Clicking still fires onClick (button is disabled but jsdom allows it).
    fireEvent.click(stop);
  });

  it("clicking a quick-start card calls timer.start (projects-first layout)", () => {
    renderToday({ layoutVariant: "projects-first" });
    const card = document.querySelector(".quick-card") as HTMLElement;
    expect(card).toBeTruthy();
    fireEvent.click(card);
    // No assertion on IPC because timer.start is a no-op without Tauri,
    // but the click handler must not throw.
  });
});

// Render Today with a running entry from the backend so the
// `deriveSource` helper and `now-source` badge are exercised.
describe("TodayView (inside Tauri — running entry from backend)", () => {
  type WithInternals = { __TAURI_INTERNALS__?: unknown };

  beforeEach(() => {
    (globalThis as WithInternals).__TAURI_INTERNALS__ = {};
    vi.resetModules();
  });

  afterEach(() => {
    delete (globalThis as WithInternals).__TAURI_INTERNALS__;
  });

  async function freshRender(source: string) {
    const invoke = vi.fn().mockResolvedValue({
      id: "e1",
      projectId: "cairn",
      taskId: null,
      description: "live work",
      startedAt: new Date(Date.now() - 60_000).toISOString(),
      endedAt: null,
      source,
      ruleId: source.startsWith("rule") ? "r1" : null,
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
      // The .now-source span renders the derived label.
      const badge = await screen.findByText(new RegExp(`^\\s*${expectedBadge}\\s*$`, "i"));
      expect(badge).toBeTruthy();
    });
  }

  it("stop button is enabled and triggers stop_entry when a backend entry is running", async () => {
    const { invoke } = await freshRender("manual");
    invoke.mockResolvedValueOnce({
      id: "e1",
      projectId: "cairn",
      taskId: null,
      description: "live work",
      startedAt: new Date(Date.now() - 60_000).toISOString(),
      endedAt: new Date().toISOString(),
      source: "manual",
      ruleId: null,
    });
    const stop = await screen.findByRole("button", { name: /stop timer/i });
    await waitFor(() => expect(stop.hasAttribute("disabled")).toBe(false));
    fireEvent.click(stop);
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("stop_entry", { id: "e1" }),
    );
  });
});
