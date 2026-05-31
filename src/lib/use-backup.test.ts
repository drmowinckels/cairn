import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";

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

const PATHS = {
  dataDir: "/data/cairn",
  dbPath: "/data/cairn/cairn.sqlite",
  pendingImport: null,
};

/**
 * Build a Tauri `invoke` mock that answers `data_paths` + `list_data_files`
 * on mount, then delegates to user-supplied `handlers` for whatever the
 * individual test cares about. Keeps each test focused on one command
 * without re-mocking the boilerplate startup calls.
 */
function mockInvoke(
  handlers: Record<string, (...args: unknown[]) => unknown> = {},
  pathsOverride: typeof PATHS = PATHS,
) {
  invokeMock.mockImplementation(async (cmd: string, ...rest: unknown[]) => {
    if (cmd === "data_paths") return pathsOverride;
    if (cmd === "list_data_files") return [];
    const handler = handlers[cmd];
    if (handler) return handler(...rest);
    return undefined;
  });
}

afterEach(() => {
  invokeMock.mockReset();
  askMock.mockReset();
  openMock.mockReset();
  saveMock.mockReset();
});

describe("useBackup (outside Tauri)", () => {
  beforeEach(() => {
    delete (globalThis as WithInternals).__TAURI_INTERNALS__;
    vi.resetModules();
  });

  it("returns idle status and no paths, no IPC traffic", async () => {
    const { useBackup } = await import("./use-backup");
    const { result } = renderHook(() => useBackup());
    expect(result.current.status).toEqual({ kind: "idle" });
    expect(result.current.paths).toBeNull();
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("all six actions are no-ops outside Tauri", async () => {
    const { useBackup } = await import("./use-backup");
    const { result } = renderHook(() => useBackup());
    await act(async () => {
      await result.current.exportBackupToFile();
      await result.current.importBackupFromFile();
      await result.current.cancelImport();
      await result.current.exportCsvToFile();
      await result.current.deleteAllData();
      await result.current.revealDataFolder();
      await result.current.refreshDataFiles();
    });
    expect(invokeMock).not.toHaveBeenCalled();
    expect(saveMock).not.toHaveBeenCalled();
    expect(openMock).not.toHaveBeenCalled();
    expect(askMock).not.toHaveBeenCalled();
    // Status stays idle — every action short-circuited.
    expect(result.current.status).toEqual({ kind: "idle" });
    expect(result.current.dataFiles).toEqual([]);
  });
});

describe("useBackup (inside Tauri)", () => {
  let original: unknown;

  beforeEach(() => {
    original = (globalThis as WithInternals).__TAURI_INTERNALS__;
    (globalThis as WithInternals).__TAURI_INTERNALS__ = {};
    vi.resetModules();
  });

  afterEach(() => {
    if (original === undefined) {
      delete (globalThis as WithInternals).__TAURI_INTERNALS__;
    } else {
      (globalThis as WithInternals).__TAURI_INTERNALS__ = original;
    }
  });

  it("loads data paths on mount", async () => {
    mockInvoke();
    const { useBackup } = await import("./use-backup");
    const { result } = renderHook(() => useBackup());
    await waitFor(() => expect(result.current.paths).not.toBeNull());
    expect(result.current.paths?.dbPath).toBe("/data/cairn/cairn.sqlite");
  });

  it("loads the data file list on mount", async () => {
    const files = [
      { name: "cairn.sqlite", sizeBytes: 4096 },
      { name: "cairn.sqlite-wal", sizeBytes: 0 },
    ];
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "data_paths") return PATHS;
      if (cmd === "list_data_files") return files;
      return undefined;
    });
    const { useBackup } = await import("./use-backup");
    const { result } = renderHook(() => useBackup());
    await waitFor(() => expect(result.current.dataFiles).toEqual(files));
  });

  it("exportBackupToFile flows through suggested-name → save dialog → export_backup", async () => {
    mockInvoke({
      suggested_backup_name: () => "cairn-backup.sqlite",
      export_backup: () => "/tmp/written.sqlite",
    });
    saveMock.mockResolvedValue("/tmp/written.sqlite");

    const { useBackup } = await import("./use-backup");
    const { result } = renderHook(() => useBackup());
    await waitFor(() => expect(result.current.paths).not.toBeNull());

    await act(async () => {
      await result.current.exportBackupToFile();
    });

    expect(saveMock).toHaveBeenCalledWith(
      expect.objectContaining({ defaultPath: "cairn-backup.sqlite" }),
    );
    expect(invokeMock).toHaveBeenCalledWith("export_backup", {
      dest: "/tmp/written.sqlite",
    });
    expect(result.current.status.kind).toBe("done");
  });

  it("exportBackupToFile is a no-op when the user cancels the save dialog", async () => {
    mockInvoke({ suggested_backup_name: () => "cairn-backup.sqlite" });
    saveMock.mockResolvedValue(null);

    const { useBackup } = await import("./use-backup");
    const { result } = renderHook(() => useBackup());
    await waitFor(() => expect(result.current.paths).not.toBeNull());

    await act(async () => {
      await result.current.exportBackupToFile();
    });

    expect(invokeMock).not.toHaveBeenCalledWith(
      "export_backup",
      expect.anything(),
    );
    expect(result.current.status).toEqual({ kind: "idle" });
  });

  it("deleteAllData requires confirmation before calling delete_everything", async () => {
    mockInvoke();
    askMock.mockResolvedValue(false);

    const { useBackup } = await import("./use-backup");
    const { result } = renderHook(() => useBackup());
    await waitFor(() => expect(result.current.paths).not.toBeNull());

    await act(async () => {
      await result.current.deleteAllData();
    });

    expect(invokeMock).not.toHaveBeenCalledWith(
      "delete_everything",
      expect.anything(),
    );
  });

  it("deleteAllData proceeds when confirmed", async () => {
    mockInvoke({ delete_everything: () => null });
    askMock.mockResolvedValue(true);

    const { useBackup } = await import("./use-backup");
    const { result } = renderHook(() => useBackup());
    await waitFor(() => expect(result.current.paths).not.toBeNull());

    await act(async () => {
      await result.current.deleteAllData();
    });

    expect(invokeMock).toHaveBeenCalledWith("delete_everything");
    expect(result.current.status.kind).toBe("done");
  });

  it("pins the popover around the delete confirmation, then unpins", async () => {
    // The native ask() dialog steals focus and would otherwise blur-hide
    // the popover (looked like a crash). deleteAllData must pin before
    // the dialog and unpin after.
    mockInvoke({ delete_everything: () => null });
    const order: string[] = [];
    invokeMock.mockImplementation(async (cmd: string, args?: unknown) => {
      if (cmd === "set_pinned") {
        order.push(
          `set_pinned:${(args as { pinned: boolean } | undefined)?.pinned}`,
        );
        return null;
      }
      if (cmd === "data_paths") return { dataDir: "/d", dbPath: "/d/x", pendingImport: null };
      if (cmd === "list_data_files") return [];
      if (cmd === "delete_everything") {
        order.push("delete_everything");
        return null;
      }
      return null;
    });
    askMock.mockImplementation(async () => {
      order.push("ask");
      return true;
    });

    const { useBackup } = await import("./use-backup");
    const { result } = renderHook(() => useBackup());
    await act(async () => {
      await result.current.deleteAllData();
    });

    // pin(true) → ask → pin(false) all happen before the delete invoke.
    expect(order).toEqual([
      "set_pinned:true",
      "ask",
      "set_pinned:false",
      "delete_everything",
    ]);
  });

  it("importBackupFromFile stages the chosen file and refreshes paths", async () => {
    let staged = false;
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "data_paths") {
        return staged ? { ...PATHS, pendingImport: "/staged/pending" } : PATHS;
      }
      if (cmd === "list_data_files") return [];
      if (cmd === "stage_import") {
        staged = true;
        return "/staged/pending";
      }
      return undefined;
    });
    openMock.mockResolvedValue("/picked/source.sqlite");

    const { useBackup } = await import("./use-backup");
    const { result } = renderHook(() => useBackup());
    await waitFor(() => expect(result.current.paths).not.toBeNull());

    await act(async () => {
      await result.current.importBackupFromFile();
    });

    expect(invokeMock).toHaveBeenCalledWith("stage_import", {
      src: "/picked/source.sqlite",
    });
    expect(result.current.pendingImport).toBe("/staged/pending");
    expect(result.current.status.kind).toBe("done");
  });

  it("revealDataFolder calls the reveal_data_folder IPC", async () => {
    const revealed = vi.fn().mockResolvedValue(null);
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "data_paths") return PATHS;
      if (cmd === "list_data_files") return [];
      if (cmd === "reveal_data_folder") {
        revealed();
        return null;
      }
      return undefined;
    });
    const { useBackup } = await import("./use-backup");
    const { result } = renderHook(() => useBackup());
    await waitFor(() => expect(result.current.paths).not.toBeNull());

    await act(async () => {
      await result.current.revealDataFolder();
    });

    expect(revealed).toHaveBeenCalledTimes(1);
  });

  it("revealDataFolder fires the IPC even when paths failed to load", async () => {
    const revealed = vi.fn().mockResolvedValue(null);
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "data_paths") throw new Error("paths failed");
      if (cmd === "list_data_files") return [];
      if (cmd === "reveal_data_folder") {
        revealed();
        return null;
      }
      return undefined;
    });
    const { useBackup } = await import("./use-backup");
    const { result } = renderHook(() => useBackup());

    await act(async () => {
      await result.current.revealDataFolder();
    });

    expect(revealed).toHaveBeenCalledTimes(1);
  });

  it("cancelImport calls the IPC and refreshes paths to idle status", async () => {
    let cancelled = false;
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "data_paths") {
        return cancelled ? PATHS : { ...PATHS, pendingImport: "/staged" };
      }
      if (cmd === "list_data_files") return [];
      if (cmd === "cancel_pending_import") {
        cancelled = true;
        return null;
      }
      return undefined;
    });
    const { useBackup } = await import("./use-backup");
    const { result } = renderHook(() => useBackup());
    await waitFor(() =>
      expect(result.current.pendingImport).toBe("/staged"),
    );

    await act(async () => {
      await result.current.cancelImport();
    });

    expect(invokeMock).toHaveBeenCalledWith("cancel_pending_import");
    expect(result.current.pendingImport).toBeNull();
    expect(result.current.status.kind).toBe("done");
  });

  it("exportCsvToFile flows through suggested-name → save dialog → export_csv", async () => {
    mockInvoke({
      suggested_csv_name: () => "entries.csv",
      export_csv: () => "/tmp/entries.csv",
    });
    saveMock.mockResolvedValue("/tmp/entries.csv");

    const { useBackup } = await import("./use-backup");
    const { result } = renderHook(() => useBackup());
    await waitFor(() => expect(result.current.paths).not.toBeNull());

    await act(async () => {
      await result.current.exportCsvToFile();
    });

    expect(invokeMock).toHaveBeenCalledWith("export_csv", {
      dest: "/tmp/entries.csv",
      rounding: { intervalMinutes: 0, mode: "nearest" },
    });
    expect(result.current.status.kind).toBe("done");
  });

  it("exportCsvToFile forwards the rounding preference (#107)", async () => {
    mockInvoke({
      suggested_csv_name: () => "entries.csv",
      export_csv: () => "/tmp/entries.csv",
    });
    saveMock.mockResolvedValue("/tmp/entries.csv");

    const { useBackup } = await import("./use-backup");
    const { result } = renderHook(() => useBackup());
    await waitFor(() => expect(result.current.paths).not.toBeNull());

    await act(async () => {
      await result.current.exportCsvToFile({ intervalMinutes: 15, mode: "up" });
    });

    expect(invokeMock).toHaveBeenCalledWith("export_csv", {
      dest: "/tmp/entries.csv",
      rounding: { intervalMinutes: 15, mode: "up" },
    });
  });

  it("exportCsvToFile is a no-op when the save dialog is cancelled", async () => {
    mockInvoke({ suggested_csv_name: () => "entries.csv" });
    saveMock.mockResolvedValue(null);
    const { useBackup } = await import("./use-backup");
    const { result } = renderHook(() => useBackup());
    await waitFor(() => expect(result.current.paths).not.toBeNull());

    await act(async () => {
      await result.current.exportCsvToFile();
    });

    expect(invokeMock).not.toHaveBeenCalledWith(
      "export_csv",
      expect.anything(),
    );
  });

  it("captures errors from export_backup as status.kind=error", async () => {
    mockInvoke({
      suggested_backup_name: () => "cairn-backup.sqlite",
      export_backup: () => {
        throw new Error("disk full");
      },
    });
    saveMock.mockResolvedValue("/tmp/out.sqlite");
    const { useBackup } = await import("./use-backup");
    const { result } = renderHook(() => useBackup());
    await waitFor(() => expect(result.current.paths).not.toBeNull());

    await act(async () => {
      await result.current.exportBackupToFile();
    });

    expect(result.current.status.kind).toBe("error");
    expect((result.current.status as { message: string }).message).toContain(
      "disk full",
    );
  });

  it("importBackupFromFile is a no-op when the open dialog returns null", async () => {
    mockInvoke();
    openMock.mockResolvedValue(null);
    const { useBackup } = await import("./use-backup");
    const { result } = renderHook(() => useBackup());
    await waitFor(() => expect(result.current.paths).not.toBeNull());

    await act(async () => {
      await result.current.importBackupFromFile();
    });

    expect(invokeMock).not.toHaveBeenCalledWith(
      "stage_import",
      expect.anything(),
    );
  });

  it("refreshDataFiles updates the list when invoked manually", async () => {
    let call = 0;
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "data_paths") return PATHS;
      if (cmd === "list_data_files") {
        call += 1;
        return call === 1
          ? []
          : [{ name: "cairn.sqlite", sizeBytes: 1024 }];
      }
      return undefined;
    });
    const { useBackup } = await import("./use-backup");
    const { result } = renderHook(() => useBackup());
    await waitFor(() => expect(result.current.dataFiles).toEqual([]));
    await act(async () => {
      await result.current.refreshDataFiles();
    });
    expect(result.current.dataFiles).toEqual([
      { name: "cairn.sqlite", sizeBytes: 1024 },
    ]);
  });

  it("swallows errors from list_data_files without crashing the hook", async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "data_paths") return PATHS;
      if (cmd === "list_data_files") throw new Error("listing failed");
      return undefined;
    });
    const { useBackup } = await import("./use-backup");
    const { result } = renderHook(() => useBackup());
    await waitFor(() => expect(result.current.paths).not.toBeNull());
    expect(result.current.dataFiles).toEqual([]);
    expect(result.current.status).toEqual({ kind: "idle" });
  });

  it("captures errors from stage_import as status.kind=error", async () => {
    mockInvoke({
      stage_import: () => {
        throw new Error("staging failed");
      },
    });
    openMock.mockResolvedValue("/src/file.sqlite");
    const { useBackup } = await import("./use-backup");
    const { result } = renderHook(() => useBackup());
    await waitFor(() => expect(result.current.paths).not.toBeNull());
    await act(async () => {
      await result.current.importBackupFromFile();
    });
    expect(result.current.status.kind).toBe("error");
    expect((result.current.status as { message: string }).message).toContain(
      "staging failed",
    );
  });

  it("captures errors from cancel_pending_import as status.kind=error", async () => {
    mockInvoke({
      cancel_pending_import: () => {
        throw new Error("cancel failed");
      },
    });
    const { useBackup } = await import("./use-backup");
    const { result } = renderHook(() => useBackup());
    await waitFor(() => expect(result.current.paths).not.toBeNull());
    await act(async () => {
      await result.current.cancelImport();
    });
    expect(result.current.status.kind).toBe("error");
  });

  it("captures errors from export_csv as status.kind=error", async () => {
    mockInvoke({
      suggested_csv_name: () => "entries.csv",
      export_csv: () => {
        throw new Error("write failed");
      },
    });
    saveMock.mockResolvedValue("/tmp/x.csv");
    const { useBackup } = await import("./use-backup");
    const { result } = renderHook(() => useBackup());
    await waitFor(() => expect(result.current.paths).not.toBeNull());
    await act(async () => {
      await result.current.exportCsvToFile();
    });
    expect(result.current.status.kind).toBe("error");
  });

  it("captures errors from reveal_data_folder as status.kind=error", async () => {
    mockInvoke({
      reveal_data_folder: () => {
        throw new Error("opener failed");
      },
    });
    const { useBackup } = await import("./use-backup");
    const { result } = renderHook(() => useBackup());
    await waitFor(() => expect(result.current.paths).not.toBeNull());
    await act(async () => {
      await result.current.revealDataFolder();
    });
    expect(result.current.status.kind).toBe("error");
  });

  it("captures errors from delete_everything as status.kind=error", async () => {
    mockInvoke({
      delete_everything: () => {
        throw new Error("nuke failed");
      },
    });
    askMock.mockResolvedValue(true);
    const { useBackup } = await import("./use-backup");
    const { result } = renderHook(() => useBackup());
    await waitFor(() => expect(result.current.paths).not.toBeNull());
    await act(async () => {
      await result.current.deleteAllData();
    });
    expect(result.current.status.kind).toBe("error");
  });
});
