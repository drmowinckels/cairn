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

export interface Rule {
  id: string;
  name: string;
  enabled: boolean;
  when: RuleCondition[];
  then: {
    project: ProjectId | null;
    taskId?: TaskId | null;
    tagsFromCalendar?: boolean;
  };
  matchedToday: number;
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
