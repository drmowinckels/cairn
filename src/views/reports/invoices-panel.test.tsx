import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const useInvoices = vi.fn();
vi.mock("../../lib/use-invoices", () => ({ useInvoices: () => useInvoices() }));

const getInvoice = vi.fn();
const listClients = vi.fn();
const exportInvoiceHtml = vi.fn();
vi.mock("../../lib/ipc", async () => {
  const actual =
    await vi.importActual<typeof import("../../lib/ipc")>("../../lib/ipc");
  return {
    ...actual,
    getInvoice: (...a: unknown[]) => getInvoice(...a),
    listClients: (...a: unknown[]) => listClients(...a),
    exportInvoiceHtml: (...a: unknown[]) => exportInvoiceHtml(...a),
  };
});

const save = vi.fn();
vi.mock("@tauri-apps/plugin-dialog", () => ({
  save: (...a: unknown[]) => save(...a),
}));
vi.mock("../../lib/use-backup", () => ({
  withPopoverPinned: (fn: () => unknown) => fn(),
}));

import { InvoicesPanel } from "./invoices-panel";
import { ROUNDING_OFF } from "../../lib/rounding";

const summary = {
  id: "i1",
  number: "INV-0001",
  clientName: "Acme",
  currency: "USD",
  issueDate: "2026-07-15",
  totalCents: 18750,
  status: "draft" as const,
};

const invoice = {
  ...summary,
  clientId: "c1",
  fromDate: "2026-07-01",
  toDate: "2026-08-01",
  taxRateBps: 2500,
  taxLabel: "",
  subtotalCents: 15000,
  taxCents: 3750,
  unratedSeconds: 3600,
  notes: "thanks",
  createdAt: "x",
  lines: [
    {
      id: "l1",
      description: "Website",
      seconds: 5400,
      amountCents: 15000,
      sort: 0,
    },
  ],
};

function state(over: Partial<ReturnType<typeof useInvoices>> = {}) {
  return {
    invoices: [],
    busy: false,
    error: null,
    create: vi.fn().mockResolvedValue(null),
    remove: vi.fn().mockResolvedValue(true),
    setStatus: vi.fn().mockResolvedValue(true),
    ...over,
  };
}

beforeEach(() => {
  useInvoices.mockReset();
  getInvoice.mockReset().mockResolvedValue(invoice);
  listClients.mockReset().mockResolvedValue([{ id: "c1", name: "Acme" }]);
  save.mockReset();
  exportInvoiceHtml.mockReset();
});

describe("InvoicesPanel", () => {
  it("shows a loading state, then the empty state", async () => {
    useInvoices.mockReturnValue(state({ invoices: null }));
    const { rerender } = render(<InvoicesPanel rounding={ROUNDING_OFF} />);
    expect(screen.getByText(/loading/i)).toBeTruthy();

    useInvoices.mockReturnValue(state({ invoices: [] }));
    rerender(<InvoicesPanel rounding={ROUNDING_OFF} />);
    expect(await screen.findByText(/no invoices yet/i)).toBeTruthy();
  });

  it("surfaces an error", () => {
    useInvoices.mockReturnValue(state({ error: "Cairn Pro isn't active" }));
    render(<InvoicesPanel rounding={ROUNDING_OFF} />);
    expect(screen.getByText(/isn't active/i)).toBeTruthy();
  });

  it("stays disabled until a client is chosen, then submits the edited form and clears notes", async () => {
    const create = vi.fn().mockResolvedValue(invoice);
    useInvoices.mockReturnValue(state({ create }));
    render(<InvoicesPanel rounding={ROUNDING_OFF} />);

    const btn = screen.getByRole("button", { name: /create invoice/i });
    expect((btn as HTMLButtonElement).disabled).toBe(true);

    await userEvent.selectOptions(
      await screen
        .findByRole("option", { name: "Acme" })
        .then((o) => o.closest("select")!),
      "c1",
    );
    // Edit the range, tax (25% → 2500 bps), and notes.
    fireEvent.change(screen.getByLabelText(/^from$/i), {
      target: { value: "2026-06-01" },
    });
    fireEvent.change(screen.getByLabelText(/^to$/i), {
      target: { value: "2026-07-01" },
    });
    const tax = screen.getByLabelText(/tax percent/i);
    await userEvent.clear(tax);
    await userEvent.type(tax, "25");
    const notes = screen.getByLabelText(/notes/i);
    await userEvent.type(notes, "thank you");
    expect((btn as HTMLButtonElement).disabled).toBe(false);

    await userEvent.click(btn);
    await waitFor(() => expect(create).toHaveBeenCalled());
    expect(create.mock.calls[0][0]).toMatchObject({
      clientId: "c1",
      fromDate: "2026-06-01",
      toDate: "2026-07-01",
      taxRateBps: 2500,
      notes: "thank you",
    });
    // Notes clear on success.
    await waitFor(() => expect((notes as HTMLInputElement).value).toBe(""));
  });

  it("lists invoices and expands one to show its lines, totals, and unrated note", async () => {
    useInvoices.mockReturnValue(state({ invoices: [summary] }));
    render(<InvoicesPanel rounding={ROUNDING_OFF} />);

    // Row summary.
    expect(screen.getByText("INV-0001")).toBeTruthy();
    expect(screen.getByText("Acme")).toBeTruthy();
    expect(screen.getByText("$187.50")).toBeTruthy();

    await userEvent.click(screen.getByRole("button", { name: /INV-0001/ }));
    expect(getInvoice).toHaveBeenCalledWith("i1");

    // Detail: line, totals, unrated note.
    expect(await screen.findByText("Website")).toBeTruthy();
    expect(screen.getByText("Subtotal")).toBeTruthy();
    expect(screen.getByText("Total")).toBeTruthy();
    // $150.00 shows for both the line amount and the subtotal.
    expect(screen.getAllByText(/\$150\.00/).length).toBeGreaterThan(0);
    expect(screen.getByText(/billable but unpriced/i)).toBeTruthy();
    // No frozen tax label on the invoice → the tax line defaults to "Tax".
    expect(screen.getByText(/Tax \(25%\)/)).toBeTruthy();

    // Clicking the row again collapses the detail.
    await userEvent.click(screen.getByRole("button", { name: /INV-0001/ }));
    await waitFor(() => expect(screen.queryByText("Website")).toBeNull());
  });

  it("labels the tax line with the invoice's frozen tax label", async () => {
    // The label rides on the invoice (snapshotted at creation), not the live
    // business profile — so an old invoice keeps the label it was issued with.
    getInvoice.mockResolvedValue({ ...invoice, taxLabel: "VAT" });
    useInvoices.mockReturnValue(state({ invoices: [summary] }));
    render(<InvoicesPanel rounding={ROUNDING_OFF} />);

    await userEvent.click(screen.getByRole("button", { name: /INV-0001/ }));
    expect(await screen.findByText(/VAT \(25%\)/)).toBeTruthy();
    expect(screen.queryByText(/^Tax \(25%\)$/)).toBeNull();
  });

  it("changes status and deletes from the expanded detail", async () => {
    const setStatus = vi.fn().mockResolvedValue(true);
    const remove = vi.fn().mockResolvedValue(true);
    useInvoices.mockReturnValue(
      state({ invoices: [summary], setStatus, remove }),
    );
    render(<InvoicesPanel rounding={ROUNDING_OFF} />);

    await userEvent.click(screen.getByRole("button", { name: /INV-0001/ }));
    await screen.findByText("Website");

    const statusGroup = screen.getByRole("radiogroup", {
      name: /invoice status/i,
    });
    await userEvent.click(
      within(statusGroup).getByRole("radio", { name: "sent" }),
    );
    expect(setStatus).toHaveBeenCalledWith("i1", "sent");

    await userEvent.click(screen.getByRole("button", { name: /^delete$/i }));
    expect(remove).toHaveBeenCalledWith("i1");
  });

  it("ignores a slow detail fetch when another row is expanded first", async () => {
    const invB = {
      ...invoice,
      id: "i2",
      number: "INV-0002",
      notes: null, // also exercises the no-notes detail branch
      lines: [
        {
          id: "l2",
          description: "Audit",
          seconds: 3600,
          amountCents: 20000,
          sort: 0,
        },
      ],
    };
    let resolveA!: (v: unknown) => void;
    getInvoice.mockImplementation((id: string) =>
      id === "i1"
        ? new Promise((r) => {
            resolveA = r;
          })
        : Promise.resolve(invB),
    );
    useInvoices.mockReturnValue(
      state({
        invoices: [summary, { ...summary, id: "i2", number: "INV-0002" }],
      }),
    );
    render(<InvoicesPanel rounding={ROUNDING_OFF} />);

    // Expand A (fetch pending), then B (resolves immediately).
    await userEvent.click(screen.getByRole("button", { name: /INV-0001/ }));
    await userEvent.click(screen.getByRole("button", { name: /INV-0002/ }));
    expect(await screen.findByText("Audit")).toBeTruthy();

    // A's late response must not clobber B's detail.
    resolveA(invoice);
    await Promise.resolve();
    expect(screen.getByText("Audit")).toBeTruthy();
    expect(screen.queryByText("Website")).toBeNull();
  });

  it("sends null notes when the field is empty and keeps the form when create fails", async () => {
    const create = vi.fn().mockResolvedValue(null);
    useInvoices.mockReturnValue(state({ create }));
    render(<InvoicesPanel rounding={ROUNDING_OFF} />);

    await userEvent.selectOptions(
      await screen
        .findByRole("option", { name: "Acme" })
        .then((o) => o.closest("select")!),
      "c1",
    );
    await userEvent.click(
      screen.getByRole("button", { name: /create invoice/i }),
    );
    await waitFor(() => expect(create).toHaveBeenCalled());
    // Empty notes → null; a failed create leaves the panel unchanged.
    expect(create.mock.calls[0][0].notes).toBeNull();
    expect(screen.getByText(/no invoices yet/i)).toBeTruthy();
  });

  it("ignores a client load that settles after unmount", async () => {
    let resolve!: (v: unknown) => void;
    listClients.mockReturnValue(
      new Promise((r) => {
        resolve = r;
      }),
    );
    useInvoices.mockReturnValue(state());
    const { unmount } = render(<InvoicesPanel rounding={ROUNDING_OFF} />);
    unmount();
    resolve([{ id: "c1", name: "Acme" }]);
    await Promise.resolve();
  });

  async function expandFirstRow() {
    useInvoices.mockReturnValue(state({ invoices: [summary] }));
    render(<InvoicesPanel rounding={ROUNDING_OFF} />);
    await userEvent.click(screen.getByRole("button", { name: /INV-0001/ }));
    await screen.findByText("Website");
  }

  it("saves an invoice to HTML through the save dialog", async () => {
    save.mockResolvedValue("/tmp/INV-0001.html");
    exportInvoiceHtml.mockResolvedValue("/tmp/INV-0001.html");
    await expandFirstRow();

    await userEvent.click(
      screen.getByRole("button", { name: /save as html/i }),
    );
    await waitFor(() =>
      expect(exportInvoiceHtml).toHaveBeenCalledWith(
        "i1",
        "/tmp/INV-0001.html",
      ),
    );
    // Default filename is derived from the invoice number.
    expect(save.mock.calls[0][0]).toMatchObject({
      defaultPath: "INV-0001.html",
    });
    expect(await screen.findByText(/saved to/i)).toBeTruthy();
  });

  it("does nothing when the save dialog is cancelled", async () => {
    save.mockResolvedValue(null);
    await expandFirstRow();
    await userEvent.click(
      screen.getByRole("button", { name: /save as html/i }),
    );
    await waitFor(() => expect(save).toHaveBeenCalled());
    expect(exportInvoiceHtml).not.toHaveBeenCalled();
  });

  it("shows an export failure as an alert, not a muted note", async () => {
    save.mockResolvedValue("/tmp/x.html");
    exportInvoiceHtml.mockRejectedValue("disk full");
    await expandFirstRow();
    await userEvent.click(
      screen.getByRole("button", { name: /save as html/i }),
    );
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/disk full/i);
  });

  it("clears a stale save notice when switching to another invoice", async () => {
    save.mockResolvedValue("/tmp/INV-0001.html");
    exportInvoiceHtml.mockResolvedValue("/tmp/INV-0001.html");
    const summaryB = { ...summary, id: "i2", number: "INV-0002" };
    getInvoice.mockImplementation((id: string) =>
      Promise.resolve(id === "i2" ? { ...invoice, ...summaryB } : invoice),
    );
    useInvoices.mockReturnValue(state({ invoices: [summary, summaryB] }));
    render(<InvoicesPanel rounding={ROUNDING_OFF} />);

    await userEvent.click(screen.getByRole("button", { name: /INV-0001/ }));
    await screen.findByText("Website");
    await userEvent.click(
      screen.getByRole("button", { name: /save as html/i }),
    );
    expect(await screen.findByText(/saved to/i)).toBeTruthy();

    // Switching rows drops the note so it can't reappear under INV-0002.
    await userEvent.click(screen.getByRole("button", { name: /INV-0002/ }));
    await waitFor(() => expect(screen.queryByText(/saved to/i)).toBeNull());
  });
});
