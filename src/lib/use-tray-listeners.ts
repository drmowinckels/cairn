import { useEffect } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  currentRunning,
  inTauri,
  startEntry,
  stopEntry,
  type BackendEntry,
  type StartEntryInput,
} from "./ipc";

/** Tray menu events emitted by `src-tauri/src/tray.rs`. The strings are
 *  asserted on the Rust side; a rename must change both. */
export const TRAY_START_PROJECT_EVENT = "tray:start-project";
export const TRAY_STOP_EVENT = "tray:stop";

interface TrayActionDeps {
  fetchCurrent: typeof currentRunning;
  startFn: typeof startEntry;
  stopFn: typeof stopEntry;
}

/**
 * Start a timer for `projectId` from the tray's quick-start submenu.
 * Closing any running entry is handled backend-side by `start_entry`
 * (single-running-timer invariant), so this is a thin reuse of the same
 * path the popover UI uses — tray-started entries are identical to
 * UI-started ones. `source: "tray"` tags their origin for reports.
 */
export async function handleTrayStartProject(
  projectId: string,
  deps: Pick<TrayActionDeps, "startFn">,
): Promise<{ kind: "started"; message: string }> {
  const started = await deps.startFn({
    projectId,
    source: "tray",
  } satisfies StartEntryInput);
  return {
    kind: "started",
    message: started.description
      ? `Timer started: ${started.description}`
      : "Timer started",
  };
}

/**
 * Stop whatever is currently running, from the tray's "Stop tracking"
 * item. No-op (with a message) when nothing is tracking — the menu
 * shouldn't offer Stop in that case, but a stale menu could.
 */
export async function handleTrayStop(
  deps: Pick<TrayActionDeps, "fetchCurrent" | "stopFn">,
): Promise<{ kind: "stopped" | "no-op"; message: string }> {
  const running: BackendEntry | null = await deps.fetchCurrent();
  if (!running) {
    return { kind: "no-op", message: "No timer running" };
  }
  await deps.stopFn(running.id);
  return { kind: "stopped", message: "Timer stopped" };
}

interface TrayListenerOpts {
  enabled?: boolean;
  listenFn?: typeof listen;
  fetchCurrent?: typeof currentRunning;
  startFn?: typeof startEntry;
  stopFn?: typeof stopEntry;
  announce?: (message: string) => void;
}

/**
 * Wire the tray menu's start/stop events to the timer. Mirrors
 * `useToggleTimerShortcut`: the Rust menu handler emits to the popover
 * webview, and the dispatch logic lives here so the start/switch path
 * reuses the same IPC the UI uses.
 */
export function useTrayListeners(opts: TrayListenerOpts = {}): void {
  const enabled = opts.enabled ?? inTauri;
  const listenFn = opts.listenFn ?? listen;
  const fetchCurrent = opts.fetchCurrent ?? currentRunning;
  const startFn = opts.startFn ?? startEntry;
  const stopFn = opts.stopFn ?? stopEntry;
  const announce = opts.announce;

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const unlisteners: UnlistenFn[] = [];

    const register = (un: UnlistenFn) => {
      if (cancelled) un();
      else unlisteners.push(un);
    };

    const run = async (fn: () => Promise<{ message: string }>) => {
      try {
        const result = await fn();
        announce?.(result.message);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        announce?.(`Tray action failed: ${msg}`);
      }
    };

    void listenFn(TRAY_START_PROJECT_EVENT, (event) => {
      const projectId = typeof event.payload === "string" ? event.payload : "";
      if (!projectId) return;
      void run(() => handleTrayStartProject(projectId, { startFn }));
    }).then(register);

    void listenFn(TRAY_STOP_EVENT, () => {
      void run(() => handleTrayStop({ fetchCurrent, stopFn }));
    }).then(register);

    return () => {
      cancelled = true;
      for (const un of unlisteners) un();
    };
  }, [enabled, listenFn, fetchCurrent, startFn, stopFn, announce]);
}
