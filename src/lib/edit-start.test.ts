import { describe, expect, it } from "vitest";
import { startEditError, validateStartEdit } from "./edit-start";

describe("validateStartEdit", () => {
  // 2026-06-01T12:00 local → fixed reference "now".
  const now = new Date(2026, 5, 1, 12, 0, 0).getTime();

  it("rejects an empty value", () => {
    expect(validateStartEdit("", now)).toEqual({ ok: false, reason: "empty" });
  });

  it("rejects an unparseable value", () => {
    expect(validateStartEdit("not-a-date", now)).toEqual({
      ok: false,
      reason: "invalid",
    });
  });

  it("rejects a time in the future", () => {
    expect(validateStartEdit("2026-06-01T12:30", now)).toEqual({
      ok: false,
      reason: "future",
    });
  });

  it("accepts a past time and returns its UTC ISO", () => {
    const result = validateStartEdit("2026-06-01T11:30", now);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(Date.parse(result.iso)).toBe(
        new Date(2026, 5, 1, 11, 30).getTime(),
      );
    }
  });

  it("accepts a value exactly equal to now (boundary)", () => {
    const local = "2026-06-01T12:00";
    const result = validateStartEdit(local, Date.parse(local));
    expect(result.ok).toBe(true);
  });
});

describe("startEditError", () => {
  it("messages the future case distinctly", () => {
    expect(startEditError("future")).toMatch(/future/i);
    expect(startEditError("invalid")).toMatch(/valid/i);
    expect(startEditError("empty")).toMatch(/valid/i);
  });
});
