import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";

const listInvoices = vi.fn();
const createInvoice = vi.fn();
const deleteInvoice = vi.fn();
const setInvoiceStatus = vi.fn();

vi.mock("./ipc", async () => {
  const actual = await vi.importActual<typeof import("./ipc")>("./ipc");
  return {
    ...actual,
    listInvoices: (...a: unknown[]) => listInvoices(...a),
    createInvoice: (...a: unknown[]) => createInvoice(...a),
    deleteInvoice: (...a: unknown[]) => deleteInvoice(...a),
    setInvoiceStatus: (...a: unknown[]) => setInvoiceStatus(...a),
  };
});

import { useInvoices } from "./use-invoices";

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
  subtotalCents: 15000,
  taxCents: 3750,
  unratedSeconds: 0,
  notes: null,
  createdAt: "x",
  lines: [
    {
      id: "l1",
      description: "Website",
      seconds: 3600,
      amountCents: 15000,
      sort: 0,
    },
  ],
};

const input = {
  clientId: "c1",
  fromDate: "2026-07-01",
  toDate: "2026-08-01",
  taxRateBps: 2500,
};

beforeEach(() => {
  listInvoices.mockReset().mockResolvedValue([]);
  createInvoice.mockReset();
  deleteInvoice.mockReset();
  setInvoiceStatus.mockReset();
});

describe("useInvoices", () => {
  it("loads the list on mount", async () => {
    listInvoices.mockResolvedValue([summary]);
    const { result } = renderHook(() => useInvoices());
    await waitFor(() => expect(result.current.invoices).toHaveLength(1));
    expect(result.current.error).toBeNull();
  });

  it("surfaces a load failure and leaves invoices null", async () => {
    listInvoices.mockRejectedValue(new Error("the billing plugin is off"));
    const { result } = renderHook(() => useInvoices());
    await waitFor(() =>
      expect(result.current.error).toContain("plugin is off"),
    );
    expect(result.current.invoices).toBeNull();
  });

  it("create returns the invoice and refreshes the list", async () => {
    createInvoice.mockResolvedValue(invoice);
    listInvoices.mockResolvedValueOnce([]).mockResolvedValueOnce([summary]);
    const { result } = renderHook(() => useInvoices());
    await waitFor(() => expect(result.current.invoices).toEqual([]));

    let created: unknown;
    await act(async () => {
      created = await result.current.create(input);
    });
    expect(created).toEqual(invoice);
    expect(createInvoice).toHaveBeenCalledWith(input);
    await waitFor(() => expect(result.current.invoices).toHaveLength(1));
  });

  it("a failed create resolves null and surfaces the reason", async () => {
    createInvoice.mockRejectedValue("no billable, priced time");
    const { result } = renderHook(() => useInvoices());
    await waitFor(() => expect(result.current.invoices).toEqual([]));

    let created: unknown = "x";
    await act(async () => {
      created = await result.current.create(input);
    });
    expect(created).toBeNull();
    expect(result.current.error).toContain("no billable");
  });

  it("remove uses the fresh list the backend returns", async () => {
    listInvoices.mockResolvedValue([summary]);
    deleteInvoice.mockResolvedValue([]);
    const { result } = renderHook(() => useInvoices());
    await waitFor(() => expect(result.current.invoices).toHaveLength(1));

    let ok = false;
    await act(async () => {
      ok = await result.current.remove("i1");
    });
    expect(ok).toBe(true);
    expect(deleteInvoice).toHaveBeenCalledWith("i1");
    expect(result.current.invoices).toEqual([]);
  });

  it("a failed remove resolves false and surfaces the reason", async () => {
    deleteInvoice.mockRejectedValue("Cairn Pro isn't active");
    const { result } = renderHook(() => useInvoices());
    await waitFor(() => expect(result.current.invoices).toEqual([]));

    let ok = true;
    await act(async () => {
      ok = await result.current.remove("i1");
    });
    expect(ok).toBe(false);
    expect(result.current.error).toContain("isn't active");
  });

  it("setStatus updates and refreshes the list", async () => {
    setInvoiceStatus.mockResolvedValue({ ...invoice, status: "sent" });
    listInvoices
      .mockResolvedValueOnce([summary])
      .mockResolvedValueOnce([{ ...summary, status: "sent" }]);
    const { result } = renderHook(() => useInvoices());
    await waitFor(() => expect(result.current.invoices).toHaveLength(1));

    let ok = false;
    await act(async () => {
      ok = await result.current.setStatus("i1", "sent");
    });
    expect(ok).toBe(true);
    expect(setInvoiceStatus).toHaveBeenCalledWith("i1", "sent");
    await waitFor(() =>
      expect(result.current.invoices?.[0].status).toBe("sent"),
    );
  });

  it("a failed setStatus resolves false and surfaces the reason", async () => {
    setInvoiceStatus.mockRejectedValue("unknown invoice");
    const { result } = renderHook(() => useInvoices());
    await waitFor(() => expect(result.current.invoices).toEqual([]));

    let ok = true;
    await act(async () => {
      ok = await result.current.setStatus("i1", "paid");
    });
    expect(ok).toBe(false);
    expect(result.current.error).toContain("unknown invoice");
  });

  it("ignores a load that settles after unmount", async () => {
    let resolve!: (v: unknown) => void;
    listInvoices.mockReturnValue(
      new Promise((r) => {
        resolve = r;
      }),
    );
    const { unmount } = renderHook(() => useInvoices());
    unmount();
    resolve([summary]);
    await Promise.resolve();
  });

  it("ignores a load that rejects after unmount", async () => {
    let reject!: (e: unknown) => void;
    listInvoices.mockReturnValue(
      new Promise((_r, rej) => {
        reject = rej;
      }),
    );
    const { unmount } = renderHook(() => useInvoices());
    unmount();
    reject(new Error("late"));
    await Promise.resolve();
  });
});
