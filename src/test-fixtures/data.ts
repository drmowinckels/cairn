import type {
  Client,
  Entry,
  LiveSignal,
  Project,
  Rule,
  RunningEntry,
  Task,
  UpcomingItem,
  WeekDay,
} from "../lib/types";
import { minutesOf as m } from "../lib/time";

export const CLIENTS: Client[] = [
  { id: "c-acme",     name: "ACME Co.",    color: null, archived: false },
  { id: "c-os",       name: "Open source", color: null, archived: false },
  { id: "c-internal", name: "Internal",    color: null, archived: false },
];

export const CLIENT_BY_ID = Object.fromEntries(
  CLIENTS.map((c) => [c.id, c]),
) as Record<string, Client>;

export const PROJECTS: Project[] = [
  { id: "acme",  name: "acme-web",      clientId: "c-acme",     color: "#81b29a", archived: false, estimateHours: 40 },
  { id: "cairn", name: "Cairn",         clientId: "c-os",       color: "#f2cc8f", archived: false, estimateHours: null },
  { id: "site",  name: "Personal site", clientId: null,         color: "#e07a5f", archived: false, estimateHours: null },
  { id: "ops",   name: "Operations",    clientId: "c-internal", color: "#9a9bb0", archived: false, estimateHours: null },
  { id: "mtg",   name: "Meetings",      clientId: null,         color: "#c8b8e0", archived: false, estimateHours: null },
];

export const PROJECT_BY_ID = Object.fromEntries(
  PROJECTS.map((p) => [p.id, p]),
) as Record<string, Project>;

export const TASKS: Task[] = [
  { id: "t-acme-design",   projectId: "acme",  name: "Design",     archived: false },
  { id: "t-acme-impl",     projectId: "acme",  name: "Implementation", archived: false },
  { id: "t-cairn-ui",      projectId: "cairn", name: "UI",         archived: false },
  { id: "t-cairn-rules",   projectId: "cairn", name: "Rules engine", archived: false },
  { id: "t-mtg-1on1",      projectId: "mtg",   name: "1:1",        archived: false },
  { id: "t-mtg-team",      projectId: "mtg",   name: "Team",       archived: false },
];

export const TASK_BY_ID = Object.fromEntries(
  TASKS.map((t) => [t.id, t]),
) as Record<string, Task>;

export const TODAY: Entry[] = [
  { start: m(9, 12),  end: m(10, 45), project: "acme",  taskId: "t-acme-design", description: "API redesign discussion", source: "manual" },
  { start: m(11, 0),  end: m(12, 30), project: "acme",  taskId: "t-acme-impl",   description: "Endpoint refactor",       source: "rule:repo=acme-web" },
  { start: m(13, 15), end: m(14, 0),  project: "mtg",   taskId: "t-mtg-1on1",    description: "1:1 with Sarah",          source: "calendar" },
  { start: m(14, 0),  end: m(14, 48), project: "cairn", taskId: "t-cairn-rules", description: "Rule preview UI",         source: "rule:branch=feat/rules" },
];

export const NOW_MIN = m(15, 2);

export const RUNNING: RunningEntry = {
  start: m(14, 48),
  project: "cairn",
  taskId: "t-cairn-rules",
  description: "Rule preview UI",
  source: "rule:branch=feat/rules",
};

export const WEEK: WeekDay[] = [
  { day: "Mon", hours: 6.2, segments: [["acme", 3.5], ["cairn", 1.8], ["ops", 0.9]] },
  { day: "Tue", hours: 7.1, segments: [["acme", 4.4], ["mtg", 1.2],   ["cairn", 1.5]] },
  { day: "Wed", hours: 5.8, segments: [["acme", 2.8], ["site", 1.7],  ["mtg", 1.3]] },
  { day: "Thu", hours: 4.4, segments: [["acme", 3.1], ["mtg", 0.75],  ["cairn", 0.55]], today: true },
  { day: "Fri", hours: 0,   segments: [], future: true },
  { day: "Sat", hours: 0,   segments: [], future: true, weekend: true },
  { day: "Sun", hours: 0,   segments: [], future: true, weekend: true },
];

export const RULES: Rule[] = [
  {
    id: "r1", name: "Cairn dev work", enabled: true, priority: 10,
    when: [{ signal: "ide.folder", op: "contains", value: "cairn" }],
    then: { project: "cairn", taskId: "t-cairn-rules" },
    matchedToday: 3,
  },
  {
    id: "r2", name: "Feature branch", enabled: true, priority: 20,
    when: [{ signal: "git.branch", op: "starts-with", value: "feat/" }],
    then: { project: null },
    matchedToday: 5,
  },
  {
    id: "r3", name: "ACME work", enabled: true, priority: 30,
    when: [
      { signal: "ide.folder",     op: "contains", value: "acme-web",            any: true },
      { signal: "browser.domain", op: "equals",   value: "acme.atlassian.net",  any: true },
      { signal: "browser.domain", op: "equals",   value: "github.com/acme",     any: true },
    ],
    then: { project: "acme", taskId: "t-acme-impl" },
    matchedToday: 12,
  },
  {
    id: "r4", name: "Calendar meetings", enabled: true, priority: 40,
    when: [{ signal: "calendar.event", op: "is-active", value: "any" }],
    then: { project: "mtg", tagsFromCalendar: true },
    matchedToday: 1,
  },
  {
    id: "r5", name: "Personal site", enabled: false, priority: 50,
    when: [{ signal: "ide.folder", op: "contains", value: "personal-site" }],
    then: { project: "site" },
    matchedToday: 0,
  },
];

export const SIGNAL_LABELS: Record<string, string> = {
  "ide.folder":     "IDE folder",
  "git.branch":     "Git branch",
  "browser.domain": "Browser domain",
  "browser.tab":    "Browser tab title",
  "window.title":   "Window title",
  "calendar.event": "Calendar event",
  "app.name":       "App name",
  "app.category":   "App category",
};

export const OP_LABELS: Record<string, string> = {
  "contains":    "contains",
  "equals":      "equals",
  "starts-with": "starts with",
  "ends-with":   "ends with",
  "matches":     "matches /regex/",
  "is-active":   "is happening",
};

export const LIVE_SIGNALS: LiveSignal[] = [
  { signal: "ide.folder",     value: "~/code/cairn",       app: "Zed" },
  { signal: "git.branch",     value: "feat/rules-ui",      app: "Zed" },
  { signal: "window.title",   value: "rules.tsx — cairn",  app: "Zed" },
  { signal: "browser.domain", value: "github.com/cairn",   app: "Safari" },
];

export const UPCOMING: UpcomingItem[] = [
  { at: m(15, 30), label: "Design review", duration: 30, project: "mtg" },
  { at: m(16, 30), label: "Focus block",   duration: 60, project: null },
];
