import { useEffect, useMemo, useRef, useState } from "react";
import { Icon, type IconName } from "../../lib/icon";
import { Empty, ProjectChip, Tag } from "../../lib/components";
import type {
  Density,
  Op,
  Project,
  Rule,
  RuleCondition,
  RulesComplexity,
  SignalKind,
} from "../../lib/types";
import { OP_LABELS, SIGNAL_LABELS } from "../../test-fixtures/data";
import {
  defaultOpForSignal,
  type PatchRule,
  useRules,
  withConditionAdded,
  withConditionAt,
  withConditionRemoved,
} from "../../lib/use-rules";
import { useProjects } from "../../lib/use-projects";
import { useDebouncedCallback } from "../../lib/use-debounced-callback";
import { snapshotToLiveSignals, useSnapshot } from "../../lib/use-snapshot";
import { LiveSignalsCard } from "./live-signals-card";
import { LIVE_SIGNALS as FIXTURE_SIGNALS } from "../../test-fixtures/data";
import { inTauri } from "../../lib/ipc";

interface Props {
  complexity: RulesComplexity;
  openRuleId: string | null;
  onOpenRule: (id: string | null) => void;
  density: Density;
}

const SIGNAL_OPTIONS: SignalKind[] = [
  "ide.folder",
  "git.branch",
  "browser.domain",
  "browser.tab",
  "window.title",
  "calendar.event",
  "app.name",
];

/**
 * Input-length caps that mirror the backend's `save_rule` validation
 * (see `src-tauri/src/ipc.rs`). Frontend `maxLength` is a hint —
 * the source of truth is the backend's bounded-size check.
 */
const MAX_RULE_NAME = 200;
const MAX_CONDITION_VALUE = 500;
const MAX_DESCRIPTION_TEMPLATE = 500;

/** ms of quiet time before a text-input keystroke commits to the
 *  backend. Short enough that the user-perceived save is "live",
 *  long enough that typing a 12-char name doesn't fire 12 IPC
 *  roundtrips + 12 rules-cache reloads. */
const TEXT_COMMIT_DELAY_MS = 300;

export function RulesView({ complexity, openRuleId, onOpenRule, density }: Props) {
  const { rules, add, update, remove, duplicate } = useRules();
  const projects = useProjects();
  const projectById = useMemo(
    () => new Map(projects.map((p) => [p.id, p])),
    [projects],
  );
  const snapshot = useSnapshot();
  // Outside Tauri (Vite dev preview / Storybook / vitest with no IPC
  // mock) we fall back to the static demo fixture so the design
  // remains explorable without a backend running. `inTauri` is a
  // module constant — included in the dep list so ESLint's
  // exhaustive-deps stays happy and refactors that swap it for a
  // hook value still re-memoize correctly.
  const liveSignals = useMemo(
    () => (inTauri ? snapshotToLiveSignals(snapshot) : FIXTURE_SIGNALS),
    [snapshot],
  );
  const [expanded, setExpanded] = useState<string | null>(openRuleId);
  useEffect(() => {
    if (openRuleId) setExpanded(openRuleId);
  }, [openRuleId]);

  const toggleExpanded = (id: string) => {
    const next = expanded === id ? null : id;
    setExpanded(next);
    onOpenRule(next);
  };

  const handleAdd = async () => {
    const id = await add();
    setExpanded(id);
    onOpenRule(id);
  };

  // Mirror `rules` into a ref so `handleSignalClick` reads the
  // latest committed state — without this, two rapid clicks
  // before React commits each other's `update()` would both
  // append against the same stale `rule.when`, losing one of them.
  // The hook itself already does ref-based mutation; we keep our
  // local ref so we can find the rule by id at click time.
  const rulesRef = useRef(rules);
  useEffect(() => {
    rulesRef.current = rules;
  }, [rules]);

  /**
   * Clicking a Live-signals row adds a condition with the prefilled
   * signal + value to the open rule. If no rule is currently open,
   * we create one and seed its first condition with the click. The
   * `op` is chosen by the same `defaultOpForSignal` rule the editor
   * uses, so the resulting rule is matchable without further edits.
   *
   * Each `update()` is awaited so a failure surfaces (the hook
   * sets `error`) instead of being silently swallowed.
   */
  const handleSignalClick = async (signal: SignalKind, value: string) => {
    const op = defaultOpForSignal(signal);
    if (expanded) {
      // Read via ref so a second rapid click sees the first
      // click's optimistic write to `when`.
      const rule = rulesRef.current.find((r) => r.id === expanded);
      if (!rule) return;
      await update(expanded, {
        when: [...rule.when, { signal, op, value }],
      });
      return;
    }
    const id = await add();
    setExpanded(id);
    onOpenRule(id);
    // Seed the new rule's first condition with the click. The
    // blank-rule template starts with a single empty `ide.folder`
    // condition, so we replace the array rather than appending.
    await update(id, { when: [{ signal, op, value }] });
  };

  return (
    <div className="view view-rules" data-density={density}>
      <header className="view-head">
        <div>
          <h2 className="view-title">Rules</h2>
          <p className="view-sub">
            Tried in order from top. First match wins.
            {complexity !== "light" && " Each rule may combine multiple signals."}
          </p>
        </div>
        <button
          className="btn btn--ghost btn--sm"
          aria-label="New rule"
          onClick={handleAdd}
        >
          <Icon name="plus" size={13} /> New
        </button>
      </header>

      {complexity !== "light" && (
        <LiveSignalsCard
          signals={liveSignals}
          onSignalClick={handleSignalClick}
        />
      )}

      {rules.length === 0 ? (
        <Empty
          title="No rules yet"
          body="Rules pair an OS signal (folder, branch, calendar event) with a project. Cairn never auto-logs without one."
          tone="soft"
          action={
            <button className="btn btn--primary btn--sm" onClick={handleAdd}>
              <Icon name="plus" size={13} /> Create your first rule
            </button>
          }
        />
      ) : (
        <ul className="rule-list" role="list">
          {rules.map((r, idx) => (
            <RuleRow
              key={r.id}
              rule={r}
              index={idx}
              expanded={expanded === r.id}
              onToggle={() => toggleExpanded(r.id)}
              onUpdate={(patch) => update(r.id, patch)}
              onDuplicate={async () => {
                const newId = await duplicate(r.id);
                setExpanded(newId);
                onOpenRule(newId);
              }}
              onDelete={async () => {
                await remove(r.id);
                if (expanded === r.id) {
                  setExpanded(null);
                  onOpenRule(null);
                }
              }}
              complexity={complexity}
              projects={projects}
              projectById={projectById}
            />
          ))}
        </ul>
      )}

      {complexity === "heavy" && (
        <section className="test-bench" aria-label="Test bench">
          <div className="sect-label">
            <span>Test bench</span>
            <span className="sect-meta">Simulate signals against your rules</span>
          </div>
          <div className="bench-inputs">
            <BenchField label="IDE folder" value="~/code/cairn" />
            <BenchField label="Git branch" value="feat/rules-ui" />
            <BenchField label="Window title" value="rules.tsx — cairn" />
          </div>
          <div className="bench-result">
            <span className="bench-arrow">
              <Icon name="arrow-right" size={12} />
            </span>
            <span>
              matches <strong>Cairn dev work</strong> → assigns{" "}
            </span>
            <ProjectChip id="cairn" />
            <span className="bench-tags">
              <Tag>dev</Tag>
              <Tag>feature</Tag>
            </span>
          </div>
        </section>
      )}
    </div>
  );
}

interface RuleRowProps {
  rule: Rule;
  index: number;
  expanded: boolean;
  onToggle: () => void;
  onUpdate: (patch: PatchRule) => void;
  onDuplicate: () => void;
  onDelete: () => void;
  complexity: RulesComplexity;
  projects: Project[];
  projectById: Map<string, Project>;
}

function RuleRow({
  rule,
  index,
  expanded,
  onToggle,
  onUpdate,
  onDuplicate,
  onDelete,
  complexity,
  projects,
  projectById,
}: RuleRowProps) {
  const project = rule.then.project ? projectById.get(rule.then.project) : null;
  const stopBubble = (e: React.MouseEvent | React.KeyboardEvent) => e.stopPropagation();

  const setCondition = (idx: number, patch: Partial<RuleCondition>) =>
    onUpdate({ when: withConditionAt(rule.when, idx, patch) });

  const handleSignalChange = (idx: number, signal: SignalKind) => {
    // Switching to/from `calendar.event` switches the op set —
    // pick a sensible default so the value field doesn't carry
    // over an unsupported op (e.g. "contains" on calendar.event).
    const currentOp = rule.when[idx]?.op;
    const op = signal === "calendar.event" || currentOp === "is-active"
      ? defaultOpForSignal(signal)
      : currentOp ?? defaultOpForSignal(signal);
    setCondition(idx, { signal, op });
  };

  const addCondition = () =>
    onUpdate({ when: withConditionAdded(rule.when) });

  const removeCondition = (idx: number) =>
    onUpdate({ when: withConditionRemoved(rule.when, idx) });

  return (
    <li
      className={`rule${expanded ? " is-open" : ""}${rule.enabled ? "" : " is-off"}`}
    >
      <header
        className="rule-head"
        onClick={onToggle}
        tabIndex={0}
        role="button"
        aria-expanded={expanded}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onToggle();
          }
        }}
      >
        <Icon name="drag" size={14} className="rule-drag" />
        <span className="rule-num">{index + 1}</span>
        <span className="rule-name">{rule.name}</span>
        <span className="rule-summary">
          {rule.when.length === 1 ? (
            <RuleConditionPill cond={rule.when[0]} />
          ) : (
            <span className="rule-multi">{rule.when.length} conditions</span>
          )}
          <Icon name="arrow-right" size={11} className="rule-arrow" />
          {project ? (
            <ProjectChip id={project.id} />
          ) : (
            <span className="rule-tags-only">+ tags</span>
          )}
        </span>
        <span className="rule-stats">{rule.matchedToday}× today</span>
        <span className="rule-toggle">
          <input
            type="checkbox"
            checked={rule.enabled}
            aria-label={`Enable ${rule.name}`}
            onClick={stopBubble}
            onChange={(e) => onUpdate({ enabled: e.target.checked })}
          />
        </span>
        <Icon
          name={expanded ? "chevron-down" : "chevron-right"}
          size={14}
          className="rule-chev"
        />
      </header>

      {expanded && (
        <div className="rule-body">
          <div className="rule-name-row">
            <label className="rule-name-label" htmlFor={`rule-name-${rule.id}`}>
              Name
            </label>
            <DebouncedTextInput
              id={`rule-name-${rule.id}`}
              className="rule-name-input"
              value={rule.name}
              onCommit={(name) => onUpdate({ name })}
              maxLength={MAX_RULE_NAME}
              onClick={stopBubble}
            />
          </div>

          <div className="rule-when">
            <div className="sect-label">When</div>
            {rule.when.map((c, i) => (
              <div key={i} className="cond">
                {i > 0 && (
                  <button
                    className="cond-join"
                    onClick={(e) => {
                      stopBubble(e);
                      setCondition(i, { any: !c.any });
                    }}
                    aria-label={
                      c.any
                        ? "OR — switch to AND"
                        : "AND — switch to OR"
                    }
                    title="Click to switch between AND / OR"
                  >
                    {c.any ? "OR" : "AND"}
                  </button>
                )}
                <SignalIcon kind={c.signal} />
                <select
                  className="cond-sig-sel"
                  value={c.signal}
                  onClick={stopBubble}
                  onChange={(e) =>
                    handleSignalChange(i, e.target.value as SignalKind)
                  }
                  aria-label="Signal"
                >
                  {SIGNAL_OPTIONS.map((s) => (
                    <option key={s} value={s}>
                      {SIGNAL_LABELS[s]}
                    </option>
                  ))}
                </select>
                <select
                  className="cond-op"
                  value={c.op}
                  onClick={stopBubble}
                  onChange={(e) =>
                    setCondition(i, { op: e.target.value as Op })
                  }
                  aria-label="Operator"
                >
                  {Object.entries(OP_LABELS).map(([k, v]) => (
                    <option key={k} value={k}>
                      {v}
                    </option>
                  ))}
                </select>
                <DebouncedTextInput
                  className="cond-val"
                  value={c.value}
                  onCommit={(value) => setCondition(i, { value })}
                  maxLength={MAX_CONDITION_VALUE}
                  onClick={stopBubble}
                  aria-label="Value"
                />
                {complexity !== "light" && rule.when.length > 1 && (
                  <button
                    className="cond-x"
                    aria-label="Remove condition"
                    onClick={(e) => {
                      stopBubble(e);
                      removeCondition(i);
                    }}
                  >
                    <Icon name="x" size={11} />
                  </button>
                )}
              </div>
            ))}
            {complexity !== "light" && (
              <button
                className="add-cond"
                onClick={(e) => {
                  stopBubble(e);
                  addCondition();
                }}
              >
                <Icon name="plus" size={11} /> add condition
              </button>
            )}
          </div>

          <div className="rule-then">
            <div className="sect-label">Then</div>
            <div className="then-row">
              <span className="then-key">Project</span>
              <select
                className="then-val"
                value={rule.then.project || ""}
                onClick={stopBubble}
                onChange={(e) =>
                  onUpdate({ then: { project: e.target.value || null } })
                }
                aria-label="Project"
              >
                <option value="">— don't change —</option>
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="then-row">
              <span className="then-key">Description</span>
              <DebouncedTextInput
                className="then-val"
                value={rule.then.descriptionTemplate ?? ""}
                placeholder="e.g. Meeting: {calendar.event}"
                maxLength={MAX_DESCRIPTION_TEMPLATE}
                onCommit={(t) =>
                  onUpdate({
                    then: { descriptionTemplate: t || undefined },
                  })
                }
                onClick={stopBubble}
                aria-label="Description template"
              />
            </div>
            <div className="then-row">
              <span className="then-key">Tags</span>
              <label className="then-tag-toggle">
                <input
                  type="checkbox"
                  checked={!!rule.then.tagsFromCalendar}
                  onChange={(e) =>
                    onUpdate({ then: { tagsFromCalendar: e.target.checked } })
                  }
                  onClick={stopBubble}
                />
                <span>from calendar attendees</span>
              </label>
            </div>
          </div>

          {complexity === "heavy" && (
            <div className="rule-meta">
              <div className="rule-meta-row">
                <span>Confidence threshold</span>
                <span className="rule-conf">{rule.confidence ?? "suggestive"}</span>
              </div>
              <div className="rule-meta-row">
                <span>If ambiguous</span>
                <span className="rule-amb">prompt me</span>
              </div>
            </div>
          )}

          <div className="rule-foot">
            <button
              className="link-btn"
              onClick={(e) => {
                stopBubble(e);
                onDuplicate();
              }}
            >
              Duplicate
            </button>
            <button
              className="link-btn link-btn--danger"
              onClick={(e) => {
                stopBubble(e);
                onDelete();
              }}
            >
              Delete
            </button>
          </div>
        </div>
      )}
    </li>
  );
}

function RuleConditionPill({ cond }: { cond: RuleCondition }) {
  return (
    <span className="cond-pill">
      <SignalIcon kind={cond.signal} small />
      <span className="cond-pill-sig">{SIGNAL_LABELS[cond.signal]}</span>
      <span className="cond-pill-op">{OP_LABELS[cond.op]}</span>
      <code>{cond.value}</code>
    </span>
  );
}

function SignalIcon({ kind, small }: { kind: SignalKind; small?: boolean }) {
  const name: IconName =
    kind === "ide.folder" ? "folder"
    : kind === "git.branch" ? "branch"
    : kind === "browser.domain" ? "globe"
    : kind === "browser.tab" ? "globe"
    : kind === "window.title" ? "type"
    : kind === "calendar.event" ? "calendar"
    : "info";
  return <Icon name={name} size={small ? 11 : 12} className="sig-ic" />;
}

function BenchField({ label, value }: { label: string; value: string }) {
  return (
    <label className="bench-field">
      <span className="bench-label">{label}</span>
      <input className="bench-input" defaultValue={value} />
    </label>
  );
}

interface DebouncedTextInputProps
  extends Omit<React.InputHTMLAttributes<HTMLInputElement>, "value" | "onChange" | "defaultValue"> {
  value: string;
  onCommit: (next: string) => void;
}

/**
 * Controlled text input that batches keystrokes — local state
 * updates immediately for snappy typing, but commits to the
 * caller's `onCommit` only after `TEXT_COMMIT_DELAY_MS` of quiet
 * time (or on blur). Without this, every keystroke would fire one
 * `save_rule` IPC + one rules-cache reload (issue #55), which
 * stalls under SQLite write contention and is a classic save-storm
 * pattern.
 */
function DebouncedTextInput({
  value,
  onCommit,
  ...rest
}: DebouncedTextInputProps) {
  const [local, setLocal] = useState(value);
  // Sync if the external value changes (e.g. another mutator
  // patched the same field). Skip while the input has focus to
  // avoid clobbering keystrokes the user has typed but not yet
  // committed.
  useEffect(() => {
    if (document.activeElement !== inputRef.current) setLocal(value);
  }, [value]);
  const inputRef = useRef<HTMLInputElement>(null);
  const commit = useDebouncedCallback(onCommit, TEXT_COMMIT_DELAY_MS);
  return (
    <input
      {...rest}
      ref={inputRef}
      value={local}
      onChange={(e) => {
        setLocal(e.target.value);
        commit(e.target.value);
      }}
      onBlur={() => commit.flush()}
    />
  );
}
