import { useCallback, useState } from "react";

const STORAGE_KEY = "cairn:tray-show-project:v1";

export interface UseTrayDetail {
  enabled: boolean;
  setEnabled: (next: boolean) => void;
}

function read(): boolean {
  try {
    return window.localStorage?.getItem(STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

/**
 * Persisted "show the tracked project in the menu bar" preference
 * (off by default). The popover reads it to decide whether to push the
 * tray title; the Settings toggle writes it. localStorage-backed, same
 * pattern as the popover-size and incognito prefs.
 */
export function useTrayDetail(): UseTrayDetail {
  const [enabled, setEnabledState] = useState<boolean>(() => read());

  const setEnabled = useCallback((next: boolean) => {
    setEnabledState(next);
    try {
      window.localStorage?.setItem(STORAGE_KEY, String(next));
    } catch {
      /* private mode — preference just won't persist */
    }
  }, []);

  return { enabled, setEnabled };
}
