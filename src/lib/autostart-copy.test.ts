import { describe, it, expect } from "vitest";
import { detectPlatform, autostartCopy } from "./autostart-copy";

describe("detectPlatform", () => {
  it("detects macOS", () => {
    expect(
      detectPlatform(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15",
      ),
    ).toBe("macos");
  });

  it("detects Windows", () => {
    expect(
      detectPlatform("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit"),
    ).toBe("windows");
  });

  it("detects Linux", () => {
    expect(
      detectPlatform("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36"),
    ).toBe("linux");
  });

  it("falls back to unknown for an unrecognised UA", () => {
    expect(detectPlatform("SomeRandomAgent/1.0")).toBe("unknown");
  });

  it("checks macOS before Linux so 'like Mac' UAs win", () => {
    // Some webviews report both tokens; macOS should take precedence.
    expect(detectPlatform("Macintosh; Linux compatible")).toBe("macos");
  });
});

describe("autostartCopy", () => {
  it("uses macOS phrasing", () => {
    expect(autostartCopy("macos").label).toBe("Open at login");
  });

  it("uses Windows phrasing", () => {
    expect(autostartCopy("windows").label).toBe("Start with Windows");
  });

  it("uses Linux phrasing", () => {
    expect(autostartCopy("linux").label).toBe("Start on session login");
  });

  it("uses a generic fallback for unknown platforms", () => {
    expect(autostartCopy("unknown").label).toBe("Start at login");
  });

  it("always supplies a non-empty hint", () => {
    for (const p of ["macos", "windows", "linux", "unknown"] as const) {
      expect(autostartCopy(p).hint.length).toBeGreaterThan(0);
    }
  });
});
