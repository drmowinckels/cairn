-- Persisted git-watcher discovery roots (issue #34 / #7).
--
-- NULL means "use the built-in defaults" (see
-- `signals::git_watcher::default_discovery_roots`). A non-NULL value is
-- a JSON array of user-entered root strings (tilde-form preserved),
-- written by the `set_git_discovery_roots` IPC command and read at boot
-- to seed the watcher.

ALTER TABLE app_state ADD COLUMN git_discovery_roots TEXT;
