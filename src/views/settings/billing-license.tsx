import { useState } from "react";
import { useBilling } from "../../lib/use-billing";

/**
 * The Pro license row (#109), rendered under the billing plugin's
 * toggle while it is enabled. Verification is fully local (an Ed25519
 * check against a key baked into the build) — no activation server.
 * Builds without a baked-in key say licensing isn't live yet instead
 * of rejecting every key with a signature error.
 */
export function BillingLicenseRow() {
  const { status, busy, error, activate, remove } = useBilling();
  const [draft, setDraft] = useState("");

  // The pasted key stays put on a rejected activation so the user can
  // fix a copy-paste error; it clears only on success.
  const submit = () => void activate(draft).then((ok) => ok && setDraft(""));
  const errorLine = error && (
    <p className="field-error" role="alert">
      {error}
    </p>
  );

  if (!status) {
    // Still loading (render nothing), unless the load itself failed —
    // an enabled plugin whose status can't be read must say so rather
    // than silently showing no row.
    return error ? (
      <p className="field-error" role="alert" data-billing="load-error">
        Couldn’t load the license status: {error}
      </p>
    ) : null;
  }

  if (!status.keyConfigured) {
    return (
      <p className="settings-sub" data-billing="no-key">
        Pro licensing isn’t available in this build. Everything else in Cairn
        stays free — billing features will unlock here once licenses go on sale.
      </p>
    );
  }

  if (status.license) {
    return (
      <div className="data-add-row" data-billing="licensed">
        <p className="settings-sub">
          Licensed to <strong>{status.license.email}</strong> (
          {status.license.product}) — verified on this machine, never online.
        </p>
        <button
          type="button"
          className="btn btn--ghost btn--sm"
          onClick={() => void remove()}
          disabled={busy}
        >
          Remove license
        </button>
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
      {errorLine}
    </div>
  );
}
