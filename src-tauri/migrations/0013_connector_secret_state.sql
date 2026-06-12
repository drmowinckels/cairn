-- Presence flags for connector secrets (#110).
--
-- Settings → Connectors shows a "Set / Needs token" badge per secret. Reading
-- the OS keychain just to render that badge re-prompts for keychain access on
-- every macOS dev rebuild (the "Always Allow" grant is bound to the app's code
-- signature, which changes each build). So a boolean "is set" is mirrored here,
-- written whenever a token is set or cleared; listing connectors reads this
-- table and never touches the keychain. The token value itself stays
-- keychain-only — only this flag lives in SQLite.
--
-- Keyed by the bare secret key, exactly as the keychain is, so two connectors
-- that share a key share one row.
CREATE TABLE IF NOT EXISTS connector_secret_state (
    secret_key TEXT PRIMARY KEY,
    present    INTEGER NOT NULL DEFAULT 0
);
