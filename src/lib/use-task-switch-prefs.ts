import { useCallback, useState } from "react";
import { TASK_SWITCH_OFF, type TaskSwitchPrefs } from "./task-switch";

const STORAGE_KEY = "cairn:task-switch:v1";

/** Clamp a positive integer pref, falling back when the stored value is
 *  missing or malformed (private mode, hand-edited localStorage). */
function clampPositive(n: unknown, fallback: number): number {
  return typeof n === "number" && Number.isFinite(n) && n > 0
    ? Math.floor(n)
    : fallback;
}

function read(): TaskSwitchPrefs {
  try {
    const raw = window.localStorage?.getItem(STORAGE_KEY);
    if (!raw) return TASK_SWITCH_OFF;
    const parsed = JSON.parse(raw) as Partial<TaskSwitchPrefs>;
    return {
      enabled: parsed.enabled === true,
      dwellSeconds: clampPositive(
        parsed.dwellSeconds,
        TASK_SWITCH_OFF.dwellSeconds,
      ),
      throttleMinutes: clampPositive(
        parsed.throttleMinutes,
        TASK_SWITCH_OFF.throttleMinutes,
      ),
    };
  } catch {
    return TASK_SWITCH_OFF;
  }
}

export interface UseTaskSwitchPrefs {
  prefs: TaskSwitchPrefs;
  setEnabled: (next: boolean) => void;
  setDwellSeconds: (seconds: number) => void;
  setThrottleMinutes: (minutes: number) => void;
}

/**
 * Persisted {@link TaskSwitchPrefs} for the #105 task-switch prompt. Off by
 * default — Cairn must not nag out of the box. localStorage-backed, same
 * read-modify-write-against-state pattern as {@link useWorkingHours} so an
 * in-memory change survives a failed write in private mode.
 */
export function useTaskSwitchPrefs(): UseTaskSwitchPrefs {
  const [prefs, setPrefs] = useState<TaskSwitchPrefs>(() => read());

  const update = useCallback((patch: Partial<TaskSwitchPrefs>) => {
    setPrefs((prev) => {
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
  const setDwellSeconds = useCallback(
    (seconds: number) =>
      update({ dwellSeconds: Math.max(1, Math.floor(seconds)) }),
    [update],
  );
  const setThrottleMinutes = useCallback(
    (minutes: number) =>
      update({ throttleMinutes: Math.max(1, Math.floor(minutes)) }),
    [update],
  );

  return { prefs, setEnabled, setDwellSeconds, setThrottleMinutes };
}
