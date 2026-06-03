-- Automatic backup snapshots to a user-chosen (typically cloud-synced)
-- folder. Resilience against data loss without putting the live WAL
-- database in a sync folder (which risks corruption) — Cairn writes
-- point-in-time `VACUUM INTO` snapshots on a cadence and keeps the last
-- `keep`. Settings live on the singleton app_state row so the backend
-- scheduler can read them without the webview being open.
--
-- `auto_backup_dir` NULL means "no folder chosen yet". `auto_backup_enabled`
-- is a separate switch so a user can pause backups without forgetting the
-- folder. Interval/keep are NULL until set, falling back to code defaults.

ALTER TABLE app_state ADD COLUMN auto_backup_enabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE app_state ADD COLUMN auto_backup_dir TEXT;
ALTER TABLE app_state ADD COLUMN auto_backup_interval_hours INTEGER;
ALTER TABLE app_state ADD COLUMN auto_backup_keep INTEGER;
