import { useCallback, useEffect, useState } from "react";
import { inTauri, projectBudgetStatus } from "./ipc";
import type { ProjectBudgetStatus } from "./types";

export type BudgetLevel = "none" | "ok" | "warning" | "over";

/** Classify how full the budget is as a semantic level. */
export function budgetLevel(status: ProjectBudgetStatus): BudgetLevel {
  if (status.estimateHours === null) return "none";
  const estimateSecs = status.estimateHours * 3600;
  if (estimateSecs <= 0) return "none";
  const ratio = status.usedSeconds / estimateSecs;
  if (ratio >= 1) return "over";
  if (ratio >= 0.8) return "warning";
  return "ok";
}

/** Fraction of estimate used, clamped to [0, 1]. Returns 0 when no estimate. */
export function budgetFraction(status: ProjectBudgetStatus): number {
  if (status.estimateHours === null || status.estimateHours <= 0) return 0;
  return Math.min(1, status.usedSeconds / (status.estimateHours * 3600));
}

/** Format seconds as "Xh Ym" (omits minutes when exactly 0). */
export function formatHours(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

export interface UseBudget {
  status: ProjectBudgetStatus | null;
  refresh: () => Promise<void>;
}

export function useBudget(projectId: string | null): UseBudget {
  const [status, setStatus] = useState<ProjectBudgetStatus | null>(null);

  const refresh = useCallback(async () => {
    if (!inTauri || projectId === null) {
      setStatus(null);
      return;
    }
    try {
      const s = await projectBudgetStatus(projectId);
      setStatus(s);
    } catch {
      setStatus(null);
    }
  }, [projectId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { status, refresh };
}
