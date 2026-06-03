import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";

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

// The auto-backup panel has its own hook (separately tested in
// use-auto-backup.test). Mock it here so the storage tests control its
// state without driving its IPC, and so the panel's own branches can be
// exercised by swapping `auto.current`.
const auto = vi.hoisted(() => ({
  current: null as unknown,
}));
vi.mock("../../lib/use-auto-backup", () => ({
  useAutoBackup: () => auto.current,
}));

interface AutoMock {
  settings: {
    enabled: boolean;
    dir: string | null;
    intervalHours: number;
    keep: number;
  };
  status: { lastBackupAt: string | null; count: number };
  op: { kind: string; message?: string };
  setEnabled: ReturnType<typeof vi.fn>;
  chooseFolder: ReturnType<typeof vi.fn>;
  setIntervalHours: ReturnType<typeof vi.fn>;
  setKeep: ReturnType<typeof vi.fn>;
  backupNow: ReturnType<typeof vi.fn>;
}

function makeAuto(overrides: Partial<AutoMock> = {}): AutoMock {
  return {
    settings: { enabled: false, dir: null, intervalHours: 24, keep: 14 },
    status: { lastBackupAt: null, count: 0 },
    op: { kind: "idle" },
    setEnabled: vi.fn(),
    chooseFolder: vi.fn(),
    setIntervalHours: vi.fn(),
    setKeep: vi.fn(),
    backupNow: vi.fn(),
    ...overrides,
  };
}

type WithInternals = { __TAURI_INTERNALS__?: unknown };

beforeEach(() => {
  // inTauri is evaluated at module import — set the flag, then reset
  // modules so the dynamic import below re-reads it as true.
  (globalThis as WithInternals).__TAURI_INTERNALS__ = {};
  vi.resetModules();
  invokeMock.mockReset();
  askMock.mockReset();
  openMock.mockReset();
  saveMock.mockReset();
  auto.current = makeAuto();
});

afterEach(() => {
  delete (globalThis as WithInternals).__TAURI_INTERNALS__;
});

const PATHS = {
  dataDir: "/data",
  dbPath: "/data/cairn.sqlite",
  pendingImport: null as string | null,
};

async function renderStorage() {
  const { DataStorageActions } = await import("./data-storage");
  return render(<DataStorageActions />);
}

describe("DataStorageActions", () => {
  it("renders the five storage action buttons", async () => {
    invokeMock.mockResolvedValue(null);
    await renderStorage();
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

  it("'View what's stored' is always clickable (keyboard-reachable)", async () => {
    invokeMock.mockResolvedValue(null);
    await renderStorage();
    const btn = screen.getByRole("button", { name: /view what's stored/i });
    expect(btn.hasAttribute("disabled")).toBe(false);
  });

  it("'View what's stored' wires to the reveal_data_folder IPC", async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "data_paths") return PATHS;
      if (cmd === "list_data_files") return [];
      if (cmd === "reveal_data_folder") return null;
      return null;
    });
    await renderStorage();
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
      if (cmd === "data_paths") return PATHS;
      if (cmd === "list_data_files") {
        return [
          { name: "cairn.sqlite", sizeBytes: 2 * 1024 * 1024 },
          { name: "cairn.sqlite-wal", sizeBytes: 17 * 1024 },
          { name: "debug-signals.ndjson", sizeBytes: 512 },
        ];
      }
      return null;
    });
    await renderStorage();
    const list = await screen.findByRole("list", {
      name: /files currently stored/i,
    });
    expect(list.textContent).toContain("cairn.sqlite");
    expect(list.textContent).toContain("2.0 MB");
    expect(list.textContent).toContain("17 KB");
    expect(list.textContent).toContain("debug-signals.ndjson");
    expect(list.textContent).toContain("512 B");
  });

  it("renders the pending-restore banner when a restore is staged", async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "data_paths") {
        return { ...PATHS, pendingImport: "/data/cairn.sqlite.pending" };
      }
      if (cmd === "list_data_files") return [];
      return null;
    });
    await renderStorage();
    expect(await screen.findByText(/restore is staged/i)).toBeTruthy();
  });

  it("surfaces a status banner after a successful export", async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "data_paths") return PATHS;
      if (cmd === "list_data_files") return [];
      if (cmd === "suggested_backup_name") return "cairn-backup.sqlite";
      if (cmd === "export_backup") return "/tmp/written.sqlite";
      return null;
    });
    saveMock.mockResolvedValue("/tmp/written.sqlite");
    await renderStorage();
    const btn = await screen.findByRole("button", { name: /export all data/i });
    await act(async () => {
      fireEvent.click(btn);
    });
    expect(await screen.findByText(/backup saved to/i)).toBeTruthy();
  });

  it("renders a status banner with role=alert on export failure", async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "data_paths") return PATHS;
      if (cmd === "list_data_files") return [];
      if (cmd === "suggested_backup_name") return "cairn-backup.sqlite";
      if (cmd === "export_backup") throw new Error("disk full");
      return null;
    });
    saveMock.mockResolvedValue("/tmp/out.sqlite");
    await renderStorage();
    const btn = await screen.findByRole("button", { name: /export all data/i });
    await act(async () => {
      fireEvent.click(btn);
    });
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/disk full/);
  });
});

describe("DataStorageActions — automatic backup panel", () => {
  it("shows a single 'Choose backup folder…' CTA when unconfigured", async () => {
    invokeMock.mockResolvedValue(null);
    auto.current = makeAuto(); // dir = null
    await renderStorage();
    const cta = screen.getByRole("button", { name: /choose backup folder/i });
    fireEvent.click(cta);
    expect((auto.current as AutoMock).chooseFolder).toHaveBeenCalled();
    // The configured controls are absent.
    expect(screen.queryByLabelText(/backup frequency/i)).toBeNull();
  });

  it("renders folder, toggle, schedule, retention and status when configured", async () => {
    invokeMock.mockResolvedValue(null);
    const a = makeAuto({
      settings: {
        enabled: true,
        dir: "/sync/cairn",
        intervalHours: 24,
        keep: 14,
      },
      status: { lastBackupAt: new Date().toISOString(), count: 3 },
    });
    auto.current = a;
    await renderStorage();

    expect(screen.getByText("/sync/cairn")).toBeTruthy();
    const toggle = screen.getByRole("checkbox", {
      name: /back up automatically/i,
    });
    expect((toggle as HTMLInputElement).checked).toBe(true);

    // Status meta reflects the count.
    expect(screen.getByText(/3 snapshots · last/i)).toBeTruthy();

    // Mutators are wired.
    fireEvent.click(toggle);
    expect(a.setEnabled).toHaveBeenCalledWith(false);

    fireEvent.change(screen.getByLabelText(/backup frequency/i), {
      target: { value: "168" },
    });
    expect(a.setIntervalHours).toHaveBeenCalledWith(168);

    fireEvent.change(screen.getByLabelText(/snapshots to keep/i), {
      target: { value: "30" },
    });
    expect(a.setKeep).toHaveBeenCalledWith(30);

    fireEvent.click(screen.getByRole("button", { name: /back up now/i }));
    expect(a.backupNow).toHaveBeenCalled();
  });

  it("shows 'No snapshots yet' before the first backup", async () => {
    invokeMock.mockResolvedValue(null);
    auto.current = makeAuto({
      settings: {
        enabled: true,
        dir: "/sync/cairn",
        intervalHours: 24,
        keep: 14,
      },
      status: { lastBackupAt: null, count: 0 },
    });
    await renderStorage();
    expect(screen.getByText(/no snapshots yet/i)).toBeTruthy();
  });

  it("surfaces the panel op banner as an alert on error", async () => {
    invokeMock.mockResolvedValue(null);
    auto.current = makeAuto({
      settings: {
        enabled: true,
        dir: "/sync/cairn",
        intervalHours: 24,
        keep: 14,
      },
      op: {
        kind: "error",
        message: "no automatic-backup folder is configured",
      },
    });
    await renderStorage();
    const alerts = await screen.findAllByRole("alert");
    expect(
      alerts.some((a) =>
        /no automatic-backup folder/i.test(a.textContent ?? ""),
      ),
    ).toBe(true);
  });
});
