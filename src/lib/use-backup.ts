import { useCallback, useEffect, useState } from "react";
import { ask, open, save } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import {
  cancelPendingImport,
  dataPaths,
  deleteEverything,
  exportBackup,
  exportCsv,
  inTauri,
  stageImport,
  suggestedBackupName,
  suggestedCsvName,
  type DataPaths,
} from "./ipc";

export type BackupStatus =
  | { kind: "idle" }
  | { kind: "working"; message: string }
  | { kind: "done"; message: string }
  | { kind: "error"; message: string };

export interface BackupState {
  paths: DataPaths | null;
  pendingImport: string | null;
  status: BackupStatus;
  exportBackupToFile: () => Promise<void>;
  importBackupFromFile: () => Promise<void>;
  cancelImport: () => Promise<void>;
  exportCsvToFile: () => Promise<void>;
  revealDataFolder: () => Promise<void>;
  deleteAllData: () => Promise<void>;
}

export function useBackup(): BackupState {
  const [paths, setPaths] = useState<DataPaths | null>(null);
  const [status, setStatus] = useState<BackupStatus>({ kind: "idle" });

  const refreshPaths = useCallback(async () => {
    if (!inTauri) return;
    try {
      setPaths(await dataPaths());
    } catch (e) {
      console.warn("data_paths failed", e);
    }
  }, []);

  useEffect(() => {
    refreshPaths();
  }, [refreshPaths]);

  const exportBackupToFile = useCallback(async () => {
    if (!inTauri) return;
    try {
      const defaultPath = await suggestedBackupName();
      const dest = await save({
        title: "Export Cairn backup",
        defaultPath,
        filters: [{ name: "SQLite database", extensions: ["sqlite"] }],
      });
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
      const src = await open({
        title: "Restore Cairn backup",
        multiple: false,
        directory: false,
        filters: [{ name: "SQLite database", extensions: ["sqlite", "db"] }],
      });
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
      const dest = await save({
        title: "Export entries as CSV",
        defaultPath,
        filters: [{ name: "CSV", extensions: ["csv"] }],
      });
      if (!dest) return;
      setStatus({ kind: "working", message: "Writing CSV…" });
      const written = await exportCsv(dest);
      setStatus({ kind: "done", message: `Entries written to ${written}` });
    } catch (e) {
      setStatus({ kind: "error", message: String(e) });
    }
  }, []);

  const revealDataFolder = useCallback(async () => {
    if (!inTauri || !paths) return;
    try {
      await revealItemInDir(paths.dbPath);
    } catch (e) {
      setStatus({ kind: "error", message: String(e) });
    }
  }, [paths]);

  const deleteAllData = useCallback(async () => {
    if (!inTauri) return;
    try {
      const confirmed = await ask(
        "This deletes every project, entry, rule, and tag stored on this machine. There is no undo. Continue?",
        {
          title: "Delete all Cairn data?",
          kind: "warning",
          okLabel: "Delete everything",
          cancelLabel: "Keep my data",
        },
      );
      if (!confirmed) return;
      setStatus({ kind: "working", message: "Deleting…" });
      await deleteEverything();
      // The app will exit before this banner renders, but keep the
      // state coherent in case the exit is delayed.
      setStatus({ kind: "done", message: "Data deleted. Cairn is quitting." });
    } catch (e) {
      setStatus({ kind: "error", message: String(e) });
    }
  }, []);

  return {
    paths,
    pendingImport: paths?.pendingImport ?? null,
    status,
    exportBackupToFile,
    importBackupFromFile,
    cancelImport,
    exportCsvToFile,
    revealDataFolder,
    deleteAllData,
  };
}
