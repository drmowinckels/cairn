import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { BudgetBanner, budgetMessage } from "./budget-banner";
import type { BudgetStatus } from "../../lib/ipc";

function status(over: Record<string, unknown> = {}): BudgetStatus {
  const {
    state = "over",
    usedMinutes = 600,
    minutes = 480,
    period = "daily",
    scopeType = "workspace",
    percent,
    ...rest
  } = over as Record<string, never>;
  return {
    budget: {
      id: "b1",
      scopeType: scopeType as BudgetStatus["budget"]["scopeType"],
      scopeId: "",
      period: period as BudgetStatus["budget"]["period"],
      minutes: minutes as number,
      warnPercent: 80,
    },
    usedMinutes: usedMinutes as number,
    percent:
      (percent as number | undefined) ??
      Math.floor(((usedMinutes as number) * 100) / (minutes as number)),
    state: state as BudgetStatus["state"],
    periodStart: "2026-09-29T00:00:00+00:00",
    ...rest,
  };
}

describe("budgetMessage", () => {
  it("says how far past the cap you are when over", () => {
    // The overshoot is the number that matters; "over budget" alone doesn't
    // tell you whether to stop now or in an hour.
    const msg = budgetMessage(status({ usedMinutes: 600, minutes: 480 }));
    expect(msg).toContain("10h");
    expect(msg).toContain("2h past");
    expect(msg).toContain("8h budget");
    expect(msg).toContain("today");
  });

  it("reports progress rather than an overshoot when approaching", () => {
    const msg = budgetMessage(
      status({ state: "approaching", usedMinutes: 420, minutes: 480 }),
    );
    expect(msg).toContain("7h of your 8h budget");
    expect(msg).not.toMatch(/past/);
  });

  it("names the period", () => {
    expect(budgetMessage(status({ period: "weekly" }))).toContain("this week");
    expect(budgetMessage(status({ period: "monthly" }))).toContain(
      "this month",
    );
    expect(budgetMessage(status({ period: "daily" }))).toContain("today");
  });

  it("names the scope for a project or client budget", () => {
    expect(budgetMessage(status({ scopeType: "project" }))).toContain(
      "on this project",
    );
    expect(budgetMessage(status({ scopeType: "client" }))).toContain(
      "for this client",
    );
    // The workspace budget covers everything, so naming a scope would be noise.
    expect(budgetMessage(status({ scopeType: "workspace" }))).not.toMatch(
      /this project|this client/,
    );
  });

  it("never reports a negative overshoot", () => {
    // Defensive: a status marked over with used below the cap shouldn't
    // render "-1h past".
    const msg = budgetMessage(
      status({ state: "over", usedMinutes: 400, minutes: 480 }),
    );
    expect(msg).not.toMatch(/-/);
  });
});

describe("BudgetBanner", () => {
  it("labels a breach differently from an approaching warning", () => {
    const { rerender } = render(
      <BudgetBanner
        status={status()}
        style="subtle"
        announce
        onDismiss={vi.fn()}
      />,
    );
    expect(screen.getByRole("region", { name: /over budget/i })).toBeTruthy();

    rerender(
      <BudgetBanner
        status={status({ state: "approaching", usedMinutes: 420 })}
        style="subtle"
        announce
        onDismiss={vi.fn()}
      />,
    );
    expect(
      screen.getByRole("region", { name: /approaching budget/i }),
    ).toBeTruthy();
  });

  it("offers no way to stop the timer", () => {
    // A budget is guidance the user set; Cairn ending a session to enforce
    // it would destroy real tracked time.
    render(
      <BudgetBanner
        status={status()}
        style="subtle"
        announce
        onDismiss={vi.fn()}
      />,
    );
    expect(screen.queryByRole("button", { name: /stop/i })).toBeNull();
  });

  it("dismisses from both the × and the button", () => {
    const onDismiss = vi.fn();
    render(
      <BudgetBanner
        status={status()}
        style="subtle"
        announce
        onDismiss={onDismiss}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /dismiss budget/i }));
    fireEvent.click(screen.getByRole("button", { name: /^dismiss$/i }));
    expect(onDismiss).toHaveBeenCalledTimes(2);
  });

  it("shows Adjust budget only when there's somewhere to go", () => {
    const { rerender } = render(
      <BudgetBanner
        status={status()}
        style="subtle"
        announce
        onDismiss={vi.fn()}
      />,
    );
    expect(screen.queryByRole("button", { name: /adjust budget/i })).toBeNull();

    const onAdjust = vi.fn();
    rerender(
      <BudgetBanner
        status={status()}
        style="subtle"
        announce
        onDismiss={vi.fn()}
        onAdjust={onAdjust}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /adjust budget/i }));
    expect(onAdjust).toHaveBeenCalledTimes(1);
  });

  it("announces assertively as a modal and politely when subtle", () => {
    const { rerender, container } = render(
      <BudgetBanner
        status={status()}
        style="modal"
        announce
        onDismiss={vi.fn()}
      />,
    );
    expect(container.querySelector("section")?.getAttribute("aria-live")).toBe(
      "assertive",
    );

    rerender(
      <BudgetBanner
        status={status()}
        style="subtle"
        announce
        onDismiss={vi.fn()}
      />,
    );
    expect(container.querySelector("section")?.getAttribute("aria-live")).toBe(
      "polite",
    );
  });

  it("stays silent for screen readers when announcements are off", () => {
    const { container } = render(
      <BudgetBanner
        status={status()}
        style="subtle"
        announce={false}
        onDismiss={vi.fn()}
      />,
    );
    expect(container.querySelector("section")?.getAttribute("aria-live")).toBe(
      "off",
    );
  });

  it("tags its state for styling", () => {
    const { container } = render(
      <BudgetBanner
        status={status()}
        style="subtle"
        announce
        onDismiss={vi.fn()}
      />,
    );
    expect(
      container.querySelector("section")?.getAttribute("data-budget-state"),
    ).toBe("over");
  });
});
