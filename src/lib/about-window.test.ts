import { afterEach, describe, expect, it, vi } from "vitest";

const hide = vi.fn().mockResolvedValue(undefined);
vi.mock("@tauri-apps/api/webviewWindow", () => ({
  getCurrentWebviewWindow: () => ({ hide }),
}));

describe("hideAboutWindow", () => {
  type WithInternals = { __TAURI_INTERNALS__?: unknown };
  afterEach(() => {
    delete (globalThis as WithInternals).__TAURI_INTERNALS__;
    vi.clearAllMocks();
  });

  it("no-ops outside Tauri", async () => {
    vi.resetModules();
    const { hideAboutWindow } = await import("./about-window");
    await hideAboutWindow();
    expect(hide).not.toHaveBeenCalled();
  });

  it("hides the current window inside Tauri", async () => {
    (globalThis as WithInternals).__TAURI_INTERNALS__ = {};
    vi.resetModules();
    const { hideAboutWindow } = await import("./about-window");
    await hideAboutWindow();
    expect(hide).toHaveBeenCalledTimes(1);
  });
});
