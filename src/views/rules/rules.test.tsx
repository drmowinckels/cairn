import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

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

  // ---- #11: editor wiring -----------------------------------------

  it("editor exposes a name input, an enabled toggle, and a project select", () => {
    const { container } = renderRules({ openRuleId: "r1" });
    // Name input lives inside the expanded body row.
    expect(container.querySelector(".rule-name-input")).toBeTruthy();
    // Enabled checkbox in the rule head.
    expect(
      container.querySelector<HTMLInputElement>(
        '.rule-toggle input[type="checkbox"]',
      ),
    ).toBeTruthy();
    // Project select inside the Then block.
    expect(container.querySelector('select[aria-label="Project"]')).toBeTruthy();
  });

  it("toggling the enabled checkbox flips the rule's class without bubbling to expand", () => {
    const { container } = renderRules(); // start with all rules collapsed
    const firstRule = container.querySelector(".rule") as HTMLElement;
    const toggle = firstRule.querySelector<HTMLInputElement>(
      '.rule-toggle input[type="checkbox"]',
    );
    expect(toggle).toBeTruthy();
    const startedChecked = toggle!.checked;
    fireEvent.click(toggle!);
    // Click on the checkbox must not toggle expansion (stopBubble).
    expect(firstRule.classList.contains("is-open")).toBe(false);
    // The local state reflects the new value (no Tauri so optimistic
    // update sticks).
    expect(toggle!.checked).toBe(!startedChecked);
  });

  it("editing the name input commits via debounce; blur flushes immediately", async () => {
    const { container } = renderRules({ openRuleId: "r1" });
    const nameInput = container.querySelector<HTMLInputElement>(
      ".rule-name-input",
    );
    expect(nameInput).toBeTruthy();
    // Local state updates synchronously so typing is snappy.
    fireEvent.change(nameInput!, { target: { value: "Renamed in test" } });
    expect(nameInput!.value).toBe("Renamed in test");
    // Blur flushes the debounced commit to the hook → header updates.
    fireEvent.blur(nameInput!);
    await waitFor(() => {
      expect(
        container.querySelector(".rule.is-open .rule-name")?.textContent,
      ).toBe("Renamed in test");
    });
  });

  it("typing in the name input does NOT fire one save per keystroke", async () => {
    // PR #65 review B1: debouncing protects against the save-storm.
    // Reach in via `useRules` indirectly by counting `.rule-name`
    // updates — without debounce, typing 'abc' fires 3 commits and
    // the header reflects each interim value. With debounce, the
    // header stays at the previous committed value until quiet
    // time elapses (or blur flushes).
    const { container } = renderRules({ openRuleId: "r1" });
    const nameInput = container.querySelector<HTMLInputElement>(
      ".rule-name-input",
    );
    const header = () =>
      container.querySelector(".rule.is-open .rule-name")?.textContent;
    const originalName = header();
    fireEvent.change(nameInput!, { target: { value: "a" } });
    fireEvent.change(nameInput!, { target: { value: "ab" } });
    fireEvent.change(nameInput!, { target: { value: "abc" } });
    // Without flushing or waiting past the debounce window, the
    // header still shows the original name. Local input value has
    // updated immediately though.
    expect(nameInput!.value).toBe("abc");
    expect(header()).toBe(originalName);
    // Now flush and assert the FINAL value is what landed.
    fireEvent.blur(nameInput!);
    await waitFor(() => expect(header()).toBe("abc"));
  });

  it("clicking the AND / OR join label toggles a condition's `any` flag", () => {
    const { container } = renderRules({ openRuleId: "r3", complexity: "heavy" });
    // r3 has 3 conditions with `any: true` ⇒ join shows OR.
    const firstJoin = container.querySelector(".cond-join") as HTMLElement;
    expect(firstJoin.textContent).toBe("OR");
    fireEvent.click(firstJoin);
    // After clicking, that specific condition flips to AND.
    expect(
      (container.querySelector(".cond-join") as HTMLElement).textContent,
    ).toBe("AND");
  });

  it("'add condition' appends a condition (medium / heavy only)", () => {
    const { container } = renderRules({ openRuleId: "r1", complexity: "medium" });
    const before = container.querySelectorAll(".cond").length;
    const addBtn = container.querySelector(".add-cond") as HTMLElement;
    expect(addBtn).toBeTruthy();
    fireEvent.click(addBtn);
    const after = container.querySelectorAll(".cond").length;
    expect(after).toBe(before + 1);
  });

  it("'add condition' is hidden in light complexity (single-condition rules only)", () => {
    const { container } = renderRules({ openRuleId: "r1", complexity: "light" });
    expect(container.querySelector(".add-cond")).toBeNull();
  });

  it("clicking the × on a condition removes it (when >1 conditions remain)", () => {
    const { container } = renderRules({ openRuleId: "r3", complexity: "medium" });
    const before = container.querySelectorAll(".cond").length;
    const removeBtn = container.querySelector(
      ".cond-x",
    ) as HTMLElement;
    expect(removeBtn).toBeTruthy();
    fireEvent.click(removeBtn);
    expect(container.querySelectorAll(".cond").length).toBe(before - 1);
  });

  it("the × is hidden when the rule has exactly one condition (can't drop to zero)", () => {
    const { container } = renderRules({ openRuleId: "r1", complexity: "medium" });
    // r1 has a single condition; removing it would leave the rule
    // with no `when` array — refuse at the UI level so the user
    // doesn't accidentally create an always-match rule.
    expect(container.querySelectorAll(".cond").length).toBe(1);
    expect(container.querySelector(".cond-x")).toBeNull();
  });

  it("Delete removes the rule from the visible list", () => {
    const { container } = renderRules({ openRuleId: "r1" });
    const before = container.querySelectorAll(".rule").length;
    const deleteBtn = Array.from(
      container.querySelectorAll<HTMLElement>(".link-btn--danger"),
    ).find((b) => b.textContent === "Delete");
    expect(deleteBtn).toBeTruthy();
    fireEvent.click(deleteBtn!);
    expect(container.querySelectorAll(".rule").length).toBe(before - 1);
  });

  it("Duplicate adds a new rule with the same body + '(copy)' suffix", () => {
    const { container } = renderRules({ openRuleId: "r1" });
    const before = container.querySelectorAll(".rule").length;
    const dupBtn = Array.from(
      container.querySelectorAll<HTMLElement>(".link-btn"),
    ).find((b) => b.textContent === "Duplicate");
    expect(dupBtn).toBeTruthy();
    fireEvent.click(dupBtn!);
    expect(container.querySelectorAll(".rule").length).toBe(before + 1);
    // The new rule's name is the original + " (copy)".
    expect(
      Array.from(container.querySelectorAll(".rule-name")).some(
        (n) => n.textContent?.endsWith("(copy)"),
      ),
    ).toBe(true);
  });

  it("'New' creates a fresh rule and expands it", async () => {
    const { container } = renderRules();
    const before = container.querySelectorAll(".rule").length;
    fireEvent.click(screen.getByRole("button", { name: /new rule/i }));
    await waitFor(() => {
      expect(container.querySelectorAll(".rule").length).toBe(before + 1);
    });
    // The newly created rule is expanded so the user can edit it.
    await waitFor(() => {
      expect(container.querySelectorAll(".rule.is-open").length).toBe(1);
    });
  });

  it("changing the signal select normalises the op for calendar.event", () => {
    const { container } = renderRules({ openRuleId: "r1", complexity: "medium" });
    const signalSel = container.querySelector<HTMLSelectElement>(
      ".cond-sig-sel",
    );
    expect(signalSel).toBeTruthy();
    fireEvent.change(signalSel!, { target: { value: "calendar.event" } });
    // The op select must have switched to "is-active" (the only
    // sensible op for calendar conditions); otherwise the resulting
    // rule would be unmatchable.
    const opSel = container.querySelector<HTMLSelectElement>(".cond-op");
    expect(opSel?.value).toBe("is-active");
  });

  // ---- #12: Live signals card integration -------------------------

  it("clicking a Live-signals row adds a condition to the open rule (#12)", async () => {
    const { container } = renderRules({ openRuleId: "r1", complexity: "medium" });
    const conditionsBefore = container.querySelectorAll(".cond").length;
    // The card renders signal rows as buttons when an onSignalClick
    // handler is wired in. Click the first one.
    const sigButtons = container.querySelectorAll<HTMLButtonElement>(
      ".sig-row--clickable",
    );
    expect(sigButtons.length).toBeGreaterThan(0);
    fireEvent.click(sigButtons[0]);
    await waitFor(() => {
      expect(container.querySelectorAll(".cond").length).toBe(conditionsBefore + 1);
    });
  });

  it("clicking a Live-signals row with no rule open creates one + seeds the condition (#12)", async () => {
    const { container } = renderRules({ complexity: "medium" });
    const rulesBefore = container.querySelectorAll(".rule").length;
    const sigButtons = container.querySelectorAll<HTMLButtonElement>(
      ".sig-row--clickable",
    );
    // The first fixture signal is `ide.folder` = "~/code/cairn".
    fireEvent.click(sigButtons[0]);
    await waitFor(() => {
      expect(container.querySelectorAll(".rule").length).toBe(rulesBefore + 1);
      // The new rule is auto-expanded so the user can edit/confirm.
      expect(container.querySelectorAll(".rule.is-open").length).toBe(1);
    });
    // Verify the seed actually landed: the open rule's single
    // condition has the clicked signal + value (not a placeholder
    // ide.folder/contains/"" from the blank-rule template).
    const openRule = container.querySelector(".rule.is-open")!;
    const conditions = openRule.querySelectorAll(".cond");
    expect(conditions.length).toBe(1);
    const signalSel = openRule.querySelector<HTMLSelectElement>(".cond-sig-sel");
    const valInput = openRule.querySelector<HTMLInputElement>(".cond-val");
    expect(signalSel?.value).toBe("ide.folder");
    expect(valInput?.value).toBe("~/code/cairn");
  });
});
