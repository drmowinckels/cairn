-- Billing plugin license storage (#109). Single-row: at most one Pro
-- license per install. The license string is a locally-verifiable
-- signed token (see plugins/billing/license.rs) — not a secret that
-- grants remote access, so it lives in the DB rather than the keychain.
-- No rates, currency, or amounts here or anywhere in core.
CREATE TABLE IF NOT EXISTS billing_license (
    singleton  INTEGER PRIMARY KEY NOT NULL CHECK (singleton = 1),
    license    TEXT NOT NULL,
    stored_at  TEXT NOT NULL
);
