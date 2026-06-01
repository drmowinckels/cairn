import { useCallback, useEffect, useRef, useState } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { inTauri, snoozeRule, startEntry } from "./ipc";
import {
  decidePrompt,
  minuteOfDay,
  type PromptSchedule,
} from "./prompt-scheduler";
import {
  dwellSatisfied,
  expireIfStale,
  NO_DWELL,
  observe,
  runningRefOf,
  type DwellState,
  type RunningRef,
  type TaskSwitchPrefs,
} from "./task-switch";
import { DEFAULT_SNOOZE_SECONDS, SIGNAL_MATCH_EVENT } from "./use-suggestion";
import type { BackendEntry } from "./ipc";
import type { RuleMatchEvent } from "./types";

const MINUTES_PER_DAY = 24 * 60;

/** How often the gate re-evaluates dwell/staleness, in ms. The snapshot
 *  stream fires ~2 Hz, so a 1 s tick surfaces the prompt within a tick of the
 *  dwell deadline and expires a stale candidate promptly. */
export const TASK_SWITCH_POLL_MS = 1_000;

/** A candidate that hasn't re-fired within this window is considered gone —
 *  matches only arrive while a rule is firing, so silence means the user
 *  moved on. Comfortably above the ~500 ms snapshot cadence. */
export const TASK_SWITCH_STALE_MS = 4_000;

export interface UseTaskSwitchPromptOpts {
  /** The persisted task-switch preference. */
  prefs: TaskSwitchPrefs;
  /** The running timer, or null. Drives the "different project" comparison. */
  running: BackendEntry | null;
  /** Bypass the inTauri guard (tests). */
  enabled?: boolean;
  pollMs?: number;
  staleMs?: number;
  /** Injected for tests. */
  now?: () => number;
  listen?: typeof listen;
  startEntry?: typeof startEntry;
  snoozeRule?: typeof snoozeRule;
}

export interface UseTaskSwitchPrompt {
  /** The switch suggestion the banner should render, or null. */
  active: RuleMatchEvent | null;
  /** Switch: stop the current timer and start the matched rule's project. */
  confirm: () => Promise<void>;
  /** Keep the current timer; snooze the matched rule so it stops nagging. */
  dismiss: () => void;
}

/** Build the always-in-window schedule the throttle reuses. The task-switch
 *  prompt has no quiet-hours window (you're already tracking, so you're
 *  working), so the window spans the whole day; only `enabled` and the
 *  throttle matter. */
function scheduleFor(prefs: TaskSwitchPrefs): PromptSchedule {
  return {
    enabled: prefs.enabled,
    startMinute: 0,
    endMinute: MINUTES_PER_DAY,
    throttleMinutes: prefs.throttleMinutes,
  };
}

/**
 * Drives the #105 task-switch prompt. Subscribes to the backend's
 * `signal:match` event and watches for a *different* project's suggestive
 * rule becoming the top match while a timer runs. Such a candidate must
 * **dwell** — stay the top match for `prefs.dwellSeconds` — before the prompt
 * surfaces, and the prompt obeys the shared throttle so it never asks more
 * than once per `prefs.throttleMinutes`. A candidate that stops matching
 * expires silently; the prompt only ever *offers* (suggestion ≠ auto-log).
 *
 * No-op when disabled or outside Tauri. The pure dwell logic lives in
 * `task-switch.ts`; this hook is the clock + I/O shell around it.
 */
export function useTaskSwitchPrompt(
  opts: UseTaskSwitchPromptOpts,
): UseTaskSwitchPrompt {
  // Only arm the listener + interval when the feature is actually on, so a
  // disabled prompt costs nothing (no always-on subscription). `opts.enabled`
  // overrides the `inTauri` guard for tests.
  const featureOn = (opts.enabled ?? inTauri) && opts.prefs.enabled;
  const pollMs = opts.pollMs ?? TASK_SWITCH_POLL_MS;
  const staleMs = opts.staleMs ?? TASK_SWITCH_STALE_MS;
  const now = opts.now ?? Date.now;
  const listenFn = opts.listen ?? listen;
  const start = opts.startEntry ?? startEntry;
  const snooze = opts.snoozeRule ?? snoozeRule;

  const [active, setActive] = useState<RuleMatchEvent | null>(null);
  const activeRef = useRef<RuleMatchEvent | null>(null);
  activeRef.current = active;

  // Latest config / running timer, mirrored so the listener + interval read
  // current values without re-subscribing on every render.
  const prefsRef = useRef<TaskSwitchPrefs>(opts.prefs);
  prefsRef.current = opts.prefs;
  const runningRef = useRef<RunningRef | null>(runningRefOf(opts.running));
  runningRef.current = runningRefOf(opts.running);

  const dwellRef = useRef<DwellState>(NO_DWELL);
  const lastPromptRef = useRef<number | null>(null);

  const clear = useCallback(() => {
    dwellRef.current = NO_DWELL;
    setActive(null);
  }, []);

  const evaluate = useCallback(() => {
    const prefs = prefsRef.current;
    const t = now();
    dwellRef.current = expireIfStale(dwellRef.current, t, staleMs);
    if (dwellRef.current.ruleId === null) {
      if (activeRef.current !== null) setActive(null);
      return;
    }
    if (
      !dwellSatisfied(dwellRef.current, t, prefs.dwellSeconds * 1_000, staleMs)
    ) {
      return;
    }
    // Dwell satisfied: gate on the throttle. Arm it the moment we surface the
    // prompt so an ignored switch isn't re-asked every tick.
    const decision = decidePrompt(scheduleFor(prefs), {
      minuteOfDay: minuteOfDay(),
      nowMs: t,
      lastPromptMs: lastPromptRef.current,
      triggered: true,
    });
    if (decision === "prompt") {
      lastPromptRef.current = t;
      setActive(dwellRef.current.match);
    }
  }, [now, staleMs]);

  // Turning the feature off (or stopping the timer) tears down the listener
  // below; clear any in-flight prompt + dwell so it doesn't linger.
  useEffect(() => {
    if (!featureOn) {
      dwellRef.current = NO_DWELL;
      setActive(null);
    }
  }, [featureOn]);

  useEffect(() => {
    if (!featureOn) return;
    let unlisten: UnlistenFn | null = null;
    let cancelled = false;
    void listenFn<RuleMatchEvent>(SIGNAL_MATCH_EVENT, (event) => {
      dwellRef.current = observe(
        dwellRef.current,
        event.payload,
        runningRef.current,
        now(),
      );
      evaluate();
    }).then((un) => {
      if (cancelled) {
        un();
      } else {
        unlisten = un;
      }
    });
    const id = window.setInterval(evaluate, pollMs);
    return () => {
      cancelled = true;
      window.clearInterval(id);
      if (unlisten) unlisten();
    };
  }, [featureOn, listenFn, pollMs, now, evaluate]);

  const confirm = useCallback(async () => {
    const m = activeRef.current;
    if (!m) return;
    lastPromptRef.current = now();
    clear();
    try {
      await start({
        projectId: m.project,
        source: "rule",
        ruleId: m.ruleId,
        description: m.description || undefined,
      });
    } catch (e) {
      console.error("useTaskSwitchPrompt: switch start_entry failed", e);
    }
  }, [start, now, clear]);

  const dismiss = useCallback(() => {
    const m = activeRef.current;
    if (!m) return;
    lastPromptRef.current = now();
    clear();
    void snooze(m.ruleId, DEFAULT_SNOOZE_SECONDS).catch((e) => {
      console.error("useTaskSwitchPrompt: snooze_rule failed", e);
    });
  }, [snooze, now, clear]);

  return { active, confirm, dismiss };
}
