import { WEEK } from "../test-fixtures/data";
import type {
  ReportDayBucket,
  ReportProjectSlice,
  ReportRange,
  ReportSourceSplit,
  ReportSummary,
} from "./ipc";

const HOUR = 3600;

/**
 * Synthesise a `ReportSummary` from the existing `WEEK` fixture so the
 * Reports view stays explorable in Vite dev / vitest with no Tauri
 * backend. Real data comes from `report_summary` IPC at runtime.
 */
export function fixtureReportSummary(range: ReportRange): ReportSummary {
  const today = new Date();
  const monday = mondayOf(today);

  const byDay: ReportDayBucket[] = WEEK.map((w, i) => {
    const d = addDays(monday, i);
    return {
      date: isoDate(d),
      byProject: w.segments.map(([projectId, hours]) => ({
        projectId,
        seconds: Math.round(hours * HOUR),
      })),
    };
  });

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
  const bySource: ReportSourceSplit = {
    rule: Math.round(totalSeconds * 0.55),
    calendar: Math.round(totalSeconds * 0.25),
    manual:
      totalSeconds -
      Math.round(totalSeconds * 0.55) -
      Math.round(totalSeconds * 0.25),
  };

  // Day / Month flatten the same data so the picker has something
  // visible; the real backend differentiates.
  if (range === "day") {
    // `byDay` is monday..sunday for the current week, so today's offset is
    // `(getDay() + 6) % 7` (Mon=0..Sun=6).
    const todayOffset = (today.getDay() + 6) % 7;
    const todayBucket = byDay[todayOffset]!;
    return {
      totalSeconds: todayBucket.byProject.reduce((a, b) => a + b.seconds, 0),
      prevTotalSeconds: 0,
      byDay: [todayBucket],
      byProject,
      bySource,
    };
  }

  if (range === "month") {
    // Synthesize one bucket per day for the full month so the chart
    // matches the real backend's shape (`window_for(Month, today)`
    // returns first..first).
    const first = new Date(today.getFullYear(), today.getMonth(), 1);
    const nextFirst = new Date(today.getFullYear(), today.getMonth() + 1, 1);
    const daysInMonth = Math.round(
      (nextFirst.getTime() - first.getTime()) / (24 * 3600 * 1000),
    );
    const monthDays: ReportDayBucket[] = [];
    for (let i = 0; i < daysInMonth; i++) {
      const d = addDays(first, i);
      const day = byDay.find((b) => b.date === isoDate(d));
      monthDays.push({
        date: isoDate(d),
        byProject: day?.byProject ?? [],
      });
    }
    return {
      totalSeconds,
      prevTotalSeconds: Math.round(totalSeconds * 0.9),
      byDay: monthDays,
      byProject,
      bySource,
    };
  }

  return {
    totalSeconds,
    prevTotalSeconds: Math.round(totalSeconds * 0.85),
    byDay,
    byProject,
    bySource,
  };
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

function isoDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
