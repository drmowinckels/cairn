import { describe, expect, it } from "vitest";
import {
  ROUNDING_OFF,
  isRoundingActive,
  roundMinutes,
  roundSeconds,
  roundingLabel,
  type Rounding,
} from "./rounding";

const M = 60;
const r = (intervalMinutes: number, mode: Rounding["mode"]): Rounding => ({
  intervalMinutes,
  mode,
});

describe("roundSeconds", () => {
  it("is the identity when disabled", () => {
    expect(roundSeconds(7 * M + 13, ROUNDING_OFF)).toBe(7 * M + 13);
    expect(isRoundingActive(ROUNDING_OFF)).toBe(false);
  });

  it("clamps non-positive inputs to zero", () => {
    expect(roundSeconds(0, r(15, "nearest"))).toBe(0);
    expect(roundSeconds(-30, r(15, "nearest"))).toBe(0);
    expect(roundSeconds(-30, ROUNDING_OFF)).toBe(0);
  });

  it("leaves exact multiples unchanged for every mode", () => {
    for (const mode of ["nearest", "up", "down"] as const) {
      expect(roundSeconds(30 * M, r(15, mode))).toBe(30 * M);
    }
  });

  it("nearest rounds to the closest, half rounds up", () => {
    const n = r(15, "nearest");
    expect(roundSeconds(7 * M, n)).toBe(0); // 7 < 7.5 → down
    expect(roundSeconds(7 * M + 30, n)).toBe(15 * M); // exactly half → up
    expect(roundSeconds(8 * M, n)).toBe(15 * M);
    expect(roundSeconds(22 * M, n)).toBe(15 * M);
    expect(roundSeconds(23 * M, n)).toBe(30 * M);
  });

  it("up always ceils a non-exact duration", () => {
    const u = r(15, "up");
    expect(roundSeconds(1, u)).toBe(15 * M);
    expect(roundSeconds(15 * M + 1, u)).toBe(30 * M);
  });

  it("down always floors", () => {
    const d = r(15, "down");
    expect(roundSeconds(14 * M + 59, d)).toBe(0);
    expect(roundSeconds(29 * M, d)).toBe(15 * M);
  });
});

describe("roundMinutes", () => {
  it("rounds a minute duration and returns whole minutes", () => {
    expect(roundMinutes(8, r(15, "nearest"))).toBe(15);
    expect(roundMinutes(8, ROUNDING_OFF)).toBe(8);
    expect(roundMinutes(38, r(15, "down"))).toBe(30);
  });
});

describe("roundingLabel", () => {
  it("labels off and intervals", () => {
    expect(roundingLabel(0)).toBe("Off");
    expect(roundingLabel(15)).toBe("15 min");
  });
});
