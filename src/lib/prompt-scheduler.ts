/**
 * Pure decision logic for Cairn's proactive prompts (issues #99, #105).
 *
 * Mirrors the Rust `prompt_scheduler` module. Cairn occasionally wants to
 * *offer* something without being asked — "you're idle during working hours,
 * start tracking?" (#99), later "this looks like a different task, switch?"
 * (#105). Both obey the same two guards so the app never nags:
 *
 *  1. A working-hours window (quiet hours): only prompt inside it.
 *  2. A rate limit: never prompt more than once per `throttleMinutes`.
 *
 * No clock, no I/O, no React. The caller passes `now`, the last-prompt time
 * and the trigger; {@link decidePrompt} returns a {@link PromptDecision}.
 * #99 is the first caller; #105 reuses the same schedule with its own
 * "trigger" signal.
 */

const MINUTES_PER_DAY = 24 * 60;

export interface PromptSchedule {
  /** Master switch. Off by default — Cairn must not nag out of the box. */
  enabled: boolean;
  /** Window start as minutes since local midnight (0..=1439). */
  startMinute: number;
  /** Window end as minutes since local midnight (1..=1440). Exclusive. */
  endMinute: number;
  /** Don't prompt more than once per this many minutes. */
  throttleMinutes: number;
}

export type PromptDecision =
  | "prompt"
  | "disabled"
  | "outside-window"
  | "not-triggered"
  | "throttled";

/** Disabled schedule with a sensible 09:00–17:00 window and 30-min throttle. */
export const SCHEDULE_OFF: PromptSchedule = {
  enabled: false,
  startMinute: 9 * 60,
  endMinute: 17 * 60,
  throttleMinutes: 30,
};

function normalize(cfg: PromptSchedule): PromptSchedule {
  return {
    enabled: cfg.enabled,
    startMinute: Math.min(Math.max(0, Math.floor(cfg.startMinute)), MINUTES_PER_DAY),
    endMinute: Math.min(Math.max(0, Math.floor(cfg.endMinute)), MINUTES_PER_DAY),
    throttleMinutes: Math.max(1, Math.floor(cfg.throttleMinutes)),
  };
}

/**
 * Half-open `[start, end)` window. A non-positive-width window (start >= end,
 * incl. the all-zero malformed case) is empty: never in window. Same-day
 * windows only — overnight shifts are a documented follow-up.
 */
function inWindow(cfg: PromptSchedule, minuteOfDay: number): boolean {
  return (
    cfg.startMinute < cfg.endMinute &&
    minuteOfDay >= cfg.startMinute &&
    minuteOfDay < cfg.endMinute
  );
}

export interface DecideInput {
  /** Local time as minutes since midnight (0..=1439). */
  minuteOfDay: number;
  /** Wall-clock millis, for the throttle. */
  nowMs: number;
  /** Millis of the last prompt, or null if never prompted. */
  lastPromptMs: number | null;
  /** Caller's trigger condition (for #99: idle past threshold AND not tracking). */
  triggered: boolean;
}

/**
 * Decide whether a proactive prompt may fire now. Guards are evaluated in a
 * fixed priority so the returned decision is the single most relevant reason:
 * disabled → outside window → not triggered → throttled → prompt.
 */
export function decidePrompt(
  schedule: PromptSchedule,
  input: DecideInput,
): PromptDecision {
  const cfg = normalize(schedule);
  if (!cfg.enabled) return "disabled";
  if (!inWindow(cfg, input.minuteOfDay)) return "outside-window";
  if (!input.triggered) return "not-triggered";
  if (input.lastPromptMs !== null) {
    const elapsedMs = input.nowMs - input.lastPromptMs;
    const throttleMs = cfg.throttleMinutes * 60_000;
    // Clock skew (last in the future) is treated as "just prompted".
    if (elapsedMs < throttleMs) return "throttled";
  }
  return "prompt";
}

/**
 * #99 idle trigger: offer tracking only when the OS reports idle past the
 * threshold AND no timer is running. `idleSeconds == null` means the host
 * can't report idle — treated as "not idle" so we never prompt blind.
 */
export function idleTrigger(
  idleSeconds: number | null,
  thresholdSeconds: number,
  isTracking: boolean,
): boolean {
  if (isTracking) return false;
  if (idleSeconds === null) return false;
  return idleSeconds >= thresholdSeconds;
}

/** Local minute-of-day for a `Date` (defaults to now). */
export function minuteOfDay(date: Date = new Date()): number {
  return date.getHours() * 60 + date.getMinutes();
}
