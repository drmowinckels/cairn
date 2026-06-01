import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { BudgetBar } from "./data";
import type { ProjectBudgetStatus } from "../../lib/types";

function status(over: Partial<ProjectBudgetStatus> = {}): ProjectBudgetStatus {
  return {
    projectId: "p1",
    usedSeconds: 0,
    estimateHours: 40,
    ...over,
  };
}

describe("BudgetBar", () => {
  it("renders nothing when the project has no estimate", () => {
    const { container } = render(
      <BudgetBar status={status({ estimateHours: null })} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("shows remaining time when under budget", () => {
    render(<BudgetBar status={status({ usedSeconds: 10 * 3600 })} />);
    expect(screen.getByText(/left/i)).toBeTruthy();
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe(
      "25",
    );
  });

  it("flags over budget when used exceeds the estimate", () => {
    render(<BudgetBar status={status({ usedSeconds: 50 * 3600 })} />);
    expect(screen.getByText(/over budget/i)).toBeTruthy();
    // Fraction clamps at 100%.
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe(
      "100",
    );
  });
});
