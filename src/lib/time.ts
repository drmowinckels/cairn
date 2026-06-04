import type { BackendEntry } from "./ipc";

export const minutesOf = (hours: number, minutes = 0): number =>
  hours * 60 + minutes;

/**
 * Sum the tracked minutes across a day's entries. Closed entries
 * count `endedAt − startedAt`; the open (running) entry counts up to
 * `now` so the footer total grows in real time. Unlike the timeline's
 * `entriesToSegments`, this is not clamped to the visible 08:00–19:00
 * band — it's the true total the footer reports. Spans that can't be
 * parsed or that go backwards (clock skew, a bad row) contribute
 * zero, so one bad entry can't drag the total below the others.
 */
export const totalTrackedMinutes = (
  entries: BackendEntry[],
  now: number = Date.now(),
): number => {
  if (!Array.isArray(entries)) return 0;
  let ms = 0;
  for (const e of entries) {
    const start = Date.parse(e.startedAt);
    if (Number.isNaN(start)) continue;
    const end = e.endedAt === null ? now : Date.parse(e.endedAt);
    if (Number.isNaN(end)) continue;
    ms += Math.max(0, end - start);
  }
  return Math.floor(ms / 60_000);
};

export const fmtHm = (totalMinutes: number): string => {
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  if (h && m) return `${h}h ${m}m`;
  if (h) return `${h}h`;
  return `${m}m`;
};

export const fmtClock = (totalMinutes: number): string => {
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
};

export const fmtRange = (start: number, end: number): string =>
  `${fmtClock(start)}–${fmtClock(end)}`;

/**
 * Format an ISO-8601 timestamp string as a `HH:MM` clock in the
 * user's local timezone. Used by the idle modal to render
 * `since`/`until` from the `signal:idle-resume` event.
 */
export const fmtClockFromIso = (iso: string): string => {
  const d = new Date(iso);
  // Degrade to an em dash on an unparseable timestamp rather than
  // rendering "NaN:NaN" in the idle prompt — mirrors the NaN guards on
  // the other helpers in this module.
  if (Number.isNaN(d.getTime())) return "—";
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

/**
 * Format a raw seconds count as a human-readable idle duration.
 * `12 sec` / `7 min` / `2 h` / `1 h 23 min`. The idle modal shows
 * this beside the time range.
 */
export const fmtIdleDuration = (seconds: number): string => {
  if (seconds < 60) return `${Math.floor(seconds)} sec`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rem = minutes % 60;
  return rem === 0 ? `${hours} h` : `${hours} h ${rem} min`;
};
