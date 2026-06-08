-- Per-connector enabled state (#110).
--
-- PM connectors are opt-in and individually toggleable. Their enabled flag
-- persists here so a user who turns off a networked connector stays opted
-- out across launches — a disabled connector makes no requests (its browse
-- is refused). A connector with no row defaults to enabled, preserving the
-- behaviour from before this table existed.
--
-- Keyed by the manifest's stable id (e.g. 'github-projects'), mirroring
-- `plugin_state`.
CREATE TABLE IF NOT EXISTS connector_state (
    id      TEXT PRIMARY KEY NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1
);
