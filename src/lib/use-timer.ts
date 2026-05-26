import { useCallback, useEffect, useRef, useState } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  currentRunning,
  inTauri,
  startEntry,
  stopEntry,
  updateEntry,
  type BackendEntry,
  type StartEntryInput,
  type UpdateEntryInput,
} from "./ipc";
import { SIGNAL_SNAPSHOT_EVENT } from "./use-snapshot";

export interface TimerState {
  running: BackendEntry | null;
  loading: boolean;
  error: string | null;
  /** ms since the running entry's `started_at`, or 0 when nothing is running. */
  elapsedMs: number;
  start: (input: StartEntryInput) => Promise<BackendEntry>;
  stop: () => Promise<BackendEntry | null>;
  refresh: () => Promise<void>;
  update: (input: Omit<UpdateEntryInput, "id">) => Promise<void>;
}

export interface UseTimerOpts {
  /** Override for tests. Defaults to module-level `inTauri`. */
  enabled?: boolean;
  /** Override for tests. */
  listen?: typeof listen;
  /** Override for tests. */
  fetchCurrent?: typeof currentRunning;
  /** Override for tests. */
  startEntry?: typeof startEntry;
  /** Override for tests. */
  stopEntry?: typeof stopEntry;
  /** Override for tests. */
  updateEntry?: typeof updateEntry;
  /** Tick cadence in ms. Default 1000. */
  tickMs?: number;
  /** Called after stop completes successfully — lets consumers refetch
   *  derived data (e.g. the Today timeline list). */
  onStopped?: (entry: BackendEntry) => void;
}

export function useTimer(opts: UseTimerOpts = {}): TimerState {
  const enabled = opts.enabled ?? inTauri;
  const listenFn = opts.listen ?? listen;
  const fetchFn = opts.fetchCurrent ?? currentRunning;
  const startFn = opts.startEntry ?? startEntry;
  const stopFn = opts.stopEntry ?? stopEntry;
  const updateFn = opts.updateEntry ?? updateEntry;
  const tickMs = opts.tickMs ?? 1000;
  const onStopped = opts.onStopped;

  const [running, setRunning] = useState<BackendEntry | null>(null);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState<number>(() => Date.now());

  const refresh = useCallback(async () => {
    if (!enabled) {
      setLoading(false);
      return;
    }
    try {
      const entry = await fetchFn();
      setRunning(entry);
      setError(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [enabled, fetchFn]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const onStoppedRef = useRef(onStopped);
  useEffect(() => {
    onStoppedRef.current = onStopped;
  }, [onStopped]);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let unlisten: UnlistenFn | null = null;
    void listenFn(SIGNAL_SNAPSHOT_EVENT, () => {
      void refresh();
    }).then((un) => {
      if (cancelled) un();
      else unlisten = un;
    });
    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, [enabled, listenFn, refresh]);

  useEffect(() => {
    if (!running) return;
    const id = window.setInterval(() => {
      setNow(Date.now());
    }, tickMs);
    return () => window.clearInterval(id);
  }, [running, tickMs]);

  const elapsedMs = running
    ? Math.max(0, now - new Date(running.startedAt).getTime())
    : 0;

  const start = useCallback(
    async (input: StartEntryInput) => {
      const entry = await startFn(input);
      setRunning(entry);
      setNow(Date.now());
      return entry;
    },
    [startFn],
  );

  const stop = useCallback(async () => {
    if (!running) return null;
    const stopped = await stopFn(running.id);
    setRunning(null);
    onStoppedRef.current?.(stopped);
    return stopped;
  }, [running, stopFn]);

  const update = useCallback(
    async (input: Omit<UpdateEntryInput, "id">) => {
      if (!running) return;
      const next = await updateFn({ ...input, id: running.id });
      setRunning(next);
    },
    [running, updateFn],
  );

  return { running, loading, error, elapsedMs, start, stop, refresh, update };
}
