import { open } from "@tauri-apps/plugin-dialog";
import { useEffect, useState } from "react";
import { billingLogoFromPath, type BusinessDetails } from "../../lib/ipc";
import { useBusiness } from "../../lib/use-business";
import { withPopoverPinned } from "../../lib/use-backup";

/** The Pro business-details panel (#1), shown under the Billing card once the
 *  license is active. Edits the issuer identity printed as the "From" block on
 *  generated invoices. Fields are optional; an empty profile omits the block. */
export function BusinessDetailsPanel() {
  const { details, busy, error, saved, save, clearSaved } = useBusiness();
  const [form, setForm] = useState<BusinessDetails | null>(null);
  const [logoError, setLogoError] = useState<string | null>(null);

  // Seed the editable form from the loaded details, once.
  useEffect(() => {
    if (details && form === null) setForm(details);
  }, [details, form]);

  // Until the form is seeded there's nothing to edit — surface a load failure
  // here rather than sitting on "Loading…" forever (the in-form error below is
  // unreachable while `form` is null).
  if (form === null) {
    return error ? (
      <p className="field-error" role="alert" data-business="load-error">
        Couldn’t load your business details: {error}
      </p>
    ) : (
      <p className="settings-sub" data-business="loading">
        Loading…
      </p>
    );
  }

  const update = (patch: Partial<BusinessDetails>) => {
    setForm({ ...form, ...patch });
    setLogoError(null);
    if (saved) clearSaved();
  };

  const submit = () => {
    setLogoError(null);
    void save(form).then((stored) => stored && setForm(stored));
  };

  const pickLogo = async () => {
    setLogoError(null);
    try {
      // Pin the popover so the native picker doesn't dismiss it.
      const path = await withPopoverPinned(() =>
        open({
          title: "Choose a logo",
          multiple: false,
          filters: [
            {
              name: "Image",
              extensions: ["png", "jpg", "jpeg", "gif", "webp"],
            },
          ],
        }),
      );
      if (typeof path !== "string") return; // cancelled
      update({ logo: await billingLogoFromPath(path) });
    } catch (e) {
      setLogoError(String(e));
    }
  };

  const hasLogo = form.logo !== "";

  return (
    <div className="biz-panel" data-billing="business">
      <h4 className="rate-h">Business details</h4>
      <p className="settings-sub">
        Shown as the “From” block on the invoices you generate. Leave everything
        blank to omit it.
      </p>
      <div className="biz-form">
        <input
          className="field-input"
          aria-label="Business name"
          placeholder="Business name"
          value={form.name}
          onChange={(e) => update({ name: e.target.value })}
        />
        <textarea
          className="field-input"
          aria-label="Address"
          placeholder="Address"
          rows={2}
          value={form.address}
          onChange={(e) => update({ address: e.target.value })}
        />
        <input
          className="field-input"
          type="email"
          aria-label="Email"
          placeholder="Email"
          value={form.email}
          onChange={(e) => update({ email: e.target.value })}
        />
        <input
          className="field-input"
          aria-label="Tax ID"
          placeholder="Tax / VAT ID"
          value={form.taxId}
          onChange={(e) => update({ taxId: e.target.value })}
        />
        <input
          className="field-input"
          aria-label="Tax label"
          placeholder="Tax line label (e.g. VAT, GST) — defaults to “Tax”"
          value={form.taxLabel}
          onChange={(e) => update({ taxLabel: e.target.value })}
        />
        <div className="biz-logo-row">
          {hasLogo && (
            <img
              className="biz-logo-preview"
              src={form.logo}
              alt="Current logo"
            />
          )}
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            onClick={() => void pickLogo()}
          >
            {hasLogo ? "Change logo" : "Add logo"}
          </button>
          {hasLogo && (
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              onClick={() => update({ logo: "" })}
            >
              Remove logo
            </button>
          )}
        </div>
        {logoError && (
          <p className="field-error" role="alert" data-business="logo-error">
            {logoError}
          </p>
        )}
        <button
          type="button"
          className="btn btn--primary btn--sm"
          onClick={submit}
          disabled={busy}
        >
          Save
        </button>
      </div>

      {saved && (
        <p
          className="settings-sub"
          role="status"
          aria-live="polite"
          data-business="saved"
        >
          Saved.
        </p>
      )}
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
