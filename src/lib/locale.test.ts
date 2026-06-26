import { beforeEach, describe, expect, it, vi } from "vitest";

const systemLocale = vi.fn();
vi.mock("./ipc", () => ({
  systemLocale: () => systemLocale(),
}));

import { initLocale, appLocale, setLocaleForTest } from "./locale";

beforeEach(() => {
  systemLocale.mockReset();
  setLocaleForTest(undefined);
});

describe("appLocale", () => {
  it("falls back to navigator.language before any resolution", () => {
    expect(appLocale()).toBe(globalThis.navigator.language);
  });

  it("returns the value set by setLocaleForTest", () => {
    setLocaleForTest("fr-FR");
    expect(appLocale()).toBe("fr-FR");
  });
});

describe("initLocale", () => {
  it("resolves the OS locale and tags <html lang>", async () => {
    systemLocale.mockResolvedValue("nb-NO");
    await initLocale();
    expect(appLocale()).toBe("nb-NO");
    expect(document.documentElement.lang).toBe("nb-NO");
  });

  it("falls back to navigator.language when the backend returns null", async () => {
    systemLocale.mockResolvedValue(null);
    await initLocale();
    expect(appLocale()).toBe(globalThis.navigator.language);
  });

  it("degrades silently when the backend call throws", async () => {
    systemLocale.mockRejectedValue(new Error("no ipc"));
    await expect(initLocale()).resolves.toBeUndefined();
    expect(appLocale()).toBe(globalThis.navigator.language);
  });
});
