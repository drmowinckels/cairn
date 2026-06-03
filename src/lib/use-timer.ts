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

/** Backend pushes this the instant the running entry changes (start/stop),
 *  so the timer — and the tray title/menu that read it — refresh at once
 *  instead of waiting for the throttled snapshot tick. Mirror of
 *  `ENTRY_CHANGED_EVENT` in src-tauri/src/ipc.rs. */
export const ENTRY_CHANGED_EVENT = "entry:changed";

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

  // `running` mirror for stable callbacks. `stop`/`update` must NOT close
  // over `running` directly: the snapshot refresh hands `setRunning` a
  // fresh object every ~2s (React only bails on `Object.is`), so closing
  // over `running` would give those callbacks a new identity every 2s and
  // churn every memo that depends on them (e.g. the palette context).
  // Set imperatively alongside every `setRunning` — an effect-synced ref
  // would lag a render, so a stop fired in the same tick as a state change
  // could act on a stale entry.
  const runningRef = useRef<BackendEntry | null>(null);
  const setRunningTracked = useCallback((entry: BackendEntry | null) => {
    runningRef.current = entry;
    setRunning(entry);
  }, []);

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
      setRunningTracked(entry);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [enabled, fetchFn, setRunningTracked]);

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
    const unlisteners: UnlistenFn[] = [];
    const arm = (un: UnlistenFn) => {
      if (cancelled) un();
      else unlisteners.push(un);
    };
    let lastRefresh = 0;
    // Snapshot stream fires ~2 Hz; throttle the running-entry refetch.
    void listenFn(SIGNAL_SNAPSHOT_EVENT, () => {
      const now = Date.now();
      if (now - lastRefresh < 2_000) return;
      lastRefresh = now;
      void refresh();
    }).then(arm);
    // A start/stop pushes this immediately — refresh without the throttle
    // so the tray title/menu reflect the change at once, not up to 2s late.
    void listenFn(ENTRY_CHANGED_EVENT, () => {
      lastRefresh = Date.now();
      void refresh();
    }).then(arm);
    return () => {
      cancelled = true;
      for (const un of unlisteners) un();
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
      setRunningTracked(entry);
      setNow(Date.now());
      return entry;
    },
    [startFn, setRunningTracked],
  );

  const stop = useCallback(async () => {
    const current = runningRef.current;
    if (!current) return null;
    const id = current.id;
    // Optimistic: clear immediately so the timer + clock stop the instant
    // the user taps Stop, instead of waiting on the IPC round-trip.
    stoppingIdRef.current = id;
    setRunningTracked(null);
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
  }, [stopFn, refresh, setRunningTracked]);

  const update = useCallback(
    async (input: Omit<UpdateEntryInput, "id">) => {
      const current = runningRef.current;
      if (!current) return;
      const next = await updateFn({ ...input, id: current.id });
      setRunningTracked(next);
    },
    [updateFn, setRunningTracked],
  );

  return { running, loading, error, elapsedMs, start, stop, refresh, update };
}
