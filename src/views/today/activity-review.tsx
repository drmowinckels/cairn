import { useCallback, useEffect, useMemo, useState } from "react";
import { Empty } from "../../lib/components";
import { fmtClockFromIso, fmtHm } from "../../lib/time";
import { createEntry, listActivityLog, type ActivityRow } from "../../lib/ipc";
import {
  appTotals,
  spanSeconds,
  splitByMinLength,
} from "../../lib/activity-review";
import { useDateTimeFormatSubscription } from "../../lib/use-datetime-format";

interface Props {
  /** Local day (`YYYY-MM-DD`) to review. */
  date: string;
  /** Shortest span offered as an entry, in minutes (#313). Shorter spans are
   *  folded behind a "show" toggle instead of cluttering the list. */
  minSpanMinutes: number;
  /** Refresh the day's entries after one is created from a span. */
  onCreated: () => Promise<void> | void;
}

/**
 * The "review your day" surface (#190): the day's recorded activity spans, a
 * "Time by app" summary, and a per-span "Add" that turns a span into a time
 * entry (uncategorised, `source: "activity_log"`) the user can then assign.
 * Only mounted when the activity log is on.
 *
 * Spans shorter than `minSpanMinutes` are held back from the list (#313) —
 * they're recorded and still counted in "Time by app", just not worth a row of
 * their own until the user asks to see them.
 */
export function ActivityReview({ date, minSpanMinutes, onCreated }: Props) {
  useDateTimeFormatSubscription();
  const [rows, setRows] = useState<ActivityRow[]>([]);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showShort, setShowShort] = useState(false);

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

  // Totals cover every span: the floor decides what's worth adding as an entry,
  // not where the day's time actually went.
  const totals = useMemo(() => appTotals(rows), [rows]);
  const split = useMemo(
    () => splitByMinLength(rows, minSpanMinutes),
    [rows, minSpanMinutes],
  );
  const listed = showShort ? rows : split.reviewable;

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
          activityRowId: row.id,
        });
        setRows((prev) =>
          prev.map((r) => (r.id === row.id ? { ...r, hasEntry: true } : r)),
        );
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
      {listed.length === 0 ? (
        <Empty
          title={
            split.hidden.length > 0
              ? "Nothing long enough to review"
              : "No activity recorded"
          }
          body={
            split.hidden.length > 0
              ? `Every recorded span was shorter than ${minSpanMinutes} minutes.`
              : "Foreground activity shows up here while the activity log is on."
          }
          tone="soft"
        />
      ) : (
        <ul className="act-list">
          {listed.map((r) => {
            const mins = Math.round(spanSeconds(r) / 60);
            const label = r.titleHint
              ? `${r.appName} · ${r.titleHint}`
              : r.appName;
            const isAdded = r.hasEntry;
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
      {split.hidden.length > 0 && (
        <p className="act-short-note">
          <span>
            {split.hidden.length === 1
              ? `1 span under ${minSpanMinutes}m`
              : `${split.hidden.length} spans under ${minSpanMinutes}m`}{" "}
            ({fmtHm(Math.round(split.hiddenSeconds / 60))})
          </span>
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            onClick={() => setShowShort((v) => !v)}
          >
            {showShort ? "Hide short activity" : "Show short activity"}
          </button>
        </p>
      )}
      {error && (
        <p className="now-stop-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
