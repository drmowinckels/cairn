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
