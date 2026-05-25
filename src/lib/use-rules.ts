import { useCallback, useEffect, useMemo, useState } from "react";
import {
  deleteRule as deleteRuleIpc,
  inTauri,
  listRules,
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
}

export interface UseRules {
  rules: Rule[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  /** Create a blank rule with sensible defaults. Returns its id. */
  add: () => Promise<string>;
  /** Patch the local rule + persist. Last-write-wins for now. */
  update: (id: string, patch: PatchRule) => Promise<void>;
  /** Drop a rule. */
  remove: (id: string) => Promise<void>;
  /** Clone the rule under a new id, suffixing the name with "(copy)". */
  duplicate: (id: string) => Promise<string>;
}

export interface PatchRule {
  name?: string;
  enabled?: boolean;
  priority?: number;
  confidence?: Confidence;
  when?: RuleCondition[];
  then?: RuleAction;
}

export function useRules(): UseRules {
  const [rules, setRules] = useState<Rule[]>(inTauri ? [] : FIXTURE_RULES);
  const [loading, setLoading] = useState(inTauri);
  const [error, setError] = useState<string | null>(null);

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
    const draft = blankRule(rules);
    const input = serializeRule(draft, null);
    if (!inTauri) {
      setRules((prev) => [...prev, draft]);
      return draft.id;
    }
    const saved = await saveRuleIpc(input);
    setRules((prev) => [...prev, deserializeRule(saved)]);
    return saved.id;
  }, [rules]);

  const update = useCallback(
    async (id: string, patch: PatchRule) => {
      // Find existing rule locally so we can build the full save
      // payload (the backend has no PATCH; it's INSERT-or-UPDATE
      // on the whole row).
      const current = rules.find((r) => r.id === id);
      if (!current) return;
      const next: Rule = { ...current, ...patch, then: patch.then ?? current.then };
      // Optimistic local update so the UI doesn't lag the keystroke.
      setRules((prev) => prev.map((r) => (r.id === id ? next : r)));
      if (!inTauri) return;
      try {
        const saved = await saveRuleIpc(serializeRule(next, id));
        // Merge the backend echo back in case it normalized fields.
        setRules((prev) =>
          prev.map((r) => (r.id === id ? deserializeRule(saved) : r)),
        );
      } catch (e) {
        setError(String(e));
        // Roll back the optimistic update.
        setRules((prev) => prev.map((r) => (r.id === id ? current : r)));
      }
    },
    [rules],
  );

  const remove = useCallback(
    async (id: string) => {
      const snapshot = rules;
      setRules((prev) => prev.filter((r) => r.id !== id));
      if (!inTauri) return;
      try {
        await deleteRuleIpc(id);
      } catch (e) {
        setError(String(e));
        setRules(snapshot);
      }
    },
    [rules],
  );

  const duplicate = useCallback(
    async (id: string): Promise<string> => {
      const source = rules.find((r) => r.id === id);
      if (!source) throw new Error(`rule ${id} not found`);
      const clone: Rule = {
        ...source,
        id: cryptoId(),
        name: `${source.name} (copy)`,
        priority: nextPriority(rules),
        matchedToday: 0,
      };
      if (!inTauri) {
        setRules((prev) => [...prev, clone]);
        return clone.id;
      }
      const saved = await saveRuleIpc(serializeRule(clone, null));
      setRules((prev) => [...prev, deserializeRule(saved)]);
      return saved.id;
    },
    [rules],
  );

  useEffect(() => {
    refresh();
  }, [refresh]);

  return useMemo(
    () => ({ rules, loading, error, refresh, add, update, remove, duplicate }),
    [rules, loading, error, refresh, add, update, remove, duplicate],
  );
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
  const body = (backend.body ?? {}) as Partial<RuleBody>;
  return {
    id: backend.id,
    name: backend.name,
    enabled: backend.enabled,
    priority: backend.priority,
    confidence: body.confidence,
    when: body.when ?? [],
    then: body.then ?? { project: null },
    matchedToday: 0,
  };
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
  // Browser + Node 19+ + the JSDOM test env all provide
  // `globalThis.crypto.randomUUID`. Fall back to Date.now() + Math
  // only when neither exists (pre-Node 19 CI is the only known
  // case; none of our targets).
  if (typeof globalThis.crypto !== "undefined" && globalThis.crypto.randomUUID) {
    return globalThis.crypto.randomUUID();
  }
  return `r-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
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
