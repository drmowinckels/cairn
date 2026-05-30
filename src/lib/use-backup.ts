import { useCallback, useEffect, useState } from "react";
import { ask, open, save } from "@tauri-apps/plugin-dialog";
import {
  cancelPendingImport,
  dataPaths,
  deleteEverything,
  exportBackup,
  exportCsv,
  inTauri,
  listDataFiles,
  revealDataFolder,
  setPinned,
  stageImport,
  suggestedBackupName,
  suggestedCsvName,
  type DataFileInfo,
  type DataPaths,
} from "./ipc";

/**
 * Run `fn` with the popover temporarily pinned. Native dialogs
 * (`ask`/`save`/`open`) steal focus, which fires the popover's
 * blur-to-close handler and hides it mid-flow — the window vanishing
 * read as a crash on "Delete everything", and silently hid the status
 * line after an export. Pinning suppresses the blur-hide for the
 * duration; the pin is always released, even on throw.
 */
async function withPopoverPinned<T>(fn: () => Promise<T>): Promise<T> {
  await setPinned(true);
  try {
    return await fn();
  } finally {
    await setPinned(false);
  }
}

export type BackupStatus =
  | { kind: "idle" }
  | { kind: "working"; message: string }
  | { kind: "done"; message: string }
  | { kind: "error"; message: string };

export interface BackupState {
  paths: DataPaths | null;
  pendingImport: string | null;
  status: BackupStatus;
  dataFiles: DataFileInfo[];
  exportBackupToFile: () => Promise<void>;
  importBackupFromFile: () => Promise<void>;
  cancelImport: () => Promise<void>;
  exportCsvToFile: () => Promise<void>;
  revealDataFolder: () => Promise<void>;
  refreshDataFiles: () => Promise<void>;
  deleteAllData: () => Promise<void>;
}

export function useBackup(): BackupState {
  const [paths, setPaths] = useState<DataPaths | null>(null);
  const [status, setStatus] = useState<BackupStatus>({ kind: "idle" });
  const [dataFiles, setDataFiles] = useState<DataFileInfo[]>([]);

  const refreshPaths = useCallback(async () => {
    if (!inTauri) return;
    try {
      setPaths(await dataPaths());
    } catch (e) {
      console.warn("data_paths failed", e);
    }
  }, []);

  const refreshDataFiles = useCallback(async () => {
    if (!inTauri) return;
    try {
      setDataFiles(await listDataFiles());
    } catch (e) {
      console.warn("list_data_files failed", e);
    }
  }, []);

  useEffect(() => {
    refreshPaths();
    refreshDataFiles();
  }, [refreshPaths, refreshDataFiles]);

  const exportBackupToFile = useCallback(async () => {
    if (!inTauri) return;
    try {
      const defaultPath = await suggestedBackupName();
      const dest = await withPopoverPinned(() =>
        save({
          title: "Export Cairn backup",
          defaultPath,
          filters: [{ name: "SQLite database", extensions: ["sqlite"] }],
        }),
      );
      if (!dest) return;
      setStatus({ kind: "working", message: "Writing backup…" });
      const written = await exportBackup(dest);
      setStatus({ kind: "done", message: `Backup saved to ${written}` });
    } catch (e) {
      setStatus({ kind: "error", message: String(e) });
    }
  }, []);

  const importBackupFromFile = useCallback(async () => {
    if (!inTauri) return;
    try {
      const src = await withPopoverPinned(() =>
        open({
          title: "Restore Cairn backup",
          multiple: false,
          directory: false,
          filters: [{ name: "SQLite database", extensions: ["sqlite", "db"] }],
        }),
      );
      if (!src || Array.isArray(src)) return;
      setStatus({ kind: "working", message: "Staging restore…" });
      await stageImport(src);
      await refreshPaths();
      setStatus({
        kind: "done",
        message: "Restore staged. Quit and reopen Cairn to apply it.",
      });
    } catch (e) {
      setStatus({ kind: "error", message: String(e) });
    }
  }, [refreshPaths]);

  const cancelImport = useCallback(async () => {
    if (!inTauri) return;
    try {
      await cancelPendingImport();
      await refreshPaths();
      setStatus({ kind: "done", message: "Pending restore cancelled." });
    } catch (e) {
      setStatus({ kind: "error", message: String(e) });
    }
  }, [refreshPaths]);

  const exportCsvToFile = useCallback(async () => {
    if (!inTauri) return;
    try {
      const defaultPath = await suggestedCsvName();
      const dest = await withPopoverPinned(() =>
        save({
          title: "Export entries as CSV",
          defaultPath,
          filters: [{ name: "CSV", extensions: ["csv"] }],
        }),
      );
      if (!dest) return;
      setStatus({ kind: "working", message: "Writing CSV…" });
      const written = await exportCsv(dest);
      setStatus({ kind: "done", message: `Entries written to ${written}` });
    } catch (e) {
      setStatus({ kind: "error", message: String(e) });
    }
  }, []);

  const revealFolder = useCallback(async () => {
    if (!inTauri) return;
    try {
      await revealDataFolder();
    } catch (e) {
      setStatus({ kind: "error", message: String(e) });
    }
  }, []);

  const deleteAllData = useCallback(async () => {
    if (!inTauri) return;
    try {
      const confirmed = await withPopoverPinned(() =>
        ask(
          "This deletes every project, entry, rule, and tag stored on this machine. There is no undo. Continue?",
          {
            title: "Delete all Cairn data?",
            kind: "warning",
            okLabel: "Delete everything",
            cancelLabel: "Keep my data",
          },
        ),
      );
      if (!confirmed) return;
      setStatus({ kind: "working", message: "Deleting…" });
      await deleteEverything();
      // The backend wiped + reseeded the DB in place (no exit/restart —
      // those crashed the app). Reload the webview so every view
      // refetches the empty state and onboarding re-arms.
      setStatus({ kind: "done", message: "All data deleted." });
      try {
        window.location?.reload?.();
      } catch {
        /* non-browser / happy-dom: navigation not implemented — ignore */
      }
    } catch (e) {
      setStatus({ kind: "error", message: String(e) });
    }
  }, []);

  return {
    paths,
    pendingImport: paths?.pendingImport ?? null,
    status,
    dataFiles,
    exportBackupToFile,
    importBackupFromFile,
    cancelImport,
    exportCsvToFile,
    revealDataFolder: revealFolder,
    refreshDataFiles,
    deleteAllData,
  };
}
