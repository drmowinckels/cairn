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
import type { UseA11yPrefs } from "../../lib/use-a11y-prefs";

type WithInternals = { __TAURI_INTERNALS__?: unknown };

function stubA11y(overrides: Partial<UseA11yPrefs> = {}): UseA11yPrefs {
  return {
    theme: "system",
    textScale: "md",
    highContrast: false,
    reduceMotion: false,
    colorblindSafe: false,
    announce: true,
    alwaysFocusRing: false,
    detectionPrompts: "subtle",
    setTextScale: vi.fn(),
    setHighContrast: vi.fn(),
    setReduceMotion: vi.fn(),
    setColorblindSafe: vi.fn(),
    setAnnounce: vi.fn(),
    setAlwaysFocusRing: vi.fn(),
    setDetectionPrompts: vi.fn(),
    ...overrides,
  };
}

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
  it("renders the four privacy guarantees", () => {
    render(<SettingsView density="comfy" a11y={stubA11y()} />);
    expect(screen.getByText(/stored locally/i)).toBeTruthy();
    expect(screen.getByText(/No accounts\. No telemetry/i)).toBeTruthy();
    expect(
      screen.getByText(/window titles are read locally/i),
    ).toBeTruthy();
    // 'Apache-2.0' appears in both the guarantee bullet and the footer.
    expect(screen.getAllByText(/Apache-2\.0/i).length).toBeGreaterThan(0);
  });

  it("renders the five privacy action buttons", () => {
    render(<SettingsView density="comfy" a11y={stubA11y()} />);
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
    render(<SettingsView density="comfy" a11y={stubA11y()} />);
    const btn = screen.getByRole("button", { name: /view what's stored/i });
    expect(btn.hasAttribute("disabled")).toBe(true);
  });

  it("renders an exclusion list (or its empty hint) with at least one signal", () => {
    const { container } = render(
      <SettingsView density="comfy" a11y={stubA11y()} />,
    );
    // Either there's an exclusion list section, OR the empty hint is shown.
    expect(
      container.querySelector(".excl-list, .settings-block"),
    ).toBeTruthy();
  });

  it("clicking an accessibility toggle calls the matching a11y setter", () => {
    const a11y = stubA11y({ highContrast: false });
    render(<SettingsView density="comfy" a11y={a11y} />);
    const sw = screen.getByRole("switch", { name: /high contrast/i });
    fireEvent.click(sw);
    expect(a11y.setHighContrast).toHaveBeenCalledWith(true);
  });

  it("renders the text-scale segmented control with the active option highlighted", () => {
    render(
      <SettingsView density="comfy" a11y={stubA11y({ textScale: "lg" })} />,
    );
    const group = screen.getByRole("radiogroup", { name: /text size/i });
    const active = Array.from(
      group.querySelectorAll<HTMLElement>('[role="radio"]'),
    ).find((b) => b.getAttribute("aria-checked") === "true");
    expect(active).toBeTruthy();
  });

  it("does not call IPC in browser-dev mode", async () => {
    render(<SettingsView density="comfy" a11y={stubA11y()} />);
    await waitFor(() => {});
    expect(invokeMock).not.toHaveBeenCalled();
  });
});

describe("SettingsView (inside Tauri)", () => {
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
    render(<FreshSettingsView density="comfy" a11y={stubA11y()} />);
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
    render(<FreshSettingsView density="comfy" a11y={stubA11y()} />);
    expect(await screen.findByText(/restore is staged/i)).toBeTruthy();
  });

  it("surfaces a status banner (status.kind=done) after a backup export", async () => {
    invokeMock
      .mockResolvedValueOnce({
        dataDir: "/data",
        dbPath: "/data/cairn.sqlite",
        pendingImport: null,
      })
      .mockResolvedValueOnce("cairn-backup.sqlite")
      .mockResolvedValueOnce("/tmp/written.sqlite");
    saveMock.mockResolvedValue("/tmp/written.sqlite");
    const { SettingsView: FreshSettingsView } = await import("./settings");
    render(<FreshSettingsView density="comfy" a11y={stubA11y()} />);
    const btn = await screen.findByRole("button", { name: /export backup/i });
    await act(async () => {
      fireEvent.click(btn);
    });
    expect(await screen.findByText(/backup saved to/i)).toBeTruthy();
  });

  it("renders a status banner with role=alert on error", async () => {
    invokeMock
      .mockResolvedValueOnce({
        dataDir: "/data",
        dbPath: "/data/cairn.sqlite",
        pendingImport: null,
      })
      .mockResolvedValueOnce("cairn-backup.sqlite")
      .mockRejectedValueOnce(new Error("disk full"));
    saveMock.mockResolvedValue("/tmp/out.sqlite");
    const { SettingsView: FreshSettingsView } = await import("./settings");
    render(<FreshSettingsView density="comfy" a11y={stubA11y()} />);
    const btn = await screen.findByRole("button", { name: /export backup/i });
    await act(async () => {
      fireEvent.click(btn);
    });
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/disk full/);
  });
});
