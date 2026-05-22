import type { Project, WeekDay } from "./types";

export interface WeekSummaryInput {
  weekLabel: string;
  week: WeekDay[];
  projectsById: Record<string, Project>;
}

export function buildWeekSummary({
  weekLabel,
  week,
  projectsById,
}: WeekSummaryInput): string {
  const totalHours = week.reduce((a, d) => a + d.hours, 0);
  const trackedDays = week.filter((d) => d.hours > 0).length || 1;
  const dailyAvg = totalHours / trackedDays;

  const projTotals = new Map<string, number>();
  for (const day of week) {
    for (const [pid, h] of day.segments) {
      projTotals.set(pid, (projTotals.get(pid) ?? 0) + h);
    }
  }
  const ranked = [...projTotals.entries()].sort((a, b) => b[1] - a[1]);

  const lines: string[] = [
    `Cairn — ${weekLabel}`,
    `${totalHours.toFixed(1)}h tracked · ${dailyAvg.toFixed(1)}h daily avg · ${ranked.length} projects`,
    "",
  ];
  for (const [pid, hours] of ranked) {
    const name = projectsById[pid]?.name ?? pid;
    const pct = totalHours > 0 ? (hours / totalHours) * 100 : 0;
    lines.push(`  ${name.padEnd(18)} ${hours.toFixed(1)}h  ${pct.toFixed(0)}%`);
  }
  return lines.join("\n");
}
