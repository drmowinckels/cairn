import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

import { LiveSignalsCard } from "./live-signals-card";
import type { LiveSignal } from "../../lib/types";

const SAMPLE: LiveSignal[] = [
  { signal: "ide.folder", value: "~/code/cairn", app: "Zed" },
  { signal: "git.branch", value: "feat/rules-ui", app: "Zed" },
  { signal: "window.title", value: "rules.tsx — cairn", app: "Zed" },
  { signal: "browser.domain", value: "github.com/cairn", app: "Safari" },
];

describe("LiveSignalsCard", () => {
  it("renders one row per signal in the spec order", () => {
    const { container } = render(<LiveSignalsCard signals={SAMPLE} />);
    const items = container.querySelectorAll(".sig-item");
    expect(items).toHaveLength(4);
    const labels = Array.from(container.querySelectorAll(".sig-label")).map(
      (n) => n.textContent,
    );
    expect(labels).toEqual([
      "IDE folder",
      "Git branch",
      "Window title",
      "Browser domain",
    ]);
  });

  it("shows the empty state when no signals are present", () => {
    render(<LiveSignalsCard signals={[]} />);
    expect(
      screen.getByText(/no signals yet — start using an app/i),
    ).toBeTruthy();
  });

  it("renders rows as buttons when onSignalClick is provided", () => {
    const onSignalClick = vi.fn();
    const { container } = render(
      <LiveSignalsCard signals={SAMPLE} onSignalClick={onSignalClick} />,
    );
    const buttons = container.querySelectorAll<HTMLButtonElement>(
      "button.sig-row--clickable",
    );
    expect(buttons).toHaveLength(4);
    // Each button is keyboard-focusable + has an aria-label that
    // describes the action, not just the signal — screen readers
    // hear "Add IDE folder = ~/code/cairn as a condition".
    expect(buttons[0].getAttribute("aria-label")).toMatch(
      /add ide folder = ~\/code\/cairn as a condition/i,
    );
  });

  it("renders rows as non-clickable divs when onSignalClick is omitted", () => {
    const { container } = render(<LiveSignalsCard signals={SAMPLE} />);
    expect(container.querySelector("button")).toBeNull();
    expect(container.querySelectorAll(".sig-row")).toHaveLength(4);
  });

  it("invokes onSignalClick with the row's signal + value on click", () => {
    const onSignalClick = vi.fn();
    render(
      <LiveSignalsCard signals={SAMPLE} onSignalClick={onSignalClick} />,
    );
    const firstButton = screen.getAllByRole("button")[0];
    fireEvent.click(firstButton);
    expect(onSignalClick).toHaveBeenCalledExactlyOnceWith(
      "ide.folder",
      "~/code/cairn",
    );
  });
});
