import { WEEK } from "../test-fixtures/data";
import { isoLocalDate } from "./report-math";
import type {
  ReportDayBucket,
  ReportProjectSlice,
  ReportRange,
  ReportSourceSplit,
  ReportSummary,
} from "./ipc";

const HOUR = 3600;

const PREV_FACTOR: Record<ReportRange, number> = {
  week: 0.85,
  month: 0.9,
  quarter: 0.95,
  year: 0.97,
};

/**
 * Synthesise a `ReportSummary` from the existing `WEEK` fixture so the
 * Reports view stays explorable in Vite dev / vitest with no Tauri
 * backend. The current week's `WEEK` hours are mapped onto their real
 * dates and the rest of the range is empty days — matching the real
 * backend's shape (one bucket per calendar day in the window). Real data
 * comes from `report_summary` IPC at runtime.
 */
export function fixtureReportSummary(range: ReportRange): ReportSummary {
  const today = new Date();
  const monday = mondayOf(today);

  const weekByDate = new Map<string, ReportProjectSlice[]>();
  WEEK.forEach((w, i) => {
    weekByDate.set(
      isoLocalDate(addDays(monday, i)),
      w.segments.map(([projectId, hours]) => ({
        projectId,
        seconds: Math.round(hours * HOUR),
      })),
    );
  });

  const [start, end] = fixtureWindow(range, today);
  const byDay: ReportDayBucket[] = [];
  for (let d = new Date(start); d < end; d = addDays(d, 1)) {
    const iso = isoLocalDate(d);
    byDay.push({ date: iso, byProject: weekByDate.get(iso) ?? [] });
  }

  const projTotals = new Map<string, number>();
  for (const day of byDay) {
    for (const slice of day.byProject) {
      const key = slice.projectId ?? "";
      projTotals.set(key, (projTotals.get(key) ?? 0) + slice.seconds);
    }
  }
  const byProject: ReportProjectSlice[] = [...projTotals.entries()]
    .map(([projectId, seconds]) => ({
      projectId: projectId === "" ? null : projectId,
      seconds,
    }))
    .sort((a, b) => b.seconds - a.seconds);

  const totalSeconds = byProject.reduce((a, b) => a + b.seconds, 0);
  // Plausible split for the prototype: 55% rule, 25% calendar, 20% manual.
  const rule = Math.round(totalSeconds * 0.55);
  const calendar = Math.round(totalSeconds * 0.25);
  const bySource: ReportSourceSplit = {
    rule,
    calendar,
    manual: totalSeconds - rule - calendar,
  };

  return {
    totalSeconds,
    prevTotalSeconds: Math.round(totalSeconds * PREV_FACTOR[range]),
    byDay,
    byProject,
    bySource,
  };
}

/** Local half-open [start, end) window for the fixture range, mirroring the
 *  Rust `report_window`. */
function fixtureWindow(range: ReportRange, today: Date): [Date, Date] {
  const y = today.getFullYear();
  const m = today.getMonth();
  switch (range) {
    case "month":
      return [new Date(y, m, 1), new Date(y, m + 1, 1)];
    case "quarter": {
      const qm = Math.floor(m / 3) * 3;
      return [new Date(y, qm, 1), new Date(y, qm + 3, 1)];
    }
    case "year":
      return [new Date(y, 0, 1), new Date(y + 1, 0, 1)];
    default: {
      const monday = mondayOf(today);
      return [monday, addDays(monday, 7)];
    }
  }
}

function mondayOf(d: Date): Date {
  const out = new Date(d);
  const dow = out.getDay();
  const offset = dow === 0 ? 6 : dow - 1;
  out.setDate(out.getDate() - offset);
  out.setHours(0, 0, 0, 0);
  return out;
}

function addDays(d: Date, n: number): Date {
  const out = new Date(d);
  out.setDate(out.getDate() + n);
  return out;
}
