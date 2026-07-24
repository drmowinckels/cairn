import { useCallback, useEffect, useState } from "react";
import {
  createInvoice,
  deleteInvoice,
  listInvoices,
  setInvoiceStatus,
  type Invoice,
  type InvoiceStatus,
  type InvoiceSummary,
} from "./ipc";

export type CreateInvoiceInput = Parameters<typeof createInvoice>[0];

export interface UseInvoices {
  /** `null` while the first load is in flight or outside Tauri. */
  invoices: InvoiceSummary[] | null;
  busy: boolean;
  error: string | null;
  /** Resolves the created invoice (with lines), or `null` on failure. */
  create: (input: CreateInvoiceInput) => Promise<Invoice | null>;
  remove: (id: string) => Promise<boolean>;
  setStatus: (id: string, status: InvoiceStatus) => Promise<boolean>;
}

/** State + actions behind the invoices panel (#1). Loads the list once and
 *  keeps it in sync after each mutation. Writes go through the backend Pro
 *  gate. */
export function useInvoices(): UseInvoices {
  const [invoices, setInvoices] = useState<InvoiceSummary[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const list = await listInvoices();
        if (alive) setInvoices(list);
      } catch (e) {
        if (alive) setError(String(e));
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const create = useCallback<UseInvoices["create"]>(async (input) => {
    setBusy(true);
    setError(null);
    try {
      const invoice = await createInvoice(input);
      setInvoices(await listInvoices());
      return invoice;
    } catch (e) {
      setError(String(e));
      return null;
    } finally {
      setBusy(false);
    }
  }, []);

  const remove = useCallback(async (id: string) => {
    setBusy(true);
    setError(null);
    try {
      // Delete returns the fresh list.
      setInvoices(await deleteInvoice(id));
      return true;
    } catch (e) {
      setError(String(e));
      return false;
    } finally {
      setBusy(false);
    }
  }, []);

  const setStatus = useCallback(async (id: string, status: InvoiceStatus) => {
    setBusy(true);
    setError(null);
    try {
      await setInvoiceStatus(id, status);
      setInvoices(await listInvoices());
      return true;
    } catch (e) {
      setError(String(e));
      return false;
    } finally {
      setBusy(false);
    }
  }, []);

  return { invoices, busy, error, create, remove, setStatus };
}
