import { useCallback, useEffect, useState } from "react";
import {
  inTauri,
  upcomingCalendarEvents,
  type ActiveCalendarEvent,
} from "./ipc";

export interface UseUpcomingState {
  events: ActiveCalendarEvent[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

export function useUpcoming(limit = 3): UseUpcomingState {
  const [events, setEvents] = useState<ActiveCalendarEvent[]>([]);
  const [loading, setLoading] = useState(inTauri);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!inTauri) return;
    try {
      setEvents((await upcomingCalendarEvents(limit)) ?? []);
      setError(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [limit]);

  useEffect(() => {
    refresh();
    if (!inTauri) return;
    const id = window.setInterval(refresh, 60_000);
    return () => window.clearInterval(id);
  }, [refresh]);

  return { events, loading, error, refresh };
}
