import { useCallback, useState } from "react";

const STORAGE_KEY = "cairn:workday-review:v1";

export interface UseWorkdayReviewPrefs {
  enabled: boolean;
  setEnabled: (next: boolean) => void;
}

function read(): boolean {
  try {
    const raw = window.localStorage?.getItem(STORAGE_KEY);
    if (!raw) return false;
    const parsed = JSON.parse(raw) as { enabled?: unknown };
    return parsed.enabled === true;
  } catch {
    return false;
  }
}

/**
 * Opt-in "Workday in Review" preference: a dismissible banner offered once
 * working hours end, pointing at the Activity view when there's unreviewed
 * activity-log data for the day. **Off by default**, and only ever offered
 * in Settings while the activity log itself is on. The trigger time reuses
 * `useWorkingHours`' `endMinute` rather than its own picker — see
 * `useWorkdayReview`. localStorage-backed, same pattern as the update-check
 * pref.
 */
export function useWorkdayReviewPrefs(): UseWorkdayReviewPrefs {
  const [enabled, setEnabledState] = useState<boolean>(() => read());

  const setEnabled = useCallback((next: boolean) => {
    setEnabledState(next);
    try {
      window.localStorage?.setItem(
        STORAGE_KEY,
        JSON.stringify({ enabled: next }),
      );
    } catch {
      /* private mode — preference just won't persist */
    }
  }, []);

  return { enabled, setEnabled };
}
