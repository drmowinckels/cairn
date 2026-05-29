import { describe, it, expect } from "vitest";
import { projectTab, parseBrowserLabel } from "./lib.js";

describe("projectTab", () => {
  it("keeps only the lowercased hostname from a normal URL", () => {
    const out = projectTab(
      { url: "https://GitHub.com/drmowinckels/cairn?token=secret#frag" },
      true,
    );
    expect(out).toEqual({ domain: "github.com", incognito: false, focused: true });
  });

  it("never carries the path, query, or hash onto the payload", () => {
    const out = projectTab(
      { url: "https://example.com/private/path?q=leak" },
      true,
    );
    expect(out.domain).toBe("example.com");
    expect(Object.keys(out).sort()).toEqual(["domain", "focused", "incognito"]);
    expect(JSON.stringify(out)).not.toContain("leak");
    expect(JSON.stringify(out)).not.toContain("private");
  });

  it("flags incognito tabs", () => {
    const out = projectTab({ url: "https://x.com/", incognito: true }, true);
    expect(out.incognito).toBe(true);
  });

  it("reports incognito as a real boolean even when the flag is absent", () => {
    const out = projectTab({ url: "https://x.com/" }, true);
    expect(out.incognito).toBe(false);
  });

  it("propagates the focused flag", () => {
    expect(projectTab({ url: "https://x.com/" }, false).focused).toBe(false);
  });

  it.each([
    "chrome://settings",
    "edge://flags",
    "brave://rewards",
    "about:blank",
    "moz-extension://abc/page.html",
    "chrome-extension://abc/page.html",
  ])("drops internal scheme %s", (url) => {
    expect(projectTab({ url }, true)).toBeNull();
  });

  it("returns null for a tab with no URL", () => {
    expect(projectTab({}, true)).toBeNull();
    expect(projectTab(null, true)).toBeNull();
  });

  it("returns null for an unparseable URL", () => {
    expect(projectTab({ url: "not a url" }, true)).toBeNull();
  });

  it("returns null when the URL has no hostname", () => {
    expect(projectTab({ url: "file:///etc/passwd" }, true)).toBeNull();
  });
});

describe("parseBrowserLabel", () => {
  it("labels Chrome", () => {
    const ua =
      "Mozilla/5.0 (Macintosh) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
    expect(parseBrowserLabel(ua)).toBe("Chrome 120");
  });

  it("labels Edge ahead of the Chrome token it also carries", () => {
    const ua =
      "Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0";
    expect(parseBrowserLabel(ua)).toBe("Edge 120");
  });

  it("labels Brave ahead of the Chrome token it also carries", () => {
    const ua =
      "Mozilla/5.0 AppleWebKit/537.36 Chrome/119.0.0.0 Safari/537.36 Brave/119";
    expect(parseBrowserLabel(ua)).toBe("Brave 119");
  });

  it("falls back to a generic label for an unrecognised UA", () => {
    expect(parseBrowserLabel("Mozilla/5.0 (SomethingElse)")).toBe("browser");
  });

  it("falls back to a generic label for null/empty input", () => {
    expect(parseBrowserLabel(null)).toBe("browser");
    expect(parseBrowserLabel(undefined)).toBe("browser");
    expect(parseBrowserLabel("")).toBe("browser");
  });
});
