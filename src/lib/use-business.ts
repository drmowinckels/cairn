import { useCallback, useEffect, useState } from "react";
import {
  billingGetBusiness,
  billingSetBusiness,
  type BusinessDetails,
} from "./ipc";

export interface UseBusiness {
  /** `null` while the first load is in flight or outside Tauri. */
  details: BusinessDetails | null;
  /** A save is in flight. */
  busy: boolean;
  error: string | null;
  /** `true` after the most recent save succeeded, until the next edit. */
  saved: boolean;
  /** The stored (trimmed) details on success, or `null` on failure — so the
   *  caller can re-seed its form to server truth. */
  save: (details: BusinessDetails) => Promise<BusinessDetails | null>;
  /** Clear the just-saved confirmation (call when the form is edited). */
  clearSaved: () => void;
}

/** State + actions behind the Pro business-details panel (#1). Loads the
 *  stored issuer details once; save goes through the backend Pro gate and
 *  returns the trimmed server form, so the panel always reflects server
 *  truth. */
export function useBusiness(): UseBusiness {
  const [details, setDetails] = useState<BusinessDetails | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const d = await billingGetBusiness();
        if (alive) setDetails(d);
      } catch (e) {
        if (alive) setError(String(e));
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const save = useCallback(async (input: BusinessDetails) => {
    setBusy(true);
    setError(null);
    try {
      const stored = await billingSetBusiness(input);
      setDetails(stored);
      setSaved(true);
      return stored;
    } catch (e) {
      setError(String(e));
      return null;
    } finally {
      setBusy(false);
    }
  }, []);

  const clearSaved = useCallback(() => setSaved(false), []);

  return { details, busy, error, saved, save, clearSaved };
}
