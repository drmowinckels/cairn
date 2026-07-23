import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const billingListRates = vi.fn();
const billingSetRate = vi.fn();
const billingDeleteRate = vi.fn();
const listClients = vi.fn();
const listProjects = vi.fn();
const listTasks = vi.fn();

vi.mock("../../lib/ipc", async () => {
  const actual =
    await vi.importActual<typeof import("../../lib/ipc")>("../../lib/ipc");
  return {
    ...actual,
    billingListRates: (...a: unknown[]) => billingListRates(...a),
    billingSetRate: (...a: unknown[]) => billingSetRate(...a),
    billingDeleteRate: (...a: unknown[]) => billingDeleteRate(...a),
    listClients: (...a: unknown[]) => listClients(...a),
    listProjects: (...a: unknown[]) => listProjects(...a),
    listTasks: (...a: unknown[]) => listTasks(...a),
  };
});

import { BillingRatesPanel } from "./billing-rates";

const rate = (over: Record<string, unknown>) => ({
  id: "id",
  scopeType: "workspace",
  scopeId: "",
  amountCents: 12000,
  currency: "USD",
  effectiveFrom: "2026-01-01",
  createdAt: "x",
  ...over,
});

beforeEach(() => {
  billingListRates.mockReset().mockResolvedValue([]);
  billingSetRate.mockReset().mockResolvedValue([]);
  billingDeleteRate.mockReset().mockResolvedValue([]);
  listClients.mockReset().mockResolvedValue([]);
  listProjects.mockReset().mockResolvedValue([]);
  listTasks.mockReset().mockResolvedValue([]);
});

describe("BillingRatesPanel", () => {
  it("shows the empty state when nothing is configured", async () => {
    render(<BillingRatesPanel />);
    expect(await screen.findByText(/no rates yet/i)).toBeTruthy();
  });

  it("lists each scope with its resolved name and formatted money", async () => {
    billingListRates.mockResolvedValue([
      rate({
        id: "w",
        scopeType: "workspace",
        scopeId: "",
        amountCents: 12000,
      }),
      rate({
        id: "c",
        scopeType: "client",
        scopeId: "c1",
        amountCents: 15000,
        effectiveFrom: "2026-03-01",
      }),
      rate({ id: "p", scopeType: "project", scopeId: "p1", amountCents: 9000 }),
      rate({ id: "t", scopeType: "task", scopeId: "t1", amountCents: 20000 }),
      // Rates whose entity was deleted — each falls back to the raw id.
      rate({ id: "o", scopeType: "client", scopeId: "gone" }),
      rate({ id: "po", scopeType: "project", scopeId: "vanished" }),
      rate({ id: "to", scopeType: "task", scopeId: "removed" }),
    ]);
    listClients.mockResolvedValue([
      { id: "c1", name: "Acme", archived: false },
    ]);
    listProjects.mockResolvedValue([
      { id: "p1", name: "Website", archived: false },
    ]);
    listTasks.mockResolvedValue([{ id: "t1", name: "Audit", archived: false }]);

    render(<BillingRatesPanel />);
    expect(await screen.findByText("Acme")).toBeTruthy();
    expect(screen.getByText("Website")).toBeTruthy();
    expect(screen.getByText("Audit")).toBeTruthy();
    // Orphaned scopes show their id rather than vanishing (client/project/task).
    expect(screen.getByText("gone")).toBeTruthy();
    expect(screen.getByText("vanished")).toBeTruthy();
    expect(screen.getByText("removed")).toBeTruthy();
    // The workspace row rendered (its remove control names the scope).
    expect(
      screen.getByRole("button", {
        name: /remove the workspace default rate/i,
      }),
    ).toBeTruthy();
    // 150.00 of some currency is rendered for the client rate.
    expect(screen.getByText(/150/)).toBeTruthy();
  });

  it("renders an unusual but well-formed currency code as-is", async () => {
    billingListRates.mockResolvedValue([
      rate({ id: "z", currency: "ZZZ", amountCents: 5000 }),
    ]);
    render(<BillingRatesPanel />);
    const amount = await screen.findByText(/ZZZ/);
    expect(amount.textContent).toMatch(/50/);
  });

  it("keeps Add disabled until the amount is a valid number", async () => {
    render(<BillingRatesPanel />);
    const add = await screen.findByRole("button", { name: /add rate/i });
    expect((add as HTMLButtonElement).disabled).toBe(true);

    const amount = screen.getByLabelText(/hourly amount/i);
    await userEvent.type(amount, "abc");
    expect((add as HTMLButtonElement).disabled).toBe(true);

    // A negative rate is rejected too.
    await userEvent.clear(amount);
    await userEvent.type(amount, "-5");
    expect((add as HTMLButtonElement).disabled).toBe(true);

    await userEvent.clear(amount);
    await userEvent.type(amount, "50");
    expect((add as HTMLButtonElement).disabled).toBe(false);
  });

  it("blocks Add when the currency is not three letters", async () => {
    render(<BillingRatesPanel />);
    await userEvent.type(await screen.findByLabelText(/hourly amount/i), "50");
    const add = screen.getByRole("button", { name: /add rate/i });
    expect((add as HTMLButtonElement).disabled).toBe(false);

    const currency = screen.getByLabelText(/currency/i);
    await userEvent.clear(currency);
    // Three characters, but not all letters — Intl would choke on this.
    await userEvent.type(currency, "US1");
    expect((add as HTMLButtonElement).disabled).toBe(true);
  });

  it("swaps the entity picker to match the chosen scope", async () => {
    listProjects.mockResolvedValue([
      { id: "p1", name: "Website", archived: false },
    ]);
    listTasks.mockResolvedValue([{ id: "t1", name: "Audit", archived: false }]);
    render(<BillingRatesPanel />);
    const scope = await screen.findByLabelText(/rate scope/i);

    await userEvent.selectOptions(scope, "project");
    expect(await screen.findByRole("option", { name: "Website" })).toBeTruthy();

    await userEvent.selectOptions(scope, "task");
    expect(await screen.findByRole("option", { name: "Audit" })).toBeTruthy();
  });

  it("still renders when the entity lists fail to load", async () => {
    billingListRates.mockResolvedValue([
      rate({ id: "c", scopeType: "client", scopeId: "c1" }),
    ]);
    listClients.mockRejectedValue(new Error("db locked"));
    render(<BillingRatesPanel />);
    // The rate still shows, labeled by its raw id since names are unavailable.
    expect(await screen.findByText("c1")).toBeTruthy();
  });

  it("ignores an entity load that settles after unmount", async () => {
    let resolve!: (v: unknown) => void;
    listClients.mockReturnValue(
      new Promise((r) => {
        resolve = r;
      }),
    );
    const { unmount } = render(<BillingRatesPanel />);
    unmount();
    resolve([]);
    await Promise.resolve();
  });

  it("adds a workspace rate with the entered amount in cents", async () => {
    billingSetRate.mockResolvedValue([rate({ id: "w", amountCents: 12000 })]);
    render(<BillingRatesPanel />);
    const amount = await screen.findByLabelText(/hourly amount/i);
    await userEvent.type(amount, "120");
    // Pick an explicit effective date (also covers the date onChange).
    fireEvent.change(screen.getByLabelText(/effective from/i), {
      target: { value: "2026-02-15" },
    });
    await userEvent.click(screen.getByRole("button", { name: /add rate/i }));

    await waitFor(() => expect(billingSetRate).toHaveBeenCalled());
    const arg = billingSetRate.mock.calls[0][0];
    expect(arg).toMatchObject({
      scopeType: "workspace",
      scopeId: "",
      amountCents: 12000,
      currency: "USD",
      effectiveFrom: "2026-02-15",
    });
    // The amount clears on success.
    await waitFor(() => expect((amount as HTMLInputElement).value).toBe(""));
  });

  it("requires a chosen entity for a non-workspace scope, then passes its id", async () => {
    listClients.mockResolvedValue([
      { id: "c1", name: "Acme", archived: false },
    ]);
    billingSetRate.mockResolvedValue([]);
    render(<BillingRatesPanel />);

    await userEvent.selectOptions(
      await screen.findByLabelText(/rate scope/i),
      "client",
    );
    await userEvent.type(screen.getByLabelText(/hourly amount/i), "150");
    const add = screen.getByRole("button", { name: /add rate/i });
    // No client picked yet ⇒ still blocked.
    expect((add as HTMLButtonElement).disabled).toBe(true);

    await userEvent.selectOptions(screen.getByLabelText(/which client/i), "c1");
    expect((add as HTMLButtonElement).disabled).toBe(false);
    await userEvent.click(add);

    await waitFor(() => expect(billingSetRate).toHaveBeenCalled());
    expect(billingSetRate.mock.calls[0][0]).toMatchObject({
      scopeType: "client",
      scopeId: "c1",
      amountCents: 15000,
    });
  });

  it("removes a rate by id", async () => {
    billingListRates.mockResolvedValue([
      rate({ id: "w", scopeType: "workspace" }),
    ]);
    billingDeleteRate.mockResolvedValue([]);
    render(<BillingRatesPanel />);

    await userEvent.click(
      await screen.findByRole("button", {
        name: /remove the workspace default rate/i,
      }),
    );
    expect(billingDeleteRate).toHaveBeenCalledWith("w");
    await waitFor(() => expect(screen.getByText(/no rates yet/i)).toBeTruthy());
  });

  it("surfaces an add failure as an alert", async () => {
    billingSetRate.mockRejectedValue("Cairn Pro isn't active");
    render(<BillingRatesPanel />);
    await userEvent.type(await screen.findByLabelText(/hourly amount/i), "100");
    await userEvent.click(screen.getByRole("button", { name: /add rate/i }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("isn't active");
  });
});
