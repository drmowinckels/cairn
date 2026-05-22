import { useCallback, useEffect, useState } from "react";
import {
  currentRunning,
  inTauri,
  startEntry,
  stopEntry,
  type BackendEntry,
  type StartEntryInput,
} from "./ipc";

export interface TimerState {
  running: BackendEntry | null;
  loading: boolean;
  error: string | null;
  start: (input: StartEntryInput) => Promise<void>;
  stop: () => Promise<void>;
  refresh: () => Promise<void>;
}

export function useTimer(): TimerState {
  const [running, setRunning] = useState<BackendEntry | null>(null);
  const [loading, setLoading] = useState(inTauri);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!inTauri) return;
    try {
      const entry = await currentRunning();
      setRunning(entry);
      setError(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const start = useCallback(
    async (input: StartEntryInput) => {
      const entry = await startEntry(input);
      setRunning(entry);
    },
    [],
  );

  const stop = useCallback(async () => {
    if (!running) return;
    await stopEntry(running.id);
    setRunning(null);
  }, [running]);

  return { running, loading, error, start, stop, refresh };
}
