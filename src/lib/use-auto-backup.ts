import { useCallback, useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import {
  autoBackupStatus,
  backupNow as backupNowCmd,
  getAutoBackupSettings,
  inTauri,
  setAutoBackupSettings,
  AUTO_BACKUP_DEFAULTS,
  type AutoBackupSettings,
  type AutoBackupStatus,
} from "./ipc";
import { withPopoverPinned } from "./use-backup";

export type AutoBackupOp =
  | { kind: "idle" }
  | { kind: "working"; message: string }
  | { kind: "done"; message: string }
  | { kind: "error"; message: string };

export interface UseAutoBackup {
  settings: AutoBackupSettings;
  status: AutoBackupStatus;
  op: AutoBackupOp;
  setEnabled: (enabled: boolean) => Promise<void>;
  chooseFolder: () => Promise<void>;
  setIntervalHours: (hours: number) => Promise<void>;
  setKeep: (keep: number) => Promise<void>;
  backupNow: () => Promise<void>;
}

/**
 * Automatic-backup settings + actions (data resilience). Mirrors
 * `useBackup`'s shape: a `settings`/`status` snapshot plus mutators that
 * round-trip through the backend (which clamps + persists and may take an
 * immediate snapshot). The folder picker is wrapped in `withPopoverPinned`
 * so the native dialog doesn't blur-close the popover.
 */
export function useAutoBackup(): UseAutoBackup {
  const [settings, setSettings] = useState<AutoBackupSettings>({
    ...AUTO_BACKUP_DEFAULTS,
  });
  const [status, setStatus] = useState<AutoBackupStatus>({
    lastBackupAt: null,
    count: 0,
  });
  const [op, setOp] = useState<AutoBackupOp>({ kind: "idle" });

  const refreshStatus = useCallback(async () => {
    try {
      // Coalesce a nullish IPC result to the empty-status floor so
      // consumers (e.g. the staleness helper) always see a real object;
      // the backend should never return null, but a stubbed bridge can.
      const next = await autoBackupStatus();
      setStatus(next ?? { lastBackupAt: null, count: 0 });
    } catch (e) {
      console.warn("auto_backup_status failed", e);
    }
  }, []);

  const load = useCallback(async () => {
    if (!inTauri) return;
    try {
      const next = await getAutoBackupSettings();
      setSettings(next ?? { ...AUTO_BACKUP_DEFAULTS });
      await refreshStatus();
    } catch (e) {
      console.warn("get_auto_backup_settings failed", e);
    }
  }, [refreshStatus]);

  useEffect(() => {
    void load();
  }, [load]);

  const persist = useCallback(
    async (next: AutoBackupSettings, working: string, done: string) => {
      setOp({ kind: "working", message: working });
      try {
        setSettings(await setAutoBackupSettings(next));
        await refreshStatus();
        setOp({ kind: "done", message: done });
      } catch (e) {
        setOp({ kind: "error", message: String(e) });
      }
    },
    [refreshStatus],
  );

  const setEnabled = useCallback(
    async (enabled: boolean) => {
      if (enabled && !settings.dir) {
        setOp({ kind: "error", message: "Choose a backup folder first." });
        return;
      }
      await persist(
        { ...settings, enabled },
        enabled ? "Enabling…" : "Pausing…",
        enabled ? "Automatic backup on." : "Automatic backup paused.",
      );
    },
    [settings, persist],
  );

  const chooseFolder = useCallback(async () => {
    if (!inTauri) return;
    let picked: string | string[] | null = null;
    try {
      picked = await withPopoverPinned(() =>
        open({
          title: "Choose a backup folder",
          directory: true,
          multiple: false,
        }),
      );
    } catch (e) {
      setOp({ kind: "error", message: String(e) });
      return;
    }
    if (!picked || Array.isArray(picked)) return;
    // Choosing a folder turns backups on — that's the user's intent.
    await persist(
      { ...settings, dir: picked, enabled: true },
      "Saving folder…",
      "Backup folder set — automatic backup is on.",
    );
  }, [settings, persist]);

  const setIntervalHours = useCallback(
    async (hours: number) => {
      await persist(
        { ...settings, intervalHours: hours },
        "Saving…",
        "Backup schedule updated.",
      );
    },
    [settings, persist],
  );

  const setKeep = useCallback(
    async (keep: number) => {
      await persist({ ...settings, keep }, "Saving…", "Retention updated.");
    },
    [settings, persist],
  );

  const backupNow = useCallback(async () => {
    if (!inTauri) return;
    setOp({ kind: "working", message: "Backing up…" });
    try {
      const path = await backupNowCmd();
      await refreshStatus();
      setOp({ kind: "done", message: `Backup written to ${path}` });
    } catch (e) {
      setOp({ kind: "error", message: String(e) });
    }
  }, [refreshStatus]);

  return {
    settings,
    status,
    op,
    setEnabled,
    chooseFolder,
    setIntervalHours,
    setKeep,
    backupNow,
  };
}
