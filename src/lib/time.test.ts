import { describe, it, expect } from "vitest";
import { fmtClock, fmtHm, fmtRange, minutesOf } from "./time";

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
});
