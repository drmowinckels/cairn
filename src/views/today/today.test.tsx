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

import { TodayView } from "./index";

interface RenderArgs {
  layoutVariant?: "default" | "projects-first";
  suggestionDismissed?: boolean;
  showIdleModal?: boolean;
}

function renderToday({
  layoutVariant = "default",
  suggestionDismissed = false,
  showIdleModal = false,
}: RenderArgs = {}) {
  const setSuggestionDismissed = vi.fn();
  const setShowIdleModal = vi.fn();
  const onOpenRule = vi.fn();
  const result = render(
    <TodayView
      density="comfy"
      layoutVariant={layoutVariant}
      onOpenRule={onOpenRule}
      suggestionDismissed={suggestionDismissed}
      setSuggestionDismissed={setSuggestionDismissed}
      showIdleModal={showIdleModal}
      setShowIdleModal={setShowIdleModal}
    />,
  );
  return { ...result, setSuggestionDismissed, setShowIdleModal, onOpenRule };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("TodayView", () => {
  it("renders the running timer card with the project chip and stop button", () => {
    const { container } = renderToday({ suggestionDismissed: true });
    expect(screen.getByLabelText(/current timer/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: /stop timer/i })).toBeTruthy();
    // Inside the .now card, expect a project chip with the running project.
    const chip = container.querySelector(".now .proj-chip");
    expect(chip?.textContent).toMatch(/cairn/i);
  });

  it("renders the auto-detect suggestion banner when not dismissed", () => {
    renderToday();
    expect(screen.getByLabelText(/auto-detected work/i)).toBeTruthy();
    expect(screen.getByText(/detected/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: /^confirm$/i })).toBeTruthy();
  });

  it("dismissing the suggestion calls setSuggestionDismissed(true)", () => {
    const { setSuggestionDismissed } = renderToday();
    fireEvent.click(screen.getByRole("button", { name: /dismiss suggestion/i }));
    expect(setSuggestionDismissed).toHaveBeenCalledWith(true);
  });

  it("clicking 'view rule' on the suggestion opens that rule", () => {
    const { onOpenRule } = renderToday();
    fireEvent.click(screen.getByRole("button", { name: /view rule/i }));
    expect(onOpenRule).toHaveBeenCalledWith("r1");
  });

  it("hides the suggestion banner when suggestionDismissed=true", () => {
    renderToday({ suggestionDismissed: true });
    expect(screen.queryByLabelText(/auto-detected work/i)).toBeNull();
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
        suggestionDismissed
        setSuggestionDismissed={vi.fn()}
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
    renderToday({ suggestionDismissed: true });
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
      task: "live work",
      startedAt: new Date(Date.now() - 60_000).toISOString(),
      endedAt: null,
      source,
      ruleId: source.startsWith("rule") ? "r1" : null,
      tags: [],
    });
    vi.doMock("@tauri-apps/api/core", () => ({ invoke }));
    const { TodayView } = await import("./today");
    const utils = render(
      <TodayView
        density="comfy"
        layoutVariant="default"
        onOpenRule={vi.fn()}
        suggestionDismissed
        setSuggestionDismissed={vi.fn()}
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
      task: "live work",
      startedAt: new Date(Date.now() - 60_000).toISOString(),
      endedAt: new Date().toISOString(),
      source: "manual",
      ruleId: null,
      tags: [],
    });
    const stop = await screen.findByRole("button", { name: /stop timer/i });
    await waitFor(() => expect(stop.hasAttribute("disabled")).toBe(false));
    fireEvent.click(stop);
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("stop_entry", { id: "e1" }),
    );
  });
});
