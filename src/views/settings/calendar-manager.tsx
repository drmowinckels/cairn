import { useState } from "react";
import { Icon } from "../../lib/icon";
import { formatRelativeTime } from "../../lib/relative-time";
import { guessCalendarKind, useCalendars } from "../../lib/use-calendars";

interface Props {
  onClose: () => void;
}

export function CalendarManager({ onClose }: Props) {
  const calendars = useCalendars();
  const [label, setLabel] = useState("");
  const [raw, setRaw] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const onAdd = async () => {
    setError(null);
    if (!label.trim() || !raw.trim()) {
      setError("Both a label and a URL or path are required.");
      return;
    }
    setBusy(true);
    try {
      await calendars.add({
        label: label.trim(),
        raw: raw.trim(),
        kind: guessCalendarKind(raw),
      });
      setLabel("");
      setRaw("");
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="modal-scrim"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="modal-card cal-mgr"
        role="dialog"
        aria-modal="true"
        aria-label="Manage calendar sources"
      >
        <header className="modal-head">
          <h2>Calendar sources</h2>
          <button
            type="button"
            className="icon-btn"
            aria-label="Close"
            onClick={onClose}
          >
            <Icon name="x" size={14} />
          </button>
        </header>

        <p className="modal-sub">
          Cairn reads ICS subscription URLs and local `.ics` files. Nothing
          leaves your machine besides the request to the source you've added.
        </p>

        {calendars.error && (
          <div className="privacy-banner privacy-banner--error" role="alert">
            <Icon name="x" size={13} />
            <span>{calendars.error}</span>
          </div>
        )}

        <ul className="cal-list">
          {calendars.sources.length === 0 && !calendars.loading && (
            <li className="cal-empty">No sources yet.</li>
          )}
          {calendars.sources.map((s) => (
            <li key={s.id} className="cal-row">
              <span className="cal-row-main">
                <span className="cal-label">{s.label}</span>
                <span className="cal-loc mono">{s.location}</span>
              </span>
              <span className="cal-row-meta">
                {s.lastError ? (
                  <span className="cal-err">error: {s.lastError}</span>
                ) : (
                  <span className="cal-synced">
                    last sync {formatRelativeTime(s.lastSyncedAt)}
                  </span>
                )}
              </span>
              <span className="cal-row-actions">
                <button
                  type="button"
                  className="link-btn"
                  onClick={() => calendars.resync(s.id)}
                >
                  Resync
                </button>
                <button
                  type="button"
                  className="link-btn"
                  onClick={() =>
                    calendars.update({ id: s.id, enabled: !s.enabled })
                  }
                >
                  {s.enabled ? "Disable" : "Enable"}
                </button>
                <button
                  type="button"
                  className="link-btn"
                  onClick={() => calendars.remove(s.id)}
                >
                  Remove
                </button>
              </span>
            </li>
          ))}
        </ul>

        <fieldset className="cal-add">
          <legend>Add a source</legend>
          <label className="cal-field">
            <span>Label</span>
            <input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="Work calendar"
            />
          </label>
          <label className="cal-field">
            <span>URL or file path</span>
            <input
              value={raw}
              onChange={(e) => setRaw(e.target.value)}
              placeholder="webcal://… or /path/to/calendar.ics"
            />
          </label>
          {error && <div className="cal-add-err">{error}</div>}
          <div className="cal-add-actions">
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              onClick={onAdd}
              disabled={busy}
            >
              {busy ? "Adding…" : "Add source"}
            </button>
          </div>
        </fieldset>
      </div>
    </div>
  );
}
