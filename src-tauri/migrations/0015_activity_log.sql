-- Opt-in activity log (#190): a compact, redacted record of which app was in
-- the foreground and for how long, powering the "review your day" flow. This
-- is NOT the debug `capture_raw_signals` NDJSON dump — it's a user-facing,
-- privacy-controlled, retention-bounded store.
--
-- Off by default (`activity_log_enabled = 0`). The exclusion list runs at the
-- collector, so an excluded app never reaches this table. `title_hint` keeps
-- only the window-title segment before the first " — " separator (or NULL),
-- never the full title. Retention-bounded (`activity_log_retention_days`,
-- default 7; 0 = keep until the user deletes), purged on launch. Every field
-- stored here is documented in docs/PRIVACY.md.

CREATE TABLE IF NOT EXISTS activity_log (
    id          INTEGER PRIMARY KEY,
    started_at  TEXT NOT NULL,
    ended_at    TEXT NOT NULL,
    app_name    TEXT NOT NULL,
    title_hint  TEXT,
    source      TEXT NOT NULL DEFAULT 'window',
    created_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS activity_log_started_at_idx ON activity_log(started_at);
CREATE INDEX IF NOT EXISTS activity_log_app_name_idx ON activity_log(app_name);

ALTER TABLE app_state ADD COLUMN activity_log_enabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE app_state ADD COLUMN activity_log_retention_days INTEGER NOT NULL DEFAULT 7;
