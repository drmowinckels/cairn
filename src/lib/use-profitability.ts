import { useCallback, useEffect, useRef, useState } from "react";
import {
  billingProfitability,
  inTauri,
  type ProfitabilityReport,
  type ReportRange,
} from "./ipc";
import { ROUNDING_OFF, type Rounding } from "./rounding";

export interface UseProfitabilityState {
  data: ProfitabilityReport | null;
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

export interface UseProfitabilityOpts {
  /** Override for tests. */
  fetch?: typeof billingProfitability;
  /** Bypass the inTauri guard so the hook can be exercised in vitest. */
  enabled?: boolean;
  rounding?: Rounding;
}

/** Loads the Pro profitability report for a range (#109). Mirrors
 *  `useReportSummary`; only mounts behind the Pro gate (the tab is hidden
 *  otherwise), so a rejected backend call surfaces as `error`. */
export function useProfitability(
  range: ReportRange,
  opts: UseProfitabilityOpts = {},
): UseProfitabilityState {
  const enabled = opts.enabled ?? inTauri;
  const fetchFn = opts.fetch ?? billingProfitability;
  const rounding = opts.rounding ?? ROUNDING_OFF;
  const [data, setData] = useState<ProfitabilityReport | null>(null);
  const [loading, setLoading] = useState<boolean>(enabled);
  const [error, setError] = useState<string | null>(null);
  const reqIdRef = useRef(0);

  const load = useCallback(() => {
    if (!enabled) {
      setData(null);
      setLoading(false);
      setError(null);
      return;
    }
    const reqId = ++reqIdRef.current;
    setLoading(true);
    setError(null);
    fetchFn(range, rounding)
      .then((result) => {
        if (reqIdRef.current !== reqId) return;
        setData(result);
        setLoading(false);
      })
      .catch((e: unknown) => {
        if (reqIdRef.current !== reqId) return;
        setError(e instanceof Error ? e.message : String(e));
        setLoading(false);
      });
    // Depend on rounding's primitive fields, not object identity (see
    // useReportSummary).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, fetchFn, range, rounding.intervalMinutes, rounding.mode]);

  useEffect(() => {
    load();
  }, [load]);

  return { data, loading, error, refresh: load };
}
