import type { ActivityRow } from "./ipc";

/** Duration of a span in whole seconds (clamped at 0; 0 for unparseable). */
export function spanSeconds(row: {
  startedAt: string;
  endedAt: string;
}): number {
  const s = Date.parse(row.startedAt);
  const e = Date.parse(row.endedAt);
  if (Number.isNaN(s) || Number.isNaN(e)) return 0;
  return Math.max(0, Math.round((e - s) / 1000));
}

export interface AppTotal {
  appName: string;
  seconds: number;
}

/**
 * "Time by app" for a day's activity rows (#190): total seconds per app,
 * highest first. The coarse summary that surfaces where uncategorised time
 * went without per-span assignment.
 */
export function appTotals(rows: ActivityRow[]): AppTotal[] {
  const byApp = new Map<string, number>();
  for (const r of rows) {
    byApp.set(r.appName, (byApp.get(r.appName) ?? 0) + spanSeconds(r));
  }
  return [...byApp.entries()]
    .map(([appName, seconds]) => ({ appName, seconds }))
    .sort((a, b) => b.seconds - a.seconds);
}

export interface ActivitySplit {
  /** Spans long enough to offer as entries, in the original order. */
  reviewable: ActivityRow[];
  /** Spans below the minimum — kept out of the list, counted here. */
  hidden: ActivityRow[];
  /** Total seconds in `hidden`, for the "shorter activity" footnote. */
  hiddenSeconds: number;
}

/**
 * Split a day's spans at the user's minimum activity length (#313). Spans
 * shorter than `minMinutes` are noise in the review list (a 30-second glance
 * at Slack is not an entry worth adding), so they're held back — but they stay
 * in `hidden` so the UI can account for the time and offer to show them, and
 * "Time by app" still totals every span.
 */
export function splitByMinLength(
  rows: ActivityRow[],
  minMinutes: number,
): ActivitySplit {
  const minSeconds = Math.max(0, minMinutes) * 60;
  const reviewable: ActivityRow[] = [];
  const hidden: ActivityRow[] = [];
  let hiddenSeconds = 0;
  for (const r of rows) {
    const seconds = spanSeconds(r);
    if (seconds >= minSeconds) {
      reviewable.push(r);
    } else {
      hidden.push(r);
      hiddenSeconds += seconds;
    }
  }
  return { reviewable, hidden, hiddenSeconds };
}
