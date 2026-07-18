import { useCallback, useEffect, useMemo, useState } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  dismissSuggestionNotification,
  inTauri,
  listProjects,
  notificationWindowPainted,
  pendingNotification,
  snoozeRule,
  startEntry,
} from "./ipc";
import type { Project, RuleMatchEvent } from "./types";
import { DEFAULT_SNOOZE_SECONDS, SIGNAL_MATCH_EVENT } from "./use-suggestion";

export interface UseNotificationWindowOpts {
  enabled?: boolean;
  listen?: typeof listen;
  pendingNotification?: typeof pendingNotification;
  listProjects?: typeof listProjects;
  startEntry?: typeof startEntry;
  snoozeRule?: typeof snoozeRule;
  dismissSuggestionNotification?: typeof dismissSuggestionNotification;
  notificationWindowPainted?: typeof notificationWindowPainted;
  /** How long to snooze the rule when the notification is dismissed
   *  (seconds). Mirrors `useSuggestion`'s default. */
  snoozeSeconds?: number;
}

export interface UseNotificationWindow {
  /** The suggestion to render, or null when nothing is pending. */
  suggestion: RuleMatchEvent | null;
  /** Live project lookup so the notification can resolve the matched
   *  project's name/color for its chip. */
  projectsById: Record<string, Project>;
  /** Confirm: start a timer with the suggested project + rule id, then
   *  dismiss the window. */
  confirm: () => Promise<void>;
  /** Dismiss: snooze the rule (same duration the inline banner uses) and
   *  hide the window. */
  dismiss: () => Promise<void>;
}

/**
 * Drives the dedicated suggestion-notification window (#267). On mount it
 * fetches `pending_notification` (the cold-start backstop for when the
 * window's webview wasn't listening when the backend showed it) and
 * subscribes to live `signal:match` events for subsequent notifications
 * while the window stays loaded — mirroring `useIdleWindow`.
 *
 * Runs entirely independently of the popover's `useSuggestion` /
 * `useSuggestionNotifier` — a separate Tauri window is a separate webview
 * with its own JS heap, so it owns its own confirm/dismiss IPC calls
 * rather than reusing any in-memory state from the popover.
 */
export function useNotificationWindow(
  opts: UseNotificationWindowOpts = {},
): UseNotificationWindow {
  const enabled = opts.enabled ?? inTauri;
  const listenFn = opts.listen ?? listen;
  const fetchPending = opts.pendingNotification ?? pendingNotification;
  const fetchProjects = opts.listProjects ?? listProjects;
  const start = opts.startEntry ?? startEntry;
  const snooze = opts.snoozeRule ?? snoozeRule;
  const dismissFn =
    opts.dismissSuggestionNotification ?? dismissSuggestionNotification;
  const notifyPainted =
    opts.notificationWindowPainted ?? notificationWindowPainted;
  const snoozeSeconds = Math.max(
    1,
    opts.snoozeSeconds ?? DEFAULT_SNOOZE_SECONDS,
  );

  const [suggestion, setSuggestion] = useState<RuleMatchEvent | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let unlisten: UnlistenFn | null = null;

    void fetchPending()
      .then((p) => {
        if (!cancelled && p) setSuggestion(p);
      })
      .catch((e) => console.error("pending_notification failed", e));

    void listenFn<RuleMatchEvent>(SIGNAL_MATCH_EVENT, (event) => {
      setSuggestion(event.payload);
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
  }, [enabled, listenFn, fetchPending]);

  // Resolve the project list whenever a suggestion arrives, so the chip
  // can show the project's real name/color.
  useEffect(() => {
    if (!enabled || !suggestion) return;
    let cancelled = false;
    void fetchProjects()
      .then((list) => {
        if (!cancelled) setProjects(list);
      })
      .catch((e) => console.error("notification: list_projects failed", e));
    return () => {
      cancelled = true;
    };
  }, [enabled, suggestion, fetchProjects]);

  // Once a suggestion is on screen, confirm to the backend that the
  // window's webview actually painted (#267, mirrors #261's idle-window
  // ack). Until this ack lands the window is shown click-through with a
  // watchdog poised to hide it, so a webview that never renders can't
  // become an invisible input trap.
  useEffect(() => {
    if (!enabled || !suggestion) return;
    const raf = requestAnimationFrame(() => {
      void notifyPainted().catch((e) =>
        console.error("notification_window_painted failed", e),
      );
    });
    return () => cancelAnimationFrame(raf);
  }, [enabled, suggestion, notifyPainted]);

  const projectsById = useMemo(
    () => Object.fromEntries(projects.map((p) => [p.id, p])),
    [projects],
  );

  const dismiss = useCallback(async () => {
    const current = suggestion;
    setSuggestion(null);
    if (current) {
      try {
        await snooze(current.ruleId, snoozeSeconds);
      } catch (e) {
        console.error("useNotificationWindow: snooze_rule failed", e);
      }
    }
    try {
      await dismissFn();
    } catch (e) {
      console.error("dismiss_suggestion_notification failed", e);
    }
  }, [suggestion, snooze, snoozeSeconds, dismissFn]);

  const confirm = useCallback(async () => {
    if (!suggestion) return;
    const current = suggestion;
    setSuggestion(null);
    try {
      await start({
        projectId: current.project ?? null,
        source: "rule",
        ruleId: current.ruleId,
        description: current.description || undefined,
      });
    } catch (e) {
      console.error("useNotificationWindow: confirm start_entry failed", e);
    }
    try {
      await dismissFn();
    } catch (e) {
      console.error("dismiss_suggestion_notification failed", e);
    }
  }, [suggestion, start, dismissFn]);

  return { suggestion, projectsById, confirm, dismiss };
}
