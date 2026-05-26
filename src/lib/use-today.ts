import { useCallback, useEffect, useState } from "react";
import { inTauri, listToday, type BackendEntry } from "./ipc";

export interface UseTodayOpts {
  /** Override for tests. Defaults to module-level `inTauri`. */
  enabled?: boolean;
  /** Override for tests. */
  fetcher?: typeof listToday;
}

export interface UseTodayState {
  entries: BackendEntry[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

export function useToday(opts: UseTodayOpts = {}): UseTodayState {
  const enabled = opts.enabled ?? inTauri;
  const fetcher = opts.fetcher ?? listToday;
  const [entries, setEntries] = useState<BackendEntry[]>([]);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!enabled) {
      setLoading(false);
      return;
    }
    try {
      const rows = await fetcher();
      setEntries(rows);
      setError(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [enabled, fetcher]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { entries, loading, error, refresh };
}
