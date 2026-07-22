import { useCallback, useEffect, useState } from "react";
import {
  activateBillingLicense,
  billingStatus,
  deactivateBillingLicense,
  refreshBillingLicense,
  type BillingStatus,
} from "./ipc";

export interface UseBilling {
  /** `null` while the first load is in flight or outside Tauri. */
  status: BillingStatus | null;
  /** A Lemon Squeezy call (activate / refresh / deactivate) is in flight. */
  busy: boolean;
  error: string | null;
  /** Resolves `true` when Lemon Squeezy activated the key (the caller
   *  clears its input only then — a rejected paste stays put for fixing). */
  activate: (license: string) => Promise<boolean>;
  refresh: () => Promise<void>;
  deactivate: () => Promise<boolean>;
}

/** State + actions behind the Pro license row (#109). Loads the stored
 *  activation with no network, then re-checks it against Lemon Squeezy
 *  once so the card reflects the live status when opened. The license key
 *  is write-only: sent once on activate, never held in state. */
export function useBilling(): UseBilling {
  const [status, setStatus] = useState<BillingStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      let loaded: BillingStatus | null;
      try {
        loaded = await billingStatus();
      } catch (e) {
        if (alive) setError(String(e));
        return;
      }
      if (!alive) return;
      setStatus(loaded);
      // Check in with Lemon Squeezy only when there's something to verify.
      if (!loaded?.license) return;
      setBusy(true);
      try {
        const fresh = await refreshBillingLicense();
        if (alive) setStatus(fresh);
      } catch (e) {
        // A dropped connection leaves the last-known state; surface why.
        if (alive) setError(String(e));
      } finally {
        if (alive) setBusy(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const run = useCallback(async (op: () => Promise<BillingStatus>) => {
    setBusy(true);
    setError(null);
    try {
      setStatus(await op());
      return true;
    } catch (e) {
      setError(String(e));
      return false;
    } finally {
      setBusy(false);
    }
  }, []);

  const activate = useCallback(
    (license: string) => run(() => activateBillingLicense(license)),
    [run],
  );
  const refresh = useCallback(async () => {
    await run(() => refreshBillingLicense());
  }, [run]);
  const deactivate = useCallback(
    () => run(() => deactivateBillingLicense()),
    [run],
  );

  return { status, busy, error, activate, refresh, deactivate };
}
