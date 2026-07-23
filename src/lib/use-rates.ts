import { useCallback, useEffect, useState } from "react";
import {
  billingDeleteRate,
  billingListRates,
  billingSetRate,
  type Rate,
} from "./ipc";

export interface RateInput {
  scopeType: Rate["scopeType"];
  scopeId: string;
  amountCents: number;
  currency: string;
  effectiveFrom: string;
}

export interface UseRates {
  /** `null` while the first load is in flight or outside Tauri. */
  rates: Rate[] | null;
  /** A rate mutation (add / delete) is in flight. */
  busy: boolean;
  error: string | null;
  /** Resolves `true` when the rate was saved. */
  addRate: (input: RateInput) => Promise<boolean>;
  deleteRate: (id: string) => Promise<boolean>;
}

/** State + actions behind the Pro rate panel (#109). Loads the configured
 *  rates once; add/delete go through the backend gate (active Pro license)
 *  and return the fresh list, so the panel always renders server truth. */
export function useRates(): UseRates {
  const [rates, setRates] = useState<Rate[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const list = await billingListRates();
        if (alive) setRates(list);
      } catch (e) {
        if (alive) setError(String(e));
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const run = useCallback(async (op: () => Promise<Rate[]>) => {
    setBusy(true);
    setError(null);
    try {
      setRates(await op());
      return true;
    } catch (e) {
      setError(String(e));
      return false;
    } finally {
      setBusy(false);
    }
  }, []);

  const addRate = useCallback(
    (input: RateInput) => run(() => billingSetRate(input)),
    [run],
  );
  const deleteRate = useCallback(
    (id: string) => run(() => billingDeleteRate(id)),
    [run],
  );

  return { rates, busy, error, addRate, deleteRate };
}
