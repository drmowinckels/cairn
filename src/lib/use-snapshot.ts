import { useEffect, useState } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { inTauri, currentSnapshot, type SignalSnapshot } from "./ipc";
import type { LiveSignal, SignalKind } from "./types";

/** Tauri event the backend's `signals::fanout` task emits. */
export const SIGNAL_SNAPSHOT_EVENT = "signal:snapshot";

export interface UseSnapshotOpts {
  /** Override for tests. */
  listen?: typeof listen;
  /** Override for tests. */
  fetchCurrent?: typeof currentSnapshot;
  /** Bypass the inTauri guard (tests). */
  enabled?: boolean;
}

/**
 * Subscribe to the backend's `signal:snapshot` event and expose the
 * latest snapshot. On mount, also fetches `current_snapshot()` so the
 * UI doesn't have to wait for the next collector tick (~500ms under
 * the default debounce) before showing anything.
 *
 * Returns `null` until a snapshot is available; consumers that need
 * "have we received anything yet" should distinguish `null` (still
 * loading / no snapshot) from a populated snapshot whose individual
 * fields may also be `null` (signal not observed).
 */
export function useSnapshot(opts: UseSnapshotOpts = {}): SignalSnapshot | null {
  const enabled = opts.enabled ?? inTauri;
  const listenFn = opts.listen ?? listen;
  const fetchFn = opts.fetchCurrent ?? currentSnapshot;
  const [snapshot, setSnapshot] = useState<SignalSnapshot | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let unlisten: UnlistenFn | null = null;

    // Seed with the current snapshot from the backend so the card
    // doesn't render its "no signals yet" empty state for ~500ms
    // every time the user opens Rules — most of the time the
    // collectors already have a stable read.
    void fetchFn().then((s) => {
      if (!cancelled && s) setSnapshot(s);
    });

    void listenFn<SignalSnapshot>(SIGNAL_SNAPSHOT_EVENT, (event) => {
      setSnapshot(event.payload);
    }).then((un) => {
      if (cancelled) {
        un();
      } else {
        unlisten = un;
      }
    });

    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, [enabled, listenFn, fetchFn]);

  return snapshot;
}

/**
 * Project the four user-facing signals out of a `SignalSnapshot`
 * into `LiveSignal` rows for display. Returns an empty array if
 * no signal is populated — the card uses this to decide between
 * the row list and the "No signals yet" empty state.
 *
 * Order matches the design spec's signal-list layout: IDE folder,
 * git branch, window title, browser domain.
 */
export function snapshotToLiveSignals(
  snapshot: SignalSnapshot | null,
): LiveSignal[] {
  if (!snapshot) return [];
  const app = snapshot.appName ?? "";
  const rows: LiveSignal[] = [];
  const push = (signal: SignalKind, value: string | null) => {
    if (value && value.trim()) rows.push({ signal, value, app });
  };
  push("ide.folder", snapshot.ideFolder);
  push("git.branch", snapshot.gitBranch);
  push("window.title", snapshot.windowTitle);
  push("browser.domain", snapshot.browserDomain);
  return rows;
}

/**
 * In Tauri, surface the live snapshot; outside Tauri (Vite dev
 * preview / vitest with no IPC mock) fall back to the static demo
 * fixture so the design remains explorable without a backend. The
 * `isTauri` flag is passed in (not read from the module-level
 * `inTauri` const) so this is unit-testable in both modes.
 */
export function selectLiveSignals(
  snapshot: SignalSnapshot | null,
  fixture: LiveSignal[],
  isTauri: boolean,
): LiveSignal[] {
  return isTauri ? snapshotToLiveSignals(snapshot) : fixture;
}
