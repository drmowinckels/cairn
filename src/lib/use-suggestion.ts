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

/**
 * Options for `useSuggestion`. **Stability matters**: `startEntry`,
 * `listen`, and `currentRunningRuleId` are part of the subscription
 * `useEffect`'s deps. Pass module-level imports or memoised values —
 * inline closures will re-subscribe on every render.
 */
export interface UseSuggestionOpts {
  /**
   * How long to suppress further `signal:match` events for a given
   * `ruleId` after a *Suggestive* dismiss. See `docs/RULES_ENGINE.md`
   * §6. The default mirrors the spec's 5-minute floor. Snooze does
   * NOT apply to Strict matches — that path is governed by the
   * `currentRunningRuleId` de-dup below.
   */
  snoozeMs?: number;
  /**
   * The `rule_id` of the currently-running timer, if any. The Strict
   * auto-start path skips the IPC when the firing rule's id already
   * matches this — without it, a Strict rule that keeps matching
   * would call `start_entry` on every snapshot publish (~2 Hz),
   * which the backend implements as "close current + open new",
   * churning the entries table with zero-second ghost entries.
   */
  currentRunningRuleId?: string | null;
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
 *   running timer surfaces in the `now` section instead. De-duped
 *   against `currentRunningRuleId` so a Strict rule that keeps
 *   matching doesn't churn the timer.
 *
 * Per `docs/RULES_ENGINE.md` §4 + §6.
 *
 * The hook is no-op outside a Tauri runtime (CI vitest, Storybook,
 * preview) so the test fixtures don't need to mock Tauri to render
 * the rest of the Today view.
 */
export function useSuggestion(opts: UseSuggestionOpts = {}): UseSuggestionState {
  const snoozeMs = Math.max(0, opts.snoozeMs ?? DEFAULT_SNOOZE_MS);
  const start = opts.startEntry ?? startEntry;
  const listenFn = opts.listen ?? listen;
  const enabled = opts.enabled ?? inTauri;
  const currentRunningRuleId = opts.currentRunningRuleId ?? null;

  const [suggestion, setSuggestion] = useState<Suggestion | null>(null);
  const snoozedUntilRef = useRef(new Map<string, number>());
  // Mirror the currently-running ruleId in a ref so the listener
  // sees the latest value without re-subscribing. The Strict
  // auto-start de-dup compares the incoming match's ruleId against
  // this; without the ref, the listener would close over the value
  // at subscribe-time and never refresh.
  const currentRunningRuleIdRef = useRef<string | null>(currentRunningRuleId);
  useEffect(() => {
    currentRunningRuleIdRef.current = currentRunningRuleId;
  }, [currentRunningRuleId]);

  useEffect(() => {
    if (!enabled) return;
    let unlisten: UnlistenFn | null = null;
    let cancelled = false;
    void listenFn<RuleMatchEvent>(SIGNAL_MATCH_EVENT, (event) => {
      const payload = event.payload;

      if (payload.confidence === "strict") {
        // Skip if the same rule already drove the running timer —
        // otherwise every snapshot publish would re-start it,
        // churning zero-second entries through the DB.
        if (currentRunningRuleIdRef.current === payload.ruleId) return;
        start({
          projectId: payload.project ?? null,
          source: "rule",
          ruleId: payload.ruleId,
        }).catch((e) => {
          console.error("useSuggestion: auto-start (strict) failed", e);
        });
        return;
      }

      // Suggestive: snooze gate applies only here, per RULES_ENGINE.md §6.
      const now = Date.now();
      const snoozedUntil = snoozedUntilRef.current.get(payload.ruleId) ?? 0;
      if (snoozedUntil > now) return;
      // Sweep this entry if it had expired — keeps the map from
      // accreting stale entries over long-running sessions.
      if (snoozedUntil > 0) snoozedUntilRef.current.delete(payload.ruleId);

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
    if (!suggestion) return;
    const current = suggestion;
    setSuggestion(null);
    try {
      await start({
        projectId: current.project ?? null,
        source: "rule",
        ruleId: current.ruleId,
      });
    } catch (e) {
      console.error("useSuggestion: confirm start_entry failed", e);
    }
  }, [start, suggestion]);

  const dismiss = useCallback(() => {
    if (!suggestion) return;
    snoozedUntilRef.current.set(suggestion.ruleId, Date.now() + snoozeMs);
    setSuggestion(null);
  }, [snoozeMs, suggestion]);

  return { suggestion, confirm, dismiss };
}

export type { Confidence };
