import { useCallback, useEffect, useState } from "react";
import {
  deleteBudget as deleteBudgetIpc,
  listBudgets,
  setBudget as setBudgetIpc,
  type Budget,
  type BudgetPeriod,
  type BudgetScopeType,
} from "./ipc";

export interface BudgetInput {
  scopeType: BudgetScopeType;
  scopeId: string;
  period: BudgetPeriod;
  minutes: number;
  warnPercent: number;
}

export interface UseBudgets {
  /** `null` while the first load is in flight or outside Tauri. */
  budgets: Budget[] | null;
  /** A mutation is in flight. */
  busy: boolean;
  error: string | null;
  /** Resolves `true` when the budget was saved. */
  saveBudget: (input: BudgetInput) => Promise<boolean>;
  removeBudget: (id: string) => Promise<boolean>;
}

/**
 * State + actions behind the work-hour budgets panel (#307).
 *
 * Mutations return the fresh list from the backend rather than patching a
 * local copy: setting a budget for a scope and period that already has one
 * *replaces* it, so the server's answer is the only reliable picture of what
 * exists afterwards.
 */
export function useBudgets(): UseBudgets {
  const [budgets, setBudgets] = useState<Budget[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const list = await listBudgets();
        if (alive) setBudgets(list);
      } catch (e) {
        if (alive) setError(String(e));
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const run = useCallback(
    async (op: () => Promise<Budget[]>): Promise<boolean> => {
      setBusy(true);
      setError(null);
      try {
        setBudgets(await op());
        return true;
      } catch (e) {
        // The backend validates (scope, period, positive minutes, threshold
        // range) and its message names the field, so surface it verbatim
        // rather than replacing it with something vaguer.
        setError(String(e));
        return false;
      } finally {
        setBusy(false);
      }
    },
    [],
  );

  const saveBudget = useCallback(
    (input: BudgetInput) => run(() => setBudgetIpc(input)),
    [run],
  );
  const removeBudget = useCallback(
    (id: string) => run(() => deleteBudgetIpc(id)),
    [run],
  );

  return { budgets, busy, error, saveBudget, removeBudget };
}
