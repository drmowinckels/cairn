import { useCallback, useEffect, useRef, useState } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { inTauri, startEntry } from "./ipc";
import type { Confidence, RuleMatchEvent } from "./types";

/** A suggestion the UI should display in the `.suggest` banner. */
export type Suggestion = RuleMatchEvent;

/** Tauri event name the backend's `signals::fanout` task emits. */
export const SIGNAL_MATCH_EVENT = "signal:match";

/** Default snooze duration for a dismissed suggestion. */
export const DEFAULT_SNOOZE_MS = 5 * 60 * 1000;

export interface UseSuggestionOpts {
  /**
   * How long to suppress further `signal:match` events for a given
   * `ruleId` after a dismiss. See `docs/RULES_ENGINE.md` §6. The
   * default mirrors the spec's 5-minute floor.
   */
  snoozeMs?: number;
  /**
   * Override the IPC start hook. The default reaches into the real
   * `startEntry` IPC; tests inject a spy so they don't need a
   * Tauri runtime.
   */
  startEntry?: typeof startEntry;
  /**
   * Override the Tauri event listener. The default uses
   * `@tauri-apps/api/event::listen`; tests inject a fake that lets
   * them drive the handler directly.
   */
  listen?: typeof listen;
  /**
   * Override the runtime `inTauri` guard. Defaults to the global
   * `inTauri` import — tests bypass it so the hook subscribes
   * without needing `__TAURI_INTERNALS__` to be set.
   */
  enabled?: boolean;
}

export interface UseSuggestionState {
  /** The current Suggestive match the UI should render, or null. */
  suggestion: Suggestion | null;
  /** Confirm: start a timer with the suggested project + rule_id. */
  confirm: () => Promise<void>;
  /** Dismiss + snooze the rule for `snoozeMs`. */
  dismiss: () => void;
}

/**
 * React hook for the suggestion-banner flow. Subscribes to the
 * backend's `signal:match` Tauri event and:
 *
 * - `confidence: "suggestive"` → exposes the payload as `suggestion`
 *   for the banner to render. The user confirms or dismisses; dismiss
 *   snoozes the rule for `snoozeMs`.
 * - `confidence: "strict"` → auto-calls `startEntry` immediately with
 *   `source: "rule"` and the rule's project + id. No banner; the
 *   running timer surfaces in the `now` section instead.
 *
 * Per `docs/RULES_ENGINE.md` §4 + §6.
 *
 * The hook is no-op outside a Tauri runtime (CI vitest, Storybook,
 * preview) so the test fixtures don't need to mock Tauri to render
 * the rest of the Today view.
 */
export function useSuggestion(opts: UseSuggestionOpts = {}): UseSuggestionState {
  const snoozeMs = opts.snoozeMs ?? DEFAULT_SNOOZE_MS;
  const start = opts.startEntry ?? startEntry;
  const listenFn = opts.listen ?? listen;
  const enabled = opts.enabled ?? inTauri;

  const [suggestion, setSuggestion] = useState<Suggestion | null>(null);
  const snoozedUntilRef = useRef(new Map<string, number>());

  useEffect(() => {
    if (!enabled) return;
    let unlisten: UnlistenFn | null = null;
    let cancelled = false;
    void listenFn<RuleMatchEvent>(SIGNAL_MATCH_EVENT, (event) => {
      const payload = event.payload;
      const now = Date.now();
      const snoozedUntil = snoozedUntilRef.current.get(payload.ruleId) ?? 0;
      if (snoozedUntil > now) return;

      if (payload.confidence === "strict") {
        start({
          projectId: payload.project ?? null,
          source: "rule",
          ruleId: payload.ruleId,
        }).catch((e) => {
          console.error("useSuggestion: auto-start (strict) failed", e);
        });
        return;
      }
      // Suggestive: drop the banner content into state for the
      // Today view to render.
      setSuggestion(payload);
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
  }, [enabled, listenFn, start]);

  const confirm = useCallback(async () => {
    setSuggestion((current) => {
      if (current) {
        void start({
          projectId: current.project ?? null,
          source: "rule",
          ruleId: current.ruleId,
        }).catch((e) =>
          console.error("useSuggestion: confirm start_entry failed", e),
        );
      }
      return null;
    });
  }, [start]);

  const dismiss = useCallback(() => {
    setSuggestion((current) => {
      if (current) {
        snoozedUntilRef.current.set(current.ruleId, Date.now() + snoozeMs);
      }
      return null;
    });
  }, [snoozeMs]);

  return { suggestion, confirm, dismiss };
}

/** Exposed for tests that want to assert the constant by name. */
export const __TEST__ = { DEFAULT_SNOOZE_MS };
export type { Confidence };
