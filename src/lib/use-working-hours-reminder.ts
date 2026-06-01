import { useCallback, useEffect, useRef, useState } from "react";
import { currentRunning, idleSeconds as idleSecondsIpc, inTauri } from "./ipc";
import {
  decidePrompt,
  idleTrigger,
  minuteOfDay,
  type PromptSchedule,
} from "./prompt-scheduler";
import type { WorkingHours } from "./use-working-hours";

/** How often the reminder re-evaluates whether to prompt. */
export const REMINDER_POLL_MS = 60_000;

export interface UseWorkingHoursReminderOpts {
  /** The persisted working-hours config (from `useWorkingHours`). */
  workingHours: WorkingHours;
  /** Bypass the inTauri guard / inject polling cadence (tests). */
  enabled?: boolean;
  pollMs?: number;
  /** Injected for tests. */
  now?: () => number;
  fetchIdleSeconds?: typeof idleSecondsIpc;
  fetchRunning?: typeof currentRunning;
}

export interface UseWorkingHoursReminder {
  /** True when the subtle reminder should be shown. */
  active: boolean;
  /** Dismiss the reminder without starting a timer. Arms the throttle. */
  dismiss: () => void;
  /** Acknowledge that the user acted on the reminder (started tracking). */
  acknowledge: () => void;
}

/**
 * Drives the #99 working-hours reminder. Polls the backend for idle seconds
 * and the running timer, then asks the pure {@link decidePrompt} scheduler
 * whether to surface a subtle "start tracking?" prompt — gated by the user's
 * working-hours window and the throttle.
 *
 * The prompt only ever *offers*: showing it never starts a timer. Both
 * dismiss and acknowledge arm the throttle (record "last prompted now") so
 * we don't immediately re-prompt.
 */
export function useWorkingHoursReminder(
  opts: UseWorkingHoursReminderOpts,
): UseWorkingHoursReminder {
  const { workingHours } = opts;
  const enabled = opts.enabled ?? inTauri;
  const pollMs = opts.pollMs ?? REMINDER_POLL_MS;
  const now = opts.now ?? Date.now;
  const fetchIdle = opts.fetchIdleSeconds ?? idleSecondsIpc;
  const fetchRunning = opts.fetchRunning ?? currentRunning;

  const [active, setActive] = useState(false);
  const lastPromptRef = useRef<number | null>(null);

  // Keep the latest config/clock without re-arming the interval each render.
  const scheduleRef = useRef<PromptSchedule>(workingHours);
  const idleThresholdRef = useRef<number>(workingHours.idleMinutes * 60);
  scheduleRef.current = workingHours;
  idleThresholdRef.current = workingHours.idleMinutes * 60;

  const evaluate = useCallback(async () => {
    const schedule = scheduleRef.current;
    if (!schedule.enabled) {
      setActive(false);
      return;
    }
    let running = false;
    try {
      running = (await fetchRunning()) !== null;
    } catch {
      return;
    }
    let idle: number | null = null;
    try {
      idle = await fetchIdle();
    } catch {
      return;
    }
    const triggered = idleTrigger(idle, idleThresholdRef.current, running);
    const decision = decidePrompt(schedule, {
      minuteOfDay: minuteOfDay(),
      nowMs: now(),
      lastPromptMs: lastPromptRef.current,
      triggered,
    });
    setActive(decision === "prompt");
  }, [fetchRunning, fetchIdle, now]);

  useEffect(() => {
    if (!enabled) return;
    void evaluate();
    const id = window.setInterval(() => void evaluate(), pollMs);
    return () => window.clearInterval(id);
  }, [enabled, pollMs, evaluate]);

  const arm = useCallback(() => {
    lastPromptRef.current = now();
    setActive(false);
  }, [now]);

  return { active, dismiss: arm, acknowledge: arm };
}
