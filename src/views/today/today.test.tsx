import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

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
});
