import { describe, expect, it } from "vitest";
import {
  dwellSatisfied,
  expireIfStale,
  isSwitchCandidate,
  NO_DWELL,
  observe,
  runningRefOf,
  TASK_SWITCH_OFF,
  type DwellState,
  type RunningRef,
} from "./task-switch";
import type { RuleMatchEvent } from "./types";

function match(over: Partial<RuleMatchEvent> = {}): RuleMatchEvent {
  return {
    ruleId: "r1",
    ruleName: "Cairn repo",
    confidence: "suggestive",
    ambiguityBehavior: "prompt",
    project: "cairn",
    tags: [],
    description: "",
    ...over,
  };
}

const running = (over: Partial<RunningRef> = {}): RunningRef => ({
  projectId: "acme",
  ruleId: "r-acme",
  ...over,
});

describe("TASK_SWITCH_OFF", () => {
  it("is disabled with a 60s dwell and 30m throttle", () => {
    expect(TASK_SWITCH_OFF).toEqual({
      enabled: false,
      dwellSeconds: 60,
      throttleMinutes: 30,
    });
  });
});

describe("runningRefOf", () => {
  it("projects an entry down to its project/rule identity", () => {
    expect(runningRefOf({ projectId: "p", ruleId: "r" })).toEqual({
      projectId: "p",
      ruleId: "r",
    });
  });

  it("maps null to null", () => {
    expect(runningRefOf(null)).toBeNull();
  });
});

describe("isSwitchCandidate", () => {
  it("flags a suggestive match for a different project while tracking", () => {
    expect(isSwitchCandidate(match(), running())).toBe(true);
  });

  it("is false with no match or no running timer", () => {
    expect(isSwitchCandidate(null, running())).toBe(false);
    expect(isSwitchCandidate(match(), null)).toBe(false);
  });

  it("ignores strict matches (those auto-start without a prompt)", () => {
    expect(isSwitchCandidate(match({ confidence: "strict" }), running())).toBe(
      false,
    );
  });

  it("is false when the running timer has no project", () => {
    expect(isSwitchCandidate(match(), running({ projectId: null }))).toBe(
      false,
    );
  });

  it("is false when the match has no project", () => {
    expect(isSwitchCandidate(match({ project: null }), running())).toBe(false);
  });

  it("is false when the match targets the project already running", () => {
    expect(isSwitchCandidate(match({ project: "acme" }), running())).toBe(
      false,
    );
  });

  it("is false when the match is the rule already driving the timer", () => {
    expect(
      isSwitchCandidate(
        match({ ruleId: "r-acme" }),
        running({ ruleId: "r-acme" }),
      ),
    ).toBe(false);
  });
});

describe("observe", () => {
  it("starts a dwell window on a fresh candidate", () => {
    const next = observe(NO_DWELL, match(), running(), 1_000);
    expect(next.ruleId).toBe("r1");
    expect(next.firstSeenMs).toBe(1_000);
    expect(next.lastSeenMs).toBe(1_000);
  });

  it("refreshes lastSeen without restarting the dwell for the same candidate", () => {
    const first = observe(NO_DWELL, match(), running(), 1_000);
    const again = observe(first, match(), running(), 3_500);
    expect(again.firstSeenMs).toBe(1_000);
    expect(again.lastSeenMs).toBe(3_500);
  });

  it("restarts the window when a different rule becomes the candidate", () => {
    const first = observe(NO_DWELL, match(), running(), 1_000);
    const other = observe(
      first,
      match({ ruleId: "r2", project: "beta" }),
      running(),
      2_000,
    );
    expect(other.ruleId).toBe("r2");
    expect(other.firstSeenMs).toBe(2_000);
  });

  it("resets to NO_DWELL when the match is no longer a switch candidate", () => {
    const first = observe(NO_DWELL, match(), running(), 1_000);
    expect(observe(first, null, running(), 2_000)).toEqual(NO_DWELL);
    expect(
      observe(first, match({ project: "acme" }), running(), 2_000),
    ).toEqual(NO_DWELL);
  });
});

describe("expireIfStale", () => {
  const dwelling: DwellState = {
    ruleId: "r1",
    match: match(),
    firstSeenMs: 1_000,
    lastSeenMs: 1_000,
  };

  it("keeps a fresh candidate", () => {
    expect(expireIfStale(dwelling, 3_000, 4_000)).toBe(dwelling);
  });

  it("drops a candidate that has gone silent past staleMs", () => {
    expect(expireIfStale(dwelling, 6_000, 4_000)).toEqual(NO_DWELL);
  });

  it("is a no-op when nothing is dwelling", () => {
    expect(expireIfStale(NO_DWELL, 9_999, 4_000)).toBe(NO_DWELL);
  });
});

describe("dwellSatisfied", () => {
  const dwelling: DwellState = {
    ruleId: "r1",
    match: match(),
    firstSeenMs: 1_000,
    lastSeenMs: 60_000,
  };

  it("is false before the dwell window elapses", () => {
    expect(dwellSatisfied(dwelling, 40_000, 60_000, 4_000)).toBe(false);
  });

  it("is true once dwelled long enough and still fresh", () => {
    expect(dwellSatisfied(dwelling, 61_500, 60_000, 4_000)).toBe(true);
  });

  it("is false when stale even past the dwell window", () => {
    const stale: DwellState = { ...dwelling, lastSeenMs: 1_000 };
    expect(dwellSatisfied(stale, 70_000, 60_000, 4_000)).toBe(false);
  });

  it("is false when nothing is dwelling", () => {
    expect(dwellSatisfied(NO_DWELL, 99_999, 60_000, 4_000)).toBe(false);
  });
});
