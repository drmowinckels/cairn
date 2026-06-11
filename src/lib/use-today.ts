import { useCallback, useEffect, useState } from "react";
import {
  createEntry,
  deleteEntry,
  inTauri,
  listDay,
  updateEntry,
  type BackendEntry,
  type CreateEntryInput,
  type UpdateEntryInput,
} from "./ipc";
import { isoLocalDate } from "./report-math";

export interface UseTodayOpts {
  /** Override for tests. Defaults to module-level `inTauri`. */
  enabled?: boolean;
  /** Local `YYYY-MM-DD` day to load. Defaults to today, so the popover footer
   *  and a fresh Today view see today; the Today view steps it back to view and
   *  edit a past day. */
  date?: string;
  /** Override for tests. */
  fetcher?: (date: string) => Promise<BackendEntry[]>;
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
  const date = opts.date ?? isoLocalDate(new Date());
  const fetcher = opts.fetcher ?? listDay;
  const [entries, setEntries] = useState<BackendEntry[]>([]);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!enabled) {
      setLoading(false);
      return;
    }
    try {
      const rows = await fetcher(date);
      setEntries(rows);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [enabled, fetcher, date]);

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
