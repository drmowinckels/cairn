import { describe, expect, it } from "vitest";
import {
  formatBytes,
  PRIVACY_GUARANTEES,
  PRIVACY_LICENSE_LABEL,
  PRIVACY_REPO_LABEL,
  PRIVACY_REPO_URL,
} from "./privacy-copy";

describe("PRIVACY_GUARANTEES (verbatim copy pinned to PRIVACY.md)", () => {
  it("pins the four guarantees so a stray edit fails CI", () => {
    expect(PRIVACY_GUARANTEES).toMatchInlineSnapshot(`
      [
        {
          "id": "local",
          "lead": "Everything is stored locally",
          "rest": "in a SQLite database under ~/.cairn/ (or platform equivalent). Nothing is uploaded.",
        },
        {
          "id": "no-telemetry",
          "lead": "No accounts. No telemetry. No background phone-home.",
          "rest": "No analytics, no crash reporting, no "anonymous usage stats". Period.",
        },
        {
          "id": "no-window-titles",
          "lead": "Window titles are read locally and never leave the device.",
          "rest": "They're evaluated against rules in memory and discarded.",
        },
        {
          "id": "source",
          "lead": "Source on GitHub, Apache 2.0 licensed.",
          "rest": "Anyone can audit.",
        },
      ]
    `);
  });

  it("exports the attribution link constants used by the privacy card", () => {
    expect(PRIVACY_REPO_URL).toBe("https://github.com/drmowinckels/cairn");
    expect(PRIVACY_REPO_LABEL).toBe("Source on GitHub");
    expect(PRIVACY_LICENSE_LABEL).toBe("Apache-2.0");
  });
});

describe("formatBytes", () => {
  it("renders bytes verbatim under 1 KB", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1023)).toBe("1023 B");
  });

  it("renders integer KB up to 1 MB", () => {
    expect(formatBytes(1024)).toBe("1 KB");
    expect(formatBytes(2 * 1024)).toBe("2 KB");
    expect(formatBytes(1024 * 1024 - 1)).toBe("1024 KB");
  });

  it("renders MB with one decimal beyond 1 MB", () => {
    expect(formatBytes(1024 * 1024)).toBe("1.0 MB");
    expect(formatBytes(2.5 * 1024 * 1024)).toBe("2.5 MB");
  });

  it("guards against negative or non-finite inputs", () => {
    expect(formatBytes(-1)).toBe("0 B");
    expect(formatBytes(Number.NaN)).toBe("0 B");
    expect(formatBytes(Number.POSITIVE_INFINITY)).toBe("0 B");
  });
});
