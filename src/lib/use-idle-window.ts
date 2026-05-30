import { useCallback, useEffect, useState } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  currentRunning,
  dismissIdle,
  inTauri,
  pendingIdle,
  resolveIdle,
  type IdleChoice,
} from "./ipc";
import type { IdleResumeEvent } from "./types";

/** Same event the fanout emits; the idle window listens for it too. */
export const SIGNAL_IDLE_RESUME_EVENT = "signal:idle-resume";

export interface UseIdleWindowOpts {
  enabled?: boolean;
  listen?: typeof listen;
  pendingIdle?: typeof pendingIdle;
  currentRunning?: typeof currentRunning;
  resolveIdle?: typeof resolveIdle;
  dismissIdle?: typeof dismissIdle;
}

export interface UseIdleWindow {
  /** The pending idle period, or null when nothing to resolve. */
  prompt: IdleResumeEvent | null;
  /** Apply one of the #93 choices to the entry that was running. */
  resolve: (choice: IdleChoice) => Promise<void>;
  /** Close the prompt without changing anything (idle stays as work). */
  dismiss: () => Promise<void>;
}

/**
 * Drives the dedicated idle-prompt window (#93). On mount it fetches
 * `pending_idle` (the cold-start backstop for when the window's webview
 * wasn't listening when the backend emitted the event) and subscribes
 * to live `signal:idle-resume` events for subsequent idles while the
 * window stays loaded. Resolving looks up the entry that's running
 * *now* (the timer keeps running through idle) and applies the choice,
 * then dismisses — which clears backend state and hides the window.
 */
export function useIdleWindow(opts: UseIdleWindowOpts = {}): UseIdleWindow {
  const enabled = opts.enabled ?? inTauri;
  const listenFn = opts.listen ?? listen;
  const fetchPending = opts.pendingIdle ?? pendingIdle;
  const fetchRunning = opts.currentRunning ?? currentRunning;
  const resolveFn = opts.resolveIdle ?? resolveIdle;
  const dismissFn = opts.dismissIdle ?? dismissIdle;

  const [prompt, setPrompt] = useState<IdleResumeEvent | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let unlisten: UnlistenFn | null = null;

    void fetchPending()
      .then((p) => {
        if (!cancelled && p) setPrompt(p);
      })
      .catch((e) => console.error("pending_idle failed", e));

    void listenFn<IdleResumeEvent>(SIGNAL_IDLE_RESUME_EVENT, (event) => {
      setPrompt(event.payload);
    }).then((un) => {
      if (cancelled) un();
      else unlisten = un;
    });

    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, [enabled, listenFn, fetchPending]);

  const dismiss = useCallback(async () => {
    setPrompt(null);
    try {
      await dismissFn();
    } catch (e) {
      console.error("dismiss_idle failed", e);
    }
  }, [dismissFn]);

  const resolve = useCallback(
    async (choice: IdleChoice) => {
      if (!prompt) return;
      const current = prompt;
      setPrompt(null);
      try {
        const running = await fetchRunning();
        if (running) {
          await resolveFn({
            entryId: running.id,
            since: current.since,
            until: current.until,
            choice,
          });
        } else {
          // The timer was stopped during idle — nothing to attribute the
          // away time to. Surface rather than silently swallow the click.
          console.warn(
            "useIdleWindow: no running entry; idle choice dropped",
            { choice, since: current.since, until: current.until },
          );
        }
      } catch (e) {
        console.error("resolve_idle failed", e);
      }
      try {
        await dismissFn();
      } catch (e) {
        console.error("dismiss_idle failed", e);
      }
    },
    [prompt, fetchRunning, resolveFn, dismissFn],
  );

  return { prompt, resolve, dismiss };
}
