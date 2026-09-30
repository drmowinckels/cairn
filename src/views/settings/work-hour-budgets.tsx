import { useEffect, useState } from "react";
import {
  listClients,
  listProjects,
  type Budget,
  type BudgetPeriod,
  type BudgetScopeType,
} from "../../lib/ipc";
import { fmtHm } from "../../lib/time";
import type { Client, Project } from "../../lib/types";
import { useBudgets } from "../../lib/use-budgets";

interface Entities {
  clients: Client[];
  projects: Project[];
}

const PERIOD_LABEL: Record<BudgetPeriod, string> = {
  daily: "per day",
  weekly: "per week",
  monthly: "per month",
};

/** The entities a scope can reference (none for the workspace default). */
function entitiesFor(
  scopeType: BudgetScopeType,
  entities: Entities,
): Array<{ id: string; name: string }> {
  if (scopeType === "client") return entities.clients;
  if (scopeType === "project") return entities.projects;
  return [];
}

/** How a budget's scope reads in the list: the entity's name, or its raw id
 *  if it's been deleted since — an orphaned budget still has to be findable
 *  so the user can remove it. */
function scopeLabel(
  budget: Budget,
  entities: Entities,
): { name: string; kind: string } {
  if (budget.scopeType === "workspace") {
    return { name: "Everything", kind: "" };
  }
  const match = entitiesFor(budget.scopeType, entities).find(
    (e) => e.id === budget.scopeId,
  );
  return { name: match?.name ?? budget.scopeId, kind: budget.scopeType };
}

/** Accept "7.5" or "7:30" and return whole minutes, or `null`. */
export function parseHours(text: string): number | null {
  const raw = text.trim();
  if (!raw) return null;
  const colon = /^(\d+):([0-5]\d)$/.exec(raw);
  if (colon) return Number(colon[1]) * 60 + Number(colon[2]);
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  // Round to the minute: a budget is a cap, and a fractional minute in one
  // would make the percentage wobble for no reason.
  return Math.round(n * 60);
}

/**
 * Work-hour budgets (#307) — recurring daily / weekly / monthly caps.
 *
 * A cap, not a target: Cairn warns as you approach one and again once you
 * pass it. Distinct from a project's estimate, which is a one-off total for
 * the whole job; these recur every period.
 */
export function WorkHourBudgetsPanel() {
  const { budgets, busy, error, saveBudget, removeBudget } = useBudgets();
  const [entities, setEntities] = useState<Entities>({
    clients: [],
    projects: [],
  });
  const [scopeType, setScopeType] = useState<BudgetScopeType>("workspace");
  const [scopeId, setScopeId] = useState("");
  const [period, setPeriod] = useState<BudgetPeriod>("weekly");
  const [hours, setHours] = useState("");
  const [warnPercent, setWarnPercent] = useState("80");

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const [clients, projects] = await Promise.all([
          listClients(),
          listProjects(),
        ]);
        if (alive) setEntities({ clients, projects });
      } catch {
        // Leave the pickers empty; rows fall back to raw ids so the panel
        // still works without the entity names.
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const scopeOptions = entitiesFor(scopeType, entities);
  const minutes = parseHours(hours);
  const warnNum = Number(warnPercent);
  const warnValid =
    warnPercent.trim() !== "" &&
    Number.isInteger(warnNum) &&
    warnNum >= 1 &&
    warnNum <= 100;
  const scopeReady = scopeType === "workspace" || scopeId !== "";
  const canAdd = !busy && minutes !== null && warnValid && scopeReady;

  const pickScope = (next: BudgetScopeType) => {
    setScopeType(next);
    setScopeId("");
  };

  // Only reachable from the Add button, disabled unless `canAdd` — so the
  // non-null assertion on `minutes` holds.
  const submit = () => {
    void saveBudget({
      scopeType,
      scopeId: scopeType === "workspace" ? "" : scopeId,
      period,
      minutes: minutes!,
      warnPercent: warnNum,
    }).then((ok) => {
      if (ok) setHours("");
    });
  };

  return (
    <div className="budget-panel" data-budgets="panel">
      {/* `settings-h`, not the billing panel's `rate-h`: this is a
          top-level Settings section like "Dates & times" and
          "Reporting", not a sub-panel nested inside a card. */}
      <h3 className="settings-h">Work-hour budgets</h3>
      <p className="settings-sub">
        A cap on how much you work, not a target to hit. Cairn warns as you
        approach one and again once you pass it — it never stops a timer for
        you. The most specific budget speaks first (project ▸ client ▸
        everything). Separate from a project&apos;s estimate, which is a one-off
        total for the whole job.
      </p>

      {budgets === null ? (
        <p className="settings-sub">Loading budgets…</p>
      ) : budgets.length === 0 ? (
        <p className="settings-sub" data-budget="empty">
          No budgets yet. Add one below to be warned before you overrun.
        </p>
      ) : (
        <ul className="rate-list">
          {budgets.map((b) => {
            const label = scopeLabel(b, entities);
            return (
              <li
                className="data-add-row"
                key={b.id}
                data-budget-scope={b.scopeType}
              >
                <span className="rate-scope">
                  {label.name}
                  {label.kind ? <em> · {label.kind}</em> : null}
                </span>
                <span className="rate-amount">
                  {fmtHm(b.minutes)} {PERIOD_LABEL[b.period]}
                </span>
                <span className="rate-from">warn at {b.warnPercent}%</span>
                <button
                  type="button"
                  className="btn btn--ghost btn--sm"
                  aria-label={`Remove the ${label.name} ${b.period} budget`}
                  onClick={() => void removeBudget(b.id)}
                  disabled={busy}
                >
                  Remove
                </button>
              </li>
            );
          })}
        </ul>
      )}

      <div
        className="data-add-row rate-add"
        role="group"
        aria-label="Add a budget"
      >
        <select
          className="field-input"
          aria-label="Budget scope"
          value={scopeType}
          onChange={(e) => pickScope(e.target.value as BudgetScopeType)}
        >
          <option value="workspace">Everything</option>
          <option value="client">Client</option>
          <option value="project">Project</option>
        </select>
        {scopeType !== "workspace" && (
          <select
            className="field-input"
            aria-label={`Which ${scopeType}`}
            value={scopeId}
            onChange={(e) => setScopeId(e.target.value)}
          >
            <option value="">Choose a {scopeType}…</option>
            {scopeOptions.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </select>
        )}
        <select
          className="field-input"
          aria-label="Budget period"
          value={period}
          onChange={(e) => setPeriod(e.target.value as BudgetPeriod)}
        >
          <option value="daily">Per day</option>
          <option value="weekly">Per week</option>
          <option value="monthly">Per month</option>
        </select>
        <input
          className="field-input"
          aria-label="Budget hours"
          inputMode="decimal"
          placeholder="7.5"
          value={hours}
          onChange={(e) => setHours(e.target.value)}
        />
        <input
          className="field-input"
          type="number"
          min="1"
          max="100"
          step="1"
          inputMode="numeric"
          aria-label="Warn at percent"
          value={warnPercent}
          onChange={(e) => setWarnPercent(e.target.value)}
        />
        <button
          type="button"
          className="btn btn--primary btn--sm"
          onClick={submit}
          disabled={!canAdd}
        >
          Add budget
        </button>
      </div>

      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
