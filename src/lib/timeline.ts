import type { BackendEntry } from "./ipc";
import type { Project, ProjectId } from "./types";

export const TIMELINE_DAY_START_MIN = 8 * 60;
export const TIMELINE_DAY_END_MIN = 19 * 60;
export const TIMELINE_DAY_SPAN_MIN =
  TIMELINE_DAY_END_MIN - TIMELINE_DAY_START_MIN;

/**
 * Map a minute-of-day to a 0..100 percentage along the 08:00–19:00
 * track. Values outside the visible band clamp to 0 / 100 so a
 * pre-08:00 event still renders pinned to the left edge instead of
 * disappearing off-track.
 */
export function startToPercent(minutes: number): number {
  if (!Number.isFinite(minutes)) return 0;
  const raw =
    ((minutes - TIMELINE_DAY_START_MIN) / TIMELINE_DAY_SPAN_MIN) * 100;
  if (raw < 0) return 0;
  if (raw > 100) return 100;
  return raw;
}

export function minutesOfDay(iso: string): number {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 0;
  return d.getHours() * 60 + d.getMinutes() + d.getSeconds() / 60;
}

export interface TimelineSegment {
  id: string;
  startMin: number;
  endMin: number;
  projectId: ProjectId | null;
  description: string;
  running: boolean;
  source: string;
}

/**
 * Project a backend entry list into segments positioned along the
 * 08:00–19:00 track. The running entry (endedAt === null) gets
 * `endMin = nowMin` so it grows in real time.
 */
export function entriesToSegments(
  entries: BackendEntry[],
  nowMin: number,
): TimelineSegment[] {
  return entries.map((e) => {
    const startMin = minutesOfDay(e.startedAt);
    const running = e.endedAt === null;
    const endMin = running
      ? Math.max(startMin, nowMin)
      : minutesOfDay(e.endedAt as string);
    return {
      id: e.id,
      startMin,
      endMin,
      projectId: e.projectId,
      description: e.description,
      running,
      source: e.source,
    };
  });
}

export interface LegendItem {
  projectId: ProjectId;
  color: string;
  name: string;
}

/**
 * Deduplicate the projects that appear in the segment list, in the
 * order they first appear. Segments without a project (uncategorized)
 * are skipped — the legend is a project key, not a catch-all.
 */
export function legendFromSegments(
  segments: TimelineSegment[],
  projects: Project[],
): LegendItem[] {
  const byId = new Map(projects.map((p) => [p.id, p] as const));
  const seen = new Set<ProjectId>();
  const out: LegendItem[] = [];
  for (const seg of segments) {
    if (!seg.projectId) continue;
    if (seen.has(seg.projectId)) continue;
    const project = byId.get(seg.projectId);
    if (!project) continue;
    seen.add(seg.projectId);
    out.push({
      projectId: seg.projectId,
      color: project.color,
      name: project.name,
    });
  }
  return out;
}
