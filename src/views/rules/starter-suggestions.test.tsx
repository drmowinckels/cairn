import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { StarterSuggestions } from "./starter-suggestions";
import type { StarterRule } from "../../lib/starter-rules";

const starters: StarterRule[] = [
  {
    id: "meetings",
    name: "Meetings",
    description: "Track meeting apps.",
    project: { name: "Meetings", color: "#c8b8e0" },
    confidence: "suggestive",
    when: [{ signal: "app.category", op: "equals", value: "meeting" }],
  },
];

describe("StarterSuggestions (#189)", () => {
  it("renders nothing when there are no pending starters", () => {
    const { container } = render(
      <StarterSuggestions
        starters={[]}
        onAdopt={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );
    expect(
      container.querySelector('[data-section="starter-rules"]'),
    ).toBeNull();
  });

  it("lists each starter with its name and description", () => {
    render(
      <StarterSuggestions
        starters={starters}
        onAdopt={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );
    expect(screen.getByText("Meetings")).toBeTruthy();
    expect(screen.getByText(/track meeting apps/i)).toBeTruthy();
    expect(screen.getByText("1")).toBeTruthy(); // count badge
  });

  it("Add calls onAdopt with the starter", () => {
    const onAdopt = vi.fn();
    render(
      <StarterSuggestions
        starters={starters}
        onAdopt={onAdopt}
        onDismiss={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /add/i }));
    expect(onAdopt).toHaveBeenCalledWith(starters[0]);
  });

  it("Dismiss calls onDismiss with the starter id", () => {
    const onDismiss = vi.fn();
    render(
      <StarterSuggestions
        starters={starters}
        onAdopt={vi.fn()}
        onDismiss={onDismiss}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /dismiss/i }));
    expect(onDismiss).toHaveBeenCalledWith("meetings");
  });

  it("collapses and expands the list via the header toggle", () => {
    render(
      <StarterSuggestions
        starters={starters}
        onAdopt={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );
    const toggle = screen.getByRole("button", { name: /suggestions/i });
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(screen.queryByText("Meetings")).toBeTruthy();
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("Meetings")).toBeNull();
  });

  it("renders an error message when adoption fails", () => {
    render(
      <StarterSuggestions
        starters={starters}
        onAdopt={vi.fn()}
        onDismiss={vi.fn()}
        error="Project create failed"
      />,
    );
    expect(
      within(screen.getByRole("alert")).getByText(/create failed/i),
    ).toBeTruthy();
  });
});
