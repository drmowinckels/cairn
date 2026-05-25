import { useCallback, useEffect, useRef, useState } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { inTauri, snoozeAll, snoozeRule, startEntry } from "./ipc";
import type { Confidence, RuleMatchEvent } from "./types";

/** A suggestion the UI should display in the `.suggest` banner. */
export type Suggestion = RuleMatchEvent;

/** Tauri event name the backend's `signals::fanout` task emits. */
export const SIGNAL_MATCH_EVENT = "signal:match";

/** Default snooze duration for a dismissed suggestion (5 min). */
export const DEFAULT_SNOOZE_SECONDS = 5 * 60;

/**
 * Options for `useSuggestion`. **Stability matters**: `startEntry`,
 * `listen`, and `currentRunningRuleId` are part of the subscription
 * `useEffect`'s deps. Pass module-level imports or memoised values —
 * inline closures will re-subscribe on every render.
 */
export interface UseSuggestionOpts {
  /**
   * How long to snooze the rule on dismiss (seconds). See
   * `docs/RULES_ENGINE.md` §6. The default mirrors the spec's
   * 5-minute floor. The snooze itself is enforced *backend-side*
   * via `snooze_rule` IPC so it persists across popover hide/show
   * (per M1 #9). Snooze does NOT apply to Strict matches — that
   * path is governed by the `currentRunningRuleId` de-dup below.
   */
  snoozeSeconds?: number;
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
   * Override the IPC snooze hook for tests.
   */
  snoozeRule?: typeof snoozeRule;
  /**
   * Override the IPC snooze-all hook for tests. Used by the
   * overflow menu's "Snooze all for 1h" / "Until tomorrow"
   * options.
   */
  snoozeAll?: typeof snoozeAll;
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
  /** Dismiss + snooze the rule on the backend for `snoozeSeconds`. */
  dismiss: () => Promise<void>;
  /** Snooze every suggestion globally for `seconds`. */
  snoozeEverything: (seconds: number) => Promise<void>;
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
  const snoozeSeconds = Math.max(1, opts.snoozeSeconds ?? DEFAULT_SNOOZE_SECONDS);
  const start = opts.startEntry ?? startEntry;
  const snooze = opts.snoozeRule ?? snoozeRule;
  const snoozeAllFn = opts.snoozeAll ?? snoozeAll;
  const listenFn = opts.listen ?? listen;
  const enabled = opts.enabled ?? inTauri;
  const currentRunningRuleId = opts.currentRunningRuleId ?? null;

  const [suggestion, setSuggestion] = useState<Suggestion | null>(null);
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

      // Suggestive: the *backend* snoozer gates whether we see this
      // event at all (per M1 #9, the matcher in `signals::fanout`
      // skips snoozed rules before emitting `signal:match`). The
      // hook just surfaces whatever the matcher decided to fire.
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

  const dismiss = useCallback(async () => {
    if (!suggestion) return;
    const current = suggestion;
    setSuggestion(null);
    try {
      await snooze(current.ruleId, snoozeSeconds);
    } catch (e) {
      console.error("useSuggestion: snooze_rule failed", e);
    }
  }, [snooze, snoozeSeconds, suggestion]);

  const snoozeEverything = useCallback(
    async (seconds: number) => {
      setSuggestion(null);
      try {
        await snoozeAllFn(Math.max(1, Math.floor(seconds)));
      } catch (e) {
        console.error("useSuggestion: snooze_all failed", e);
      }
    },
    [snoozeAllFn],
  );

  return { suggestion, confirm, dismiss, snoozeEverything };
}

export type { Confidence };
