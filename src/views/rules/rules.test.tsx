import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

import { RulesView } from "./index";

afterEach(() => {
  vi.clearAllMocks();
});

function renderRules(
  overrides: Partial<{
    complexity: "light" | "medium" | "heavy";
    openRuleId: string | null;
  }> = {},
) {
  const onOpenRule = vi.fn();
  const utils = render(
    <RulesView
      complexity={overrides.complexity ?? "medium"}
      openRuleId={overrides.openRuleId ?? null}
      onOpenRule={onOpenRule}
      density="comfy"
    />,
  );
  return { ...utils, onOpenRule };
}

describe("RulesView", () => {
  it("renders the Rules header and the New button", () => {
    renderRules();
    expect(screen.getByRole("heading", { name: /^rules$/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /new rule/i })).toBeTruthy();
  });

  it("renders one row per fixture rule", () => {
    const { container } = renderRules();
    expect(container.querySelectorAll(".rule").length).toBeGreaterThan(0);
  });

  it("hides the Live signals card and 'combine multiple signals' copy at complexity=light", () => {
    renderRules({ complexity: "light" });
    expect(screen.queryByLabelText(/live signals/i)).toBeNull();
    expect(
      screen.queryByText(/each rule may combine multiple signals/i),
    ).toBeNull();
  });

  it("renders Live signals card at complexity=medium", () => {
    renderRules({ complexity: "medium" });
    expect(screen.getByLabelText(/live signals/i)).toBeTruthy();
    expect(
      screen.getByText(/each rule may combine multiple signals/i),
    ).toBeTruthy();
  });

  it("renders the Test bench at complexity=heavy", () => {
    renderRules({ complexity: "heavy" });
    expect(screen.getByLabelText(/test bench/i)).toBeTruthy();
  });

  it("clicking a rule head expands it and invokes onOpenRule", () => {
    const { container, onOpenRule } = renderRules();
    const firstHead = container.querySelector(".rule-head") as HTMLElement;
    expect(firstHead.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(firstHead);
    expect(firstHead.getAttribute("aria-expanded")).toBe("true");
    expect(onOpenRule).toHaveBeenCalled();
  });

  it("preselects openRuleId on mount", () => {
    const { container } = renderRules({ openRuleId: "r1" });
    const heads = Array.from(
      container.querySelectorAll<HTMLElement>(".rule-head"),
    );
    const expanded = heads.find(
      (h) => h.getAttribute("aria-expanded") === "true",
    );
    expect(expanded).toBeTruthy();
  });

  it("clicking the same rule head twice collapses it (sets onOpenRule to null)", () => {
    const { container, onOpenRule } = renderRules({ openRuleId: "r1" });
    const head = container.querySelector(
      ".rule.is-open .rule-head",
    ) as HTMLElement;
    fireEvent.click(head);
    expect(onOpenRule).toHaveBeenLastCalledWith(null);
  });
});
