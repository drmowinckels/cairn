import { useCallback, useEffect, useState } from "react";
import {
  billingStatus,
  clearBillingLicense,
  setBillingLicense,
  type BillingStatus,
} from "./ipc";

export interface UseBilling {
  /** `null` while loading or outside Tauri (callers render nothing). */
  status: BillingStatus | null;
  busy: boolean;
  error: string | null;
  /** Resolves `true` when the license was accepted (the caller clears
   *  its input only then — a rejected paste stays put for fixing). */
  activate: (license: string) => Promise<boolean>;
  remove: () => Promise<boolean>;
}

/** State + actions behind the Pro license row (#109). The license
 *  string is write-only: it is sent once on activate and never held in
 *  state — the backend replies with the attested identity only. */
export function useBilling(): UseBilling {
  const [status, setStatus] = useState<BillingStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    billingStatus()
      .then((s) => {
        if (alive) setStatus(s);
      })
      .catch((e) => {
        if (alive) setError(String(e));
      });
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
    (license: string) => run(() => setBillingLicense(license)),
    [run],
  );
  const remove = useCallback(() => run(() => clearBillingLicense()), [run]);

  return { status, busy, error, activate, remove };
}
