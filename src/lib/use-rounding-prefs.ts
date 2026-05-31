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

  const persist = useCallback((next: Rounding) => {
    setRounding(next);
    try {
      window.localStorage?.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      /* private mode — preference just won't persist */
    }
  }, []);

  const setIntervalMinutes = useCallback(
    (minutes: number) =>
      persist({ ...read(), intervalMinutes: Math.max(0, Math.floor(minutes)) }),
    [persist],
  );

  const setMode = useCallback(
    (mode: RoundMode) => persist({ ...read(), mode }),
    [persist],
  );

  return { rounding, setIntervalMinutes, setMode };
}
