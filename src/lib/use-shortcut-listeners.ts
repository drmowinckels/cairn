import { useEffect } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  currentRunning,
  inTauri,
  listDay,
  startEntry,
  stopEntry,
  type BackendEntry,
} from "./ipc";
import { isoLocalDate } from "./report-math";

/** Today's entries, newest-relevant first — the shortcut uses this to find
 *  the last project to resume. */
function listTodayEntries(): Promise<BackendEntry[]> {
  return listDay(isoLocalDate(new Date()));
}
import {
  SHORTCUT_TOGGLE_TIMER_EVENT,
  emitToast,
  requestOpenPalette,
} from "./shortcuts";

interface ToggleTimerOpts {
  enabled?: boolean;
  listenFn?: typeof listen;
  fetchCurrent?: typeof currentRunning;
  fetchToday?: typeof listTodayEntries;
  startFn?: typeof startEntry;
  stopFn?: typeof stopEntry;
  announce?: (message: string) => void;
  toast?: (message: string) => void;
}

export async function handleToggleTimer(opts: {
  fetchCurrent: typeof currentRunning;
  fetchToday: typeof listTodayEntries;
  startFn: typeof startEntry;
  stopFn: typeof stopEntry;
}): Promise<{ kind: "started" | "stopped" | "no-project"; message: string }> {
  const running = await opts.fetchCurrent();
  if (running) {
    await opts.stopFn(running.id);
    return { kind: "stopped", message: "Timer stopped" };
  }
  const today = await opts.fetchToday();
  const lastProjectId = today.find((e) => e.projectId)?.projectId ?? null;
  if (!lastProjectId) {
    return {
      kind: "no-project",
      message: "No recent project — open Cairn to start a timer",
    };
  }
  const started = await opts.startFn({
    projectId: lastProjectId,
    source: "shortcut",
  });
  return {
    kind: "started",
    message: started.description
      ? `Timer started: ${started.description}`
      : "Timer started",
  };
}

export function useToggleTimerShortcut(opts: ToggleTimerOpts = {}): void {
  const enabled = opts.enabled ?? inTauri;
  const listenFn = opts.listenFn ?? listen;
  const fetchCurrent = opts.fetchCurrent ?? currentRunning;
  const fetchToday = opts.fetchToday ?? listTodayEntries;
  const startFn = opts.startFn ?? startEntry;
  const stopFn = opts.stopFn ?? stopEntry;
  const announce = opts.announce;
  const toast = opts.toast ?? emitToast;

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let unlisten: UnlistenFn | null = null;
    void listenFn(SHORTCUT_TOGGLE_TIMER_EVENT, () => {
      void (async () => {
        try {
          const result = await handleToggleTimer({
            fetchCurrent,
            fetchToday,
            startFn,
            stopFn,
          });
          announce?.(result.message);
          toast(result.message);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          announce?.(`Timer toggle failed: ${msg}`);
          toast(`Timer toggle failed: ${msg}`);
        }
      })();
    }).then((un) => {
      if (cancelled) un();
      else unlisten = un;
    });
    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, [
    enabled,
    listenFn,
    fetchCurrent,
    fetchToday,
    startFn,
    stopFn,
    announce,
    toast,
  ]);
}

interface PaletteShortcutOpts {
  onOpen?: () => void;
}

export function usePaletteShortcut(opts: PaletteShortcutOpts = {}): void {
  const onOpen = opts.onOpen;
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" || target.tagName === "TEXTAREA")
      ) {
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        if (onOpen) onOpen();
        else requestOpenPalette();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onOpen]);
}
