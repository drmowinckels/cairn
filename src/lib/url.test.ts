import { describe, expect, it } from "vitest";
import { isSafeExternalUrl } from "./url";

describe("isSafeExternalUrl", () => {
  it("accepts http and https", () => {
    expect(isSafeExternalUrl("https://github.com/o/r/issues/1")).toBe(true);
    expect(isSafeExternalUrl("http://example.test/x")).toBe(true);
  });

  it("rejects dangerous schemes", () => {
    expect(isSafeExternalUrl("javascript:alert(1)")).toBe(false);
    expect(isSafeExternalUrl("file:///etc/passwd")).toBe(false);
    expect(isSafeExternalUrl("data:text/html,<script>")).toBe(false);
  });

  it("rejects unparseable, empty, and nullish input", () => {
    expect(isSafeExternalUrl("not a url")).toBe(false);
    expect(isSafeExternalUrl("")).toBe(false);
    expect(isSafeExternalUrl(null)).toBe(false);
    expect(isSafeExternalUrl(undefined)).toBe(false);
  });
});
