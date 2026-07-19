-- One-time notice for a repaired stale launch-at-login entry (#264).
--
-- A macOS LaunchAgent enabled before #263's dev-build guard existed can
-- still point at a since-removed `target/{debug,release}` binary, or one
-- that's been relocated/uninstalled. Startup detects and repairs such a
-- stale agent (repoint at the installed bundle, or clear it if none
-- exists) and records the user-facing explanation here so Settings can
-- surface it once. NULL = nothing to show — either nothing has ever been
-- repaired, or the user already dismissed the notice.
ALTER TABLE app_state ADD COLUMN autostart_repair_notice TEXT;
