import { useEffect, useState } from "react";
import { listClients, listProjects, listTasks, type Rate } from "../../lib/ipc";
import {
  currencyExponent,
  formatMoney,
  minorUnitsPerMajor,
  moneyFromMajor,
} from "../../lib/money";
import { isoLocalDate } from "../../lib/report-math";
import type { Client, Project, Task } from "../../lib/types";
import { useRates } from "../../lib/use-rates";
import { DateField } from "../../lib/datetime-fields";

type ScopeType = Rate["scopeType"];

interface Entities {
  clients: Client[];
  projects: Project[];
  tasks: Task[];
}

/** The entities a scope can reference (empty for the workspace default) —
 *  shared by the row labels and the add-form picker. */
function entitiesFor(
  scopeType: ScopeType,
  entities: Entities,
): Array<{ id: string; name: string }> {
  switch (scopeType) {
    case "client":
      return entities.clients;
    case "project":
      return entities.projects;
    case "task":
      return entities.tasks;
    default:
      return [];
  }
}

/** How a rate's scope reads in the list: the entity's name (or its raw id
 *  if it's been deleted since), tagged with the scope kind. */
function scopeLabel(
  rate: Rate,
  entities: Entities,
): { name: string; kind: string } {
  if (rate.scopeType === "workspace") {
    return { name: "Workspace default", kind: "" };
  }
  const match = entitiesFor(rate.scopeType, entities).find(
    (e) => e.id === rate.scopeId,
  );
  return { name: match?.name ?? rate.scopeId, kind: rate.scopeType };
}

/** The Pro rate panel (#109), rendered under the billing card once the
 *  license is active. Lists the configured hourly rates and adds/removes
 *  them; the backend resolves which one applies to a given piece of work
 *  most-granular-wins with historical effective-from dates. */
export function BillingRatesPanel() {
  const { rates, busy, error, addRate, deleteRate } = useRates();
  const [entities, setEntities] = useState<Entities>({
    clients: [],
    projects: [],
    tasks: [],
  });
  const [scopeType, setScopeType] = useState<ScopeType>("workspace");
  const [scopeId, setScopeId] = useState("");
  const [amount, setAmount] = useState("");
  const [currency, setCurrency] = useState("USD");
  const [effectiveFrom, setEffectiveFrom] = useState(() =>
    isoLocalDate(new Date()),
  );

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const [clients, projects, tasks] = await Promise.all([
          listClients(),
          listProjects(),
          listTasks(),
        ]);
        if (alive) setEntities({ clients, projects, tasks });
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

  const amountNum = Number(amount);
  // The stored integer is minor units of the chosen currency, and how many of
  // those make a major unit differs by currency (1 for JPY, 1000 for KWD), so
  // the entry step and factor follow the currency rather than assuming hundredths.
  const exponent = currencyExponent(currency);
  const amountStep = (10 ** -exponent).toFixed(exponent);
  // A finer amount than the currency can hold — ¥150.50, or $1.005 — would be
  // rounded on the way into the database. Say so instead: silently altering
  // money is the failure this whole scale change exists to remove. The
  // tolerance absorbs binary-float error (15.505 × 1000 lands just under).
  const scaled = amountNum * minorUnitsPerMajor(currency);
  const amountFitsCurrency = Math.abs(scaled - Math.round(scaled)) < 1e-6;
  // Split from `amountValid` so the Add button and the "too many decimals"
  // message below can't disagree about what a plausible number even is.
  const amountIsPlausible =
    amount.trim() !== "" && Number.isFinite(amountNum) && amountNum >= 0;
  const amountValid = amountIsPlausible && amountFitsCurrency;
  const scopeReady = scopeType === "workspace" || scopeId !== "";
  // A 3-letter code, not just any 3 chars — so `Intl` never chokes on it
  // and the user learns before a pointless backend round trip.
  const currencyValid = /^[A-Za-z]{3}$/.test(currency.trim());
  const canAdd = !busy && amountValid && scopeReady && currencyValid;

  const pickScope = (next: ScopeType) => {
    setScopeType(next);
    setScopeId("");
  };

  // Only ever reached from the Add button, which is disabled unless
  // `canAdd` — so no re-guard here.
  const submit = () => {
    void addRate({
      scopeType,
      scopeId: scopeType === "workspace" ? "" : scopeId,
      amount: moneyFromMajor(amountNum, currency),
      effectiveFrom,
    }).then((ok) => {
      if (ok) setAmount("");
    });
  };

  return (
    <div className="rate-panel" data-billing="rates">
      <h4 className="rate-h">Rates</h4>
      {rates === null ? (
        <p className="settings-sub">Loading rates…</p>
      ) : rates.length === 0 ? (
        <p className="settings-sub" data-rate="empty">
          No rates yet. Add one below — the most specific rate (task ▸ project ▸
          client ▸ workspace) applies, using the rate in effect on the work
          date.
        </p>
      ) : (
        <ul className="rate-list">
          {rates.map((rate) => {
            const label = scopeLabel(rate, entities);
            return (
              <li
                className="data-add-row"
                key={rate.id}
                data-rate-scope={rate.scopeType}
              >
                <span className="rate-scope">
                  {label.name}
                  {label.kind ? <em> · {label.kind}</em> : null}
                </span>
                <span className="rate-amount">
                  {formatMoney(rate.amount)} / hr
                </span>
                <span className="rate-from">from {rate.effectiveFrom}</span>
                <button
                  type="button"
                  className="btn btn--ghost btn--sm"
                  aria-label={`Remove the ${label.name} rate from ${rate.effectiveFrom}`}
                  onClick={() => void deleteRate(rate.id)}
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
        aria-label="Add a rate"
      >
        <select
          className="field-input"
          aria-label="Rate scope"
          value={scopeType}
          onChange={(e) => pickScope(e.target.value as ScopeType)}
        >
          <option value="workspace">Workspace default</option>
          <option value="client">Client</option>
          <option value="project">Project</option>
          <option value="task">Task</option>
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
        <input
          className="field-input"
          type="number"
          min="0"
          step={amountStep}
          inputMode="decimal"
          aria-label="Hourly amount"
          placeholder={(0).toFixed(exponent)}
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
        />
        <input
          className="field-input"
          aria-label="Currency"
          placeholder="USD"
          maxLength={3}
          value={currency}
          onChange={(e) => setCurrency(e.target.value)}
        />
        <DateField
          className="field-input"
          label="Effective from"
          value={effectiveFrom}
          onChange={setEffectiveFrom}
        />
        <button
          type="button"
          className="btn btn--primary btn--sm"
          onClick={submit}
          disabled={!canAdd}
        >
          Add rate
        </button>
      </div>

      {amountIsPlausible && !amountFitsCurrency && (
        <p className="field-error" role="alert">
          {exponent === 0
            ? `${currency.trim().toUpperCase()} amounts are whole numbers.`
            : `${currency.trim().toUpperCase()} amounts have at most ${exponent} decimal places.`}
        </p>
      )}

      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
