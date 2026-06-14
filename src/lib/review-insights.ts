import type { BackendEntry, ReportSummary } from "./ipc";
import type { MatchedSignal, RuleMatchEvent } from "./types";

const STORAGE_KEY = "cairn:suggestion-feedback:v1";
export const DISMISSED_LEARNING_KEY = "cairn:rule-learning:dismissed:v1";
const MAX_EVENTS = 400;
const NULL_PROJECT_KEY = "_none";
const MIN_OCCURRENCES_FOR_LEARNING = 3;
const MIN_LEARNING_CONFIDENCE = 0.67;
const GAP_THRESHOLD_MINUTES = 20;
const DEEP_WORK_THRESHOLD_MINUTES = 45;
const FRAGMENTED_THRESHOLD_MINUTES = 15;

export type SuggestionOutcome = "confirmed" | "dismissed" | "changed";

export interface SuggestionFeedbackEvent {
  timestamp: string;
  ruleId: string;
  ruleName: string;
  sourceProjectId: string | null;
  selectedProjectId: string | null;
  matchedSignals: MatchedSignal[];
  outcome: SuggestionOutcome;
}

export interface LearnedRuleCandidate {
  signature: string;
  confidence: number;
  projectId: string | null;
  sampleRuleName: string;
  conditions: Array<{ signal: MatchedSignal["signal"]; value: string }>;
  confirms: number;
  changes: number;
}

export interface ReviewInboxItem {
  id: string;
  kind: "no-project" | "gap" | "dismissed-suggestion";
  title: string;
  detail: string;
  entryIds: string[];
}

export interface FocusInsights {
  contextSwitches: number;
  deepWorkBlocks: number;
  deepWorkMinutes: number;
  fragmentedBlocks: number;
  meetingMinutes: number;
}

export interface WeeklyTrustSummary {
  autoClassifiedPct: number;
  manualPct: number;
  unresolvedSeconds: number;
  correctedSuggestions: number;
  dismissedSuggestions: number;
}

function nowIso(): string {
  return new Date().toISOString();
}

function safeParse(raw: string | null): SuggestionFeedbackEvent[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is SuggestionFeedbackEvent => {
      if (!item || typeof item !== "object") return false;
      const obj = item as Record<string, unknown>;
      return (
        typeof obj.timestamp === "string" &&
        typeof obj.ruleId === "string" &&
        typeof obj.ruleName === "string" &&
        (obj.sourceProjectId === null ||
          typeof obj.sourceProjectId === "string") &&
        (obj.selectedProjectId === null ||
          typeof obj.selectedProjectId === "string") &&
        Array.isArray(obj.matchedSignals) &&
        (obj.outcome === "confirmed" ||
          obj.outcome === "dismissed" ||
          obj.outcome === "changed")
      );
    });
  } catch {
    return [];
  }
}

export function loadSuggestionFeedback(): SuggestionFeedbackEvent[] {
  if (typeof window === "undefined") return [];
  return safeParse(window.localStorage.getItem(STORAGE_KEY));
}

export function saveSuggestionFeedback(
  events: SuggestionFeedbackEvent[],
): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify(events.slice(-MAX_EVENTS)),
  );
}

/** Wipe the locally-persisted feedback log + dismissed-learning marker. Called
 *  by "Delete everything" so the privacy reset clears this log too (the matched
 *  signal values it holds are documented in `docs/PRIVACY.md`). */
export function clearReviewInsights(): void {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(STORAGE_KEY);
  window.localStorage.removeItem(DISMISSED_LEARNING_KEY);
}

export function recordSuggestionFeedback(
  existing: SuggestionFeedbackEvent[],
  match: RuleMatchEvent,
  outcome: SuggestionOutcome,
  selectedProjectId: string | null,
): SuggestionFeedbackEvent[] {
  const next = [
    ...existing,
    {
      timestamp: nowIso(),
      ruleId: match.ruleId,
      ruleName: match.ruleName,
      sourceProjectId: match.project ?? null,
      selectedProjectId,
      matchedSignals: match.matchedSignals ?? [],
      outcome,
    },
  ];
  return next.slice(-MAX_EVENTS);
}

function dayKey(iso: string): string {
  return iso.slice(0, 10);
}

export function eventsInLastDays(
  events: SuggestionFeedbackEvent[],
  days: number,
): SuggestionFeedbackEvent[] {
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  return events.filter((e) => Date.parse(e.timestamp) >= cutoff);
}

export function suggestionSignature(event: SuggestionFeedbackEvent): string {
  // `MatchedSignal.value` is always a string in the event schema (`types.ts`).
  const signalParts = [...event.matchedSignals]
    .sort((a, b) => a.signal.localeCompare(b.signal))
    .map((s) => `${s.signal}:${s.value.toLowerCase()}`);
  return `${event.ruleId}|${signalParts.join("|")}`;
}

function effectiveProjectKey(event: SuggestionFeedbackEvent): string {
  return event.selectedProjectId ?? event.sourceProjectId ?? NULL_PROJECT_KEY;
}

export function bestLearnedRuleCandidate(
  events: SuggestionFeedbackEvent[],
): LearnedRuleCandidate | null {
  const recent = eventsInLastDays(events, 14).filter(
    (e) => e.outcome === "confirmed" || e.outcome === "changed",
  );
  const groups = new Map<string, SuggestionFeedbackEvent[]>();
  for (const event of recent) {
    if (event.matchedSignals.length === 0) continue;
    const key = suggestionSignature(event);
    const list = groups.get(key) ?? [];
    list.push(event);
    groups.set(key, list);
  }
  let best: LearnedRuleCandidate | null = null;
  for (const [signature, group] of groups) {
    const confirms = group.filter((e) => e.outcome === "confirmed").length;
    const changes = group.filter((e) => e.outcome === "changed").length;
    const total = confirms + changes;
    if (total < MIN_OCCURRENCES_FOR_LEARNING) continue;

    const projectCounts = new Map<string, number>();
    for (const event of group) {
      const project = effectiveProjectKey(event);
      projectCounts.set(project, (projectCounts.get(project) ?? 0) + 1);
    }
    let projectKey = NULL_PROJECT_KEY;
    let projectVotes = 0;
    for (const [key, votes] of projectCounts) {
      if (votes > projectVotes) {
        projectKey = key;
        projectVotes = votes;
      }
    }
    const confidence = projectVotes / total;
    if (confidence < MIN_LEARNING_CONFIDENCE) continue;

    const sample = group[group.length - 1];
    const candidate: LearnedRuleCandidate = {
      signature,
      confidence,
      projectId: projectKey === NULL_PROJECT_KEY ? null : projectKey,
      sampleRuleName: sample.ruleName,
      conditions: sample.matchedSignals.map((s) => ({
        signal: s.signal,
        value: s.value,
      })),
      confirms,
      changes,
    };
    if (!best || candidate.confidence > best.confidence) best = candidate;
  }
  return best;
}

type ClosedEntry = BackendEntry & { endedAt: string };

function isClosed(entry: BackendEntry): entry is ClosedEntry {
  return entry.endedAt !== null;
}

function entryMinutes(entry: ClosedEntry): number {
  return Math.max(
    0,
    Math.round(
      (Date.parse(entry.endedAt) - Date.parse(entry.startedAt)) / 60_000,
    ),
  );
}

export function buildReviewInbox(
  entries: BackendEntry[],
  events: SuggestionFeedbackEvent[],
): ReviewInboxItem[] {
  const items: ReviewInboxItem[] = [];
  const noProject = entries.filter((e) => e.projectId === null);
  if (noProject.length > 0) {
    items.push({
      id: "no-project",
      kind: "no-project",
      title: "Unassigned time",
      detail: `${noProject.length} entries without a project`,
      entryIds: noProject.map((e) => e.id),
    });
  }

  const sorted = [...entries]
    .filter(isClosed)
    .sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
  let gapCount = 0;
  for (let i = 1; i < sorted.length; i += 1) {
    const prevEnd = Date.parse(sorted[i - 1].endedAt);
    const nextStart = Date.parse(sorted[i].startedAt);
    const gapMinutes = Math.floor((nextStart - prevEnd) / 60_000);
    if (gapMinutes >= GAP_THRESHOLD_MINUTES) gapCount += 1;
  }
  if (gapCount > 0) {
    items.push({
      id: "gaps",
      kind: "gap",
      title: "Timeline gaps",
      detail: `${gapCount} gaps of ${GAP_THRESHOLD_MINUTES}+ minutes`,
      entryIds: [],
    });
  }

  const today = dayKey(nowIso());
  const dismissedToday = events.filter(
    (e) => dayKey(e.timestamp) === today && e.outcome === "dismissed",
  ).length;
  if (dismissedToday > 0) {
    items.push({
      id: "dismissed-suggestions",
      kind: "dismissed-suggestion",
      title: "Dismissed suggestions",
      detail: `${dismissedToday} suggestions need later review`,
      entryIds: [],
    });
  }
  return items;
}

export function computeFocusInsights(entries: BackendEntry[]): FocusInsights {
  const closed = [...entries]
    .filter(isClosed)
    .sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
  let switches = 0;
  let deepBlocks = 0;
  let deepMinutes = 0;
  let fragmented = 0;
  let meetingMinutes = 0;
  let prevProject: string | null | undefined;
  for (const entry of closed) {
    const minutes = entryMinutes(entry);
    if (
      prevProject !== undefined &&
      prevProject !== null &&
      entry.projectId !== null &&
      prevProject !== entry.projectId
    ) {
      switches += 1;
    }
    prevProject = entry.projectId;
    if (minutes >= DEEP_WORK_THRESHOLD_MINUTES) {
      deepBlocks += 1;
      deepMinutes += minutes;
    }
    if (minutes > 0 && minutes <= FRAGMENTED_THRESHOLD_MINUTES) fragmented += 1;
    if (entry.source === "calendar") meetingMinutes += minutes;
  }
  return {
    contextSwitches: switches,
    deepWorkBlocks: deepBlocks,
    deepWorkMinutes: deepMinutes,
    fragmentedBlocks: fragmented,
    meetingMinutes,
  };
}

export function weeklyTrustSummary(
  summary: ReportSummary | null,
  feedback: SuggestionFeedbackEvent[],
): WeeklyTrustSummary {
  if (!summary || summary.totalSeconds <= 0) {
    return {
      autoClassifiedPct: 0,
      manualPct: 0,
      unresolvedSeconds: 0,
      correctedSuggestions: 0,
      dismissedSuggestions: 0,
    };
  }
  const auto = summary.bySource.rule + summary.bySource.calendar;
  const unresolvedSeconds = summary.byProject
    .filter((s) => s.projectId === null)
    .reduce((acc, s) => acc + s.seconds, 0);
  const weekEvents = eventsInLastDays(feedback, 7);
  return {
    autoClassifiedPct: Math.round((auto / summary.totalSeconds) * 100),
    manualPct: Math.round(
      (summary.bySource.manual / summary.totalSeconds) * 100,
    ),
    unresolvedSeconds,
    correctedSuggestions: weekEvents.filter((e) => e.outcome === "changed")
      .length,
    dismissedSuggestions: weekEvents.filter((e) => e.outcome === "dismissed")
      .length,
  };
}

export function plannedVsActualMinutes(entries: BackendEntry[]): {
  planned: number;
  actual: number;
  drift: number;
} {
  const closed = entries.filter(isClosed);
  let planned = 0;
  let actual = 0;
  for (const entry of closed) {
    const minutes = entryMinutes(entry);
    if (entry.source === "calendar") planned += minutes;
    else actual += minutes;
  }
  return { planned, actual, drift: actual - planned };
}
