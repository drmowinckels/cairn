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

  // ---- #14: Confidence heuristic warning --------------------------

  it("editor exposes a confidence select at complexity=heavy", () => {
    const { container } = renderRules({ openRuleId: "r1", complexity: "heavy" });
    const sel = container.querySelector<HTMLSelectElement>(
      'select[aria-label="Confidence"]',
    );
    expect(sel).toBeTruthy();
    // Default for fixture rules is suggestive (no `confidence` set).
    expect(sel!.value).toBe("suggestive");
  });

  it("does not show the confidence warning for a default (suggestive) rule", () => {
    const { container } = renderRules({ openRuleId: "r1", complexity: "heavy" });
    expect(container.querySelector(".rule-meta-warn")).toBeNull();
  });

  it("shows the warning after switching a 1-condition rule to strict", async () => {
    const { container } = renderRules({ openRuleId: "r1", complexity: "heavy" });
    // r1 in the fixture has a single condition with op=contains, which
    // is the heuristic's full danger shape.
    const sel = container.querySelector<HTMLSelectElement>(
      'select[aria-label="Confidence"]',
    );
    fireEvent.change(sel!, { target: { value: "strict" } });
    await waitFor(() => {
      expect(container.querySelector(".rule-meta-warn")).toBeTruthy();
    });
    expect(
      container.querySelector(".rule-meta-warn .warn-text")?.textContent,
    ).toMatch(/may auto-start aggressively/i);
  });

  it("clicking Dismiss removes the warning + persists the per-rule flag", async () => {
    const { container } = renderRules({ openRuleId: "r1", complexity: "heavy" });
    const sel = container.querySelector<HTMLSelectElement>(
      'select[aria-label="Confidence"]',
    );
    fireEvent.change(sel!, { target: { value: "strict" } });
    await waitFor(() => {
      expect(container.querySelector(".rule-meta-warn")).toBeTruthy();
    });
    const dismiss = container.querySelector<HTMLButtonElement>(
      ".rule-meta-warn .warn-dismiss",
    );
    expect(dismiss).toBeTruthy();
    fireEvent.click(dismiss!);
    await waitFor(() => {
      expect(container.querySelector(".rule-meta-warn")).toBeNull();
    });
    // The rule stays strict — only the warning is dismissed.
    expect(sel!.value).toBe("strict");
  });

  it("re-arms the warning only on suggestive → strict transitions (not on every change)", async () => {
    const { container } = renderRules({ openRuleId: "r1", complexity: "heavy" });
    const sel = container.querySelector<HTMLSelectElement>(
      'select[aria-label="Confidence"]',
    );
    // Strict → dismiss → suggestive → strict again must re-warn.
    fireEvent.change(sel!, { target: { value: "strict" } });
    await waitFor(() =>
      expect(container.querySelector(".rule-meta-warn")).toBeTruthy(),
    );
    fireEvent.click(
      container.querySelector<HTMLButtonElement>(".warn-dismiss")!,
    );
    await waitFor(() =>
      expect(container.querySelector(".rule-meta-warn")).toBeNull(),
    );
    fireEvent.change(sel!, { target: { value: "suggestive" } });
    fireEvent.change(sel!, { target: { value: "strict" } });
    await waitFor(() =>
      expect(container.querySelector(".rule-meta-warn")).toBeTruthy(),
    );
  });

  it("does NOT re-arm the warning on a strict → strict reselect", async () => {
    // Keyboard cycling can fire onChange with the same value. A
    // re-arm on every change would clobber the user's prior dismiss
    // and resurface the warning they explicitly silenced.
    const { container } = renderRules({ openRuleId: "r1", complexity: "heavy" });
    const sel = container.querySelector<HTMLSelectElement>(
      'select[aria-label="Confidence"]',
    );
    fireEvent.change(sel!, { target: { value: "strict" } });
    await waitFor(() =>
      expect(container.querySelector(".rule-meta-warn")).toBeTruthy(),
    );
    fireEvent.click(
      container.querySelector<HTMLButtonElement>(".warn-dismiss")!,
    );
    await waitFor(() =>
      expect(container.querySelector(".rule-meta-warn")).toBeNull(),
    );
    // A second strict change (e.g. user reselects via keyboard).
    fireEvent.change(sel!, { target: { value: "strict" } });
    // Warning stays dismissed — the prior user choice is respected.
    expect(container.querySelector(".rule-meta-warn")).toBeNull();
  });

  it("the warning is wired to the select via aria-describedby (not role=alert spam)", async () => {
    // role=alert announces every time the warning re-renders, which
    // happens on every keystroke that touches `rule`. We use a
    // persistent `role=note` + aria-describedby on the select so
    // screen-reader users hear the advisory as part of the control's
    // description, not as an interrupt.
    const { container } = renderRules({ openRuleId: "r1", complexity: "heavy" });
    const sel = container.querySelector<HTMLSelectElement>(
      'select[aria-label="Confidence"]',
    );
    // No warning → no describedby reference.
    expect(sel!.getAttribute("aria-describedby")).toBeNull();
    fireEvent.change(sel!, { target: { value: "strict" } });
    await waitFor(() => {
      const warn = container.querySelector(".rule-meta-warn");
      expect(warn).toBeTruthy();
      expect(warn!.getAttribute("role")).toBe("note");
      const id = warn!.getAttribute("id");
      expect(id).toBeTruthy();
      expect(sel!.getAttribute("aria-describedby")).toBe(id);
    });
  });

  it("drops a confidence value that isn't in CONFIDENCE_OPTIONS (forged event guard)", async () => {
    // The handler validates the select's value against an allow-list
    // before persisting. A synthetic change event (or a future third
    // <option>) that lands an unknown string must NOT write into the
    // rule body — otherwise garbage would round-trip through the
    // SQLite-stored JSON. Pin the negative path so a regression on
    // the guard surfaces in CI.
    const { container } = renderRules({ openRuleId: "r1", complexity: "heavy" });
    const sel = container.querySelector<HTMLSelectElement>(
      'select[aria-label="Confidence"]',
    );
    fireEvent.change(sel!, {
      target: { value: "definitely-not-a-confidence" },
    });
    // No warning — the bogus value never made it through the guard
    // (warning needs `strict`, which the guard refused to set).
    expect(container.querySelector(".rule-meta-warn")).toBeNull();
    // And a subsequent legitimate change still works, proving the
    // guard returned early without throwing.
    fireEvent.change(sel!, { target: { value: "strict" } });
    await waitFor(() => {
      expect(container.querySelector(".rule-meta-warn")).toBeTruthy();
    });
  });

  // ---- #15: drag-to-reorder + keyboard alternative -----------------

  it("reorders rules via Alt+ArrowDown when the rule head is focused", async () => {
    const { container } = renderRules({ complexity: "medium" });
    const heads = Array.from(
      container.querySelectorAll<HTMLElement>(".rule-head"),
    );
    expect(heads.length).toBeGreaterThan(1);
    const firstName = heads[0].querySelector(".rule-name")?.textContent;
    heads[0].focus();
    fireEvent.keyDown(heads[0], { key: "ArrowDown", altKey: true });
    await waitFor(() => {
      const newFirst = container
        .querySelector<HTMLElement>(".rule:nth-child(1) .rule-name")
        ?.textContent;
      // The original first rule is no longer at the top.
      expect(newFirst).not.toBe(firstName);
    });
  });

  it("reorders rules via Alt+ArrowUp when the rule head is focused", async () => {
    const { container } = renderRules({ complexity: "medium" });
    const heads = Array.from(
      container.querySelectorAll<HTMLElement>(".rule-head"),
    );
    const lastName =
      heads[heads.length - 1].querySelector(".rule-name")?.textContent;
    heads[heads.length - 1].focus();
    fireEvent.keyDown(heads[heads.length - 1], {
      key: "ArrowUp",
      altKey: true,
    });
    await waitFor(() => {
      const newLast = container.querySelector<HTMLElement>(
        ".rule:last-child .rule-name",
      )?.textContent;
      expect(newLast).not.toBe(lastName);
    });
  });

  it("Alt+ArrowUp on the first rule is a no-op (already at top)", () => {
    const { container } = renderRules({ complexity: "medium" });
    const heads = Array.from(
      container.querySelectorAll<HTMLElement>(".rule-head"),
    );
    const firstNameBefore = heads[0].querySelector(".rule-name")?.textContent;
    heads[0].focus();
    fireEvent.keyDown(heads[0], { key: "ArrowUp", altKey: true });
    const firstNameAfter = container
      .querySelector(".rule:first-child .rule-name")
      ?.textContent;
    expect(firstNameAfter).toBe(firstNameBefore);
  });

  it("Alt+ArrowDown on the last rule is a no-op (already at bottom)", () => {
    const { container } = renderRules({ complexity: "medium" });
    const heads = Array.from(
      container.querySelectorAll<HTMLElement>(".rule-head"),
    );
    const lastNameBefore =
      heads[heads.length - 1].querySelector(".rule-name")?.textContent;
    heads[heads.length - 1].focus();
    fireEvent.keyDown(heads[heads.length - 1], {
      key: "ArrowDown",
      altKey: true,
    });
    const lastNameAfter = container.querySelector(
      ".rule:last-child .rule-name",
    )?.textContent;
    expect(lastNameAfter).toBe(lastNameBefore);
  });

  it("ArrowDown WITHOUT alt does NOT reorder (Alt is the spec's required modifier)", () => {
    const { container } = renderRules({ complexity: "medium" });
    const heads = Array.from(
      container.querySelectorAll<HTMLElement>(".rule-head"),
    );
    const firstNameBefore = heads[0].querySelector(".rule-name")?.textContent;
    heads[0].focus();
    fireEvent.keyDown(heads[0], { key: "ArrowDown" });
    const firstNameAfter = container
      .querySelector(".rule:first-child .rule-name")
      ?.textContent;
    expect(firstNameAfter).toBe(firstNameBefore);
  });

  it("dropping rule 1 onto rule 2 reorders via the drag handler", async () => {
    const { container } = renderRules({ complexity: "medium" });
    const rules = Array.from(
      container.querySelectorAll<HTMLElement>(".rule"),
    );
    expect(rules.length).toBeGreaterThan(1);
    const firstName = rules[0].querySelector(".rule-name")?.textContent;
    // `draggable` lives on the .rule-head (the visible drag grip);
    // the drop target is the whole .rule <li>. Source index is held
    // in a parent ref (the dataTransfer write is just there to keep
    // Firefox happy). The drop handler reads the ref, so we don't
    // need a working DataTransfer here.
    const firstHead = rules[0].querySelector(".rule-head") as HTMLElement;
    fireEvent.dragStart(firstHead);
    fireEvent.dragOver(rules[1]);
    fireEvent.drop(rules[1]);
    await waitFor(() => {
      const newFirst = container
        .querySelector(".rule:first-child .rule-name")
        ?.textContent;
      expect(newFirst).not.toBe(firstName);
    });
  });

  it("dropping a rule onto itself is a no-op (from === target)", () => {
    const { container } = renderRules({ complexity: "medium" });
    const rules = Array.from(
      container.querySelectorAll<HTMLElement>(".rule"),
    );
    const firstNameBefore = rules[0]
      .querySelector(".rule-name")
      ?.textContent;
    const firstHead = rules[0].querySelector(".rule-head") as HTMLElement;
    fireEvent.dragStart(firstHead);
    fireEvent.dragOver(rules[0]);
    fireEvent.drop(rules[0]);
    const firstNameAfter = container.querySelector(
      ".rule:first-child .rule-name",
    )?.textContent;
    expect(firstNameAfter).toBe(firstNameBefore);
  });

  it("dragend without drop resets the source-index ref (Escape / off-window)", () => {
    // If onDragStart fires but the drag ends outside any drop target
    // (user pressed Escape, dragged off the window), the source-index
    // ref must reset. Otherwise a subsequent drop on an unrelated
    // element would fire with a stale `from`.
    const { container } = renderRules({ complexity: "medium" });
    const rules = Array.from(
      container.querySelectorAll<HTMLElement>(".rule"),
    );
    const firstNameBefore = rules[0]
      .querySelector(".rule-name")
      ?.textContent;
    const firstHead = rules[0].querySelector(".rule-head") as HTMLElement;
    fireEvent.dragStart(firstHead);
    fireEvent.dragEnd(firstHead); // user aborted the drag
    // Now a drop on rule 2 (without a fresh dragStart) must NOT
    // reorder, because the ref was reset.
    fireEvent.drop(rules[1]);
    const firstNameAfter = container.querySelector(
      ".rule:first-child .rule-name",
    )?.textContent;
    expect(firstNameAfter).toBe(firstNameBefore);
  });

  it("the rule head exposes the Alt+arrow shortcut via aria-keyshortcuts (not in the visible label)", () => {
    // role=alert spam was the same anti-pattern; here the concern is
    // that announcing 'Use Alt+Up or Alt+Down' on every rule focus is
    // verbose for a 50-rule list. aria-keyshortcuts is the platform-
    // standard way to tell ATs about a shortcut without putting it
    // in the visible / spoken label.
    const { container } = renderRules({ complexity: "medium" });
    const head = container.querySelector(".rule-head") as HTMLElement;
    expect(head.getAttribute("aria-keyshortcuts")).toBe(
      "Alt+ArrowUp Alt+ArrowDown",
    );
    // The visible label is just the rule's name + index — no shortcut
    // hint baked into it.
    const label = head.getAttribute("aria-label") ?? "";
    expect(label).not.toMatch(/Alt/);
  });

  it("hovering a drop target toggles data-drag-over on, dragleave toggles it off", () => {
    // Cover both arms of the dragOver / dragLeave guards:
    // - dragOver while NOT already set → set true
    // - dragOver while already set → no-op (the if-guard's false arm)
    // - dragLeave while set → set false
    // - dragLeave while NOT set → no-op (the if-guard's false arm)
    const { container } = renderRules({ complexity: "medium" });
    const rules = Array.from(
      container.querySelectorAll<HTMLElement>(".rule"),
    );
    expect(rules[1].getAttribute("data-drag-over")).toBeNull();
    fireEvent.dragOver(rules[1]);
    expect(rules[1].getAttribute("data-drag-over")).toBe("true");
    // Second dragOver hits the !dragOver===false arm (no-op).
    fireEvent.dragOver(rules[1]);
    expect(rules[1].getAttribute("data-drag-over")).toBe("true");
    fireEvent.dragLeave(rules[1]);
    expect(rules[1].getAttribute("data-drag-over")).toBeNull();
    // Second dragLeave hits the dragOver===false arm (no-op).
    fireEvent.dragLeave(rules[1]);
    expect(rules[1].getAttribute("data-drag-over")).toBeNull();
  });

  it("Enter or Space on the focused rule head toggles expansion (keyboard-accessible)", () => {
    const { container, onOpenRule } = renderRules();
    const head = container.querySelector(".rule-head") as HTMLElement;
    expect(head.getAttribute("aria-expanded")).toBe("false");
    head.focus();
    fireEvent.keyDown(head, { key: "Enter" });
    expect(head.getAttribute("aria-expanded")).toBe("true");
    expect(onOpenRule).toHaveBeenCalled();
    // And Space toggles it back closed.
    fireEvent.keyDown(head, { key: " " });
    expect(head.getAttribute("aria-expanded")).toBe("false");
  });

  it("expanded editor inputs aren't draggable (text selection isn't hijacked)", () => {
    const { container } = renderRules({ openRuleId: "r1", complexity: "medium" });
    const nameInput = container.querySelector<HTMLInputElement>(
      ".rule-name-input",
    );
    expect(nameInput).toBeTruthy();
    // `draggable` lives only on the rule-head, not the <li> or the
    // body. Inputs inside a draggable ancestor have their text
    // selection hijacked by the browser's drag handler on macOS /
    // Windows. Walking up the ancestors must find no draggable
    // element before the <li>.
    let node: HTMLElement | null = nameInput;
    while (node && !node.classList.contains("rule")) {
      expect(node.getAttribute("draggable")).not.toBe("true");
      node = node.parentElement;
    }
  });

  // ---- #16: Ambiguity per-rule selector ----------------------------

  it("editor exposes an Ambiguity-behaviour select at complexity=heavy", () => {
    const { container } = renderRules({ openRuleId: "r1", complexity: "heavy" });
    const sel = container.querySelector<HTMLSelectElement>(
      'select[aria-label="Ambiguity behaviour"]',
    );
    expect(sel).toBeTruthy();
    // Default for fixture rules (no field set) is "prompt".
    expect(sel!.value).toBe("prompt");
    const options = Array.from(sel!.options).map((o) => o.value);
    expect(options).toEqual(["prompt", "skip", "log-to-uncategorized"]);
  });

  it("changing the ambiguity select persists the new value", async () => {
    const { container } = renderRules({ openRuleId: "r1", complexity: "heavy" });
    const sel = container.querySelector<HTMLSelectElement>(
      'select[aria-label="Ambiguity behaviour"]',
    );
    fireEvent.change(sel!, { target: { value: "log-to-uncategorized" } });
    await waitFor(() => {
      expect(sel!.value).toBe("log-to-uncategorized");
    });
    // And a second change cycles to a third value.
    fireEvent.change(sel!, { target: { value: "skip" } });
    await waitFor(() => {
      expect(sel!.value).toBe("skip");
    });
  });

  it("drops an ambiguity value that isn't in AMBIGUITY_OPTIONS (forged event guard)", () => {
    const { container } = renderRules({ openRuleId: "r1", complexity: "heavy" });
    const sel = container.querySelector<HTMLSelectElement>(
      'select[aria-label="Ambiguity behaviour"]',
    );
    fireEvent.change(sel!, {
      target: { value: "definitely-not-an-ambiguity-value" },
    });
    // Guard rejects — value stays at the default "prompt".
    expect(sel!.value).toBe("prompt");
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

  it("clicking a Live-signals row is a no-op if the expanded id is stale", () => {
    // If `openRuleId` references a rule that doesn't exist (e.g. the
    // user deleted it from another view while Rules was open), the
    // handler must short-circuit: no new rule, no exception.
    const { container } = renderRules({
      openRuleId: "does-not-exist",
      complexity: "medium",
    });
    const rulesBefore = container.querySelectorAll(".rule").length;
    const sigButtons = container.querySelectorAll<HTMLButtonElement>(
      ".sig-row--clickable",
    );
    expect(sigButtons.length).toBeGreaterThan(0);
    fireEvent.click(sigButtons[0]);
    // Same rule count; the click didn't fall through to the
    // "create new rule" path either.
    expect(container.querySelectorAll(".rule").length).toBe(rulesBefore);
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
