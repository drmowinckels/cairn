-- Pro rate model (#109). Plugin-owned hourly rates with historical
-- effective-from dates. Resolution is most-granular-wins: a task rate
-- beats a project rate beats a client rate beats the workspace default,
-- and within a scope the latest effective_from on/before the work date
-- wins — so re-pricing forward never rewrites what past work billed at.
-- All money lives here; core has none of it. `scope_id` is '' for the
-- workspace default, else the client/project/task id — no foreign key,
-- since scopes are polymorphic and an orphaned rate is simply never
-- resolved (no live entry references a dead scope).
CREATE TABLE IF NOT EXISTS billing_rates (
    id             TEXT PRIMARY KEY NOT NULL,
    scope_type     TEXT NOT NULL CHECK (scope_type IN ('workspace', 'client', 'project', 'task')),
    scope_id       TEXT NOT NULL DEFAULT '',
    amount_cents   INTEGER NOT NULL CHECK (amount_cents >= 0),
    currency       TEXT NOT NULL,
    effective_from TEXT NOT NULL,
    created_at     TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (scope_type, scope_id, effective_from)
);
