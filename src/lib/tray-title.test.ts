import { describe, expect, it } from "vitest";
import { formatTrayTitle } from "./tray-title";

describe("formatTrayTitle", () => {
  it("is empty when the feature is off (clears the title)", () => {
    expect(formatTrayTitle(false, "Cairn", true)).toBe("");
    expect(formatTrayTitle(false, null, false)).toBe("");
  });

  it("shows the project name while tracking", () => {
    expect(formatTrayTitle(true, "Cairn", true)).toBe("● Cairn");
  });

  it("shows a generic label while tracking with no project", () => {
    expect(formatTrayTitle(true, null, true)).toBe("● Tracking");
    expect(formatTrayTitle(true, "   ", true)).toBe("● Tracking");
  });

  it("shows Idle when not tracking", () => {
    expect(formatTrayTitle(true, null, false)).toBe("Idle");
    expect(formatTrayTitle(true, "Cairn", false)).toBe("Idle");
  });
});
