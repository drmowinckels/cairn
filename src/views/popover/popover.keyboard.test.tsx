import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(null),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({
  ask: vi.fn(),
  open: vi.fn(),
  save: vi.fn(),
}));
vi.mock("@tauri-apps/plugin-opener", () => ({
  revealItemInDir: vi.fn(),
}));

const confirmMock = vi.fn().mockResolvedValue(undefined);
const dismissMock = vi.fn().mockResolvedValue(undefined);

vi.mock("../../lib/use-suggestion", () => ({
  useSuggestion: () => ({
    suggestion: {
      ruleId: "r1",
      ruleName: "Cairn dev",
      confidence: "suggestive" as const,
      project: "cairn",
      tags: ["dev"],
    },
    confirm: confirmMock,
    dismiss: dismissMock,
  }),
}));

import { Popover } from "./popover";

beforeEach(() => {
  document.body.removeAttribute("data-theme");
  confirmMock.mockClear();
  dismissMock.mockClear();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("Popover · keyboard navigation (#27)", () => {
  it("Tab walks the popover top-to-bottom and Enter confirms the focused suggestion", async () => {
    const user = userEvent.setup();
    render(<Popover />);

    // Tab through the header + nav into the Today view body until the
    // suggestion's Confirm button takes focus. Bounded to a generous
    // ceiling so a regression that drops the banner out of tab order
    // fails the test instead of hanging.
    const confirm = screen.getByRole("button", { name: /^confirm$/i });
    for (let i = 0; i < 30; i++) {
      if (document.activeElement === confirm) break;
      await user.tab();
    }
    expect(document.activeElement).toBe(confirm);

    // Enter on a focused <button> activates click — the native
    // behaviour. This proves the suggestion can be confirmed without
    // ever using the mouse.
    await user.keyboard("{Enter}");
    expect(confirmMock).toHaveBeenCalledTimes(1);
  });

  it("Escape on the document dismisses the open suggestion banner (no modal in the way)", async () => {
    const user = userEvent.setup();
    render(<Popover />);
    await user.keyboard("{Escape}");
    expect(dismissMock).toHaveBeenCalledTimes(1);
  });

  it("the six tabs are focusable via Tab and report aria-selected", async () => {
    const user = userEvent.setup();
    render(<Popover />);
    const tabs = screen.getAllByRole("tab");
    expect(tabs).toHaveLength(6);
    // Walk Tab forward until we land on the first tab (after the
    // header's icon buttons). Bound the search to avoid a runaway
    // loop on regression.
    for (let i = 0; i < 20; i++) {
      if (document.activeElement === tabs[0]) break;
      await user.tab();
    }
    expect(document.activeElement).toBe(tabs[0]);
    // Activating a non-selected tab via Enter switches the view; the
    // first tab is already selected so move to the next and Enter.
    await user.tab();
    expect(document.activeElement).toBe(tabs[1]);
    await user.keyboard("{Enter}");
    expect(tabs[1].getAttribute("aria-selected")).toBe("true");
  });

  it("keyboard shortcut '3' switches to Rules when no input has focus", async () => {
    const user = userEvent.setup();
    render(<Popover />);
    await user.keyboard("3");
    // Rules view renders its own H2 heading.
    expect(screen.getByRole("heading", { name: /^rules$/i })).toBeTruthy();
  });

  it("Esc cascade: modal close eats the keystroke, suggestion survives", async () => {
    // Spec (#27): Escape should close any open modal first; only
    // when no modal is in the way does the suggestion get dismissed.
    // Open the manual-entry modal via the command palette, then press
    // Escape. The modal closes; the suggestion remains so the user gets
    // a chance to confirm it next.
    const user = userEvent.setup();
    render(<Popover />);

    await user.click(screen.getByRole("button", { name: /^search$/i }));
    const palette = await screen.findByRole("textbox", {
      name: /command palette/i,
    });
    await user.type(palette, "add manual entry");
    await user.click(await screen.findByText(/Add manual entry/i));
    const dialog = await screen.findByRole("dialog", { name: /new entry/i });
    expect(dialog).toBeTruthy();
    expect(dismissMock).not.toHaveBeenCalled();

    await user.keyboard("{Escape}");

    // Modal is closed.
    expect(screen.queryByRole("dialog", { name: /new entry/i })).toBeNull();
    // Suggestion was NOT dismissed by the same keystroke — the
    // cascade absorbed it at the modal layer.
    expect(dismissMock).not.toHaveBeenCalled();
  });
});
