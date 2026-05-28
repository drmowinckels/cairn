const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

export interface RelativeTimeOptions {
  now?: Date;
}

/**
 * Format an ISO timestamp (or `Date`) as a short human-readable
 * "time ago" string. Examples: `just now`, `2m ago`, `3h ago`,
 * `5d ago`, `2w ago`, `2026-04-12`.
 *
 * Anything in the future returns `just now`.
 */
export function formatRelativeTime(
  value: string | Date | null | undefined,
  options: RelativeTimeOptions = {},
): string {
  if (value === null || value === undefined) return "never";
  const when = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(when.getTime())) return "never";
  const now = options.now ?? new Date();
  const delta = now.getTime() - when.getTime();
  if (delta < 45 * SECOND) return "just now";
  if (delta < HOUR) return `${Math.floor(delta / MINUTE)}m ago`;
  if (delta < DAY) return `${Math.floor(delta / HOUR)}h ago`;
  if (delta < WEEK) return `${Math.floor(delta / DAY)}d ago`;
  if (delta < 4 * WEEK) return `${Math.floor(delta / WEEK)}w ago`;
  return when.toISOString().slice(0, 10);
}
