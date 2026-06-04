-- Per-plugin enabled state (#111).
--
-- Signal-source plugins (calendar today; browser / PM connectors later)
-- are opt-in and individually toggleable. Their enabled flag persists
-- here so a user who turns off a networked plugin stays opted out across
-- launches. A plugin with no row defaults to enabled — calendar was
-- always-on before this table existed, so its absence must preserve that
-- behaviour rather than silently disabling it.
--
-- Keyed by the plugin's stable manifest id (e.g. 'calendar'), not a
-- surrogate key, so the backend can look a plugin up directly.

CREATE TABLE IF NOT EXISTS plugin_state (
    id      TEXT PRIMARY KEY NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1
);
