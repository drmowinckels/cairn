import { useCallback, useEffect, useRef, useState } from "react";
import {
  inTauri,
  reportSummary,
  type ReportRange,
  type ReportSummary,
} from "./ipc";
import { fixtureReportSummary } from "./report-fixture";

export interface UseReportSummaryState {
  data: ReportSummary | null;
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

export interface UseReportSummaryOpts {
  /** Override for tests / Storybook. */
  fetch?: typeof reportSummary;
  /** Bypass the inTauri guard so the hook can be exercised in vitest
   *  without faking `__TAURI_INTERNALS__`. */
  enabled?: boolean;
}

export function useReportSummary(
  range: ReportRange,
  opts: UseReportSummaryOpts = {},
): UseReportSummaryState {
  const enabled = opts.enabled ?? inTauri;
  const fetchFn = opts.fetch ?? reportSummary;
  const [data, setData] = useState<ReportSummary | null>(
    enabled ? null : fixtureReportSummary(range),
  );
  const [loading, setLoading] = useState<boolean>(enabled);
  const [error, setError] = useState<string | null>(null);
  const reqIdRef = useRef(0);

  const load = useCallback(() => {
    if (!enabled) {
      setData(fixtureReportSummary(range));
      setLoading(false);
      setError(null);
      return;
    }
    const reqId = ++reqIdRef.current;
    setLoading(true);
    setError(null);
    fetchFn(range)
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
  }, [enabled, fetchFn, range]);

  useEffect(() => {
    load();
  }, [load]);

  return { data, loading, error, refresh: load };
}
