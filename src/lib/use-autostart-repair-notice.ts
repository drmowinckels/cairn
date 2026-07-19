import { useCallback, useEffect, useState } from "react";
import { dismissAutostartRepairNotice, getAutostartRepairNotice } from "./ipc";

export interface UseAutostartRepairNotice {
  /** The one-time explanation to show, or `null` (nothing pending, or
   *  already dismissed). */
  message: string | null;
  /** Clear the notice. Persisted backend-side (`app_state`), so it
   *  won't reappear on a later launch. */
  dismiss: () => Promise<void>;
}

/**
 * Surfaces the one-time notice (#264) for a stale launch-at-login
 * LaunchAgent that startup detected and repaired — one baked before
 * #263's dev-build guard existed, pointing at a since-removed dev build
 * or a relocated/uninstalled bundle. Backend-driven: the repair itself
 * runs once at startup (macOS only) and persists its explanation in the
 * `app_state` row; this hook only reads it and, on dismiss, clears it.
 */
export function useAutostartRepairNotice(): UseAutostartRepairNotice {
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const notice = await getAutostartRepairNotice();
        if (!cancelled) setMessage(notice.message);
      } catch {
        /* best-effort — a failed read just means no banner this launch */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const dismiss = useCallback(async () => {
    setMessage(null);
    try {
      await dismissAutostartRepairNotice();
    } catch {
      /* best-effort — a failed persist just means it may resurface */
    }
  }, []);

  return { message, dismiss };
}
