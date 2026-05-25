import { useCallback, useEffect, useRef, useState } from "react";
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
}

/// Internal: we capture the running entry's id at the moment the
/// event arrives so the user's choice is applied to the entry that
/// WAS running at idle time, not whatever's running now. Without
/// this snapshot, the user could stop the timer mid-modal and then
/// click Discard — `runningEntryId` would be null, the IPC would
/// be skipped, and the entry would keep whatever ended_at the
/// manual stop set. Silent disagreement with user intent.
interface PendingPrompt extends IdleResumeEvent {
  entryId: string | null;
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

  const [pending, setPending] = useState<PendingPrompt | null>(null);
  // Mirror the latest running id in a ref so the listener captures
  // the freshest value when an event arrives, without re-subscribing.
  const runningEntryIdRef = useRef<string | null>(runningEntryId);
  useEffect(() => {
    runningEntryIdRef.current = runningEntryId;
  }, [runningEntryId]);

  useEffect(() => {
    if (!enabled) return;
    let unlisten: UnlistenFn | null = null;
    let cancelled = false;
    void listenFn<IdleResumeEvent>(SIGNAL_IDLE_RESUME_EVENT, (event) => {
      // Snapshot the running entry id at event-arrival time. The
      // user might stop the timer manually before clicking a
      // button; we still apply their choice to the entry that
      // was running when the idle happened.
      setPending({
        ...event.payload,
        entryId: runningEntryIdRef.current,
      });
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
      if (!pending) return;
      const current = pending;
      setPending(null);
      if (!current.entryId) {
        // No timer was running when the idle event arrived. Log
        // and surface — silently dropping would let the user
        // think their choice took effect.
        console.warn(
          "useIdlePrompt: idle event arrived with no running entry; choice dropped",
          { choice, since: current.since, until: current.until },
        );
        return;
      }
      try {
        await resolve({
          entryId: current.entryId,
          since: current.since,
          until: current.until,
          choice,
        });
      } catch (e) {
        console.error("useIdlePrompt: resolve_idle failed", e);
      }
    },
    [pending, resolve],
  );

  const prompt: IdleResumeEvent | null = pending
    ? {
        since: pending.since,
        until: pending.until,
        durationSeconds: pending.durationSeconds,
      }
    : null;

  return {
    prompt,
    keep: useCallback(() => resolveChoice("keep"), [resolveChoice]),
    discard: useCallback(() => resolveChoice("discard"), [resolveChoice]),
    moveToBreak: useCallback(() => resolveChoice("break"), [resolveChoice]),
  };
}
