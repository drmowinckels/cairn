import type { Confidence, Project, Rule, RuleCondition } from "./types";
import type { RuleTemplate } from "./use-rules";

/**
 * A bundled, disabled-by-default rule template surfaced in the Rules view's
 * "Suggestions" section (#189). Starters are never auto-applied — they show a
 * new user what's possible out of the box. Adopting one creates the named
 * project (if absent) and a real rule from `when` + `tags`.
 */
export interface StarterRule {
  id: string;
  name: string;
  /** One-line "what this tracks" shown under the suggestion. */
  description: string;
  /** Project to attribute matches to; created on adopt if it doesn't exist. */
  project: { name: string; color: string };
  confidence: Confidence;
  when: RuleCondition[];
}

/**
 * The shipped starter set. Both lean on the `app.category` condition (#189) so
 * one rule covers a whole class of apps. Kept deliberately small — these are a
 * starting point, not a catalogue.
 */
export const STARTER_RULES: StarterRule[] = [
  {
    id: "meetings",
    name: "Meetings",
    description: "Track time in Zoom, Teams, Webex and other meeting apps.",
    project: { name: "Meetings", color: "#c8b8e0" },
    confidence: "suggestive",
    when: [{ signal: "app.category", op: "equals", value: "meeting" }],
  },
  {
    id: "coding",
    name: "Coding",
    description: "Track time spent in your code editor or IDE.",
    project: { name: "Development", color: "#81b29a" },
    confidence: "suggestive",
    when: [{ signal: "app.category", op: "equals", value: "editor" }],
  },
];

export const STARTER_DISMISSED_KEY = "cairn:starter-rules:dismissed:v1";

function conditionKey(c: RuleCondition): string {
  return `${c.signal}|${c.op}|${c.value}`;
}

/**
 * A starter is "adopted" once some existing rule already carries all of its
 * conditions — whether the user adopted it here or wrote an equivalent rule by
 * hand. Matching on conditions (not name) means a renamed rule still counts,
 * and deleting the rule brings the suggestion back.
 */
export function isStarterAdopted(starter: StarterRule, rules: Rule[]): boolean {
  const need = starter.when.map(conditionKey);
  return rules.some((r) => {
    const have = new Set(r.when.map(conditionKey));
    return need.every((k) => have.has(k));
  });
}

function safeParseIds(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((x): x is string => typeof x === "string")
      : [];
  } catch {
    return [];
  }
}

export function loadDismissedStarters(): string[] {
  return safeParseIds(window.localStorage.getItem(STARTER_DISMISSED_KEY));
}

export function persistDismissedStarter(id: string): string[] {
  const next = Array.from(new Set([...loadDismissedStarters(), id]));
  window.localStorage.setItem(STARTER_DISMISSED_KEY, JSON.stringify(next));
  return next;
}

/** Starters still worth suggesting: neither adopted nor dismissed. */
export function pendingStarters(
  rules: Rule[],
  dismissed: string[],
): StarterRule[] {
  const dis = new Set(dismissed);
  return STARTER_RULES.filter(
    (s) => !dis.has(s.id) && !isStarterAdopted(s, rules),
  );
}

export interface AdoptStarterDeps {
  projects: Project[];
  createProject: (input: { name: string; color: string }) => Promise<Project>;
  addFromTemplate: (template: RuleTemplate) => Promise<string>;
}

/**
 * Adopt a starter: find-or-create its project (by case-insensitive name) and
 * create a rule from its conditions. Returns an error message on failure (the
 * project create or rule save) or `null` on success — the caller surfaces it
 * without needing its own try/catch, which keeps the orchestration testable
 * in isolation from React state.
 */
export async function adoptStarter(
  starter: StarterRule,
  deps: AdoptStarterDeps,
): Promise<string | null> {
  try {
    const existing = deps.projects.find(
      (p) => p.name.toLowerCase() === starter.project.name.toLowerCase(),
    );
    const project =
      existing ??
      (await deps.createProject({
        name: starter.project.name,
        color: starter.project.color,
      }));
    await deps.addFromTemplate({
      name: starter.name,
      when: starter.when,
      then: { project: project.id },
      confidence: starter.confidence,
    });
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}
