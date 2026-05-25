import { describe, it, expect } from "vitest";
import {
  fmtClock,
  fmtClockFromIso,
  fmtHm,
  fmtIdleDuration,
  fmtRange,
  minutesOf,
} from "./time";

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
