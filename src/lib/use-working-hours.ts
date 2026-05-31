import { useCallback, useState } from "react";
import { SCHEDULE_OFF, type PromptSchedule } from "./prompt-scheduler";

const STORAGE_KEY = "cairn:working-hours:v1";

const MINUTES_PER_DAY = 24 * 60;

/**
 * The working-hours reminder pref (#99): persisted {@link PromptSchedule}
 * plus the idle threshold that arms the reminder. Off by default — Cairn
 * must not nag out of the box. localStorage-backed, same pattern as the
 * rounding and tray prefs.
 */
export interface WorkingHours extends PromptSchedule {
  /** Minutes of no input before the reminder is eligible to fire. */
  idleMinutes: number;
}

export const WORKING_HOURS_OFF: WorkingHours = {
  ...SCHEDULE_OFF,
  idleMinutes: 10,
};

function clampMinuteOfDay(n: unknown, fallback: number): number {
  return typeof n === "number" && Number.isFinite(n)
    ? Math.min(Math.max(0, Math.floor(n)), MINUTES_PER_DAY)
    : fallback;
}

function clampPositive(n: unknown, fallback: number): number {
  return typeof n === "number" && Number.isFinite(n) && n > 0
    ? Math.floor(n)
    : fallback;
}

function read(): WorkingHours {
  try {
    const raw = window.localStorage?.getItem(STORAGE_KEY);
    if (!raw) return WORKING_HOURS_OFF;
    const parsed = JSON.parse(raw) as Partial<WorkingHours>;
    return {
      enabled: parsed.enabled === true,
      startMinute: clampMinuteOfDay(parsed.startMinute, WORKING_HOURS_OFF.startMinute),
      endMinute: clampMinuteOfDay(parsed.endMinute, WORKING_HOURS_OFF.endMinute),
      throttleMinutes: clampPositive(parsed.throttleMinutes, WORKING_HOURS_OFF.throttleMinutes),
      idleMinutes: clampPositive(parsed.idleMinutes, WORKING_HOURS_OFF.idleMinutes),
    };
  } catch {
    return WORKING_HOURS_OFF;
  }
}

export interface UseWorkingHours {
  workingHours: WorkingHours;
  setEnabled: (next: boolean) => void;
  setStartMinute: (minute: number) => void;
  setEndMinute: (minute: number) => void;
  setThrottleMinutes: (minutes: number) => void;
  setIdleMinutes: (minutes: number) => void;
}

export function useWorkingHours(): UseWorkingHours {
  const [workingHours, setWorkingHours] = useState<WorkingHours>(() => read());

  // Merge against current React state, not a fresh localStorage read, so an
  // in-memory change survives a failed write (private mode).
  const update = useCallback((patch: Partial<WorkingHours>) => {
    setWorkingHours((prev) => {
      const next = { ...prev, ...patch };
      try {
        window.localStorage?.setItem(STORAGE_KEY, JSON.stringify(next));
      } catch {
        /* private mode — preference just won't persist */
      }
      return next;
    });
  }, []);

  const setEnabled = useCallback(
    (next: boolean) => update({ enabled: next }),
    [update],
  );
  const setStartMinute = useCallback(
    (minute: number) => update({ startMinute: clampMinuteOfDay(minute, 0) }),
    [update],
  );
  const setEndMinute = useCallback(
    (minute: number) => update({ endMinute: clampMinuteOfDay(minute, MINUTES_PER_DAY) }),
    [update],
  );
  const setThrottleMinutes = useCallback(
    (minutes: number) => update({ throttleMinutes: Math.max(1, Math.floor(minutes)) }),
    [update],
  );
  const setIdleMinutes = useCallback(
    (minutes: number) => update({ idleMinutes: Math.max(1, Math.floor(minutes)) }),
    [update],
  );

  return {
    workingHours,
    setEnabled,
    setStartMinute,
    setEndMinute,
    setThrottleMinutes,
    setIdleMinutes,
  };
}
