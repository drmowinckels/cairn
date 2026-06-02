import { useCallback, useEffect, useState } from "react";
import { checkForUpdate, type UpdateInfo } from "./ipc";

const DISMISS_KEY = "cairn:update-dismissed:v1";
export const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

export interface UseUpdateCheck {
  /** The available update to surface, or null (up to date / dismissed / off). */
  available: UpdateInfo | null;
  /** Hide the banner for the current version; it won't reappear for it. */
  dismiss: () => void;
}

function readDismissed(): string | null {
  try {
    return window.localStorage?.getItem(DISMISS_KEY) ?? null;
  } catch {
    return null;
  }
}

/**
 * Drives the opt-in update check (#45). When `enabled`, runs a single
 * check on mount and again every 24h while the app is open; when disabled
 * it performs no network call and clears any pending banner. A dismissed
 * version is remembered so the banner doesn't nag for the same release.
 */
export function useUpdateCheck(enabled: boolean): UseUpdateCheck {
  const [available, setAvailable] = useState<UpdateInfo | null>(null);
  const [dismissed, setDismissed] = useState<string | null>(() =>
    readDismissed(),
  );

  useEffect(() => {
    if (!enabled) {
      setAvailable(null);
      return;
    }
    let cancelled = false;
    const run = async () => {
      try {
        const info = await checkForUpdate();
        if (!cancelled) setAvailable(info);
      } catch {
        /* network/transport failure — stay silent, treat as no update */
      }
    };
    void run();
    const id = window.setInterval(() => void run(), UPDATE_CHECK_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [enabled]);

  const dismiss = useCallback(() => {
    setAvailable((current) => {
      if (current) {
        setDismissed(current.version);
        try {
          window.localStorage?.setItem(DISMISS_KEY, current.version);
        } catch {
          /* private mode — dismissal just won't persist */
        }
      }
      return current;
    });
  }, []);

  const visible =
    available && available.version !== dismissed ? available : null;
  return { available: visible, dismiss };
}
