import type { AutoBackupSettings, AutoBackupStatus } from "./ipc";
import { formatRelativeTime } from "./relative-time";

const HOUR_MS = 60 * 60 * 1000;

/**
 * Health of the automatic-backup pipeline, derived purely from the
 * persisted settings + last-run status (no IPC, no side effects):
 *
 * - `off`   — automatic backup is disabled or no folder is configured.
 * - `never` — enabled + configured, but nothing has been written yet
 *             (no snapshots, or a missing/invalid last-backup timestamp).
 * - `stale` — enabled + configured + has run, but the last snapshot is
 *             older than twice the configured interval. That's a clear
 *             "something's wrong" signal (synced folder unreachable,
 *             machine asleep, permissions lost) — not merely "due soon".
 * - `ok`    — enabled, configured, and recent enough.
 */
export type BackupHealth = "off" | "never" | "stale" | "ok";

export function backupHealth(
  settings: AutoBackupSettings,
  status: AutoBackupStatus,
  now: Date = new Date(),
): BackupHealth {
  if (!settings.enabled || !settings.dir) return "off";
  if (status.count === 0 || status.lastBackupAt === null) return "never";

  const last = new Date(status.lastBackupAt);
  if (Number.isNaN(last.getTime())) return "never";

  const ageMs = now.getTime() - last.getTime();
  const staleAfterMs = settings.intervalHours * 2 * HOUR_MS;
  if (ageMs > staleAfterMs) return "stale";

  return "ok";
}

/**
 * User-facing copy for a non-healthy state. Returns `null` for `off`
 * and `ok` (nothing to say). `stale` reuses `formatRelativeTime` so the
 * age reads the same as elsewhere in the UI.
 */
export function backupHealthMessage(
  health: BackupHealth,
  status: AutoBackupStatus,
  now: Date = new Date(),
): string | null {
  if (health === "never") return "No backup taken yet.";
  if (health === "stale") {
    const rel = formatRelativeTime(status.lastBackupAt, { now });
    return `Last backup was ${rel} — check your backup folder is reachable.`;
  }
  return null;
}
