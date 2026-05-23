-- Calendar sources the user has registered.
--
-- Cairn never stores credentials in this table. For URL-kind sources the
-- secret part of the URL (Google's "secret address in iCal format" etc.)
-- lives in the OS keychain under service="cairn-calendar" account=<id>.
-- The `location` column stores the URL with the secret redacted (the path
-- before the last `/` segment, or the full URL for non-secret feeds) so
-- the UI can show the user what they registered. For file-kind sources
-- `location` is the absolute path on disk.

CREATE TABLE IF NOT EXISTS calendar_sources (
    id              TEXT PRIMARY KEY NOT NULL,
    kind            TEXT NOT NULL CHECK (kind IN ('url', 'file')),
    label           TEXT NOT NULL,
    location        TEXT NOT NULL,
    poll_seconds    INTEGER NOT NULL DEFAULT 900,
    enabled         INTEGER NOT NULL DEFAULT 1,
    last_synced_at  TEXT,
    last_etag       TEXT,
    last_modified   TEXT,
    last_error      TEXT,
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS calendar_sources_enabled_idx
    ON calendar_sources(enabled);
