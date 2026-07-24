import { save } from "@tauri-apps/plugin-dialog";
import { useEffect, useRef, useState } from "react";
import { Empty, ErrorBanner } from "../../lib/components";
import {
  exportInvoiceHtml,
  getInvoice,
  listClients,
  type Invoice,
  type InvoiceStatus,
} from "../../lib/ipc";
import { formatMoney } from "../../lib/money";
import { isoLocalDate, secondsToHours } from "../../lib/report-math";
import type { Rounding } from "../../lib/rounding";
import type { Client } from "../../lib/types";
import { withPopoverPinned } from "../../lib/use-backup";
import { useInvoices } from "../../lib/use-invoices";

const STATUSES: InvoiceStatus[] = ["draft", "sent", "paid"];

function hours(seconds: number): string {
  return secondsToHours(seconds).toFixed(1);
}

/** Percent from basis points, trimmed of trailing zeros (825 → "8.25"). */
function taxPercentLabel(bps: number): string {
  return String(Number((bps / 100).toFixed(2)));
}

/** Default range: the current calendar month `[1st, 1st of next month)`. */
function currentMonthRange(): { from: string; to: string } {
  const now = new Date();
  const first = new Date(now.getFullYear(), now.getMonth(), 1);
  const next = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  return { from: isoLocalDate(first), to: isoLocalDate(next) };
}

/** The Reports → Invoices tab (#1). Generate an invoice for a client + date
 *  range, list stored invoices, and expand one to see its lines and change
 *  its status or delete it. Only mounts when Pro is active. */
export function InvoicesPanel({ rounding }: { rounding: Rounding }) {
  const { invoices, busy, error, create, remove, setStatus } = useInvoices();
  const [clients, setClients] = useState<Client[]>([]);
  // Guards the expand fetch: bumped by every action that changes what the
  // detail should show, so a slow `getInvoice` can't overwrite a newer one.
  const detailReq = useRef(0);
  const [clientId, setClientId] = useState("");
  const initial = currentMonthRange();
  const [from, setFrom] = useState(initial.from);
  const [to, setTo] = useState(initial.to);
  const [taxPercent, setTaxPercent] = useState("0");
  const [notes, setNotes] = useState("");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<Invoice | null>(null);
  // A per-save note shown under the expanded row. Cleared whenever the
  // expanded row changes so a success/error can't leak onto another invoice.
  const [notice, setNotice] = useState<{
    text: string;
    error: boolean;
  } | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const cs = await listClients();
        if (alive) setClients(cs);
      } catch {
        // Leave the picker empty; the create button stays disabled.
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const taxNum = Number(taxPercent);
  const taxValid =
    taxPercent.trim() !== "" && Number.isFinite(taxNum) && taxNum >= 0;
  const canCreate =
    !busy && clientId !== "" && from !== "" && to !== "" && taxValid;

  const toggle = (id: string) => {
    const req = ++detailReq.current;
    setNotice(null);
    if (expandedId === id) {
      setExpandedId(null);
      setDetail(null);
      return;
    }
    setExpandedId(id);
    setDetail(null);
    void getInvoice(id).then((inv) => {
      if (detailReq.current === req) setDetail(inv);
    });
  };

  // Called only from the Add button, which is `disabled` unless `canCreate`.
  const submit = () => {
    void create({
      clientId,
      fromDate: from,
      toDate: to,
      taxRateBps: Math.round(taxNum * 100),
      notes: notes.trim() || null,
      rounding,
    }).then((inv) => {
      if (inv) {
        // Invalidate any in-flight expand fetch, then show the new invoice.
        detailReq.current += 1;
        setNotes("");
        setNotice(null);
        setExpandedId(inv.id);
        setDetail(inv);
      }
    });
  };

  // Status and delete act on the row's id and read status from the (live)
  // list summary, so there's no stale in-detail copy to keep in sync.
  const removeRow = (id: string) => {
    detailReq.current += 1;
    void remove(id);
    setExpandedId(null);
    setDetail(null);
  };

  const saveHtml = async (inv: Invoice) => {
    setNotice(null);
    try {
      // Pin the popover so the native save dialog doesn't dismiss it.
      const dest = await withPopoverPinned(() =>
        save({
          title: "Save invoice",
          defaultPath: `${inv.number}.html`,
          filters: [{ name: "HTML", extensions: ["html"] }],
        }),
      );
      if (typeof dest !== "string") return; // cancelled
      const path = await exportInvoiceHtml(inv.id, dest);
      setNotice({ text: `Saved to ${path}`, error: false });
    } catch (e) {
      setNotice({ text: String(e), error: true });
    }
  };

  return (
    <section className="rep-invoices" aria-label="Invoices">
      <div
        className="data-add-row inv-create"
        role="group"
        aria-label="New invoice"
      >
        <select
          className="field-input"
          aria-label="Client"
          value={clientId}
          onChange={(e) => setClientId(e.target.value)}
        >
          <option value="">Choose a client…</option>
          {clients.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        <input
          className="field-input"
          type="date"
          aria-label="From"
          value={from}
          onChange={(e) => setFrom(e.target.value)}
        />
        <input
          className="field-input"
          type="date"
          aria-label="To"
          value={to}
          onChange={(e) => setTo(e.target.value)}
        />
        <input
          className="field-input"
          type="number"
          min="0"
          step="0.1"
          inputMode="decimal"
          aria-label="Tax percent"
          value={taxPercent}
          onChange={(e) => setTaxPercent(e.target.value)}
        />
        <input
          className="field-input"
          aria-label="Notes"
          placeholder="Notes (optional)"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
        />
        <button
          type="button"
          className="btn btn--primary btn--sm"
          onClick={submit}
          disabled={!canCreate}
        >
          Create invoice
        </button>
      </div>

      {error && <ErrorBanner message={error} />}

      {invoices === null ? (
        <p className="settings-sub">Loading…</p>
      ) : invoices.length === 0 ? (
        <Empty
          title="No invoices yet"
          body="Pick a client and date range above to generate one from billable time."
        />
      ) : (
        <ul className="inv-list">
          {invoices.map((inv) => (
            <li key={inv.id} className="inv-row" data-status={inv.status}>
              <button
                type="button"
                className="inv-head"
                aria-expanded={expandedId === inv.id}
                aria-controls={`inv-detail-${inv.id}`}
                onClick={() => toggle(inv.id)}
              >
                <span className="inv-number">{inv.number}</span>
                <span className="inv-client">{inv.clientName}</span>
                <span className="inv-total">
                  {formatMoney(inv.totalCents, inv.currency)}
                </span>
                <span className={`inv-badge inv-badge--${inv.status}`}>
                  {inv.status}
                </span>
              </button>
              {expandedId === inv.id &&
                (detail === null ? (
                  <p className="settings-sub" data-inv="loading">
                    Loading…
                  </p>
                ) : (
                  <div className="inv-detail" id={`inv-detail-${inv.id}`}>
                    <table className="rep-profit-table">
                      <thead>
                        <tr>
                          <th scope="col">Project</th>
                          <th scope="col">Hours</th>
                          <th scope="col">Amount</th>
                        </tr>
                      </thead>
                      <tbody>
                        {detail.lines.map((line) => (
                          <tr key={line.id}>
                            <td>{line.description}</td>
                            <td>{hours(line.seconds)}h</td>
                            <td>
                              {formatMoney(line.amountCents, detail.currency)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>

                    <dl className="inv-totals">
                      <div>
                        <dt>Subtotal</dt>
                        <dd>
                          {formatMoney(detail.subtotalCents, detail.currency)}
                        </dd>
                      </div>
                      <div>
                        <dt>Tax ({taxPercentLabel(detail.taxRateBps)}%)</dt>
                        <dd>{formatMoney(detail.taxCents, detail.currency)}</dd>
                      </div>
                      <div className="inv-grand">
                        <dt>Total</dt>
                        <dd>
                          {formatMoney(detail.totalCents, detail.currency)}
                        </dd>
                      </div>
                    </dl>

                    {detail.unratedSeconds > 0 && (
                      <p className="settings-sub" data-inv="unrated">
                        {hours(detail.unratedSeconds)}h billable but unpriced in
                        this range — not invoiced. Set a rate to include it.
                      </p>
                    )}

                    {detail.notes ? (
                      <p className="settings-sub">{detail.notes}</p>
                    ) : null}

                    <div className="data-form-actions">
                      <span
                        className="seg"
                        role="radiogroup"
                        aria-label="Invoice status"
                      >
                        {STATUSES.map((s) => (
                          <button
                            key={s}
                            type="button"
                            role="radio"
                            aria-checked={inv.status === s}
                            className={`seg-btn${inv.status === s ? " is-on" : ""}`}
                            onClick={() => void setStatus(inv.id, s)}
                            disabled={busy}
                          >
                            {s}
                          </button>
                        ))}
                      </span>
                      <button
                        type="button"
                        className="btn btn--ghost btn--sm"
                        onClick={() => void saveHtml(detail)}
                      >
                        Save as HTML
                      </button>
                      <button
                        type="button"
                        className="btn btn--ghost btn--sm"
                        onClick={() => removeRow(inv.id)}
                        disabled={busy}
                      >
                        Delete
                      </button>
                    </div>
                    {notice && (
                      <p
                        className={
                          notice.error ? "field-error" : "settings-sub"
                        }
                        role={notice.error ? "alert" : undefined}
                        data-inv="notice"
                      >
                        {notice.text}
                      </p>
                    )}
                  </div>
                ))}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
