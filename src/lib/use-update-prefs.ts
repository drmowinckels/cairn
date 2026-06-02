import { useCallback, useState } from "react";

const STORAGE_KEY = "cairn:update-check:v1";

export interface UseUpdatePrefs {
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
 * Opt-in "check for updates" preference. **Off by default** — this gates
 * the only outbound network Cairn core makes besides user-configured
 * calendar fetches (see docs/PRIVACY.md). localStorage-backed, same
 * pattern as the rounding / a11y prefs.
 */
export function useUpdatePrefs(): UseUpdatePrefs {
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
