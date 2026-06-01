import { describe, expect, it } from "vitest";
import { budgetFraction, budgetLevel, formatHours } from "./use-budget";
import type { ProjectBudgetStatus } from "./types";

function status(
  usedSeconds: number,
  estimateHours: number | null,
): ProjectBudgetStatus {
  return { projectId: "p1", usedSeconds, estimateHours };
}

describe("budgetLevel", () => {
  it("returns none when no estimate", () => {
    expect(budgetLevel(status(3600, null))).toBe("none");
  });

  it("returns none when estimate is zero", () => {
    expect(budgetLevel(status(0, 0))).toBe("none");
  });

  it("returns ok when under 80%", () => {
    // 40% used: 2h of 5h
    expect(budgetLevel(status(2 * 3600, 5))).toBe("ok");
  });

  it("returns warning at exactly 80%", () => {
    // 4h of 5h = 80%
    expect(budgetLevel(status(4 * 3600, 5))).toBe("warning");
  });

  it("returns warning between 80% and 100%", () => {
    // 4.5h of 5h = 90%
    expect(budgetLevel(status(4.5 * 3600, 5))).toBe("warning");
  });

  it("returns over at exactly 100%", () => {
    expect(budgetLevel(status(5 * 3600, 5))).toBe("over");
  });

  it("returns over when beyond 100%", () => {
    expect(budgetLevel(status(6 * 3600, 5))).toBe("over");
  });
});

describe("budgetFraction", () => {
  it("returns 0 with no estimate", () => {
    expect(budgetFraction(status(3600, null))).toBe(0);
  });

  it("returns 0 with zero estimate", () => {
    expect(budgetFraction(status(0, 0))).toBe(0);
  });

  it("returns 0.5 at half used", () => {
    expect(budgetFraction(status(2 * 3600, 4))).toBeCloseTo(0.5);
  });

  it("clamps to 1 when over", () => {
    expect(budgetFraction(status(10 * 3600, 5))).toBe(1);
  });
});

describe("formatHours", () => {
  it("formats exact hours with no minutes", () => {
    expect(formatHours(3600)).toBe("1h");
    expect(formatHours(7200)).toBe("2h");
  });

  it("formats hours and minutes", () => {
    expect(formatHours(3660)).toBe("1h 1m");
    expect(formatHours(5400)).toBe("1h 30m");
  });

  it("formats zero as 0h", () => {
    expect(formatHours(0)).toBe("0h");
  });
});
