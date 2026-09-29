import { useCallback, useEffect, useRef, useState } from "react";
import {
  budgetStatus as budgetStatusIpc,
  inTauri,
  type BudgetStatus,
} from "./ipc";

/** How often to re-check. A budget moves at most one minute per minute, so
 *  anything faster is wasted work; anything much slower and a cap you're
 *  actively burning is reported late. */
export const BUDGET_POLL_MS = 60_000;

export interface UseBudgetAlertsOpts {
  /** Off outside Tauri, where there's no backend to ask. */
  enabled?: boolean;
  pollMs?: number;
  /** Injected for tests. */
  fetchStatus?: () => Promise<BudgetStatus[]>;
}

export interface UseBudgetAlerts {
  /** The budget worth telling the user about, or `null` when none is.
   *  At most one: several caps breaching at once is one situation, not
   *  three notifications. */
  alert: BudgetStatus | null;
  /** Everything, for the settings/report display. */
  statuses: BudgetStatus[];
  /** Acknowledge the current alert. It won't return unless the budget gets
   *  worse (approaching → over) or a new period starts. */
  dismiss: () => void;
  refresh: () => Promise<void>;
}

/** A stable identity for "this budget, at this severity, in this period".
 *  Dismissing is keyed on it, so the same cap can speak again when it
 *  crosses from approaching to over, or when the period rolls over — but
 *  not every poll in between. */
export function alertKey(status: BudgetStatus): string {
  return `${status.budget.id}:${status.periodStart}:${status.state}`;
}

const SEVERITY: Record<string, number> = { under: 0, approaching: 1, over: 2 };

/**
 * Pick the one budget worth surfacing: the most severe, and among equals the
 * most specific scope — a project cap names something actionable, where the
 * workspace cap just says "you've worked a lot".
 *
 * Returns `null` when nothing is at or past its threshold.
 */
export function pickAlert(statuses: BudgetStatus[]): BudgetStatus | null {
  const firing = statuses.filter((s) => s.state !== "under");
  if (firing.length === 0) return null;
  const scopeRank: Record<string, number> = {
    project: 2,
    client: 1,
    workspace: 0,
  };
  return firing.reduce((best, s) => {
    const bySeverity = (SEVERITY[s.state] ?? 0) - (SEVERITY[best.state] ?? 0);
    if (bySeverity !== 0) return bySeverity > 0 ? s : best;
    const byScope =
      (scopeRank[s.budget.scopeType] ?? 0) -
      (scopeRank[best.budget.scopeType] ?? 0);
    if (byScope !== 0) return byScope > 0 ? s : best;
    // Same severity and scope: the one further past its cap.
    return s.percent > best.percent ? s : best;
  });
}

/**
 * Poll work-hour budgets and surface the one worth acting on (#307).
 *
 * Only ever *reports* — it never stops a timer or blocks anything. A budget
 * is a warning about how much you've worked, and Cairn deciding to stop
 * tracking on your behalf would lose real data.
 */
export function useBudgetAlerts(
  opts: UseBudgetAlertsOpts = {},
): UseBudgetAlerts {
  const enabled = opts.enabled ?? inTauri;
  const pollMs = opts.pollMs ?? BUDGET_POLL_MS;
  const fetchStatus = opts.fetchStatus ?? budgetStatusIpc;

  const [statuses, setStatuses] = useState<BudgetStatus[]>([]);
  const [alert, setAlert] = useState<BudgetStatus | null>(null);
  const dismissedRef = useRef<Set<string>>(new Set());

  const refresh = useCallback(async () => {
    let next: BudgetStatus[];
    try {
      next = await fetchStatus();
    } catch {
      // A failed poll leaves the last known state alone rather than
      // clearing an alert the user hasn't dealt with.
      return;
    }
    setStatuses(next);
    const candidate = pickAlert(next);
    setAlert(
      candidate && !dismissedRef.current.has(alertKey(candidate))
        ? candidate
        : null,
    );
  }, [fetchStatus]);

  useEffect(() => {
    if (!enabled) return;
    void refresh();
    const id = window.setInterval(() => void refresh(), pollMs);
    return () => window.clearInterval(id);
  }, [enabled, pollMs, refresh]);

  const dismiss = useCallback(() => {
    setAlert((current) => {
      if (current) dismissedRef.current.add(alertKey(current));
      return null;
    });
  }, []);

  return { alert, statuses, dismiss, refresh };
}
