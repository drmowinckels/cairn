import { useCallback, useEffect, useState } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import {
  ACTIVITY_LOG_DEFAULTS,
  deleteActivityLog,
  exportActivityLogCsv,
  getActivityLogSettings,
  inTauri,
  setActivityLogSettings,
  type ActivityLogSettings,
} from "./ipc";
import { withPopoverPinned } from "./use-backup";

export interface UseActivityLog {
  settings: ActivityLogSettings;
  error: string | null;
  /** Turn recording on/off. Disabling purges all rows (backend). */
  setEnabled: (enabled: boolean) => Promise<void>;
  /** Change the retention window (days; 0 = keep until deleted). */
  setRetentionDays: (days: number) => Promise<void>;
  /** Hard-delete every row now, leaving the toggle on. */
  deleteAll: () => Promise<void>;
  /** Pick a destination and write the log to CSV. No-op if cancelled. */
  exportToFile: () => Promise<void>;
}

/**
 * Opt-in activity-log settings (#190). The toggle + retention persist in the
 * backend; this hook loads them on mount and writes through. Recording is
 * active exactly when `settings.enabled`, so the popover footer reads that for
 * its "recording" indicator. Off by default.
 */
export function useActivityLog(): UseActivityLog {
  const [settings, setSettings] = useState<ActivityLogSettings>(
    ACTIVITY_LOG_DEFAULTS,
  );
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getActivityLogSettings()
      .then((s) => {
        if (!cancelled) setSettings(s);
      })
      .catch((e) => {
        if (!cancelled) setError(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const write = useCallback(
    async (next: ActivityLogSettings) => {
      const prev = settings;
      setSettings(next); // optimistic
      setError(null);
      try {
        await setActivityLogSettings(next);
      } catch (e) {
        setSettings(prev); // roll back a failed write
        setError(String(e));
      }
    },
    [settings],
  );

  const setEnabled = useCallback(
    (enabled: boolean) => write({ ...settings, enabled }),
    [settings, write],
  );

  const setRetentionDays = useCallback(
    (retentionDays: number) => write({ ...settings, retentionDays }),
    [settings, write],
  );

  const deleteAll = useCallback(async () => {
    setError(null);
    try {
      await deleteActivityLog();
    } catch (e) {
      setError(String(e));
    }
  }, []);

  const exportToFile = useCallback(async () => {
    if (!inTauri) return;
    setError(null);
    try {
      const defaultPath = `cairn-activity-${new Date().toISOString().slice(0, 10)}.csv`;
      const dest = await withPopoverPinned(() =>
        save({
          title: "Export activity log as CSV",
          defaultPath,
          filters: [{ name: "CSV", extensions: ["csv"] }],
        }),
      );
      if (!dest) return;
      await exportActivityLogCsv(dest);
    } catch (e) {
      setError(String(e));
    }
  }, []);

  return {
    settings,
    error,
    setEnabled,
    setRetentionDays,
    deleteAll,
    exportToFile,
  };
}
