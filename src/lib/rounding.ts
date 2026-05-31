// Optional time rounding applied at the display/export layer only — raw
// timestamps are never mutated (issue #107). Mirrors the Rust `Rounding`
// type in src-tauri/src/rounding.rs; the field names cross the IPC boundary.

export type RoundMode = "nearest" | "up" | "down";

export interface Rounding {
  /** Rounding interval in minutes. `0` disables rounding. */
  intervalMinutes: number;
  mode: RoundMode;
}

export const ROUNDING_OFF: Rounding = { intervalMinutes: 0, mode: "nearest" };

/** Allowed intervals offered in Settings (minutes). `0` = off. */
export const ROUNDING_INTERVALS = [0, 1, 5, 6, 10, 15, 30] as const;

export const ROUND_MODES: readonly RoundMode[] = ["nearest", "up", "down"];

export function isRoundingActive(r: Rounding): boolean {
  return r.intervalMinutes > 0;
}

/**
 * Round a positive duration in seconds to the configured interval. Non-positive
 * inputs clamp to 0; a disabled config is the identity. Under `nearest`/`down`,
 * a duration shorter than half/one interval rounds to 0 — standard timesheet
 * behaviour. Keep this in lockstep with `Rounding::round_secs` in Rust.
 */
export function roundSeconds(seconds: number, r: Rounding): number {
  const interval = r.intervalMinutes * 60;
  if (interval <= 0 || seconds <= 0) return Math.max(0, seconds);
  const rem = seconds % interval;
  if (rem === 0) return seconds;
  const floor = seconds - rem;
  switch (r.mode) {
    case "down":
      return floor;
    case "up":
      return floor + interval;
    case "nearest":
      return rem * 2 >= interval ? floor + interval : floor;
  }
}

/** Round a duration given in minutes (returns whole minutes when rounding). */
export function roundMinutes(minutes: number, r: Rounding): number {
  return roundSeconds(minutes * 60, r) / 60;
}

/** Human label for an interval, e.g. `Off`, `5 min`, `15 min`. */
export function roundingLabel(intervalMinutes: number): string {
  return intervalMinutes === 0 ? "Off" : `${intervalMinutes} min`;
}
