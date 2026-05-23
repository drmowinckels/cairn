import { useCallback, useEffect, useState } from "react";
import {
  addCalendarSource,
  inTauri,
  listCalendarSources,
  refreshCalendarSource as refreshCalendarSourceIpc,
  removeCalendarSource,
  updateCalendarSource,
  type AddCalendarInput,
  type CalendarSource,
  type UpdateCalendarInput,
} from "./ipc";

export interface UseCalendars {
  sources: CalendarSource[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  add: (input: AddCalendarInput) => Promise<CalendarSource>;
  update: (input: UpdateCalendarInput) => Promise<CalendarSource>;
  remove: (id: string) => Promise<void>;
  resync: (id: string) => Promise<CalendarSource>;
}

export function useCalendars(): UseCalendars {
  const [sources, setSources] = useState<CalendarSource[]>([]);
  const [loading, setLoading] = useState(inTauri);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!inTauri) return;
    try {
      setSources(await listCalendarSources());
      setError(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  const add = useCallback(
    async (input: AddCalendarInput) => {
      const created = await addCalendarSource(input);
      await refresh();
      return created;
    },
    [refresh],
  );

  const update = useCallback(
    async (input: UpdateCalendarInput) => {
      const updated = await updateCalendarSource(input);
      await refresh();
      return updated;
    },
    [refresh],
  );

  const remove = useCallback(
    async (id: string) => {
      await removeCalendarSource(id);
      await refresh();
    },
    [refresh],
  );

  const resync = useCallback(
    async (id: string) => {
      const next = await refreshCalendarSourceIpc(id);
      await refresh();
      return next;
    },
    [refresh],
  );

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { sources, loading, error, refresh, add, update, remove, resync };
}

/**
 * Heuristic: `webcal://`, `webcals://`, `http://`, `https://` → url
 * source. Anything else (absolute path) → file source.
 */
export function guessCalendarKind(raw: string): "url" | "file" {
  const t = raw.trim().toLowerCase();
  if (
    t.startsWith("webcal://") ||
    t.startsWith("webcals://") ||
    t.startsWith("http://") ||
    t.startsWith("https://")
  ) {
    return "url";
  }
  return "file";
}
