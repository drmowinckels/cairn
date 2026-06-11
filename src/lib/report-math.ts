import type { ReportProjectSlice, ReportRange, ReportSummary } from "./ipc";

const HOUR = 3600;

export function secondsToHours(seconds: number): number {
  return seconds / HOUR;
}

/** Percentage of a part relative to a total, clamped to [0, 100]. */
export function percentOf(part: number, total: number): number {
  if (total <= 0) return 0;
  return Math.max(0, Math.min(100, (part / total) * 100));
}

export interface ChartAxis {
  /** Axis ceiling in seconds; bars are scaled against this. */
  maxSeconds: number;
  /** Gridline marks in whole hours, ascending from 0 to the ceiling. */
  ticks: number[];
}

/**
 * Y-axis for the hours-per-day chart (spec §3.2). Anchored at a minimum
 * of 8h so a light week still shows the 0/2/4/6/8 gridlines, and the
 * ceiling is rounded up to the next even hour so the top gridline always
 * sits at the axis ceiling and a heavy day's bar never overflows it.
 * Negative/NaN input is treated as zero.
 */
export function chartAxis(maxDaySeconds: number): ChartAxis {
  const safeSeconds = Number.isFinite(maxDaySeconds)
    ? Math.max(0, maxDaySeconds)
    : 0;
  const maxHours = Math.max(8, Math.ceil(safeSeconds / HOUR / 2) * 2);
  const ticks: number[] = [];
  for (let h = 0; h <= maxHours; h += 2) ticks.push(h);
  return { maxSeconds: maxHours * HOUR, ticks };
}

export type Delta =
  | { kind: "none" }
  | { kind: "up" | "down" | "flat"; deltaSeconds: number; percent: number };

export function computeDelta(current: number, previous: number): Delta {
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
  week: "This week",
  month: "This month",
  quarter: "This quarter",
  year: "This year",
};

export function rangeTitle(range: ReportRange): string {
  return RANGE_LABEL[range];
}

const RANGE_COMPARISON: Record<ReportRange, string> = {
  week: "vs last week",
  month: "vs last month",
  quarter: "vs last quarter",
  year: "vs last year",
};

export function deltaComparisonLabel(range: ReportRange): string {
  return RANGE_COMPARISON[range];
}

/** How the chart buckets a range's days into bars (dataviz-guide: keep the
 *  bar count small and readable — "few periods"). Week shows each day;
 *  longer ranges roll up so the chart never becomes 30+ thin bars. */
export type BucketGranularity = "day" | "week" | "month";

export function bucketGranularity(range: ReportRange): BucketGranularity {
  switch (range) {
    case "week":
      return "day";
    case "month":
      return "week";
    case "quarter":
    case "year":
      return "month";
  }
}

/** Average-per-period label for the digest, e.g. "/day" for a week. */
export function averageUnitLabel(unit: BucketGranularity): string {
  return unit === "day" ? "/day" : unit === "week" ? "/wk" : "/mo";
}

const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function weekdayLabel(isoDate: string): string {
  const [y, m, d] = isoDate.split("-").map(Number);
  if (!y || !m || !d) return "";
  const date = new Date(y, m - 1, d);
  return WEEKDAY_LABELS[date.getDay()];
}

const MONTH_LABELS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
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
  const firstYear = first.slice(0, 4);
  const lastYear = last.slice(0, 4);
  // When the range straddles a year boundary, show both years so the
  // start isn't silently attributed to the end's year (e.g. a week
  // spanning Dec 2025 → Jan 2026).
  if (firstYear !== lastYear) {
    return `${dayMonthLabel(first)}, ${firstYear} — ${dayMonthLabel(last)}, ${lastYear}`;
  }
  return `${dayMonthLabel(first)} — ${dayMonthLabel(last)}, ${lastYear}`;
}

/** Monday (ISO week start) of the week containing `isoDate`, as an ISO date. */
export function mondayOfIso(isoDate: string): string {
  const [y, m, d] = isoDate.split("-").map(Number);
  if (!y || !m || !d) return isoDate;
  const date = new Date(y, m - 1, d);
  const dow = date.getDay();
  date.setDate(date.getDate() - (dow === 0 ? 6 : dow - 1));
  return isoLocalDate(date);
}

export interface BucketSegment {
  projectId: string | null;
  remoteProjectName: string | null;
  seconds: number;
}

export interface ReportBucket {
  /** Stable key for React + grouping (iso date, iso week-monday, or YYYY-MM). */
  key: string;
  /** Bar label: weekday, week-start day ("Jun 9"), or month ("Jun"). */
  label: string;
  segments: BucketSegment[];
  totalSeconds: number;
  /** This bucket contains today. */
  isCurrent: boolean;
  /** Every day in this bucket is in the future (nothing tracked yet). */
  isFuture: boolean;
}

function bucketIdOf(
  isoDate: string,
  gran: BucketGranularity,
): { key: string; label: string } {
  if (gran === "day") return { key: isoDate, label: weekdayLabel(isoDate) };
  if (gran === "month") {
    // `isoDate` is a real calendar day from `summary.byDay`, so its month is
    // always 1–12 — index straight into the labels (no defensive fallback,
    // which would be an untestable dead branch).
    const m = Number(isoDate.slice(5, 7));
    return { key: isoDate.slice(0, 7), label: MONTH_LABELS[m - 1]! };
  }
  const monday = mondayOfIso(isoDate);
  return { key: monday, label: dayMonthLabel(monday) };
}

/**
 * Roll `summary.byDay` (one bucket per calendar day) up to the chart's
 * display granularity for `range`: days for a week, ISO weeks for a month,
 * months for a quarter/year. Per-project seconds are summed within each
 * bucket and the segments sorted largest-first for stable stacking.
 */
export function buildBuckets(
  summary: ReportSummary,
  range: ReportRange,
  now: Date = new Date(),
): ReportBucket[] {
  const gran = bucketGranularity(range);
  const todayIso = isoLocalDate(now);
  const order: string[] = [];
  const byKey = new Map<string, ReportBucket>();

  for (const day of summary.byDay) {
    const { key, label } = bucketIdOf(day.date, gran);
    let bucket = byKey.get(key);
    if (!bucket) {
      bucket = {
        key,
        label,
        segments: [],
        totalSeconds: 0,
        isCurrent: false,
        isFuture: true,
      };
      byKey.set(key, bucket);
      order.push(key);
    }
    for (const s of day.byProject) {
      const sk = s.projectId ?? s.remoteProjectName ?? "_none";
      let seg = bucket.segments.find(
        (x) => (x.projectId ?? x.remoteProjectName ?? "_none") === sk,
      );
      if (!seg) {
        seg = {
          projectId: s.projectId,
          remoteProjectName: s.remoteProjectName ?? null,
          seconds: 0,
        };
        bucket.segments.push(seg);
      }
      seg.seconds += s.seconds;
      bucket.totalSeconds += s.seconds;
    }
    if (day.date === todayIso) bucket.isCurrent = true;
    if (day.date <= todayIso) bucket.isFuture = false;
  }

  for (const b of byKey.values()) {
    b.segments.sort((a, c) => c.seconds - a.seconds);
  }
  return order.map((k) => byKey.get(k)!);
}

export interface ReportDigest {
  /** Mean tracked seconds per elapsed bucket (day/week/month). */
  averageSeconds: number;
  averageUnit: BucketGranularity;
  /** The heaviest elapsed bucket with tracked time, or null. */
  busiest: { label: string; seconds: number } | null;
  /** The largest project slice + its share of the total, or null. */
  topProject: { slice: ReportProjectSlice; percent: number } | null;
  /** Calendar days in the range with any tracked time. */
  daysTracked: number;
  /** Calendar days in the range that have already elapsed (incl. today). */
  daysElapsed: number;
}

/** Digest highlights for the longer ranges: period average, busiest period,
 *  top project share, and tracking coverage. Pure — derived from the summary
 *  + the already-bucketed bars. */
export function reportDigest(
  summary: ReportSummary,
  buckets: ReportBucket[],
  range: ReportRange,
  now: Date = new Date(),
): ReportDigest {
  const elapsed = buckets.filter((b) => !b.isFuture);
  const averageSeconds =
    elapsed.length > 0 ? summary.totalSeconds / elapsed.length : 0;

  let busiest: { label: string; seconds: number } | null = null;
  for (const b of elapsed) {
    if (b.totalSeconds > 0 && (!busiest || b.totalSeconds > busiest.seconds)) {
      busiest = { label: b.label, seconds: b.totalSeconds };
    }
  }

  // `byProject` arrives grouped by project id, not by size, so pick the
  // largest slice explicitly rather than trusting position 0.
  const top = summary.byProject.reduce<ReportProjectSlice | null>(
    (max, s) => (max && max.seconds >= s.seconds ? max : s),
    null,
  );
  const topProject =
    top && summary.totalSeconds > 0
      ? { slice: top, percent: percentOf(top.seconds, summary.totalSeconds) }
      : null;

  const todayIso = isoLocalDate(now);
  const daysTracked = summary.byDay.filter(
    (d) => d.byProject.reduce((a, s) => a + s.seconds, 0) > 0,
  ).length;
  const daysElapsed = summary.byDay.filter((d) => d.date <= todayIso).length;

  return {
    averageSeconds,
    averageUnit: bucketGranularity(range),
    busiest,
    topProject,
    daysTracked,
    daysElapsed,
  };
}
