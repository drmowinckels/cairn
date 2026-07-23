import { useState } from "react";
import { formatRelativeTime } from "../../lib/relative-time";
import { useBilling, type UseBilling } from "../../lib/use-billing";
import { BillingRatesPanel } from "./billing-rates";

/**
 * The Pro license row (#109), rendered under the billing plugin's toggle
 * while it is enabled. Licenses are verified **directly with Lemon
 * Squeezy** (activate / re-check / deactivate) — the same approach as the
 * sister app Entracte. A licensing call carries only the key + a device
 * id, never tracked time data; the "Checking…" state surfaces the network
 * activity (docs/PRIVACY.md).
 *
 * Presentational: its parent [`BillingDetail`] owns the single `useBilling`
 * instance so the license state is shared with the rate panel's gate.
 */
export function BillingLicenseRow({ billing }: { billing: UseBilling }) {
  const { status, busy, error, activate, refresh, deactivate } = billing;
  const [draft, setDraft] = useState("");

  const submit = () => void activate(draft).then((ok) => ok && setDraft(""));
  const errorLine = error && (
    <p className="field-error" role="alert">
      {error}
    </p>
  );
  const checking = busy && (
    <span className="settings-sub" data-billing="checking">
      Checking with Lemon Squeezy…
    </span>
  );

  if (!status) {
    return error ? (
      <p className="field-error" role="alert" data-billing="load-error">
        Couldn’t load the license status: {error}
      </p>
    ) : null;
  }

  const license = status.license;

  if (license) {
    return (
      <div
        className="data-add-row"
        data-billing={license.active ? "active" : "inactive"}
      >
        {license.active ? (
          <p className="settings-sub">
            Licensed
            {license.customerEmail ? (
              <>
                {" "}
                to <strong>{license.customerEmail}</strong>
              </>
            ) : null}
            {license.productName ? ` (${license.productName})` : ""}
            {license.expiresAt ? ` — renews ${license.expiresAt}` : ""}. Checked
            with Lemon Squeezy {formatRelativeTime(license.lastValidatedAt)}.
          </p>
        ) : (
          // Persistent state, not a transient alert — the `errorLine`
          // below is the sole role="alert" so the two don't compete.
          <p className="field-error">
            This license is no longer active ({license.status}). Re-check it, or
            remove it to enter a different key.
          </p>
        )}
        <div className="data-form-actions">
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            onClick={() => void refresh()}
            disabled={busy}
          >
            Re-check
          </button>
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            onClick={() => void deactivate()}
            disabled={busy}
          >
            Remove license
          </button>
        </div>
        {checking}
        {errorLine}
      </div>
    );
  }

  return (
    <div className="data-add-row" data-billing="locked">
      <input
        className="field-input"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && draft.trim()) {
            e.preventDefault();
            submit();
          }
        }}
        placeholder="Paste your Pro license key"
        aria-label="Pro license key"
        disabled={busy}
      />
      <button
        type="button"
        className="btn btn--primary btn--sm"
        onClick={submit}
        disabled={busy || !draft.trim()}
      >
        Activate
      </button>
      <p className="settings-sub" data-billing="network-note">
        Activating checks the key with Lemon Squeezy over the network — the only
        thing billing ever sends out.
      </p>
      {checking}
      {errorLine}
    </div>
  );
}

/**
 * The billing card's detail block (#109): the license row, and — once the
 * license is active — the Pro rate panel. Owns the single `useBilling`
 * instance and shares it, so activating a key immediately reveals the
 * rate panel without a remount. Spans the full plugin row.
 */
export function BillingDetail() {
  const billing = useBilling();
  return (
    <div className="plugin-detail" data-plugin-detail="billing">
      <BillingLicenseRow billing={billing} />
      {billing.status?.license?.active && <BillingRatesPanel />}
    </div>
  );
}
