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

  // Id of the entry currently being stopped. `stop()` clears `running`
  // optimistically for instant feedback, but the snapshot-driven
  // refresh (throttled, runs on a timer) could read `current_running`
  // before the stop commits and resurrect the entry — making the timer
  // reappear and look like Stop "didn't work". Guard against that.
  const stoppingIdRef = useRef<string | null>(null);

  const refresh = useCallback(async () => {
    if (!enabled) {
      setLoading(false);
      return;
    }
    try {
      const entry = await fetchFn();
      if (entry && stoppingIdRef.current === entry.id) {
        // Mid-stop on this exact entry — don't resurrect it.
        return;
      }
      setRunning(entry);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
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

  // The snapshot stream fires every ~500ms; refetching current_running
  // every tick would hammer SQLite with no payoff (the running entry
  // only changes on user/rule action). Throttle to ≥ 2 seconds — enough
  // to keep rule-driven starts visible within 2s, sparse enough to
  // stop the popover acting as a 2 Hz polling client. Replace with a
  // dedicated entry:changed event in a follow-up.
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let unlisten: UnlistenFn | null = null;
    let lastRefresh = 0;
    void listenFn(SIGNAL_SNAPSHOT_EVENT, () => {
      const now = Date.now();
      if (now - lastRefresh < 2_000) return;
      lastRefresh = now;
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
    const id = running.id;
    // Optimistic: clear immediately so the timer + clock stop the instant
    // the user taps Stop, instead of waiting on the IPC round-trip.
    stoppingIdRef.current = id;
    setRunning(null);
    setNow(Date.now());
    try {
      const stopped = await stopFn(id);
      onStoppedRef.current?.(stopped);
      return stopped;
    } catch (e) {
      // Stop failed — restore the true state, then surface the error.
      // refresh() clears `error` on success, so set it *after* the
      // restore or it'd be wiped.
      stoppingIdRef.current = null;
      await refresh();
      setError(e instanceof Error ? e.message : String(e));
      return null;
    } finally {
      stoppingIdRef.current = null;
    }
  }, [running, stopFn, refresh]);

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
