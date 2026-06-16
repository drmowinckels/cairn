import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Icon, type IconName } from "../../lib/icon";
import { Empty, ProjectChip } from "../../lib/components";
import type { AppCategory } from "../../lib/ipc";
import { useAppCategories } from "../../lib/use-app-categories";
import type {
  AmbiguityBehavior,
  Confidence,
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
  AMBIGUITY_OPTIONS,
  coerceAmbiguity,
  defaultOpForSignal,
  type PatchRule,
  shouldWarnConfidence,
  useRules,
  withConditionAdded,
  withConditionAt,
  withConditionRemoved,
} from "../../lib/use-rules";
import { useProjects } from "../../lib/use-projects";
import { useDebouncedCallback } from "../../lib/use-debounced-callback";
import { selectLiveSignals, useSnapshot } from "../../lib/use-snapshot";
import { LiveSignalsCard } from "./live-signals-card";
import { RuleTestBench } from "./test-bench";
import { ExclusionsSection } from "./exclusions-section";
import { StarterSuggestions } from "./starter-suggestions";
import {
  adoptStarter,
  loadDismissedStarters,
  pendingStarters,
  persistDismissedStarter,
  type StarterRule,
} from "../../lib/starter-rules";
import { LIVE_SIGNALS as FIXTURE_SIGNALS } from "../../test-fixtures/data";
import { inTauri } from "../../lib/ipc";

interface Props {
  complexity: RulesComplexity;
  openRuleId: string | null;
  onOpenRule: (id: string | null) => void;
  density: Density;
  /**
   * App-wide default for new rules' `ambiguityBehavior` (#71).
   * Falls through to the hook's own `"prompt"` fallback when omitted.
   * Existing rules are never mutated when this changes.
   */
  ambiguityDefault?: AmbiguityBehavior;
}

const SIGNAL_OPTIONS: SignalKind[] = [
  "ide.folder",
  "git.branch",
  "browser.domain",
  "browser.tab",
  "window.title",
  "calendar.event",
  "app.name",
  "app.category",
];

const CONFIDENCE_OPTIONS: Confidence[] = ["suggestive", "strict"];

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

export function RulesView({
  complexity,
  openRuleId,
  onOpenRule,
  density,
  ambiguityDefault,
}: Props) {
  const { rules, add, addFromTemplate, update, remove, duplicate, move } =
    useRules({
      defaultAmbiguity: ambiguityDefault,
    });
  const { projects, create: createProject } = useProjects();
  const projectById = useMemo(
    () => new Map(projects.map((p) => [p.id, p])),
    [projects],
  );
  const snapshot = useSnapshot();
  const liveSignals = useMemo(
    () => selectLiveSignals(snapshot, FIXTURE_SIGNALS, inTauri),
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

  // Source index of an in-flight drag (HTML5 drag protocol). Tracked
  // in a ref rather than DataTransfer because jsdom's DragEvent
  // refuses to round-trip getData/setData reliably, and a ref is
  // simpler than the MIME-type dance. We still call setData on
  // dragstart so Firefox actually initiates the drag (it refuses
  // without anything on the transfer object). Convention: a value
  // of -1 means "no drag in flight" — `onDragEnd` resets to that.
  const dragFromIdx = useRef<number | null>(null);

  // Live region for SR announcements after a successful move. Keeps
  // sighted users uninterrupted while screen-reader users hear
  // "Rule X moved to position Y" without taking focus from the
  // active control.
  const [moveAnnouncement, setMoveAnnouncement] = useState("");

  // Starter-rule suggestions (#189): bundled templates the user can adopt
  // with one click. Dismissals persist to localStorage; adoption is detected
  // by the live rule set, so an adopted/dismissed starter stops suggesting.
  const [dismissedStarters, setDismissedStarters] = useState<string[]>(
    loadDismissedStarters,
  );
  const [starterBusy, setStarterBusy] = useState(false);
  const [starterError, setStarterError] = useState<string | null>(null);
  const pendingStarterRules = useMemo(
    () => pendingStarters(rules, dismissedStarters),
    [rules, dismissedStarters],
  );

  const handleAdoptStarter = useCallback(
    async (starter: StarterRule) => {
      setStarterBusy(true);
      setStarterError(null);
      const err = await adoptStarter(starter, {
        projects,
        createProject,
        addFromTemplate,
      });
      setStarterError(err);
      setStarterBusy(false);
    },
    [projects, createProject, addFromTemplate],
  );

  const handleDismissStarter = useCallback((id: string) => {
    setDismissedStarters(persistDismissedStarter(id));
  }, []);

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
      {/* SR-only live region for reorder announcements. polite =
          announce after current speech, not interrupting. */}
      <div
        className="sr-only"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        {moveAnnouncement}
      </div>
      <header className="view-head">
        <div>
          <h2 className="view-title">Rules</h2>
          <p className="view-sub">
            Tried in order from top. First match wins.
            {complexity !== "light" &&
              " Each rule may combine multiple signals."}
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
        // role="list" is redundant per ARIA but restores list semantics
        // that Safari/VoiceOver drop when `list-style: none` is set.
        // eslint-disable-next-line jsx-a11y/no-redundant-roles
        <ul className="rule-list" role="list">
          {rules.map((r, idx) => (
            <RuleRow
              key={r.id}
              rule={r}
              index={idx}
              total={rules.length}
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
              onMove={async (to) => {
                await move(idx, to);
                setMoveAnnouncement(
                  `Rule ${r.name} moved to position ${to + 1}`,
                );
              }}
              onDragStartIndex={(i) => {
                // `i === -1` is the dragend reset sentinel; anything
                // ≥ 0 is a real source index.
                dragFromIdx.current = i < 0 ? null : i;
              }}
              onDropAtIndex={async (target) => {
                const from = dragFromIdx.current;
                dragFromIdx.current = null;
                if (from === null || from === target) return;
                await move(from, target);
                setMoveAnnouncement(
                  `Rule moved from position ${from + 1} to position ${target + 1}`,
                );
              }}
              complexity={complexity}
              projects={projects}
              projectById={projectById}
            />
          ))}
        </ul>
      )}

      <StarterSuggestions
        starters={pendingStarterRules}
        onAdopt={handleAdoptStarter}
        onDismiss={handleDismissStarter}
        busy={starterBusy}
        error={starterError}
      />

      {complexity === "heavy" && <RuleTestBench />}

      <ExclusionsSection />
    </div>
  );
}

interface RuleRowProps {
  rule: Rule;
  index: number;
  total: number;
  expanded: boolean;
  onToggle: () => void;
  onUpdate: (patch: PatchRule) => void;
  onDuplicate: () => void;
  onDelete: () => void;
  /** Move this row to position `to`. Index-based; parent maps to ids. */
  onMove: (to: number) => void;
  /** Drag protocol hooks (parent owns the source-index ref). */
  onDragStartIndex: (from: number) => void;
  onDropAtIndex: (target: number) => void;
  complexity: RulesComplexity;
  projects: Project[];
  projectById: Map<string, Project>;
}

function RuleRow({
  rule,
  index,
  total,
  expanded,
  onToggle,
  onUpdate,
  onDuplicate,
  onDelete,
  onMove,
  onDragStartIndex,
  onDropAtIndex,
  complexity,
  projects,
  projectById,
}: RuleRowProps) {
  const project = rule.then.project ? projectById.get(rule.then.project) : null;
  const appCategories = useAppCategories();
  const stopBubble = (e: React.MouseEvent | React.KeyboardEvent) =>
    e.stopPropagation();

  const setCondition = (idx: number, patch: Partial<RuleCondition>) =>
    onUpdate({ when: withConditionAt(rule.when, idx, patch) });

  // Re-arm the warning only when the user transitions *into* strict
  // from non-strict. A strict→strict reselect (keyboard cycling, no-
  // op) doesn't clobber a prior dismissal; suggestive→suggestive is
  // a no-op anyway since the warning needs strict to render. Also
  // guards against a malformed value from a forged event.
  const handleConfidenceChange = (raw: string) => {
    const next: Confidence | null = CONFIDENCE_OPTIONS.includes(
      raw as Confidence,
    )
      ? (raw as Confidence)
      : null;
    if (!next) return;
    const wasStrict = rule.confidence === "strict";
    const becomingStrict = next === "strict" && !wasStrict;
    onUpdate(
      becomingStrict
        ? { confidence: next, confidenceWarningDismissed: false }
        : { confidence: next },
    );
  };

  const handleSignalChange = (idx: number, signal: SignalKind) => {
    // Switching to/from `calendar.event` switches the op set —
    // pick a sensible default so the value field doesn't carry
    // over an unsupported op (e.g. "contains" on calendar.event).
    const currentOp = rule.when[idx]?.op;
    const op =
      signal === "calendar.event" || currentOp === "is-active"
        ? defaultOpForSignal(signal)
        : (currentOp ?? defaultOpForSignal(signal));
    setCondition(idx, { signal, op });
  };

  const addCondition = () => onUpdate({ when: withConditionAdded(rule.when) });

  const removeCondition = (idx: number) =>
    onUpdate({ when: withConditionRemoved(rule.when, idx) });

  const [dragOver, setDragOver] = useState(false);

  return (
    <li
      className={`rule${expanded ? " is-open" : ""}${rule.enabled ? "" : " is-off"}`}
      data-drag-over={dragOver || undefined}
      onDragOver={(e) => {
        // Allow drop on every row in the list. The default action
        // is to refuse, so we have to preventDefault explicitly.
        e.preventDefault();
        if (!dragOver) setDragOver(true);
      }}
      onDragLeave={() => {
        if (dragOver) setDragOver(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        onDropAtIndex(index);
      }}
    >
      <header
        className="rule-head"
        // `draggable` lives on the header, not the whole <li>. The
        // expanded body has text inputs and selects — putting
        // `draggable` on their ancestor hijacks text selection on
        // macOS/Windows and makes the inputs feel broken. With the
        // header as the drag handle, the user can only initiate a
        // drag from the visible "grip" area, which matches the
        // grab-cursor affordance on `.rule-drag`.
        draggable
        onDragStart={(e) => {
          // Stash the source index in the parent ref. We also touch
          // `dataTransfer` with a token string so Firefox actually
          // initiates the drag — it refuses to start without
          // *something* on the transfer object.
          try {
            e.dataTransfer.setData("text/plain", String(index));
            e.dataTransfer.effectAllowed = "move";
          } catch {
            // jsdom / some browsers throw on dataTransfer access in
            // certain modes — ignore; the ref-based source-index path
            // doesn't need this to succeed.
          }
          onDragStartIndex(index);
        }}
        onDragEnd={() => {
          // Reset the source-index ref even when the drag ends
          // outside any drop target (Escape, drag-off-window).
          // Without this a follow-up drop on an unrelated element
          // would fire with a stale `from` index.
          onDragStartIndex(-1);
          setDragOver(false);
        }}
      >
        {/* `.rule-disclose` is the actual disclosure control. The
            surrounding `<header>` used to carry `role="button"`,
            but axe's `nested-interactive` (rightly) rejects a
            button that contains a focusable checkbox + a
            draggable handle. Splitting the row keeps the row
            clickable while putting a real `<button>` on the
            keyboard-accessible path. */}
        <button
          type="button"
          className="rule-disclose"
          aria-expanded={expanded}
          aria-controls={expanded ? `rule-body-${rule.id}` : undefined}
          aria-label={`Rule ${index + 1}: ${rule.name}`}
          aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
          onClick={(e) => {
            stopBubble(e);
            onToggle();
          }}
          onKeyDown={(e) => {
            // Alt+↑/↓: keyboard alternative to the drag handle. The
            // spec requires this so power users without a mouse can
            // still order their rules. Bounds-checked so a no-op key
            // press at the top/bottom doesn't fire a useless IPC.
            if (e.altKey && e.key === "ArrowUp" && index > 0) {
              e.preventDefault();
              onMove(index - 1);
              return;
            }
            if (e.altKey && e.key === "ArrowDown" && index < total - 1) {
              e.preventDefault();
              onMove(index + 1);
              return;
            }
          }}
        >
          <Icon
            name="drag"
            size={14}
            className="rule-drag"
            aria-hidden="true"
          />
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
              <ProjectChip project={project} />
            ) : (
              <span className="rule-tags-only">+ tags</span>
            )}
          </span>
          <span className="rule-stats">{rule.matchedToday}× today</span>
        </button>
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
          aria-hidden="true"
        />
      </header>

      {expanded && (
        <div className="rule-body" id={`rule-body-${rule.id}`}>
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
                      c.any ? "OR — switch to AND" : "AND — switch to OR"
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
                {c.signal === "app.category" && (
                  <p className="cond-hint">
                    {appCategoryHint(c.value, appCategories)}
                  </p>
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
                <select
                  className="rule-conf"
                  value={rule.confidence ?? "suggestive"}
                  onClick={stopBubble}
                  onChange={(e) => handleConfidenceChange(e.target.value)}
                  aria-label="Confidence"
                  aria-describedby={
                    shouldWarnConfidence(rule)
                      ? `rule-conf-warn-${rule.id}`
                      : undefined
                  }
                >
                  <option value="suggestive">suggestive</option>
                  <option value="strict">strict</option>
                </select>
              </div>
              {shouldWarnConfidence(rule) && (
                <div
                  id={`rule-conf-warn-${rule.id}`}
                  className="rule-meta-warn"
                  role="note"
                >
                  <Icon name="info" size={12} className="warn-ic" />
                  <span className="warn-text">
                    This rule may auto-start aggressively. Consider switching to{" "}
                    <em>Suggestive</em>.
                  </span>
                  <button
                    type="button"
                    className="warn-dismiss"
                    aria-label="Dismiss warning"
                    onClick={(e) => {
                      stopBubble(e);
                      onUpdate({ confidenceWarningDismissed: true });
                    }}
                  >
                    Dismiss
                  </button>
                </div>
              )}
              <div className="rule-meta-row">
                {/* Label text matches the spoken accessible name — the
                    `<label htmlFor>` association IS the SR-name source
                    of truth, so we drop the (mismatched) `aria-label`. */}
                <label htmlFor={`rule-amb-${rule.id}`}>If ambiguous</label>
                <select
                  id={`rule-amb-${rule.id}`}
                  className="rule-amb"
                  value={rule.ambiguityBehavior ?? "prompt"}
                  onClick={stopBubble}
                  onChange={(e) => {
                    // Guard against a forged event value via the
                    // shared `coerceAmbiguity` helper — same source
                    // of truth as the body deserializer. An unknown
                    // value coerces to "prompt" (the safe default).
                    const next = AMBIGUITY_OPTIONS.includes(
                      e.target.value as AmbiguityBehavior,
                    )
                      ? coerceAmbiguity(e.target.value)
                      : null;
                    if (next) onUpdate({ ambiguityBehavior: next });
                  }}
                >
                  <option value="prompt">prompt me</option>
                  <option value="skip">skip</option>
                  <option value="log-to-uncategorized">
                    log to uncategorized
                  </option>
                </select>
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

const HINT_MAX_APPS = 6;

/** Helper text under an `app.category` condition: which apps the entered
 *  category matches. Falls back to listing the valid category names when the
 *  value is empty or unrecognised, so the user can see their options (#189).
 *  Returns "" when the table hasn't loaded (helper text is optional). */
export function appCategoryHint(
  value: string,
  categories: AppCategory[],
): string {
  if (categories.length === 0) return "";
  const match = categories.find(
    (c) => c.category.toLowerCase() === value.trim().toLowerCase(),
  );
  if (!match) {
    return `Use one of: ${categories.map((c) => c.category).join(", ")}`;
  }
  const shown = match.apps.slice(0, HINT_MAX_APPS).join(", ");
  const more = match.apps.length > HINT_MAX_APPS ? ", …" : "";
  return `Matches ${match.label.toLowerCase()}: ${shown}${more}`;
}

function SignalIcon({ kind, small }: { kind: SignalKind; small?: boolean }) {
  const name: IconName =
    kind === "ide.folder"
      ? "folder"
      : kind === "git.branch"
        ? "branch"
        : kind === "browser.domain"
          ? "globe"
          : kind === "browser.tab"
            ? "globe"
            : kind === "window.title"
              ? "type"
              : kind === "calendar.event"
                ? "calendar"
                : kind === "app.category"
                  ? "grid"
                  : "info";
  return <Icon name={name} size={small ? 11 : 12} className="sig-ic" />;
}

interface DebouncedTextInputProps extends Omit<
  React.InputHTMLAttributes<HTMLInputElement>,
  "value" | "onChange" | "defaultValue"
> {
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
