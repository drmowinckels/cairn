import { useCallback, useEffect, useState } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { inTauri, resolveIdle, type IdleChoice } from "./ipc";
import type { IdleResumeEvent } from "./types";

/** Tauri event the backend's `signals::fanout` task emits. */
export const SIGNAL_IDLE_RESUME_EVENT = "signal:idle-resume";

export interface UseIdlePromptOpts {
  /**
   * The currently-running entry's id, if any. The modal is only
   * meaningful while a timer is running — when there's no timer
   * to resolve, idle-resume events are dropped silently.
   */
  runningEntryId?: string | null;
  /**
   * Override the IPC resolve hook for tests.
   */
  resolveIdle?: typeof resolveIdle;
  /**
   * Override the Tauri event listener for tests.
   */
  listen?: typeof listen;
  /**
   * Override the runtime `inTauri` guard. Defaults to the global
   * `inTauri` import; tests bypass it.
   */
  enabled?: boolean;
}

export interface UseIdlePromptState {
  /** The pending idle-resume event, or null if no modal is open. */
  prompt: IdleResumeEvent | null;
  /** Resolve "Keep": idle time counts as work. */
  keep: () => Promise<void>;
  /** Resolve "Discard idle": trim the entry to `since`. */
  discard: () => Promise<void>;
  /** Resolve "Move to break": close, insert a break entry, resume. */
  moveToBreak: () => Promise<void>;
  /** Dismiss without resolving (closes the modal — defaults to Keep). */
  dismiss: () => Promise<void>;
}

/**
 * React hook for the idle ambiguity modal. Subscribes to the
 * backend's `signal:idle-resume` Tauri event and exposes the three
 * resolution paths from `docs/RULES_ENGINE.md` §6 (M1 #7
 * acceptance):
 *
 * - Keep — idle time counts as work; no DB change.
 * - Discard — trim the running entry's `ended_at` to `since`.
 * - Move to break — close the entry at `since`, insert a no-project
 *   `idle-break` entry until `until`, then start a new entry with
 *   the same project/task/description at `until`.
 *
 * If no timer is running when an idle-resume event arrives, the
 * event is dropped — there's nothing to attribute the idle time to.
 */
export function useIdlePrompt(opts: UseIdlePromptOpts = {}): UseIdlePromptState {
  const runningEntryId = opts.runningEntryId ?? null;
  const resolve = opts.resolveIdle ?? resolveIdle;
  const listenFn = opts.listen ?? listen;
  const enabled = opts.enabled ?? inTauri;

  const [prompt, setPrompt] = useState<IdleResumeEvent | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let unlisten: UnlistenFn | null = null;
    let cancelled = false;
    void listenFn<IdleResumeEvent>(SIGNAL_IDLE_RESUME_EVENT, (event) => {
      setPrompt(event.payload);
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
  }, [enabled, listenFn]);

  const resolveChoice = useCallback(
    async (choice: IdleChoice) => {
      if (!prompt) return;
      const current = prompt;
      setPrompt(null);
      if (!runningEntryId) {
        // No timer to attribute the idle time to. The event was
        // emitted (backend doesn't know the running state); drop
        // it on the UI side.
        return;
      }
      try {
        await resolve({
          entryId: runningEntryId,
          since: current.since,
          until: current.until,
          choice,
        });
      } catch (e) {
        console.error("useIdlePrompt: resolve_idle failed", e);
      }
    },
    [prompt, runningEntryId, resolve],
  );

  return {
    prompt,
    keep: useCallback(() => resolveChoice("keep"), [resolveChoice]),
    discard: useCallback(() => resolveChoice("discard"), [resolveChoice]),
    moveToBreak: useCallback(() => resolveChoice("break"), [resolveChoice]),
    dismiss: useCallback(() => resolveChoice("keep"), [resolveChoice]),
  };
}
