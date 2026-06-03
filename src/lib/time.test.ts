import { describe, it, expect } from "vitest";
import {
  fmtClock,
  fmtClockFromIso,
  fmtHm,
  fmtIdleDuration,
  fmtRange,
  minutesOf,
  totalTrackedMinutes,
} from "./time";
import type { BackendEntry } from "./ipc";

function entry(over: Partial<BackendEntry> = {}): BackendEntry {
  return {
    id: "e1",
    projectId: "p1",
    taskId: null,
    description: "",
    startedAt: "2026-06-02T09:00:00Z",
    endedAt: "2026-06-02T10:00:00Z",
    source: "manual",
    ruleId: null,
    ...over,
  };
}

describe("time formatters", () => {
  it("fmtHm formats hours and minutes", () => {
    expect(fmtHm(0)).toBe("0m");
    expect(fmtHm(45)).toBe("45m");
    expect(fmtHm(60)).toBe("1h");
    expect(fmtHm(75)).toBe("1h 15m");
  });

  it("fmtClock zero-pads", () => {
    expect(fmtClock(0)).toBe("00:00");
    expect(fmtClock(minutesOf(9, 5))).toBe("09:05");
    expect(fmtClock(minutesOf(15, 2))).toBe("15:02");
  });

  it("fmtRange joins start and end with an en-dash", () => {
    expect(fmtRange(minutesOf(9, 12), minutesOf(10, 45))).toBe("09:12–10:45");
  });

  it("fmtClockFromIso renders local HH:MM from a UTC ISO string", () => {
    // We can't pin the exact local string without knowing the
    // host's tz. Pin the shape (5 chars, HH:MM, both numeric).
    const out = fmtClockFromIso("2026-05-25T14:50:00Z");
    expect(out).toMatch(/^\d{2}:\d{2}$/);
  });

  it("fmtIdleDuration handles seconds / minutes / hours / mixed", () => {
    expect(fmtIdleDuration(0)).toBe("0 sec");
    expect(fmtIdleDuration(45)).toBe("45 sec");
    expect(fmtIdleDuration(60)).toBe("1 min");
    expect(fmtIdleDuration(720)).toBe("12 min");
    expect(fmtIdleDuration(3599)).toBe("59 min");
    expect(fmtIdleDuration(3600)).toBe("1 h");
    expect(fmtIdleDuration(7200)).toBe("2 h");
    expect(fmtIdleDuration(7260)).toBe("2 h 1 min");
    expect(fmtIdleDuration(5025)).toBe("1 h 23 min");
  });
});

describe("totalTrackedMinutes", () => {
  it("sums closed entries by elapsed minutes", () => {
    const entries = [
      entry({
        startedAt: "2026-06-02T09:00:00Z",
        endedAt: "2026-06-02T10:00:00Z",
      }),
      entry({
        startedAt: "2026-06-02T11:00:00Z",
        endedAt: "2026-06-02T11:30:00Z",
      }),
    ];
    expect(totalTrackedMinutes(entries)).toBe(90);
  });

  it("counts the running entry up to `now`", () => {
    const now = Date.parse("2026-06-02T09:45:00Z");
    const entries = [
      entry({ startedAt: "2026-06-02T09:00:00Z", endedAt: null }),
    ];
    expect(totalTrackedMinutes(entries, now)).toBe(45);
  });

  it("clamps negative spans (clock skew / bad row) to zero", () => {
    const entries = [
      entry({
        startedAt: "2026-06-02T10:00:00Z",
        endedAt: "2026-06-02T09:00:00Z",
      }),
      entry({
        startedAt: "2026-06-02T11:00:00Z",
        endedAt: "2026-06-02T11:20:00Z",
      }),
    ];
    expect(totalTrackedMinutes(entries)).toBe(20);
  });

  it("skips entries with unparseable timestamps", () => {
    const entries = [
      entry({ startedAt: "not-a-date", endedAt: "2026-06-02T10:00:00Z" }),
      entry({ startedAt: "2026-06-02T09:00:00Z", endedAt: "also-bad" }),
      entry({
        startedAt: "2026-06-02T09:00:00Z",
        endedAt: "2026-06-02T09:15:00Z",
      }),
    ];
    expect(totalTrackedMinutes(entries)).toBe(15);
  });

  it("returns 0 for an empty day", () => {
    expect(totalTrackedMinutes([])).toBe(0);
  });

  it("returns 0 when handed a non-array (malformed backend response)", () => {
    expect(totalTrackedMinutes(null as unknown as BackendEntry[])).toBe(0);
  });
});
