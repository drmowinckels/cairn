import { useCallback, useEffect, useState } from "react";
import {
  createEntry,
  deleteEntry,
  inTauri,
  listToday,
  updateEntry,
  type BackendEntry,
  type CreateEntryInput,
  type UpdateEntryInput,
} from "./ipc";

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
  create: (input: CreateEntryInput) => Promise<BackendEntry>;
  update: (input: UpdateEntryInput) => Promise<BackendEntry>;
  remove: (id: string) => Promise<void>;
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
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [enabled, fetcher]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const create = useCallback(
    async (input: CreateEntryInput) => {
      const created = await createEntry(input);
      await refresh();
      return created;
    },
    [refresh],
  );

  const update = useCallback(
    async (input: UpdateEntryInput) => {
      const updated = await updateEntry(input);
      await refresh();
      return updated;
    },
    [refresh],
  );

  const remove = useCallback(
    async (id: string) => {
      await deleteEntry(id);
      await refresh();
    },
    [refresh],
  );

  return { entries, loading, error, refresh, create, update, remove };
}
