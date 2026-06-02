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
