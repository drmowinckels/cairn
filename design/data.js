// data.js — sample data for the Cairn prototype.
// Loaded as a plain script so all vars become globals.

const PROJECTS = [
  { id: "acme", name: "acme-web",         client: "ACME Co.",     color: "#81b29a" }, // muted-teal
  { id: "cairn", name: "Cairn",           client: "Open source",  color: "#f2cc8f" }, // apricot-cream
  { id: "site",  name: "Personal site",   client: null,           color: "#e07a5f" }, // burnt-peach
  { id: "ops",   name: "Operations",      client: "Internal",     color: "#9a9bb0" }, // muted indigo
  { id: "mtg",   name: "Meetings",        client: null,           color: "#c8b8e0" }, // soft violet
];

const PROJECT_BY_ID = Object.fromEntries(PROJECTS.map(p => [p.id, p]));

// Today's entries — assume "now" is 15:02.
// minutes since 00:00
const m = (h, min) => h * 60 + (min || 0);

const TODAY = [
  { start: m(9,12),  end: m(10,45), project: "acme",  task: "API redesign discussion", tags: ["api","design"], source: "manual" },
  { start: m(11,0),  end: m(12,30), project: "acme",  task: "Endpoint refactor",        tags: ["api","refactor"], source: "rule:repo=acme-web" },
  { start: m(13,15), end: m(14,0),  project: "mtg",   task: "1:1 with Sarah",            tags: ["1:1"], source: "calendar" },
  { start: m(14,0),  end: m(14,48), project: "cairn", task: "Rule preview UI",           tags: ["ui","rules"], source: "rule:branch=feat/rules" },
  // running entry — handled separately in the timer
];

// Current running entry
const NOW_MIN = m(15,2);
const RUNNING = {
  start: m(14,48),
  project: "cairn",
  task: "Rule preview UI",
  tags: ["ui","rules"],
  source: "rule:branch=feat/rules",
};

// Week totals (Mon..Sun, current = Thu)
const WEEK = [
  { day: "Mon", hours: 6.2,  segments: [["acme",3.5],["cairn",1.8],["ops",0.9]] },
  { day: "Tue", hours: 7.1,  segments: [["acme",4.4],["mtg",1.2],["cairn",1.5]] },
  { day: "Wed", hours: 5.8,  segments: [["acme",2.8],["site",1.7],["mtg",1.3]] },
  { day: "Thu", hours: 4.4,  segments: [["acme",3.1],["mtg",0.75],["cairn",0.55]], today: true },
  { day: "Fri", hours: 0,    segments: [], future: true },
  { day: "Sat", hours: 0,    segments: [], future: true, weekend: true },
  { day: "Sun", hours: 0,    segments: [], future: true, weekend: true },
];

// Rules — ordered by priority
const RULES = [
  {
    id: "r1", name: "Cairn dev work", enabled: true,
    when: [
      { signal: "ide.folder",    op: "contains",  value: "cairn" },
    ],
    then: { project: "cairn", tags: ["dev"] },
    matchedToday: 3,
  },
  {
    id: "r2", name: "Feature branch → tags", enabled: true,
    when: [
      { signal: "git.branch", op: "starts-with", value: "feat/" },
    ],
    then: { tags: ["feature"], project: null },
    matchedToday: 5,
  },
  {
    id: "r3", name: "ACME work", enabled: true,
    when: [
      { signal: "ide.folder",    op: "contains",  value: "acme-web", any: true },
      { signal: "browser.domain",op: "equals",    value: "acme.atlassian.net", any: true },
      { signal: "browser.domain",op: "equals",    value: "github.com/acme",    any: true },
    ],
    then: { project: "acme" },
    matchedToday: 12,
  },
  {
    id: "r4", name: "Calendar meetings", enabled: true,
    when: [
      { signal: "calendar.event", op: "is-active", value: "any" },
    ],
    then: { project: "mtg", tagsFromCalendar: true },
    matchedToday: 1,
  },
  {
    id: "r5", name: "Personal site", enabled: false,
    when: [
      { signal: "ide.folder", op: "contains", value: "personal-site" },
    ],
    then: { project: "site" },
    matchedToday: 0,
  },
];

const SIGNAL_LABELS = {
  "ide.folder":      "IDE folder",
  "git.branch":      "Git branch",
  "browser.domain":  "Browser domain",
  "browser.tab":     "Browser tab title",
  "window.title":    "Window title",
  "calendar.event":  "Calendar event",
  "app.name":        "App name",
};

const OP_LABELS = {
  "contains":    "contains",
  "equals":      "equals",
  "starts-with": "starts with",
  "ends-with":   "ends with",
  "matches":     "matches /regex/",
  "is-active":   "is happening",
};

// Live signals currently observed (for the "why" explanation)
const LIVE_SIGNALS = [
  { signal: "ide.folder",    value: "~/code/cairn",      app: "Zed" },
  { signal: "git.branch",    value: "feat/rules-ui",     app: "Zed" },
  { signal: "window.title",  value: "rules.jsx — cairn", app: "Zed" },
  { signal: "browser.domain",value: "github.com/cairn",  app: "Safari" },
];

// Upcoming calendar
const UPCOMING = [
  { at: m(15,30), label: "Design review", duration: 30, project: "mtg" },
  { at: m(16,30), label: "Focus block",   duration: 60, project: null },
];

// Format helpers
const fmtHm = (min) => {
  const h = Math.floor(min/60), mn = min%60;
  if (h && mn) return `${h}h ${mn}m`;
  if (h) return `${h}h`;
  return `${mn}m`;
};
const fmtClock = (min) => {
  const h = Math.floor(min/60), mn = min%60;
  return `${String(h).padStart(2,"0")}:${String(mn).padStart(2,"0")}`;
};
const fmtRange = (a, b) => `${fmtClock(a)}–${fmtClock(b)}`;

Object.assign(window, {
  PROJECTS, PROJECT_BY_ID, TODAY, NOW_MIN, RUNNING, WEEK, RULES,
  SIGNAL_LABELS, OP_LABELS, LIVE_SIGNALS, UPCOMING,
  fmtHm, fmtClock, fmtRange,
});
