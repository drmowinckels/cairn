-- Per-connector configuration parameters (#110).
--
-- Non-secret, user-entered config a connector manifest declares and references
-- as a `{{key}}` template variable — e.g. the GitHub connector's `owner` (a user
-- or organisation login) that scopes which Projects v2 board it lists. Unlike a
-- secret, a param value is not sensitive: it is stored here (not the keychain),
-- shown back in the settings card, and editable in place.
--
-- Keyed by the manifest's stable id + the param key. A connector/param with no
-- row defaults to the empty string, which a manifest treats as "unset" (the
-- GitHub connector falls back to `viewer` when `owner` is blank). Mirrors
-- `connector_state` / `connector_secret_state`.
CREATE TABLE IF NOT EXISTS connector_params (
    connector_id TEXT NOT NULL,
    param_key    TEXT NOT NULL,
    value        TEXT NOT NULL,
    PRIMARY KEY (connector_id, param_key)
);
