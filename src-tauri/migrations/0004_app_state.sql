-- First-run onboarding marker (issue #31).
--
-- Single-row table; a UNIQUE check on a constant column guarantees the
-- invariant at the schema level. `completed_at` is NULL until the user
-- finishes (or skips) the onboarding flow. Reset by `reset_onboarding`
-- via `Settings → Run onboarding again`.

CREATE TABLE IF NOT EXISTS app_state (
    singleton    INTEGER PRIMARY KEY NOT NULL CHECK (singleton = 1),
    completed_at TEXT
);

INSERT OR IGNORE INTO app_state (singleton, completed_at) VALUES (1, NULL);
