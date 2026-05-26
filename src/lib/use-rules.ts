import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  deleteRule as deleteRuleIpc,
  inTauri,
  listRules,
  reorderRules as reorderRulesIpc,
  saveRule as saveRuleIpc,
  type BackendRule,
  type SaveRuleInput,
} from "./ipc";
import type {
  Confidence,
  Op,
  Rule,
  RuleAction,
  RuleCondition,
  SignalKind,
} from "./types";
import { RULES as FIXTURE_RULES } from "../test-fixtures/data";

/**
 * Shape of the JSON serialized into `rules.body`. The Rust side
 * keeps `confidence`/`when`/`then` in body, with `id`/`name`/`enabled`/`priority`
 * at the top level. Frontend mirror is in `serializeRule` /
 * `deserializeRule`.
 */
interface RuleBody {
  confidence?: Confidence;
  when: RuleCondition[];
  then: RuleAction;
  confidenceWarningDismissed?: boolean;
}

export interface UseRules {
  rules: Rule[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  /** Create a blank rule with sensible defaults. Returns its id. */
  add: () => Promise<string>;
  /** Patch the local rule + persist. `then` is shallow-merged. */
  update: (id: string, patch: PatchRule) => Promise<void>;
  /** Drop a rule. */
  remove: (id: string) => Promise<void>;
  /** Clone the rule under a new id, suffixing the name with "(copy)". */
  duplicate: (id: string) => Promise<string>;
  /** Move the rule at `from` to position `to` and persist the new
   *  priority order. Pure index-based swap; the backend rewrites
   *  every priority transactionally on success. */
  move: (from: number, to: number) => Promise<void>;
}

export interface PatchRule {
  name?: string;
  enabled?: boolean;
  priority?: number;
  confidence?: Confidence;
  when?: RuleCondition[];
  /** Shallow-merged into the existing `then` — pass only the fields you're changing. */
  then?: Partial<RuleAction>;
  confidenceWarningDismissed?: boolean;
}

export function useRules(): UseRules {
  const [rules, setRules] = useState<Rule[]>(inTauri ? [] : FIXTURE_RULES);
  const [loading, setLoading] = useState(inTauri);
  const [error, setError] = useState<string | null>(null);

  // The mutators read the current rules through this ref so two
  // rapid same-tick calls don't race on a stale `useCallback`
  // closure. Without this, typing "ab" can save "a" twice instead
  // of "a" then "ab" because both closures capture the same
  // `rules` snapshot. `commit` below writes the ref *synchronously*
  // before calling `setRules`, so even calls inside the same `act`
  // / event handler see each other's effects.
  const rulesRef = useRef(rules);
  const commit = useCallback((updater: (prev: Rule[]) => Rule[]) => {
    rulesRef.current = updater(rulesRef.current);
    setRules(rulesRef.current);
  }, []);
  useEffect(() => {
    rulesRef.current = rules;
  }, [rules]);

  const refresh = useCallback(async () => {
    if (!inTauri) {
      setRules(FIXTURE_RULES);
      return;
    }
    try {
      const backend = await listRules();
      setRules(backend.map(deserializeRule));
      setError(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  const add = useCallback(async (): Promise<string> => {
    const draft = blankRule(rulesRef.current);
    if (!inTauri) {
      commit((prev) => [...prev, draft]);
      return draft.id;
    }
    const saved = await saveRuleIpc(serializeRule(draft, null));
    commit((prev) => [...prev, deserializeRule(saved)]);
    return saved.id;
  }, [commit]);

  const update = useCallback(
    async (id: string, patch: PatchRule) => {
      // `commit` runs the updater *and* writes the ref in the same
      // synchronous step, so the next call sees the freshly-merged
      // rule even when both fire inside the same React tick (e.g.
      // a rapid sequence of `update(id, {name})` then
      // `update(id, {enabled})`).
      let next: Rule | undefined;
      commit((prev) =>
        prev.map((r) => {
          if (r.id !== id) return r;
          next = applyPatch(r, patch);
          return next;
        }),
      );
      if (!next) return; // rule was deleted between trigger and patch
      if (!inTauri) return;
      try {
        await saveRuleIpc(serializeRule(next, id));
        // No need to overwrite local state with the backend echo —
        // the echo is the same data we just sent. Overwriting it
        // on a slow save can clobber keystrokes the user already
        // typed after the optimistic update committed.
      } catch (e) {
        setError(String(e));
        // Don't rollback. Rolling back here discards every
        // keystroke the user typed after this save was queued.
        // Surfacing the error and leaving local state alone is
        // the safer default for a tool whose contract is "we
        // don't lose your input" — the next mutation will retry
        // the save with the latest local value.
      }
    },
    [commit],
  );

  const remove = useCallback(
    async (id: string) => {
      const before = rulesRef.current;
      commit((prev) => prev.filter((r) => r.id !== id));
      if (!inTauri) return;
      try {
        await deleteRuleIpc(id);
      } catch (e) {
        setError(String(e));
        commit(() => before);
      }
    },
    [commit],
  );

  const duplicate = useCallback(
    async (id: string): Promise<string> => {
      const source = rulesRef.current.find((r) => r.id === id);
      if (!source) throw new Error(`rule ${id} not found`);
      const clone: Rule = {
        ...source,
        id: cryptoId(),
        name: `${source.name} (copy)`,
        priority: nextPriority(rulesRef.current),
        matchedToday: 0,
      };
      if (!inTauri) {
        commit((prev) => [...prev, clone]);
        return clone.id;
      }
      const saved = await saveRuleIpc(serializeRule(clone, null));
      commit((prev) => [...prev, deserializeRule(saved)]);
      return saved.id;
    },
    [commit],
  );

  const move = useCallback(
    async (from: number, to: number) => {
      if (from === to) return;
      const before = rulesRef.current;
      const reordered = moveByIndex(before, from, to);
      if (reordered === before) return; // out-of-range no-op
      // Rewrite priorities locally so the UI's render order (which
      // sorts by `priority` upstream) reflects the optimistic move
      // before the IPC round-trip lands. Backend writes 10/20/30…
      // and we mirror that here.
      const renumbered = reordered.map((r, i) => ({
        ...r,
        priority: (i + 1) * 10,
      }));
      commit(() => renumbered);
      if (!inTauri) return;
      try {
        await reorderRulesIpc(renumbered.map((r) => r.id));
      } catch (e) {
        setError(String(e));
        // Mirror update()'s policy: don't roll back. The next move
        // call retries with the latest local order.
      }
    },
    [commit],
  );

  useEffect(() => {
    refresh();
  }, [refresh]);

  return useMemo(
    () => ({ rules, loading, error, refresh, add, update, remove, duplicate, move }),
    [rules, loading, error, refresh, add, update, remove, duplicate, move],
  );
}

/**
 * Pure index-based move. Returns the original array (referentially)
 * when the move would be a no-op (out-of-range `from` / `to`, or
 * `from === to`) so callers can use === to detect "nothing changed."
 */
export function moveByIndex<T>(arr: T[], from: number, to: number): T[] {
  if (from === to) return arr;
  if (from < 0 || from >= arr.length) return arr;
  if (to < 0 || to >= arr.length) return arr;
  const next = arr.slice();
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}

/**
 * Apply a `PatchRule` to an existing rule. Shallow-merges `then`
 * so callers can patch individual `RuleAction` fields without
 * having to spread the whole object.
 */
function applyPatch(rule: Rule, patch: PatchRule): Rule {
  return {
    ...rule,
    ...patch,
    then: patch.then ? { ...rule.then, ...patch.then } : rule.then,
  };
}

// -----------------------------------------------------------------
// Serialization helpers — keep IPC-shape vs UI-shape conversion in
// one place so callers never reach into `body` directly.
// -----------------------------------------------------------------

export function serializeRule(rule: Rule, id: string | null): SaveRuleInput {
  const body: RuleBody = {
    confidence: rule.confidence,
    when: rule.when,
    then: rule.then,
    ...(rule.confidenceWarningDismissed
      ? { confidenceWarningDismissed: true }
      : {}),
  };
  return {
    id,
    name: rule.name,
    enabled: rule.enabled,
    priority: rule.priority,
    body,
  };
}

export function deserializeRule(backend: BackendRule): Rule {
  // The body field is `unknown` because it's the JSON column the
  // backend stores opaquely. Defensive: arrays / strings / null
  // collapse to the empty defaults below.
  const raw = backend.body;
  const body: Partial<RuleBody> =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Partial<RuleBody>)
      : {};
  return {
    id: backend.id,
    name: backend.name,
    enabled: backend.enabled,
    priority: backend.priority,
    confidence: body.confidence,
    when: Array.isArray(body.when) ? body.when : [],
    // `body.then` may be missing `project` (e.g. a hand-edited or
    // partially-saved row); default it explicitly afterwards so
    // every Rule the UI sees satisfies the `RuleAction` shape.
    then:
      body.then && typeof body.then === "object"
        ? { ...body.then, project: body.then.project ?? null }
        : { project: null },
    matchedToday: 0,
    confidenceWarningDismissed: body.confidenceWarningDismissed === true,
  };
}

/**
 * Per `docs/RULES_ENGINE.md` §5: a rule with `confidence: strict`
 * that has fewer than 2 conditions OR uses only `contains` ops is
 * likely to over-fire (and auto-start the timer without prompting).
 * Surface a dismissible warning in the editor.
 *
 * Returns `false` once the user has dismissed the warning on this
 * specific rule — `confidenceWarningDismissed` is a per-rule flag,
 * persisted in the rule body so the dismissal sticks across sessions.
 * It does NOT silence the warning on other rules.
 *
 * Pure: no React, no state. Easy to unit-test against every shape.
 */
export function shouldWarnConfidence(rule: Rule): boolean {
  if (rule.confidence !== "strict") return false;
  if (rule.confidenceWarningDismissed === true) return false;
  if (rule.when.length < 2) return true;
  return rule.when.every((c) => c.op === "contains");
}

// -----------------------------------------------------------------
// Defaults
// -----------------------------------------------------------------

export const DEFAULT_CONDITION: RuleCondition = {
  signal: "ide.folder",
  op: "contains",
  value: "",
};

function blankRule(existing: Rule[]): Rule {
  return {
    id: cryptoId(),
    name: "New rule",
    enabled: true,
    priority: nextPriority(existing),
    when: [{ ...DEFAULT_CONDITION }],
    then: { project: null },
    matchedToday: 0,
  };
}

function nextPriority(rules: Rule[]): number {
  if (rules.length === 0) return 10;
  const max = rules.reduce((acc, r) => Math.max(acc, r.priority), 0);
  return max + 10;
}

function cryptoId(): string {
  // Browser + Node 19+ + JSDOM all provide `globalThis.crypto`. We
  // require Node 20+ per package.json; the fallback was dead code
  // and would have produced non-uniform ids if reached.
  return globalThis.crypto.randomUUID();
}

// -----------------------------------------------------------------
// Condition-list helpers — kept exported so component-level tests
// can exercise the same logic the editor uses.
// -----------------------------------------------------------------

export function withConditionAt(
  conditions: RuleCondition[],
  index: number,
  patch: Partial<RuleCondition>,
): RuleCondition[] {
  return conditions.map((c, i) => (i === index ? { ...c, ...patch } : c));
}

export function withConditionAdded(
  conditions: RuleCondition[],
  signal: SignalKind = DEFAULT_CONDITION.signal,
): RuleCondition[] {
  return [...conditions, { ...DEFAULT_CONDITION, signal }];
}

export function withConditionRemoved(
  conditions: RuleCondition[],
  index: number,
): RuleCondition[] {
  return conditions.filter((_, i) => i !== index);
}

export function defaultOpForSignal(signal: SignalKind): Op {
  // `calendar.event` is a state, not a substring — the engine only
  // supports `is-active` for it. Other signals default to `contains`
  // which is the friendliest fuzzy match for IDE folders / titles.
  return signal === "calendar.event" ? "is-active" : "contains";
}
