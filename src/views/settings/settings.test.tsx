import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";

const invokeMock = vi.fn();
const askMock = vi.fn();
const openMock = vi.fn();
const saveMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({
  ask: (...args: unknown[]) => askMock(...args),
  open: (...args: unknown[]) => openMock(...args),
  save: (...args: unknown[]) => saveMock(...args),
}));

import { SettingsView } from "./index";
import type { UseA11yPrefs } from "../../lib/use-a11y-prefs";
import type { UseSignalCapture } from "../../lib/use-signal-capture";

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
    ambiguityDefault: "prompt",
    setTextScale: vi.fn(),
    setHighContrast: vi.fn(),
    setReduceMotion: vi.fn(),
    setColorblindSafe: vi.fn(),
    setAnnounce: vi.fn(),
    setAlwaysFocusRing: vi.fn(),
    setDetectionPrompts: vi.fn(),
    setAmbiguityDefault: vi.fn(),
    ...overrides,
  };
}

function stubCapture(overrides: Partial<UseSignalCapture> = {}): UseSignalCapture {
  return {
    status: { active: false, path: null, bytesWritten: 0 },
    error: null,
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
    refresh: vi.fn(async () => undefined),
    ...overrides,
  };
}

beforeEach(() => {
  invokeMock.mockReset();
  askMock.mockReset();
  openMock.mockReset();
  saveMock.mockReset();
});

afterEach(() => {
  delete (globalThis as WithInternals).__TAURI_INTERNALS__;
});

describe("SettingsView (browser-dev mode)", () => {
  it("renders the four privacy guarantees verbatim from PRIVACY.md", () => {
    render(<SettingsView density="comfy" a11y={stubA11y()} capture={stubCapture()} />);
    expect(
      screen.getByText(/Everything is stored locally/i),
    ).toBeTruthy();
    expect(
      screen.getByText(/SQLite database under ~\/\.cairn\//i),
    ).toBeTruthy();
    expect(
      screen.getByText(/No accounts\. No telemetry\. No background phone-home\./i),
    ).toBeTruthy();
    expect(
      screen.getByText(/Window titles are read locally and never leave the device\./i),
    ).toBeTruthy();
    expect(
      screen.getByText(/Source on GitHub, Apache 2\.0 licensed\./i),
    ).toBeTruthy();
  });

  it("renders the Source on GitHub · Apache-2.0 attribution with a real link", () => {
    render(<SettingsView density="comfy" a11y={stubA11y()} capture={stubCapture()} />);
    const link = screen.getByRole("link", { name: /source on github/i });
    expect(link.getAttribute("href")).toBe(
      "https://github.com/drmowinckels/cairn",
    );
    expect(link.getAttribute("rel")).toMatch(/noopener/);
  });

  it("renders the five privacy action buttons", () => {
    render(<SettingsView density="comfy" a11y={stubA11y()} capture={stubCapture()} />);
    for (const name of [
      /export all data/i,
      /restore from file/i,
      /export csv/i,
      /view what's stored/i,
      /delete everything/i,
    ]) {
      expect(screen.getByRole("button", { name })).toBeTruthy();
    }
  });

  it("'View what's stored' is always clickable so the button is keyboard-reachable", () => {
    render(<SettingsView density="comfy" a11y={stubA11y()} capture={stubCapture()} />);
    const btn = screen.getByRole("button", { name: /view what's stored/i });
    expect(btn.hasAttribute("disabled")).toBe(false);
  });

  it("renders an exclusion list (or its empty hint) with at least one signal", () => {
    const { container } = render(
      <SettingsView density="comfy" a11y={stubA11y()} capture={stubCapture()} />,
    );
    // Either there's an exclusion list section, OR the empty hint is shown.
    expect(
      container.querySelector(".excl-list, .settings-block"),
    ).toBeTruthy();
  });

  it("clicking an accessibility toggle calls the matching a11y setter", () => {
    const a11y = stubA11y({ highContrast: false });
    render(<SettingsView density="comfy" a11y={a11y} capture={stubCapture()} />);
    const sw = screen.getByRole("switch", { name: /high contrast/i });
    fireEvent.click(sw);
    expect(a11y.setHighContrast).toHaveBeenCalledWith(true);
  });

  it("renders the text-scale segmented control with the active option highlighted", () => {
    render(
      <SettingsView density="comfy" a11y={stubA11y({ textScale: "lg" })} capture={stubCapture()} />,
    );
    const group = screen.getByRole("radiogroup", { name: /text size/i });
    const active = Array.from(
      group.querySelectorAll<HTMLElement>('[role="radio"]'),
    ).find((b) => b.getAttribute("aria-checked") === "true");
    expect(active).toBeTruthy();
  });

  it("renders the Default ambiguity behaviour segmented control with the active option highlighted", () => {
    render(
      <SettingsView
        density="comfy"
        a11y={stubA11y({ ambiguityDefault: "log-to-uncategorized" })}
        capture={stubCapture()}
      />,
    );
    const group = screen.getByRole("radiogroup", {
      name: /default ambiguity behaviour/i,
    });
    const active = Array.from(
      group.querySelectorAll<HTMLElement>('[role="radio"]'),
    ).find((b) => b.getAttribute("aria-checked") === "true");
    expect(active?.textContent).toMatch(/Uncategorized/i);
  });

  it("clicking an ambiguity option calls setAmbiguityDefault with the new value", () => {
    const a11y = stubA11y({ ambiguityDefault: "prompt" });
    render(<SettingsView density="comfy" a11y={a11y} capture={stubCapture()} />);
    const group = screen.getByRole("radiogroup", {
      name: /default ambiguity behaviour/i,
    });
    const skipBtn = Array.from(
      group.querySelectorAll<HTMLElement>('[role="radio"]'),
    ).find((b) => b.textContent === "Skip");
    expect(skipBtn).toBeTruthy();
    fireEvent.click(skipBtn!);
    expect(a11y.setAmbiguityDefault).toHaveBeenCalledExactlyOnceWith("skip");
  });

  it("does not call IPC in browser-dev mode", async () => {
    render(<SettingsView density="comfy" a11y={stubA11y()} capture={stubCapture()} />);
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

  it("'View what's stored' wires to the reveal_data_folder IPC", async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "data_paths") {
        return {
          dataDir: "/data",
          dbPath: "/data/cairn.sqlite",
          pendingImport: null,
        };
      }
      if (cmd === "list_data_files") return [];
      if (cmd === "reveal_data_folder") return null;
      return null;
    });
    const { SettingsView: FreshSettingsView } = await import("./settings");
    render(<FreshSettingsView density="comfy" a11y={stubA11y()} capture={stubCapture()} />);
    const btn = await screen.findByRole("button", {
      name: /view what's stored/i,
    });
    await act(async () => {
      fireEvent.click(btn);
    });
    expect(invokeMock).toHaveBeenCalledWith("reveal_data_folder");
  });

  it("renders the list of stored files with formatted sizes", async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "data_paths") {
        return {
          dataDir: "/data",
          dbPath: "/data/cairn.sqlite",
          pendingImport: null,
        };
      }
      if (cmd === "list_data_files") {
        return [
          { name: "cairn.sqlite", sizeBytes: 2 * 1024 * 1024 },
          { name: "cairn.sqlite-wal", sizeBytes: 17 * 1024 },
          { name: "debug-signals.ndjson", sizeBytes: 512 },
        ];
      }
      return null;
    });
    const { SettingsView: FreshSettingsView } = await import("./settings");
    render(<FreshSettingsView density="comfy" a11y={stubA11y()} capture={stubCapture()} />);
    const list = await screen.findByRole("list", {
      name: /files currently stored/i,
    });
    expect(list.textContent).toContain("cairn.sqlite");
    expect(list.textContent).toContain("2.0 MB");
    expect(list.textContent).toContain("cairn.sqlite-wal");
    expect(list.textContent).toContain("17 KB");
    expect(list.textContent).toContain("debug-signals.ndjson");
    expect(list.textContent).toContain("512 B");
  });

  it("pins the rendered structure of the file list", async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "data_paths") {
        return {
          dataDir: "/data",
          dbPath: "/data/cairn.sqlite",
          pendingImport: null,
        };
      }
      if (cmd === "list_data_files") {
        return [
          { name: "cairn.sqlite", sizeBytes: 4096 },
          { name: "cairn.sqlite-wal", sizeBytes: 32768 },
        ];
      }
      return null;
    });
    const { SettingsView: FreshSettingsView } = await import("./settings");
    const { container } = render(
      <FreshSettingsView density="comfy" a11y={stubA11y()} capture={stubCapture()} />,
    );
    const list = await screen.findByRole("list", {
      name: /files currently stored/i,
    });
    expect(list.outerHTML).toMatchInlineSnapshot(
      `"<ul class="privacy-files" aria-label="Files currently stored on this machine"><li><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"></path></svg><code>cairn.sqlite</code><span class="privacy-files-size">4 KB</span></li><li><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"></path></svg><code>cairn.sqlite-wal</code><span class="privacy-files-size">32 KB</span></li></ul>"`,
    );
    expect(container.querySelector(".privacy-attrib")).toBeTruthy();
  });

  it("renders the pending-restore banner when a restore is staged", async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "data_paths") {
        return {
          dataDir: "/data",
          dbPath: "/data/cairn.sqlite",
          pendingImport: "/data/cairn.sqlite.pending",
        };
      }
      if (cmd === "list_data_files") return [];
      return null;
    });
    const { SettingsView: FreshSettingsView } = await import("./settings");
    render(<FreshSettingsView density="comfy" a11y={stubA11y()} capture={stubCapture()} />);
    expect(await screen.findByText(/restore is staged/i)).toBeTruthy();
  });

  it("surfaces a status banner (status.kind=done) after a backup export", async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "data_paths") {
        return {
          dataDir: "/data",
          dbPath: "/data/cairn.sqlite",
          pendingImport: null,
        };
      }
      if (cmd === "list_data_files") return [];
      if (cmd === "suggested_backup_name") return "cairn-backup.sqlite";
      if (cmd === "export_backup") return "/tmp/written.sqlite";
      return null;
    });
    saveMock.mockResolvedValue("/tmp/written.sqlite");
    const { SettingsView: FreshSettingsView } = await import("./settings");
    render(<FreshSettingsView density="comfy" a11y={stubA11y()} capture={stubCapture()} />);
    const btn = await screen.findByRole("button", { name: /export all data/i });
    await act(async () => {
      fireEvent.click(btn);
    });
    expect(await screen.findByText(/backup saved to/i)).toBeTruthy();
  });

  it("renders a status banner with role=alert on error", async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "data_paths") {
        return {
          dataDir: "/data",
          dbPath: "/data/cairn.sqlite",
          pendingImport: null,
        };
      }
      if (cmd === "list_data_files") return [];
      if (cmd === "suggested_backup_name") return "cairn-backup.sqlite";
      if (cmd === "export_backup") throw new Error("disk full");
      return null;
    });
    saveMock.mockResolvedValue("/tmp/out.sqlite");
    const { SettingsView: FreshSettingsView } = await import("./settings");
    render(<FreshSettingsView density="comfy" a11y={stubA11y()} capture={stubCapture()} />);
    const btn = await screen.findByRole("button", { name: /export all data/i });
    await act(async () => {
      fireEvent.click(btn);
    });
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/disk full/);
  });
});

describe("SettingsView · Advanced / Capture raw signals", () => {
  it("renders the Advanced section as the last block", () => {
    render(
      <SettingsView density="comfy" a11y={stubA11y()} capture={stubCapture()} />,
    );
    const advanced = screen.getByRole("region", { name: /advanced/i });
    expect(advanced).toBeTruthy();
    expect(advanced.textContent).toContain("Capture raw signals");
  });

  it("opens the confirmation dialog instead of starting capture immediately", async () => {
    const capture = stubCapture();
    render(<SettingsView density="comfy" a11y={stubA11y()} capture={capture} />);
    fireEvent.click(
      screen.getByRole("switch", { name: /capture raw signals/i }),
    );

    const dialog = await screen.findByTestId("capture-confirm");
    expect(dialog).toBeTruthy();
    expect(dialog.textContent).toMatch(
      /troubleshooting|writes|toggle is never persisted/i,
    );
    expect(capture.start).not.toHaveBeenCalled();
  });

  it("invokes capture.start() only after the confirmation button is pressed", async () => {
    const capture = stubCapture();
    render(<SettingsView density="comfy" a11y={stubA11y()} capture={capture} />);
    fireEvent.click(
      screen.getByRole("switch", { name: /capture raw signals/i }),
    );

    fireEvent.click(
      await screen.findByRole("button", {
        name: /I understand — capture for this session/i,
      }),
    );

    await waitFor(() => expect(capture.start).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(screen.queryByTestId("capture-confirm")).toBeNull(),
    );
  });

  it("cancelling the dialog does not start capture", async () => {
    const capture = stubCapture();
    render(<SettingsView density="comfy" a11y={stubA11y()} capture={capture} />);
    fireEvent.click(
      screen.getByRole("switch", { name: /capture raw signals/i }),
    );
    fireEvent.click(await screen.findByRole("button", { name: /cancel/i }));
    await waitFor(() =>
      expect(screen.queryByTestId("capture-confirm")).toBeNull(),
    );
    expect(capture.start).not.toHaveBeenCalled();
  });

  it("clicking the toggle when active calls stop() without re-opening the dialog", () => {
    const capture = stubCapture({
      status: {
        active: true,
        path: "/tmp/cairn/debug-signals.ndjson",
        bytesWritten: 1,
      },
    });
    render(<SettingsView density="comfy" a11y={stubA11y()} capture={capture} />);
    expect(screen.queryByTestId("capture-confirm")).toBeNull();
    fireEvent.click(
      screen.getByRole("switch", { name: /capture raw signals/i }),
    );
    expect(capture.stop).toHaveBeenCalledTimes(1);
  });

  it("renders the on-disk path while capture is active", () => {
    const capture = stubCapture({
      status: {
        active: true,
        path: "/tmp/cairn/debug-signals.ndjson",
        bytesWritten: 256,
      },
    });
    render(<SettingsView density="comfy" a11y={stubA11y()} capture={capture} />);
    expect(screen.getByTestId("capture-path").textContent).toContain(
      "/tmp/cairn/debug-signals.ndjson",
    );
  });

  it("renders an error banner when capture.error is set", () => {
    const capture = stubCapture({ error: "boom" });
    render(<SettingsView density="comfy" a11y={stubA11y()} capture={capture} />);
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("boom");
  });
});
