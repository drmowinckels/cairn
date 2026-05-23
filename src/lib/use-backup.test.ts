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

type WithInternals = { __TAURI_INTERNALS__?: unknown };

const PATHS = {
  dataDir: "/data/cairn",
  dbPath: "/data/cairn/cairn.sqlite",
  pendingImport: null,
};

afterEach(() => {
  invokeMock.mockReset();
  askMock.mockReset();
  openMock.mockReset();
  saveMock.mockReset();
  revealMock.mockReset();
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
    invokeMock.mockResolvedValueOnce(PATHS);
    const { useBackup } = await import("./use-backup");
    const { result } = renderHook(() => useBackup());
    await waitFor(() => expect(result.current.paths).not.toBeNull());
    expect(result.current.paths?.dbPath).toBe("/data/cairn/cairn.sqlite");
  });

  it("exportBackupToFile flows through suggested-name → save dialog → export_backup", async () => {
    invokeMock
      .mockResolvedValueOnce(PATHS) // data_paths
      .mockResolvedValueOnce("cairn-backup.sqlite") // suggested_backup_name
      .mockResolvedValueOnce("/tmp/written.sqlite"); // export_backup
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
    invokeMock
      .mockResolvedValueOnce(PATHS)
      .mockResolvedValueOnce("cairn-backup.sqlite");
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
    invokeMock.mockResolvedValueOnce(PATHS);
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
    invokeMock
      .mockResolvedValueOnce(PATHS)
      .mockResolvedValueOnce(null); // delete_everything
    askMock.mockResolvedValue(true);

    const { useBackup } = await import("./use-backup");
    const { result } = renderHook(() => useBackup());
    await waitFor(() => expect(result.current.paths).not.toBeNull());

    await act(async () => {
      await result.current.deleteAllData();
    });

    expect(invokeMock).toHaveBeenCalledWith("delete_everything", undefined);
    expect(result.current.status.kind).toBe("done");
  });

  it("importBackupFromFile stages the chosen file and refreshes paths", async () => {
    invokeMock
      .mockResolvedValueOnce(PATHS) // data_paths on mount
      .mockResolvedValueOnce("/staged/pending") // stage_import returns the staged path
      .mockResolvedValueOnce({
        ...PATHS,
        pendingImport: "/staged/pending",
      }); // data_paths after stage
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

  it("revealDataFolder calls the opener plugin with the db path", async () => {
    invokeMock.mockResolvedValueOnce(PATHS);
    const { useBackup } = await import("./use-backup");
    const { result } = renderHook(() => useBackup());
    await waitFor(() => expect(result.current.paths).not.toBeNull());

    await act(async () => {
      await result.current.revealDataFolder();
    });

    expect(revealMock).toHaveBeenCalledWith("/data/cairn/cairn.sqlite");
  });

  it("cancelImport calls the IPC and refreshes paths to idle status", async () => {
    invokeMock
      .mockResolvedValueOnce({ ...PATHS, pendingImport: "/staged" }) // initial
      .mockResolvedValueOnce(null) // cancel_pending_import
      .mockResolvedValueOnce(PATHS); // refresh paths
    const { useBackup } = await import("./use-backup");
    const { result } = renderHook(() => useBackup());
    await waitFor(() =>
      expect(result.current.pendingImport).toBe("/staged"),
    );

    await act(async () => {
      await result.current.cancelImport();
    });

    expect(invokeMock).toHaveBeenCalledWith("cancel_pending_import", undefined);
    expect(result.current.pendingImport).toBeNull();
    expect(result.current.status.kind).toBe("done");
  });

  it("exportCsvToFile flows through suggested-name → save dialog → export_csv", async () => {
    invokeMock
      .mockResolvedValueOnce(PATHS)
      .mockResolvedValueOnce("entries.csv") // suggested_csv_name
      .mockResolvedValueOnce("/tmp/entries.csv"); // export_csv
    saveMock.mockResolvedValue("/tmp/entries.csv");

    const { useBackup } = await import("./use-backup");
    const { result } = renderHook(() => useBackup());
    await waitFor(() => expect(result.current.paths).not.toBeNull());

    await act(async () => {
      await result.current.exportCsvToFile();
    });

    expect(invokeMock).toHaveBeenCalledWith("export_csv", {
      dest: "/tmp/entries.csv",
    });
    expect(result.current.status.kind).toBe("done");
  });

  it("exportCsvToFile is a no-op when the save dialog is cancelled", async () => {
    invokeMock.mockResolvedValueOnce(PATHS).mockResolvedValueOnce("entries.csv");
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
    invokeMock
      .mockResolvedValueOnce(PATHS)
      .mockResolvedValueOnce("cairn-backup.sqlite")
      .mockRejectedValueOnce(new Error("disk full"));
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
    invokeMock.mockResolvedValueOnce(PATHS);
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

  it("revealDataFolder is a no-op until paths have loaded", async () => {
    // No invokeMock value → data_paths rejects/yields undefined.
    invokeMock.mockResolvedValueOnce(undefined);
    const { useBackup } = await import("./use-backup");
    const { result } = renderHook(() => useBackup());
    // Without paths, revealDataFolder bails out.
    await act(async () => {
      await result.current.revealDataFolder();
    });
    expect(revealMock).not.toHaveBeenCalled();
  });
});
