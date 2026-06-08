-- Offline cache of connector reads (#110).
--
-- A PM connector reads its projects/tasks from a remote that may be
-- unreachable. So time attribution still works offline, the last
-- successful read of each scope is cached here; a later read that fails
-- falls back to this snapshot (surfaced as stale in the UI). A missing row
-- just means "no cache yet" — the next successful read repopulates it.
--
-- `scope` is 'projects' for the project list, or 'tasks:<project_id>' for
-- one project's tasks. `payload` is the JSON array Cairn returns to the UI;
-- `fetched_at` is an RFC 3339 timestamp of the successful read.
CREATE TABLE IF NOT EXISTS connector_cache (
    connector_id TEXT NOT NULL,
    scope        TEXT NOT NULL,
    payload      TEXT NOT NULL,
    fetched_at   TEXT NOT NULL,
    PRIMARY KEY (connector_id, scope)
);
