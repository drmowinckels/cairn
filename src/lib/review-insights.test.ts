import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  bestLearnedRuleCandidate,
  buildReviewInbox,
  clearReviewInsights,
  computeFocusInsights,
  eventsInLastDays,
  loadSuggestionFeedback,
  plannedVsActualMinutes,
  recordSuggestionFeedback,
  saveSuggestionFeedback,
  suggestionSignature,
  weeklyTrustSummary,
  type SuggestionFeedbackEvent,
} from "./review-insights";
import type { BackendEntry, ReportSummary } from "./ipc";
import type { RuleMatchEvent } from "./types";

const STORAGE_KEY = "cairn:suggestion-feedback:v1";

const match: RuleMatchEvent = {
  ruleId: "r1",
  ruleName: "Cairn work",
  confidence: "suggestive",
  ambiguityBehavior: "prompt",
  project: "p1",
  tags: [],
  description: "",
  matchedSignals: [
    { signal: "git.branch", value: "feat/review" },
    { signal: "ide.folder", value: "~/code/cairn" },
  ],
};

function entry(over: Partial<BackendEntry>): BackendEntry {
  return {
    id: "e",
    projectId: null,
    taskId: null,
    description: "",
    startedAt: "2026-06-06T08:00:00Z",
    endedAt: "2026-06-06T08:30:00Z",
    source: "manual",
    ruleId: null,
    ...over,
  };
}

function event(
  over: Partial<SuggestionFeedbackEvent>,
): SuggestionFeedbackEvent {
  return {
    timestamp: new Date().toISOString(),
    ruleId: "r1",
    ruleName: "Cairn work",
    sourceProjectId: "p1",
    selectedProjectId: null,
    matchedSignals: [{ signal: "git.branch", value: "feat/review" }],
    outcome: "confirmed",
    ...over,
  };
}

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("review-insights", () => {
  describe("persistence", () => {
    it("round-trips feedback events through localStorage", () => {
      const events = [
        recordSuggestionFeedback([], match, "confirmed", "p1")[0],
      ];
      saveSuggestionFeedback(events);
      const loaded = loadSuggestionFeedback();
      expect(loaded).toHaveLength(1);
      expect(loaded[0].ruleId).toBe("r1");
    });

    it("returns [] when nothing is stored", () => {
      expect(loadSuggestionFeedback()).toEqual([]);
    });

    it("returns [] for malformed JSON", () => {
      window.localStorage.setItem(STORAGE_KEY, "{not json");
      expect(loadSuggestionFeedback()).toEqual([]);
    });

    it("returns [] when the stored value is not an array", () => {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ a: 1 }));
      expect(loadSuggestionFeedback()).toEqual([]);
    });

    it("drops items that don't match the event schema", () => {
      const valid = event({ outcome: "confirmed" });
      const validDismissed = event({
        outcome: "dismissed",
        sourceProjectId: "p2",
      });
      const validChanged = event({
        outcome: "changed",
        selectedProjectId: null,
        sourceProjectId: null,
      });
      window.localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify([
          valid,
          validDismissed,
          validChanged,
          42,
          null,
          { ...valid, timestamp: 1 },
          { ...valid, ruleId: 1 },
          { ...valid, ruleName: 1 },
          { ...valid, sourceProjectId: 1 },
          { ...valid, selectedProjectId: 1 },
          { ...valid, matchedSignals: "nope" },
          { ...valid, outcome: "weird" },
        ]),
      );
      const loaded = loadSuggestionFeedback();
      expect(loaded).toHaveLength(3);
      expect(loaded.map((e) => e.outcome)).toEqual([
        "confirmed",
        "dismissed",
        "changed",
      ]);
    });

    it("is a no-op without a window (load + save + clear)", () => {
      vi.stubGlobal("window", undefined);
      expect(loadSuggestionFeedback()).toEqual([]);
      expect(() => saveSuggestionFeedback([event({})])).not.toThrow();
      expect(() => clearReviewInsights()).not.toThrow();
    });

    it("clears the feedback log and dismissed-learning marker", () => {
      saveSuggestionFeedback([event({})]);
      window.localStorage.setItem("cairn:rule-learning:dismissed:v1", "sig");
      clearReviewInsights();
      expect(loadSuggestionFeedback()).toEqual([]);
      expect(
        window.localStorage.getItem("cairn:rule-learning:dismissed:v1"),
      ).toBeNull();
    });

    it("caps the persisted log at the maximum event count", () => {
      const many = Array.from({ length: 401 }, (_, i) =>
        event({ ruleId: `r${i}` }),
      );
      const capped = recordSuggestionFeedback(many, match, "confirmed", "p1");
      expect(capped).toHaveLength(400);
      expect(capped[capped.length - 1].ruleId).toBe("r1");
    });
  });

  describe("recordSuggestionFeedback", () => {
    it("normalizes a match with no project and no signals", () => {
      const noProject: RuleMatchEvent = {
        ...match,
        project: null,
        matchedSignals: undefined,
      };
      const [recorded] = recordSuggestionFeedback(
        [],
        noProject,
        "dismissed",
        null,
      );
      expect(recorded.sourceProjectId).toBeNull();
      expect(recorded.matchedSignals).toEqual([]);
      expect(recorded.selectedProjectId).toBeNull();
    });
  });

  describe("eventsInLastDays", () => {
    it("excludes events older than the window", () => {
      const fresh = event({ timestamp: new Date().toISOString() });
      const stale = event({ timestamp: "2000-01-01T00:00:00Z" });
      expect(eventsInLastDays([fresh, stale], 7)).toEqual([fresh]);
    });
  });

  describe("suggestionSignature", () => {
    it("sorts signals and lowercases values for a stable key", () => {
      const a = event({
        matchedSignals: [
          { signal: "ide.folder", value: "~/Code/Cairn" },
          { signal: "git.branch", value: "Feat/Review" },
        ],
      });
      const b = event({
        matchedSignals: [
          { signal: "git.branch", value: "feat/review" },
          { signal: "ide.folder", value: "~/code/cairn" },
        ],
      });
      expect(suggestionSignature(a)).toBe(suggestionSignature(b));
    });
  });

  describe("bestLearnedRuleCandidate", () => {
    it("returns null with no events", () => {
      expect(bestLearnedRuleCandidate([])).toBeNull();
    });

    it("finds a candidate from repeated confirmations", () => {
      let events: SuggestionFeedbackEvent[] = [];
      events = recordSuggestionFeedback(events, match, "confirmed", "p1");
      events = recordSuggestionFeedback(events, match, "confirmed", "p1");
      events = recordSuggestionFeedback(events, match, "changed", "p1");
      const candidate = bestLearnedRuleCandidate(events);
      expect(candidate?.projectId).toBe("p1");
      expect(candidate?.conditions).toHaveLength(2);
      expect(candidate?.confirms).toBe(2);
      expect(candidate?.changes).toBe(1);
    });

    it("ignores events with no matched signals and dismissals", () => {
      const events = [
        event({ matchedSignals: [], outcome: "confirmed" }),
        event({ outcome: "dismissed" }),
        event({ outcome: "dismissed" }),
      ];
      expect(bestLearnedRuleCandidate(events)).toBeNull();
    });

    it("requires the minimum number of occurrences", () => {
      const events = [
        event({ outcome: "confirmed" }),
        event({ outcome: "confirmed" }),
      ];
      expect(bestLearnedRuleCandidate(events)).toBeNull();
    });

    it("rejects a pattern below the confidence threshold", () => {
      const events = [
        event({ selectedProjectId: "a", sourceProjectId: null }),
        event({ selectedProjectId: "b", sourceProjectId: null }),
        event({ selectedProjectId: "c", sourceProjectId: null }),
      ];
      expect(bestLearnedRuleCandidate(events)).toBeNull();
    });

    it("proposes a null project when the pattern resolves to no project", () => {
      const events = [
        event({ selectedProjectId: null, sourceProjectId: null }),
        event({ selectedProjectId: null, sourceProjectId: null }),
        event({ selectedProjectId: null, sourceProjectId: null }),
      ];
      const candidate = bestLearnedRuleCandidate(events);
      expect(candidate?.projectId).toBeNull();
    });

    it("keeps the highest-confidence candidate across signatures", () => {
      // Three distinct signatures, evaluated in insertion order. The middle
      // group beats the first (covers the "new best" path); the last is weaker
      // and must be discarded (covers the "keep current best" path).
      const group = (ruleId: string, projects: string[]) =>
        projects.map((p) =>
          event({ ruleId, selectedProjectId: p, sourceProjectId: null }),
        );
      const events = [
        ...group("first", ["a", "a", "a", "other"]), // 3/4 = 0.75
        ...group("middle", ["b", "b", "b"]), // 3/3 = 1.0 → new best
        ...group("last", ["c", "c", "c", "other"]), // 3/4 = 0.75 → discarded
      ];
      const candidate = bestLearnedRuleCandidate(events);
      expect(candidate?.projectId).toBe("b");
      expect(candidate?.confidence).toBe(1);
    });
  });

  describe("buildReviewInbox", () => {
    it("is empty when nothing needs review", () => {
      const entries = [
        entry({ id: "a", projectId: "p1" }),
        entry({
          id: "b",
          projectId: "p1",
          startedAt: "2026-06-06T08:35:00Z",
          endedAt: "2026-06-06T09:00:00Z",
        }),
      ];
      expect(buildReviewInbox(entries, [])).toEqual([]);
    });

    it("flags unassigned entries, gaps, and dismissed suggestions", () => {
      const entries = [
        entry({ id: "a", projectId: null }),
        entry({
          id: "b",
          projectId: "p1",
          startedAt: "2026-06-06T09:00:00Z",
          endedAt: "2026-06-06T10:00:00Z",
        }),
      ];
      const inbox = buildReviewInbox(entries, [
        event({ outcome: "dismissed" }),
      ]);
      expect(inbox.map((i) => i.kind)).toEqual([
        "no-project",
        "gap",
        "dismissed-suggestion",
      ]);
    });
  });

  describe("computeFocusInsights", () => {
    it("counts switches, deep work, fragments, and meetings", () => {
      const entries = [
        entry({
          id: "a",
          projectId: "a",
          startedAt: "2026-06-06T08:00:00Z",
          endedAt: "2026-06-06T09:00:00Z",
        }),
        entry({
          id: "b",
          projectId: "b",
          source: "calendar",
          startedAt: "2026-06-06T09:10:00Z",
          endedAt: "2026-06-06T09:20:00Z",
        }),
        entry({
          id: "c",
          projectId: "b",
          startedAt: "2026-06-06T09:30:00Z",
          endedAt: "2026-06-06T10:30:00Z",
        }),
        entry({
          id: "d",
          projectId: null,
          startedAt: "2026-06-06T10:40:00Z",
          endedAt: "2026-06-06T10:45:00Z",
        }),
        entry({
          id: "e",
          projectId: "a",
          startedAt: "2026-06-06T11:00:00Z",
          endedAt: "2026-06-06T11:45:00Z",
        }),
      ];
      const insights = computeFocusInsights(entries);
      expect(insights.contextSwitches).toBe(1);
      expect(insights.deepWorkBlocks).toBe(3);
      expect(insights.deepWorkMinutes).toBe(165);
      expect(insights.fragmentedBlocks).toBe(2);
      expect(insights.meetingMinutes).toBe(10);
    });

    it("ignores still-running entries", () => {
      const insights = computeFocusInsights([
        entry({ id: "open", projectId: "a", endedAt: null }),
      ]);
      expect(insights.deepWorkBlocks).toBe(0);
    });
  });

  describe("weeklyTrustSummary", () => {
    const summary: ReportSummary = {
      totalSeconds: 1000,
      prevTotalSeconds: 500,
      byDay: [],
      byProject: [{ projectId: null, seconds: 100 }],
      bySource: { rule: 300, calendar: 200, manual: 500 },
    };

    it("summarizes report sources and recent corrections", () => {
      const trust = weeklyTrustSummary(summary, [
        event({ outcome: "changed", selectedProjectId: "p2" }),
        event({ outcome: "dismissed" }),
      ]);
      expect(trust.autoClassifiedPct).toBe(50);
      expect(trust.manualPct).toBe(50);
      expect(trust.unresolvedSeconds).toBe(100);
      expect(trust.correctedSuggestions).toBe(1);
      expect(trust.dismissedSuggestions).toBe(1);
    });

    it("returns zeros for a null summary", () => {
      expect(weeklyTrustSummary(null, [])).toEqual({
        autoClassifiedPct: 0,
        manualPct: 0,
        unresolvedSeconds: 0,
        correctedSuggestions: 0,
        dismissedSuggestions: 0,
      });
    });

    it("returns zeros when no time is tracked", () => {
      expect(weeklyTrustSummary({ ...summary, totalSeconds: 0 }, [])).toEqual({
        autoClassifiedPct: 0,
        manualPct: 0,
        unresolvedSeconds: 0,
        correctedSuggestions: 0,
        dismissedSuggestions: 0,
      });
    });
  });

  describe("plannedVsActualMinutes", () => {
    it("splits calendar (planned) from tracked (actual) and reports drift", () => {
      const entries = [
        entry({
          id: "cal",
          source: "calendar",
          startedAt: "2026-06-06T09:00:00Z",
          endedAt: "2026-06-06T09:30:00Z",
        }),
        entry({
          id: "work",
          startedAt: "2026-06-06T10:00:00Z",
          endedAt: "2026-06-06T11:00:00Z",
        }),
        entry({ id: "open", endedAt: null }),
      ];
      const pva = plannedVsActualMinutes(entries);
      expect(pva.planned).toBe(30);
      expect(pva.actual).toBe(60);
      expect(pva.drift).toBe(30);
    });
  });
});
