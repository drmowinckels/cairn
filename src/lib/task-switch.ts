/**
 * Pure decision logic for the #105 task-switch prompt.
 *
 * While a timer is running, the rules engine keeps matching the live signal.
 * When a *different* project's rule becomes the top match, it looks like the
 * user changed task. Cairn must not nag on a momentary alt-tab, so the prompt
 * is gated by a **dwell**: the new rule has to stay the top match for a
 * sustained window before we ask. This module is the pure core of that gate —
 * no clock, no I/O, no React. {@link useTaskSwitchPrompt} drives it.
 *
 * See `docs/RULES_ENGINE.md` and the #99 `prompt-scheduler` (whose throttle
 * this feature reuses for the "how often to ask" half).
 */

import type { RuleMatchEvent } from "./types";

/** Persisted preference for the task-switch prompt. Off by default — Cairn
 *  must not nag out of the box. localStorage-backed, same shape family as the
 *  working-hours and rounding prefs. */
export interface TaskSwitchPrefs {
  /** Master switch. Off by default. */
  enabled: boolean;
  /** How long the different-project rule must stay the top match before we
   *  ask, in seconds. The "how long to wait" half of issue #105. */
  dwellSeconds: number;
  /** Don't ask more than once per this many minutes. Reuses the
   *  prompt-scheduler throttle — the "how often to ask" half. */
  throttleMinutes: number;
}

export const TASK_SWITCH_OFF: TaskSwitchPrefs = {
  enabled: false,
  dwellSeconds: 60,
  throttleMinutes: 30,
};

/** The running timer's identity, as far as the switch gate cares. */
export interface RunningRef {
  projectId: string | null;
  ruleId: string | null;
}

/** Project a running entry (or null) down to the {@link RunningRef} the gate
 *  compares against. Keeps the entry's wider shape out of the pure logic. */
export function runningRefOf(
  entry: { projectId: string | null; ruleId: string | null } | null,
): RunningRef | null {
  return entry ? { projectId: entry.projectId, ruleId: entry.ruleId } : null;
}

/**
 * True when `match` looks like the user switched to a *different* task than
 * the running timer. All of these must hold:
 *
 *  - a timer is running and it has a project (we only flag switches *between*
 *    known projects — an uncategorised timer is left to the normal flow),
 *  - the match carries a project,
 *  - that project differs from the running one,
 *  - the match isn't the very rule that started the running timer.
 *
 * Strict matches are excluded: those auto-start via `useSuggestion`, so the
 * switch happens without a prompt. Pure.
 */
export function isSwitchCandidate(
  match: RuleMatchEvent | null,
  running: RunningRef | null,
): boolean {
  if (!match || !running) return false;
  if (match.confidence !== "suggestive") return false;
  if (running.projectId === null) return false;
  if (match.project === null) return false;
  if (match.project === running.projectId) return false;
  if (match.ruleId === running.ruleId) return false;
  return true;
}

/**
 * Accumulated dwell for the candidate currently being watched. `ruleId` is
 * null when nothing is dwelling. `firstSeenMs` anchors the dwell window;
 * `lastSeenMs` tracks freshness so a candidate that stops matching expires.
 */
export interface DwellState {
  ruleId: string | null;
  match: RuleMatchEvent | null;
  firstSeenMs: number;
  lastSeenMs: number;
}

export const NO_DWELL: DwellState = {
  ruleId: null,
  match: null,
  firstSeenMs: 0,
  lastSeenMs: 0,
};

/**
 * Fold a fresh match into the dwell state. A non-candidate (or a match for a
 * different rule than the one dwelling) resets the window; the same candidate
 * re-firing just refreshes `lastSeenMs`, extending its freshness without
 * restarting the dwell clock.
 */
export function observe(
  state: DwellState,
  match: RuleMatchEvent | null,
  running: RunningRef | null,
  nowMs: number,
): DwellState {
  if (!isSwitchCandidate(match, running)) return NO_DWELL;
  const m = match as RuleMatchEvent;
  if (state.ruleId === m.ruleId) {
    return { ...state, match: m, lastSeenMs: nowMs };
  }
  return { ruleId: m.ruleId, match: m, firstSeenMs: nowMs, lastSeenMs: nowMs };
}

/**
 * Drop the candidate if it hasn't re-fired within `staleMs`. Matches only
 * arrive *while* a rule is firing, so silence means the user moved on — the
 * gate has no other way to learn the candidate is gone.
 */
export function expireIfStale(
  state: DwellState,
  nowMs: number,
  staleMs: number,
): DwellState {
  if (state.ruleId === null) return state;
  if (nowMs - state.lastSeenMs > staleMs) return NO_DWELL;
  return state;
}

/**
 * Has the candidate dwelled long enough *and* is it still fresh? Both are
 * required: a stale candidate (user moved on) never satisfies, and a fresh
 * one only satisfies once `dwellMs` has elapsed since it was first seen.
 */
export function dwellSatisfied(
  state: DwellState,
  nowMs: number,
  dwellMs: number,
  staleMs: number,
): boolean {
  if (state.ruleId === null) return false;
  if (nowMs - state.lastSeenMs > staleMs) return false;
  return nowMs - state.firstSeenMs >= dwellMs;
}
