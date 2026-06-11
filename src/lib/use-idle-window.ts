import { useCallback, useEffect, useState } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  currentRunning,
  dismissIdle,
  inTauri,
  listProjects,
  pendingIdle,
  resolveIdle,
  type BackendEntry,
  type IdleChoice,
} from "./ipc";
import type { IdleResumeEvent, Project } from "./types";

/** Same event the fanout emits; the idle window listens for it too. */
export const SIGNAL_IDLE_RESUME_EVENT = "signal:idle-resume";

/** What the timer was on while the user was away — shown in the prompt so
 *  the choice ("keep / discard") has context. */
export interface IdleTracking {
  /** The running entry's project name, or `null` when it has no project. */
  projectName: string | null;
  /** The running entry's description (may be empty). */
  description: string;
}

/** Resolve the running entry's project name for display in the prompt. */
export function trackingOf(
  running: BackendEntry,
  projects: Project[],
): IdleTracking {
  const projectName = running.projectId
    ? (projects.find((p) => p.id === running.projectId)?.name ?? null)
    : null;
  return { projectName, description: running.description };
}

export interface UseIdleWindowOpts {
  enabled?: boolean;
  listen?: typeof listen;
  pendingIdle?: typeof pendingIdle;
  currentRunning?: typeof currentRunning;
  listProjects?: typeof listProjects;
  resolveIdle?: typeof resolveIdle;
  dismissIdle?: typeof dismissIdle;
}

export interface UseIdleWindow {
  /** The pending idle period, or null when nothing to resolve. */
  prompt: IdleResumeEvent | null;
  /** What the timer is tracking, or null while unknown / nothing running. */
  tracking: IdleTracking | null;
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
  const fetchProjects = opts.listProjects ?? listProjects;
  const resolveFn = opts.resolveIdle ?? resolveIdle;
  const dismissFn = opts.dismissIdle ?? dismissIdle;

  const [prompt, setPrompt] = useState<IdleResumeEvent | null>(null);
  const [tracking, setTracking] = useState<IdleTracking | null>(null);

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

  // Look up what the timer is on whenever a prompt arrives, so the choices
  // are anchored to a project the user recognizes.
  useEffect(() => {
    if (!enabled || !prompt) {
      setTracking(null);
      return;
    }
    let cancelled = false;
    void Promise.all([fetchRunning(), fetchProjects()])
      .then(([running, projects]) => {
        if (cancelled) return;
        setTracking(running ? trackingOf(running, projects) : null);
      })
      .catch((e) => console.error("idle tracking lookup failed", e));
    return () => {
      cancelled = true;
    };
  }, [enabled, prompt, fetchRunning, fetchProjects]);

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
          console.warn("useIdleWindow: no running entry; idle choice dropped", {
            choice,
            since: current.since,
            until: current.until,
          });
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

  return { prompt, tracking, resolve, dismiss };
}
