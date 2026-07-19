import { useCallback, useEffect, useRef, useState } from "react";
import { countUncategorizedActivity, inTauri } from "./ipc";
import { isoLocalDate } from "./report-math";
import {
  decidePrompt,
  inWindow,
  minuteOfDay,
  normalize,
  type PromptSchedule,
} from "./prompt-scheduler";
import type { WorkingHours } from "./use-working-hours";

/** How often the reminder re-evaluates whether to prompt. */
export const WORKDAY_REVIEW_POLL_MS = 60_000;

/** Don't re-show more than once an hour — a dismiss isn't "done for the
 *  day", since more activity can accumulate; it just quiets the banner for
 *  a while. */
export const WORKDAY_REVIEW_THROTTLE_MINUTES = 60;

export interface UseWorkdayReviewOpts {
  /** The user's "Workday in Review" toggle (from `useWorkdayReviewPrefs`). */
  enabled: boolean;
  /** Only ever offered while the activity log itself is on — there's
   *  nothing to review otherwise. */
  activityLogEnabled: boolean;
  /** Anchor: the banner's window is [workingHours.endMinute, midnight) —
   *  reuses the existing "end of working hours" setting instead of a
   *  separate time picker. */
  workingHours: WorkingHours;
  /** Override the inTauri guard / inject polling cadence (tests). */
  pollEnabled?: boolean;
  pollMs?: number;
  /** Injected for tests. */
  now?: () => number;
  fetchUncategorizedCount?: typeof countUncategorizedActivity;
}

export interface UseWorkdayReview {
  /** True when the banner should be shown. */
  active: boolean;
  /** Dismiss without reviewing. Arms the throttle. */
  dismiss: () => void;
  /** The user tapped through to the Activity view. Arms the throttle. */
  acknowledge: () => void;
}

/**
 * Drives the "Workday in Review" banner: polls the count of uncategorized
 * activity-log spans for today, then asks the pure {@link decidePrompt}
 * scheduler (shared with the #99 working-hours reminder) whether to surface
 * it — gated by the end-of-workday window and the throttle.
 *
 * The banner only ever *offers* a review; it never assigns or discards
 * anything on its own.
 */
export function useWorkdayReview(opts: UseWorkdayReviewOpts): UseWorkdayReview {
  const { workingHours, activityLogEnabled } = opts;
  const pollEnabled = opts.pollEnabled ?? inTauri;
  const pollMs = opts.pollMs ?? WORKDAY_REVIEW_POLL_MS;
  const now = opts.now ?? Date.now;
  const fetchCount = opts.fetchUncategorizedCount ?? countUncategorizedActivity;

  const [active, setActive] = useState(false);
  const lastPromptRef = useRef<number | null>(null);

  const schedule: PromptSchedule = {
    enabled: opts.enabled && activityLogEnabled,
    startMinute: workingHours.endMinute,
    endMinute: 24 * 60,
    throttleMinutes: WORKDAY_REVIEW_THROTTLE_MINUTES,
  };
  const scheduleRef = useRef<PromptSchedule>(schedule);
  scheduleRef.current = schedule;

  const evaluate = useCallback(async () => {
    const schedule = scheduleRef.current;
    const nowMs = now();
    const nowDate = new Date(nowMs);
    const minute = minuteOfDay(nowDate);
    // Cheap in-memory checks first: skip the backend fetch entirely outside
    // the trigger window (most polls, most of the day) or while disabled.
    if (!schedule.enabled || !inWindow(normalize(schedule), minute)) {
      setActive(false);
      return;
    }
    let uncategorized = 0;
    try {
      uncategorized = await fetchCount(isoLocalDate(nowDate));
    } catch {
      return;
    }
    const decision = decidePrompt(schedule, {
      minuteOfDay: minute,
      nowMs,
      lastPromptMs: lastPromptRef.current,
      triggered: uncategorized > 0,
    });
    setActive(decision === "prompt");
  }, [fetchCount, now]);

  useEffect(() => {
    if (!pollEnabled) return;
    void evaluate();
    const id = window.setInterval(() => void evaluate(), pollMs);
    return () => window.clearInterval(id);
  }, [pollEnabled, pollMs, evaluate]);

  const arm = useCallback(() => {
    lastPromptRef.current = now();
    setActive(false);
  }, [now]);

  return { active, dismiss: arm, acknowledge: arm };
}
