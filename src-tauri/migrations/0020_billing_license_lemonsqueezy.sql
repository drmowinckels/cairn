-- Billing switches from an offline signed token to direct Lemon Squeezy
-- verification (#109), matching the sister app Entracte. The old
-- single-column token table is replaced with the activation state:
-- license key, the device instance id Lemon Squeezy assigns, the last
-- known status, and display metadata. No rates/currency here or anywhere
-- in core. Version 20 never shipped in a release, so dropping the old
-- table only discards dev-only signed tokens that no longer apply.
DROP TABLE IF EXISTS billing_license;

CREATE TABLE billing_license (
    singleton         INTEGER PRIMARY KEY NOT NULL CHECK (singleton = 1),
    license_key       TEXT NOT NULL,
    instance_id       TEXT NOT NULL,
    status            TEXT NOT NULL,
    customer_email    TEXT,
    product_name      TEXT,
    expires_at        TEXT,
    activated_at      TEXT NOT NULL,
    last_validated_at TEXT NOT NULL
);
