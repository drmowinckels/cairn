import { describe, it, expect } from "vitest";
import { formatRelativeTime } from "./relative-time";

const NOW = new Date("2026-05-26T12:00:00Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();

describe("formatRelativeTime", () => {
  it("returns 'never' for null/undefined/invalid", () => {
    expect(formatRelativeTime(null)).toBe("never");
    expect(formatRelativeTime(undefined)).toBe("never");
    expect(formatRelativeTime("not-a-date")).toBe("never");
  });

  it("returns 'just now' for very recent or future times", () => {
    expect(formatRelativeTime(NOW.toISOString(), { now: NOW })).toBe(
      "just now",
    );
    expect(formatRelativeTime(ago(10_000), { now: NOW })).toBe("just now");
    expect(
      formatRelativeTime(new Date(NOW.getTime() + 60_000).toISOString(), {
        now: NOW,
      }),
    ).toBe("just now");
  });

  it("formats minutes for sub-hour deltas", () => {
    expect(formatRelativeTime(ago(2 * 60_000), { now: NOW })).toBe("2m ago");
    expect(formatRelativeTime(ago(59 * 60_000), { now: NOW })).toBe("59m ago");
  });

  it("formats hours for sub-day deltas", () => {
    expect(formatRelativeTime(ago(60 * 60_000), { now: NOW })).toBe("1h ago");
    expect(formatRelativeTime(ago(23 * 3_600_000), { now: NOW })).toBe(
      "23h ago",
    );
  });

  it("formats days for sub-week deltas", () => {
    expect(formatRelativeTime(ago(24 * 3_600_000), { now: NOW })).toBe(
      "1d ago",
    );
    expect(formatRelativeTime(ago(6 * 24 * 3_600_000), { now: NOW })).toBe(
      "6d ago",
    );
  });

  it("formats weeks for sub-month deltas", () => {
    expect(formatRelativeTime(ago(7 * 24 * 3_600_000), { now: NOW })).toBe(
      "1w ago",
    );
    expect(formatRelativeTime(ago(21 * 24 * 3_600_000), { now: NOW })).toBe(
      "3w ago",
    );
  });

  it("falls back to an ISO date for older timestamps", () => {
    expect(formatRelativeTime(ago(60 * 24 * 3_600_000), { now: NOW })).toMatch(
      /^\d{4}-\d{2}-\d{2}$/,
    );
  });

  it("accepts a Date directly", () => {
    expect(
      formatRelativeTime(new Date(NOW.getTime() - 5 * 60_000), { now: NOW }),
    ).toBe("5m ago");
  });
});
