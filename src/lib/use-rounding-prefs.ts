import { useCallback, useState } from "react";
import { ROUNDING_OFF, type RoundMode, type Rounding } from "./rounding";

const STORAGE_KEY = "cairn:rounding:v1";

export interface UseRoundingPrefs {
  rounding: Rounding;
  setIntervalMinutes: (minutes: number) => void;
  setMode: (mode: RoundMode) => void;
}

function read(): Rounding {
  try {
    const raw = window.localStorage?.getItem(STORAGE_KEY);
    if (!raw) return ROUNDING_OFF;
    const parsed = JSON.parse(raw) as Partial<Rounding>;
    const intervalMinutes =
      typeof parsed.intervalMinutes === "number" && parsed.intervalMinutes > 0
        ? Math.floor(parsed.intervalMinutes)
        : 0;
    const mode: RoundMode =
      parsed.mode === "up" || parsed.mode === "down" ? parsed.mode : "nearest";
    return { intervalMinutes, mode };
  } catch {
    return ROUNDING_OFF;
  }
}

/**
 * Persisted, global time-rounding preference (off by default). Display and
 * export read it to round each entry's duration; the raw timestamps are never
 * touched. localStorage-backed, same pattern as the a11y and tray prefs.
 */
export function useRoundingPrefs(): UseRoundingPrefs {
  const [rounding, setRounding] = useState<Rounding>(() => read());

  // Merge against the current React state, not a fresh localStorage read, so
  // an in-memory change survives even when the write fails (private mode).
  const update = useCallback((patch: Partial<Rounding>) => {
    setRounding((prev) => {
      const next = { ...prev, ...patch };
      try {
        window.localStorage?.setItem(STORAGE_KEY, JSON.stringify(next));
      } catch {
        /* private mode — preference just won't persist */
      }
      return next;
    });
  }, []);

  const setIntervalMinutes = useCallback(
    (minutes: number) =>
      update({ intervalMinutes: Math.max(0, Math.floor(minutes)) }),
    [update],
  );

  const setMode = useCallback((mode: RoundMode) => update({ mode }), [update]);

  return { rounding, setIntervalMinutes, setMode };
}
