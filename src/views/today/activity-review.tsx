import { useCallback, useEffect, useMemo, useState } from "react";
import { Empty } from "../../lib/components";
import { fmtClockFromIso, fmtHm } from "../../lib/time";
import { createEntry, listActivityLog, type ActivityRow } from "../../lib/ipc";
import { appTotals, spanSeconds } from "../../lib/activity-review";

interface Props {
  /** Local day (`YYYY-MM-DD`) to review. */
  date: string;
  /** Refresh the day's entries after one is created from a span. */
  onCreated: () => Promise<void> | void;
}

/**
 * The "review your day" surface (#190): the day's recorded activity spans, a
 * "Time by app" summary, and a per-span "Add" that turns a span into a time
 * entry (uncategorised, `source: "activity_log"`) the user can then assign.
 * Only mounted when the activity log is on.
 */
export function ActivityReview({ date, onCreated }: Props) {
  const [rows, setRows] = useState<ActivityRow[]>([]);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [added, setAdded] = useState<Set<number>>(() => new Set());
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    listActivityLog(date)
      .then((r) => {
        if (!cancelled) setRows(r);
      })
      .catch((e) => {
        if (!cancelled) setError(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [date]);

  const totals = useMemo(() => appTotals(rows), [rows]);

  const createFrom = useCallback(
    async (row: ActivityRow) => {
      setBusyId(row.id);
      setError(null);
      try {
        await createEntry({
          startedAt: row.startedAt,
          endedAt: row.endedAt,
          description: row.titleHint ?? "",
          source: "activity_log",
        });
        setAdded((prev) => new Set(prev).add(row.id));
        await onCreated();
      } catch (e) {
        setError(String(e));
      } finally {
        setBusyId(null);
      }
    },
    [onCreated],
  );

  return (
    <div className="act-review" aria-label="Activity review">
      {totals.length > 0 && (
        <ul className="act-totals" aria-label="Time by app">
          {totals.map((t) => (
            <li className="act-total" key={t.appName}>
              <span className="act-total-app">{t.appName}</span>
              <span className="act-total-dur">
                {fmtHm(Math.round(t.seconds / 60))}
              </span>
            </li>
          ))}
        </ul>
      )}
      {rows.length === 0 ? (
        <Empty
          title="No activity recorded"
          body="Foreground activity shows up here while the activity log is on."
          tone="soft"
        />
      ) : (
        <ul className="act-list">
          {rows.map((r) => {
            const mins = Math.round(spanSeconds(r) / 60);
            const label = r.titleHint
              ? `${r.appName} · ${r.titleHint}`
              : r.appName;
            const isAdded = added.has(r.id);
            return (
              <li className="act-row" key={r.id}>
                <span className="act-time">{fmtClockFromIso(r.startedAt)}</span>
                <span className="act-body">
                  <span className="act-app">{r.appName}</span>
                  {r.titleHint && (
                    <span className="act-hint">{r.titleHint}</span>
                  )}
                </span>
                <span className="act-dur">{mins}m</span>
                <button
                  type="button"
                  className="btn btn--ghost btn--sm"
                  disabled={busyId === r.id || isAdded}
                  aria-label={
                    isAdded
                      ? `Already added an entry from ${label}`
                      : `Add a time entry from ${label}`
                  }
                  onClick={() => void createFrom(r)}
                >
                  {isAdded ? "Added" : "Add"}
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {error && (
        <p className="now-stop-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
