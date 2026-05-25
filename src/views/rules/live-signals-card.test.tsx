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

  it("omits the source-app cell entirely when a row has no app (R4)", () => {
    // An empty source-app span would eat the grid's trailing `auto`
    // column and shift the layout. The component renders an empty
    // <span/> placeholder instead — assert .sig-src is absent.
    // `snapshotToLiveSignals` falls back to `app: ""` when the
    // collector didn't observe an app, which is the case this
    // branch exists for.
    const { container } = render(
      <LiveSignalsCard
        signals={[{ signal: "git.branch", value: "main", app: "" }]}
      />,
    );
    expect(container.querySelector(".sig-src")).toBeNull();
    // The row still renders (just without the app cell).
    expect(container.querySelectorAll(".sig-item")).toHaveLength(1);
  });

  it("renders the correct icon for every SignalKind the card supports", () => {
    // Cover the SignalIcon nested-ternary fully — without this the
    // browser.tab / calendar.event / fall-through branches stay
    // unreachable from the SAMPLE fixture.
    const ALL: LiveSignal[] = [
      { signal: "browser.tab", value: "1", app: "Safari" },
      { signal: "calendar.event", value: "Standup", app: "Calendar" },
      { signal: "app.name", value: "Zed", app: "Zed" },
    ];
    const { container } = render(<LiveSignalsCard signals={ALL} />);
    const icons = container.querySelectorAll<SVGElement>(".sig-ic");
    // 3 rows → 3 icons; we don't assert the inner shape (icon lib
    // detail) but each one must have rendered.
    expect(icons).toHaveLength(3);
  });
});
