import { useEffect, useRef } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { inTauri, showSuggestionNotification } from "./ipc";
import type { RuleMatchEvent } from "./types";
import { coerceAmbiguity } from "./use-rules";
import { SIGNAL_MATCH_EVENT } from "./use-suggestion";

export interface UseSuggestionNotifierOpts {
  /** Whether the "Detection prompts" setting is `"notification"`. Read via
   *  a ref internally so toggling the setting doesn't force a
   *  re-subscription of the underlying event listener. */
  enabled: boolean;
  /** Override the Tauri event listener. Tests inject a fake so they can
   *  drive the handler without a Tauri runtime. */
  listen?: typeof listen;
  /** Override the IPC show hook for tests. */
  showSuggestionNotification?: typeof showSuggestionNotification;
  /** Override the runtime `inTauri` guard for tests. */
  runtimeEnabled?: boolean;
}

/**
 * Routes Suggestive/`Prompt` rule matches to the dedicated notification
 * overlay window (#267) when "Detection prompts" is set to `"notification"`.
 *
 * Mounted once at the popover-shell level (not inside `TodayView`) so it
 * keeps listening regardless of which tab is active or whether the popover
 * window is hidden — the popover webview stays alive in the background
 * (it's hidden, not destroyed, on close), so this subscription is exactly
 * as persistent as the always-loaded idle/about windows. That's what fixes
 * the "suggestion silently lost while on Rules/Settings" bug described in
 * #267: the listener no longer depends on `TodayView` being mounted.
 *
 * Deliberately does NOT handle:
 * - `confidence: "strict"` matches (auto-start) — that stays solely in
 *   `useSuggestion` (used by `TodayView`) to avoid a double `start_entry`
 *   call if both hooks ever ran for the same event. This means strict
 *   auto-start still only fires while Today is mounted — a pre-existing
 *   gap this change does not close; only the *Suggestive* "prompt" banner
 *   presentation moves to the always-available window.
 * - `ambiguityBehavior: "log-to-uncategorized"` — same reasoning; left to
 *   `useSuggestion`'s existing auto-start path.
 *
 * Only acts on `confidence: "suggestive"` + `ambiguityBehavior: "prompt"`
 * matches, and only when `enabled`. Re-showing an already-visible window is
 * safe and cheap — the backend (`show_suggestion_notification_impl`)
 * de-dupes so a repeatedly-matching rule doesn't flicker the window.
 */
export function useSuggestionNotifier(opts: UseSuggestionNotifierOpts): void {
  const listenFn = opts.listen ?? listen;
  const show = opts.showSuggestionNotification ?? showSuggestionNotification;
  const runtimeEnabled = opts.runtimeEnabled ?? inTauri;

  const enabledRef = useRef(opts.enabled);
  useEffect(() => {
    enabledRef.current = opts.enabled;
  }, [opts.enabled]);

  useEffect(() => {
    if (!runtimeEnabled) return;
    let unlisten: UnlistenFn | null = null;
    let cancelled = false;

    void listenFn<RuleMatchEvent>(SIGNAL_MATCH_EVENT, (event) => {
      if (!enabledRef.current) return;
      const payload = event.payload;
      if (payload.confidence !== "suggestive") return;
      if (coerceAmbiguity(payload.ambiguityBehavior) !== "prompt") return;
      show(payload).catch((e) => {
        console.error(
          "useSuggestionNotifier: show_suggestion_notification failed",
          e,
        );
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
  }, [runtimeEnabled, listenFn, show]);
}
