import { describe, expect, it } from "vitest";
import {
  decidePrompt,
  idleTrigger,
  minuteOfDay,
  SCHEDULE_OFF,
  type PromptSchedule,
} from "./prompt-scheduler";

const NOON = 12 * 60;
const MIN_MS = 60_000;

const on = (over: Partial<PromptSchedule> = {}): PromptSchedule => ({
  enabled: true,
  startMinute: 9 * 60,
  endMinute: 17 * 60,
  throttleMinutes: 30,
  ...over,
});

const base = {
  minuteOfDay: NOON,
  nowMs: 0,
  lastPromptMs: null,
  triggered: true,
};

describe("SCHEDULE_OFF", () => {
  it("is disabled with a sane default window", () => {
    expect(SCHEDULE_OFF.enabled).toBe(false);
    expect(SCHEDULE_OFF.startMinute).toBe(9 * 60);
    expect(SCHEDULE_OFF.endMinute).toBe(17 * 60);
    expect(SCHEDULE_OFF.throttleMinutes).toBe(30);
  });
});

describe("decidePrompt", () => {
  it("returns disabled when the feature is off", () => {
    expect(decidePrompt(on({ enabled: false }), base)).toBe("disabled");
  });

  it("returns outside-window before the start", () => {
    expect(decidePrompt(on(), { ...base, minuteOfDay: 8 * 60 })).toBe(
      "outside-window",
    );
  });

  it("treats the end minute as exclusive", () => {
    expect(decidePrompt(on(), { ...base, minuteOfDay: 17 * 60 })).toBe(
      "outside-window",
    );
  });

  it("prompts at the inclusive start boundary", () => {
    expect(decidePrompt(on(), { ...base, minuteOfDay: 9 * 60 })).toBe("prompt");
  });

  it("prompts one minute before the end", () => {
    expect(decidePrompt(on(), { ...base, minuteOfDay: 17 * 60 - 1 })).toBe(
      "prompt",
    );
  });

  it("returns not-triggered inside the window when the trigger is false", () => {
    expect(decidePrompt(on(), { ...base, triggered: false })).toBe(
      "not-triggered",
    );
  });

  it("prompts when enabled, in window, triggered and never prompted", () => {
    expect(decidePrompt(on(), base)).toBe("prompt");
  });

  it("throttles within the rate limit", () => {
    const last = 1_000_000;
    expect(
      decidePrompt(on(), {
        ...base,
        nowMs: last + 29 * MIN_MS,
        lastPromptMs: last,
      }),
    ).toBe("throttled");
  });

  it("prompts again once the rate limit elapses", () => {
    const last = 1_000_000;
    expect(
      decidePrompt(on(), {
        ...base,
        nowMs: last + 30 * MIN_MS,
        lastPromptMs: last,
      }),
    ).toBe("prompt");
  });

  it("stays quiet on clock skew (last prompt in the future)", () => {
    const now = 1_000_000;
    expect(
      decidePrompt(on(), {
        ...base,
        nowMs: now,
        lastPromptMs: now + 5 * MIN_MS,
      }),
    ).toBe("throttled");
  });

  it("never matches an inverted window", () => {
    expect(
      decidePrompt(on({ startMinute: 17 * 60, endMinute: 9 * 60 }), base),
    ).toBe("outside-window");
  });

  it("clamps a zero throttle to one minute", () => {
    const last = 1_000_000;
    const cfg = on({ throttleMinutes: 0 });
    expect(
      decidePrompt(cfg, { ...base, nowMs: last + 30_000, lastPromptMs: last }),
    ).toBe("throttled");
    expect(
      decidePrompt(cfg, { ...base, nowMs: last + MIN_MS, lastPromptMs: last }),
    ).toBe("prompt");
  });

  it("clamps out-of-range and negative minutes without throwing", () => {
    expect(
      decidePrompt(on({ startMinute: 5_000, endMinute: 9_000 }), base),
    ).toBe("outside-window");
    expect(decidePrompt(on({ startMinute: -100, endMinute: -10 }), base)).toBe(
      "outside-window",
    );
  });
});

describe("idleTrigger", () => {
  it("fires when idle past the threshold and not tracking", () => {
    expect(idleTrigger(300, 300, false)).toBe(true);
    expect(idleTrigger(600, 300, false)).toBe(true);
  });

  it("does not fire below the threshold", () => {
    expect(idleTrigger(299, 300, false)).toBe(false);
  });

  it("does not fire while a timer is running", () => {
    expect(idleTrigger(999, 300, true)).toBe(false);
  });

  it("does not fire when idle can't be reported", () => {
    expect(idleTrigger(null, 300, false)).toBe(false);
  });
});

describe("minuteOfDay", () => {
  it("converts a Date to minutes since midnight", () => {
    expect(minuteOfDay(new Date(2026, 0, 1, 9, 30, 0))).toBe(9 * 60 + 30);
    expect(minuteOfDay(new Date(2026, 0, 1, 0, 0, 0))).toBe(0);
  });

  it("defaults to the current time", () => {
    const v = minuteOfDay();
    expect(v).toBeGreaterThanOrEqual(0);
    expect(v).toBeLessThan(24 * 60);
  });
});
