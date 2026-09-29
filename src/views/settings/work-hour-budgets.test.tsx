import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const listBudgets = vi.fn();
const setBudget = vi.fn();
const deleteBudget = vi.fn();
const listClients = vi.fn();
const listProjects = vi.fn();

vi.mock("../../lib/ipc", async () => {
  const actual =
    await vi.importActual<typeof import("../../lib/ipc")>("../../lib/ipc");
  return {
    ...actual,
    listBudgets: (...a: unknown[]) => listBudgets(...a),
    setBudget: (...a: unknown[]) => setBudget(...a),
    deleteBudget: (...a: unknown[]) => deleteBudget(...a),
    listClients: (...a: unknown[]) => listClients(...a),
    listProjects: (...a: unknown[]) => listProjects(...a),
  };
});

import { WorkHourBudgetsPanel, parseHours } from "./work-hour-budgets";

const budget = (over: Record<string, unknown> = {}) => ({
  id: "b1",
  scopeType: "workspace",
  scopeId: "",
  period: "weekly",
  minutes: 2400,
  warnPercent: 80,
  ...over,
});

beforeEach(() => {
  listBudgets.mockReset().mockResolvedValue([]);
  setBudget.mockReset().mockResolvedValue([]);
  deleteBudget.mockReset().mockResolvedValue([]);
  listClients.mockReset().mockResolvedValue([]);
  listProjects.mockReset().mockResolvedValue([]);
});

describe("parseHours", () => {
  it("accepts a decimal number of hours", () => {
    expect(parseHours("7.5")).toBe(450);
    expect(parseHours("8")).toBe(480);
    expect(parseHours(" 2 ")).toBe(120);
  });

  it("accepts an h:mm form", () => {
    expect(parseHours("7:30")).toBe(450);
    expect(parseHours("0:45")).toBe(45);
  });

  it("rounds to the minute", () => {
    // A fractional minute inside a cap would make the percentage wobble.
    expect(parseHours("1.008")).toBe(60);
  });

  it("rejects anything that isn't a positive duration", () => {
    for (const text of ["", "   ", "0", "-3", "abc", "7:99", "1:2"]) {
      expect(parseHours(text)).toBeNull();
    }
  });
});

describe("WorkHourBudgetsPanel", () => {
  it("shows the empty state when nothing is configured", async () => {
    render(<WorkHourBudgetsPanel />);
    expect(await screen.findByText(/no budgets yet/i)).toBeTruthy();
  });

  it("explains that a budget is a cap, not a target", async () => {
    // The distinction drives the whole feature's wording, and the one from
    // a project estimate is the thing users would otherwise conflate.
    render(<WorkHourBudgetsPanel />);
    expect(await screen.findByText(/cap on how much you work/i)).toBeTruthy();
    expect(screen.getByText(/never stops a timer/i)).toBeTruthy();
    expect(screen.getByText(/one-off total for the whole job/i)).toBeTruthy();
  });

  it("lists a budget with its period and threshold", async () => {
    listBudgets.mockResolvedValue([budget()]);
    render(<WorkHourBudgetsPanel />);
    expect(await screen.findByText("Everything")).toBeTruthy();
    expect(screen.getByText(/40h per week/)).toBeTruthy();
    expect(screen.getByText(/warn at 80%/)).toBeTruthy();
  });

  it("resolves a scoped budget to its entity name", async () => {
    listBudgets.mockResolvedValue([
      budget({ scopeType: "project", scopeId: "p1", period: "daily" }),
    ]);
    listProjects.mockResolvedValue([
      { id: "p1", name: "Website", archived: false },
    ]);
    render(<WorkHourBudgetsPanel />);
    expect(await screen.findByText("Website")).toBeTruthy();
  });

  it("falls back to the raw id for a scope that's been deleted", async () => {
    // An orphaned budget still has to be findable so it can be removed.
    listBudgets.mockResolvedValue([
      budget({ scopeType: "client", scopeId: "gone" }),
    ]);
    render(<WorkHourBudgetsPanel />);
    expect(await screen.findByText("gone")).toBeTruthy();
  });

  it("keeps Add disabled until the hours are a positive duration", async () => {
    render(<WorkHourBudgetsPanel />);
    const add = await screen.findByRole("button", { name: /add budget/i });
    expect((add as HTMLButtonElement).disabled).toBe(true);

    const hours = screen.getByLabelText(/budget hours/i);
    await userEvent.type(hours, "abc");
    expect((add as HTMLButtonElement).disabled).toBe(true);

    await userEvent.clear(hours);
    await userEvent.type(hours, "7.5");
    expect((add as HTMLButtonElement).disabled).toBe(false);
  });

  it("blocks Add when the threshold is outside 1–100", async () => {
    render(<WorkHourBudgetsPanel />);
    await userEvent.type(await screen.findByLabelText(/budget hours/i), "7.5");
    const add = screen.getByRole("button", { name: /add budget/i });
    expect((add as HTMLButtonElement).disabled).toBe(false);

    const warn = screen.getByLabelText(/warn at percent/i);
    await userEvent.clear(warn);
    await userEvent.type(warn, "150");
    expect((add as HTMLButtonElement).disabled).toBe(true);
  });

  it("blocks Add on a scoped budget until a scope is chosen", async () => {
    listProjects.mockResolvedValue([
      { id: "p1", name: "Website", archived: false },
    ]);
    render(<WorkHourBudgetsPanel />);
    await userEvent.type(await screen.findByLabelText(/budget hours/i), "4");
    await userEvent.selectOptions(
      screen.getByLabelText(/budget scope/i),
      "project",
    );
    const add = screen.getByRole("button", { name: /add budget/i });
    expect((add as HTMLButtonElement).disabled).toBe(true);

    await userEvent.selectOptions(
      screen.getByLabelText(/which project/i),
      "p1",
    );
    expect((add as HTMLButtonElement).disabled).toBe(false);
  });

  it("submits hours as minutes and clears the field on success", async () => {
    setBudget.mockResolvedValue([budget({ minutes: 450 })]);
    render(<WorkHourBudgetsPanel />);
    const hours = await screen.findByLabelText(/budget hours/i);
    await userEvent.type(hours, "7.5");
    await userEvent.selectOptions(
      screen.getByLabelText(/budget period/i),
      "daily",
    );
    await userEvent.click(screen.getByRole("button", { name: /add budget/i }));

    await waitFor(() => expect(setBudget).toHaveBeenCalled());
    expect(setBudget.mock.calls[0][0]).toMatchObject({
      scopeType: "workspace",
      scopeId: "",
      period: "daily",
      minutes: 450,
      warnPercent: 80,
    });
    await waitFor(() => expect((hours as HTMLInputElement).value).toBe(""));
  });

  it("swaps the entity picker to match the chosen scope", async () => {
    listClients.mockResolvedValue([
      { id: "c1", name: "Acme", archived: false },
    ]);
    listProjects.mockResolvedValue([
      { id: "p1", name: "Website", archived: false },
    ]);
    render(<WorkHourBudgetsPanel />);
    const scope = await screen.findByLabelText(/budget scope/i);

    await userEvent.selectOptions(scope, "client");
    expect(await screen.findByRole("option", { name: "Acme" })).toBeTruthy();

    await userEvent.selectOptions(scope, "project");
    expect(await screen.findByRole("option", { name: "Website" })).toBeTruthy();
  });

  it("clears a chosen entity when the scope kind changes", async () => {
    // Otherwise a project id would be submitted as a client budget.
    listClients.mockResolvedValue([
      { id: "c1", name: "Acme", archived: false },
    ]);
    listProjects.mockResolvedValue([
      { id: "p1", name: "Website", archived: false },
    ]);
    render(<WorkHourBudgetsPanel />);
    const scope = await screen.findByLabelText(/budget scope/i);
    await userEvent.selectOptions(scope, "project");
    await userEvent.selectOptions(
      screen.getByLabelText(/which project/i),
      "p1",
    );
    await userEvent.selectOptions(scope, "client");

    expect(
      (screen.getByLabelText(/which client/i) as HTMLSelectElement).value,
    ).toBe("");
  });

  it("removes a budget", async () => {
    listBudgets.mockResolvedValue([budget()]);
    render(<WorkHourBudgetsPanel />);
    await userEvent.click(
      await screen.findByRole("button", {
        name: /remove the everything weekly budget/i,
      }),
    );
    await waitFor(() => expect(deleteBudget).toHaveBeenCalledWith("b1"));
  });

  it("surfaces a backend validation message verbatim", async () => {
    // The backend names the offending field; replacing it with something
    // vaguer would hide which one.
    setBudget.mockRejectedValue(
      "the warning threshold must be between 1 and 100 percent (got 0)",
    );
    render(<WorkHourBudgetsPanel />);
    await userEvent.type(await screen.findByLabelText(/budget hours/i), "8");
    await userEvent.click(screen.getByRole("button", { name: /add budget/i }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/between 1 and 100/);
  });

  it("still renders when the entity lists fail to load", async () => {
    listBudgets.mockResolvedValue([
      budget({ scopeType: "client", scopeId: "c1" }),
    ]);
    listClients.mockRejectedValue(new Error("db locked"));
    render(<WorkHourBudgetsPanel />);
    // Labelled by its raw id, since names are unavailable.
    expect(await screen.findByText("c1")).toBeTruthy();
  });

  it("ignores a load that settles after unmount", async () => {
    let resolve!: (v: unknown) => void;
    listBudgets.mockReturnValue(
      new Promise((r) => {
        resolve = r;
      }),
    );
    const { unmount } = render(<WorkHourBudgetsPanel />);
    unmount();
    resolve([]);
    await Promise.resolve();
  });

  it("accepts an h:mm budget as well as a decimal one", async () => {
    setBudget.mockResolvedValue([]);
    render(<WorkHourBudgetsPanel />);
    const hours = await screen.findByLabelText(/budget hours/i);
    fireEvent.change(hours, { target: { value: "7:30" } });
    await userEvent.click(screen.getByRole("button", { name: /add budget/i }));
    await waitFor(() => expect(setBudget).toHaveBeenCalled());
    expect(setBudget.mock.calls[0][0].minutes).toBe(450);
  });
});

describe("submitting a scoped budget", () => {
  it("sends the chosen entity id rather than an empty scope", async () => {
    // The workspace default is the only scope that submits an empty id.
    listProjects.mockResolvedValue([
      { id: "p1", name: "Website", archived: false },
    ]);
    setBudget.mockResolvedValue([]);
    render(<WorkHourBudgetsPanel />);
    await userEvent.type(await screen.findByLabelText(/budget hours/i), "4");
    await userEvent.selectOptions(
      screen.getByLabelText(/budget scope/i),
      "project",
    );
    await userEvent.selectOptions(
      screen.getByLabelText(/which project/i),
      "p1",
    );
    await userEvent.click(screen.getByRole("button", { name: /add budget/i }));

    await waitFor(() => expect(setBudget).toHaveBeenCalled());
    expect(setBudget.mock.calls[0][0]).toMatchObject({
      scopeType: "project",
      scopeId: "p1",
      minutes: 240,
    });
  });
});
