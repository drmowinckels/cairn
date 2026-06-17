import { useState } from "react";
import { Icon } from "../../lib/icon";
import type { UseActivityLog } from "../../lib/use-activity-log";
import { SetRow, Toggle } from "./settings";

const RETENTION_OPTIONS: Array<{ value: number; label: string }> = [
  { value: 1, label: "1 day" },
  { value: 7, label: "7 days" },
  { value: 30, label: "30 days" },
  { value: 0, label: "Until I delete" },
];

interface Props {
  activityLog: UseActivityLog;
}

/**
 * Settings → Activity log control for the opt-in activity log (#190): the toggle
 * (warns on enable), the retention window, and a delete-now button. Off by
 * default; turning it off purges the log (handled in the backend). The full
 * privacy contract is in `docs/PRIVACY.md`.
 */
export function ActivityLogCard({ activityLog }: Props) {
  const {
    settings,
    error,
    setEnabled,
    setRetentionDays,
    deleteAll,
    exportToFile,
  } = activityLog;
  const [confirmEnable, setConfirmEnable] = useState(false);

  return (
    <section
      className="settings-block"
      aria-label="Activity log"
      data-section="activity-log"
    >
      <h3 className="settings-h">Activity log</h3>
      <p className="settings-sub">
        Off by default. When on, Cairn keeps a compact, redacted record of which
        app was in the foreground and for how long, so you can review your day
        later. Excluded apps and private windows are never recorded, and turning
        it off deletes everything it stored.
      </p>

      <SetRow
        label="Save activity log"
        hint="Records the foreground app + a redacted window-title fragment. Stays on your device; turning it off deletes the log."
      >
        <Toggle
          on={settings.enabled}
          onChange={(next) => {
            if (next) setConfirmEnable(true);
            else void setEnabled(false);
          }}
          label="Save activity log"
        />
      </SetRow>

      {settings.enabled && (
        <SetRow label="Keep for" hint="Older entries are purged on launch.">
          <select
            className="field-input"
            aria-label="Activity log retention"
            value={settings.retentionDays}
            onChange={(e) => void setRetentionDays(Number(e.target.value))}
          >
            {RETENTION_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </SetRow>
      )}

      <div className="settings-actions">
        {settings.enabled && (
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            onClick={() => void exportToFile()}
          >
            Export CSV
          </button>
        )}
        <button
          type="button"
          className="btn btn--ghost btn--sm"
          onClick={() => void deleteAll()}
        >
          Delete activity log now
        </button>
      </div>

      {error && (
        <div className="privacy-banner privacy-banner--error" role="alert">
          <Icon name="x" size={13} />
          <span>{error}</span>
        </div>
      )}

      {confirmEnable && (
        <div
          className="capture-confirm-backdrop"
          role="dialog"
          aria-modal="true"
          aria-labelledby="activity-confirm-title"
          data-testid="activity-confirm"
        >
          <div className="capture-confirm">
            <h2 id="activity-confirm-title" className="capture-confirm-title">
              <Icon name="info" size={16} /> Save activity log?
            </h2>
            <p className="capture-confirm-warn" role="note">
              Cairn will store which app is in the foreground and a redacted
              piece of each window title — only the part before the first dash,
              never the full title — on this device. Your exclusion list still
              applies, and private / incognito windows are never recorded. The
              log is kept for the retention window you choose and deleted when
              you turn this off.
            </p>
            <p className="capture-confirm-body">
              This stays on your device — nothing is uploaded.
            </p>
            <div className="capture-confirm-actions">
              <button
                type="button"
                className="btn btn--ghost btn--sm"
                onClick={() => setConfirmEnable(false)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn btn--primary btn--sm"
                onClick={() => {
                  void setEnabled(true);
                  setConfirmEnable(false);
                }}
              >
                Turn on
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
