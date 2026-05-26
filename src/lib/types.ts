export type ClientId = string;
export type ProjectId = string;
export type TaskId = string;

export interface Client {
  id: ClientId;
  name: string;
  color: string | null;
  archived: boolean;
}

export interface Project {
  id: ProjectId;
  name: string;
  clientId: ClientId | null;
  color: string;
  archived: boolean;
}

export interface Task {
  id: TaskId;
  projectId: ProjectId;
  name: string;
  archived: boolean;
}

export type EntrySource =
  | "manual"
  | "calendar"
  | `rule:${string}`;

/** Test-fixture entry shape — uses minutes-of-day for start/end to keep
 *  the demo timeline cheap to author. Real DB entries flow through
 *  TodayEntry in use-today.ts. */
export interface Entry {
  start: number;
  end: number;
  project: ProjectId;
  taskId?: TaskId | null;
  description: string;
  source: EntrySource;
}

export interface RunningEntry {
  start: number;
  project: ProjectId;
  taskId?: TaskId | null;
  description: string;
  source: EntrySource;
}

export type SignalKind =
  | "ide.folder"
  | "git.branch"
  | "browser.domain"
  | "browser.tab"
  | "window.title"
  | "calendar.event"
  | "app.name";

export type Op =
  | "contains"
  | "equals"
  | "starts-with"
  | "ends-with"
  | "matches"
  | "is-active";

export interface RuleCondition {
  signal: SignalKind;
  op: Op;
  value: string;
  any?: boolean;
}

export type Confidence = "suggestive" | "strict";

/**
 * What to do for a `Suggestive` match (RULES_ENGINE.md §4, issue #16):
 * - `prompt` (default): show the suggestion banner; user confirms.
 * - `skip`: drop the match silently.
 * - `log-to-uncategorized`: auto-start a timer with `projectId = null`
 *   and `source = "rule"` so the entry surfaces uncategorized.
 *
 * Strict matches always auto-start and ignore this field.
 */
export type AmbiguityBehavior = "prompt" | "skip" | "log-to-uncategorized";

export interface RuleAction {
  project: ProjectId | null;
  taskId?: TaskId | null;
  tagsFromCalendar?: boolean;
  /**
   * Optional template string for the resulting time entry's
   * description. Tokens like `{calendar.event}` get substituted
   * at match time. Empty / absent ⇒ no description.
   */
  descriptionTemplate?: string;
}

export interface Rule {
  id: string;
  name: string;
  enabled: boolean;
  /**
   * Lower is earlier-evaluated. The matcher iterates rules in
   * priority order (asc) and returns the first match — so a lower
   * priority means a rule "wins" against a later one. The drag-to-
   * reorder UI in #15 will rewrite priorities transactionally.
   */
  priority: number;
  confidence?: Confidence;
  /**
   * Per-rule "if ambiguous" behaviour (RULES_ENGINE.md §4, #16).
   * Defaults to `"prompt"` for rules persisted before this field
   * existed.
   */
  ambiguityBehavior?: AmbiguityBehavior;
  when: RuleCondition[];
  then: RuleAction;
  matchedToday: number;
  /**
   * Set when the user dismisses the confidence-heuristic warning
   * (see #14, RULES_ENGINE.md §5). Persisted in the rule body so
   * the dismissal sticks across sessions. Per-rule, not global.
   */
  confidenceWarningDismissed?: boolean;
}

/**
 * Payload of the `signal:idle-resume` Tauri event. The backend
 * fires this when the user returns from an idle period that
 * crossed the configured threshold (default 5 min). The Today
 * view's idle modal listens via `useIdlePrompt`.
 */
export interface IdleResumeEvent {
  since: string;
  until: string;
  durationSeconds: number;
}

/**
 * Payload of the `signal:match` Tauri event. The backend fires
 * this on every snapshot publish where a rule fires. The UI's
 * `useSuggestion` hook decides what to do based on
 * `confidence`: Suggestive → banner; Strict → auto-start.
 */
export interface RuleMatchEvent {
  ruleId: string;
  ruleName: string;
  confidence: Confidence;
  /**
   * Per-rule ambiguity behaviour (#16). `useSuggestion` dispatches
   * on this for `confidence: "suggestive"` matches; strict matches
   * ignore the field.
   */
  ambiguityBehavior: AmbiguityBehavior;
  project: ProjectId | null;
  tags: string[];
  /**
   * Pre-substituted description from the rule's `description_template`
   * (e.g. `"Meeting: Stand-up"` after `{calendar.event}` resolution).
   * Empty string when the rule has no template.
   */
  description: string;
}

export interface LiveSignal {
  signal: SignalKind;
  value: string;
  app: string;
}

export interface UpcomingItem {
  at: number;
  label: string;
  duration: number;
  project: ProjectId | null;
}

export interface WeekDay {
  day: string;
  hours: number;
  segments: Array<[ProjectId, number]>;
  today?: boolean;
  future?: boolean;
  weekend?: boolean;
}

export type Density = "comfy" | "compact";
export type LayoutVariant = "default" | "projects-first";
export type RulesComplexity = "light" | "medium" | "heavy";
export type Theme = "light" | "dark";
export type View = "today" | "reports" | "rules" | "projects" | "settings";

export type TextScale = "sm" | "md" | "lg" | "xl";
export type DetectionPrompts = "off" | "subtle" | "modal";
export type ThemePref = "system" | "light" | "dark";

export interface A11yPrefs {
  theme: ThemePref;
  textScale: TextScale;
  highContrast: boolean;
  reduceMotion: boolean;
  colorblindSafe: boolean;
  announce: boolean;
  alwaysFocusRing: boolean;
  detectionPrompts: DetectionPrompts;
}
