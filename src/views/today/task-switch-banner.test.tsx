import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { TaskSwitchBanner } from "./task-switch-banner";
import type { RuleMatchEvent } from "../../lib/types";

function match(over: Partial<RuleMatchEvent> = {}): RuleMatchEvent {
  return {
    ruleId: "r1",
    ruleName: "Cairn repo",
    confidence: "suggestive",
    ambiguityBehavior: "prompt",
    project: "cairn",
    tags: [],
    description: "",
    ...over,
  };
}

describe("TaskSwitchBanner", () => {
  it("renders nothing without a match", () => {
    const { container } = render(
      <TaskSwitchBanner
        match={null}
        style="subtle"
        announce
        onConfirm={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders the switch prompt with the matched project chip", () => {
    render(
      <TaskSwitchBanner
        match={match()}
        style="subtle"
        announce
        onConfirm={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );
    expect(
      screen.getByRole("region", { name: /task switch detected/i }),
    ).toBeTruthy();
    expect(screen.getByText(/looks like you switched to/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: /^switch$/i })).toBeTruthy();
  });

  it("falls back to the rule name when the match has no project", () => {
    render(
      <TaskSwitchBanner
        match={match({ project: null, ruleName: "Deep work" })}
        style="subtle"
        announce={false}
        onConfirm={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );
    // The rule name appears both in the body fallback and the trailing "— rule".
    expect(screen.getAllByText("Deep work").length).toBeGreaterThan(0);
  });

  it("uses an alertdialog role in modal style", () => {
    render(
      <TaskSwitchBanner
        match={match()}
        style="modal"
        announce
        onConfirm={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );
    expect(screen.getByRole("alertdialog")).toBeTruthy();
  });

  it("wires Switch to confirm and both dismiss affordances", () => {
    const onConfirm = vi.fn();
    const onDismiss = vi.fn();
    render(
      <TaskSwitchBanner
        match={match()}
        style="subtle"
        announce
        onConfirm={onConfirm}
        onDismiss={onDismiss}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /^switch$/i }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    fireEvent.click(
      screen.getByRole("button", { name: /keep current timer/i }),
    );
    fireEvent.click(screen.getByRole("button", { name: /^keep current$/i }));
    expect(onDismiss).toHaveBeenCalledTimes(2);
  });
});
