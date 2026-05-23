import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";

const invokeMock = vi.fn();
const askMock = vi.fn();
const openMock = vi.fn();
const saveMock = vi.fn();
const revealMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({
  ask: (...args: unknown[]) => askMock(...args),
  open: (...args: unknown[]) => openMock(...args),
  save: (...args: unknown[]) => saveMock(...args),
}));
vi.mock("@tauri-apps/plugin-opener", () => ({
  revealItemInDir: (...args: unknown[]) => revealMock(...args),
}));

import { SettingsView } from "./index";

type WithInternals = { __TAURI_INTERNALS__?: unknown };

beforeEach(() => {
  invokeMock.mockReset();
  askMock.mockReset();
  openMock.mockReset();
  saveMock.mockReset();
  revealMock.mockReset();
});

afterEach(() => {
  delete (globalThis as WithInternals).__TAURI_INTERNALS__;
});

describe("SettingsView (browser-dev mode)", () => {
  it("renders the four privacy guarantees verbatim", () => {
    render(<SettingsView density="comfy" />);
    expect(
      screen.getByText(
        /Everything is stored locally in\s+SQLite on this machine/i,
      ),
    ).toBeTruthy();
    expect(
      screen.getByText(
        /No accounts\. No telemetry\. No\s+background phone-home/i,
      ),
    ).toBeTruthy();
    expect(
      screen.getByText(
        /Window titles are read locally and\s+never leave the device/i,
      ),
    ).toBeTruthy();
    expect(
      screen.getByText(/Source on GitHub · Apache-2\.0\s+licensed/i),
    ).toBeTruthy();
  });

  it("renders the five privacy action buttons", () => {
    render(<SettingsView density="comfy" />);
    for (const name of [
      /export backup/i,
      /restore from file/i,
      /export csv/i,
      /view what's stored/i,
      /delete everything/i,
    ]) {
      expect(screen.getByRole("button", { name })).toBeTruthy();
    }
  });

  it("disables 'View what's stored' when no paths are loaded", () => {
    render(<SettingsView density="comfy" />);
    const btn = screen.getByRole("button", { name: /view what's stored/i });
    expect(btn.hasAttribute("disabled")).toBe(true);
  });

  it("renders the exclusion list with mono codes and remove buttons", () => {
    const { container } = render(<SettingsView density="comfy" />);
    expect(container.querySelectorAll(".excl-row").length).toBeGreaterThanOrEqual(
      3,
    );
    expect(container.querySelectorAll(".excl-x").length).toBeGreaterThanOrEqual(
      3,
    );
  });

  it("renders accessibility toggles with labels (a11y fix verification)", () => {
    render(<SettingsView density="comfy" />);
    expect(
      screen.getByRole("switch", { name: /high contrast/i }),
    ).toBeTruthy();
    expect(
      screen.getByRole("switch", { name: /reduce motion/i }),
    ).toBeTruthy();
    expect(
      screen.getByRole("switch", { name: /colorblind-safe palette/i }),
    ).toBeTruthy();
  });

  it("toggling a switch flips aria-checked", () => {
    render(<SettingsView density="comfy" />);
    const sw = screen.getByRole("switch", { name: /high contrast/i });
    expect(sw.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(sw);
    expect(sw.getAttribute("aria-checked")).toBe("true");
  });

  it("does not call IPC in browser-dev mode", async () => {
    render(<SettingsView density="comfy" />);
    // Give effects a tick to fire.
    await waitFor(() => {});
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("the github footer link prevents default navigation when clicked", () => {
    render(<SettingsView density="comfy" />);
    const link = screen.getByRole("link", {
      name: /github\.com\/drmowinckels\/cairn/i,
    });
    const evt = new MouseEvent("click", { bubbles: true, cancelable: true });
    link.dispatchEvent(evt);
    expect(evt.defaultPrevented).toBe(true);
  });
});

describe("SettingsView (inside Tauri)", () => {
  // `inTauri` in src/lib/ipc.ts is evaluated at module-load time, so we
  // set the flag, reset modules, and dynamically import a fresh copy of
  // the component for each test in this block.
  beforeEach(() => {
    (globalThis as WithInternals).__TAURI_INTERNALS__ = {};
    vi.resetModules();
  });

  afterEach(() => {
    delete (globalThis as WithInternals).__TAURI_INTERNALS__;
  });

  it("enables 'View what's stored' once paths load and wires it to the opener plugin", async () => {
    invokeMock.mockResolvedValue({
      dataDir: "/data",
      dbPath: "/data/cairn.sqlite",
      pendingImport: null,
    });
    const { SettingsView: FreshSettingsView } = await import("./settings");
    render(<FreshSettingsView density="comfy" />);
    const btn = await waitFor(() => {
      const b = screen.getByRole("button", { name: /view what's stored/i });
      expect(b.hasAttribute("disabled")).toBe(false);
      return b;
    });

    await act(async () => {
      fireEvent.click(btn);
    });
    expect(revealMock).toHaveBeenCalledWith("/data/cairn.sqlite");
  });

  it("renders the pending-restore banner when a restore is staged", async () => {
    invokeMock.mockResolvedValue({
      dataDir: "/data",
      dbPath: "/data/cairn.sqlite",
      pendingImport: "/data/cairn.sqlite.pending",
    });
    const { SettingsView: FreshSettingsView } = await import("./settings");
    render(<FreshSettingsView density="comfy" />);
    expect(await screen.findByText(/restore is staged/i)).toBeTruthy();
  });
});
