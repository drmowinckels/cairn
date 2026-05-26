import type { ReportRange, ReportSummary } from "./ipc";

const HOUR = 3600;

export function secondsToHours(seconds: number): number {
  return seconds / HOUR;
}

/** Percentage of a part relative to a total, clamped to [0, 100]. */
export function percentOf(part: number, total: number): number {
  if (total <= 0) return 0;
  return Math.max(0, Math.min(100, (part / total) * 100));
}

export type Delta =
  | { kind: "none" }
  | { kind: "up" | "down" | "flat"; deltaSeconds: number; percent: number };

export function computeDelta(
  current: number,
  previous: number,
): Delta {
  if (previous <= 0 && current <= 0) return { kind: "none" };
  if (previous <= 0) {
    return { kind: "up", deltaSeconds: current, percent: 100 };
  }
  const diff = current - previous;
  const pct = (diff / previous) * 100;
  if (diff > 0) return { kind: "up", deltaSeconds: diff, percent: pct };
  if (diff < 0) return { kind: "down", deltaSeconds: diff, percent: pct };
  return { kind: "flat", deltaSeconds: 0, percent: 0 };
}

/** ISO date (YYYY-MM-DD) in the local timezone. */
export function isoLocalDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function isToday(isoDate: string, now: Date = new Date()): boolean {
  return isoDate === isoLocalDate(now);
}

export function isFuture(isoDate: string, now: Date = new Date()): boolean {
  return isoDate > isoLocalDate(now);
}

const RANGE_LABEL: Record<ReportRange, string> = {
  day: "Today",
  week: "This week",
  month: "This month",
};

export function rangeTitle(range: ReportRange): string {
  return RANGE_LABEL[range];
}

const RANGE_COMPARISON: Record<ReportRange, string> = {
  day: "vs yesterday",
  week: "vs last week",
  month: "vs last month",
};

export function deltaComparisonLabel(range: ReportRange): string {
  return RANGE_COMPARISON[range];
}

const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function weekdayLabel(isoDate: string): string {
  const [y, m, d] = isoDate.split("-").map(Number);
  if (!y || !m || !d) return "";
  const date = new Date(y, m - 1, d);
  return WEEKDAY_LABELS[date.getDay()] ?? "";
}

const MONTH_LABELS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

export function dayMonthLabel(isoDate: string): string {
  const [, m, d] = isoDate.split("-").map(Number);
  if (!m || !d) return "";
  return `${MONTH_LABELS[m - 1]} ${d}`;
}

/**
 * Format a date-range header label like "May 18 — May 24, 2026".
 * Falls back to a single date for a 1-day range.
 */
export function formatRangeLabel(summary: ReportSummary): string {
  if (summary.byDay.length === 0) return "";
  const first = summary.byDay[0]!.date;
  const last = summary.byDay[summary.byDay.length - 1]!.date;
  if (first === last) {
    return `${dayMonthLabel(first)}, ${first.slice(0, 4)}`;
  }
  return `${dayMonthLabel(first)} — ${dayMonthLabel(last)}, ${last.slice(0, 4)}`;
}

export interface StackedDay {
  isoDate: string;
  weekday: string;
  segments: Array<{ projectId: string | null; seconds: number }>;
  totalSeconds: number;
  isToday: boolean;
  isFuture: boolean;
}

export function buildStackedDays(
  summary: ReportSummary,
  now: Date = new Date(),
): StackedDay[] {
  return summary.byDay.map((d) => {
    const totalSeconds = d.byProject.reduce((a, b) => a + b.seconds, 0);
    return {
      isoDate: d.date,
      weekday: weekdayLabel(d.date),
      segments: d.byProject.map((s) => ({
        projectId: s.projectId,
        seconds: s.seconds,
      })),
      totalSeconds,
      isToday: isToday(d.date, now),
      isFuture: isFuture(d.date, now),
    };
  });
}
