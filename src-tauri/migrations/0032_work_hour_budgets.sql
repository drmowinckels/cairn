-- Recurring work-hour budgets (#307). A *cap*, not a target: Cairn warns as
-- you approach one and again once you pass it, so a budget is protection
-- against overwork rather than a quota to fill.
--
-- Scope resolution is most-granular-wins, mirroring billing_rates (#109):
-- a project budget beats a client budget beats the workspace default. Unlike
-- rates this lives in CORE — knowing you have worked too much this week is
-- not a billing feature and must never sit behind a paid plugin.
--
-- Distinct from `projects.estimate_hours`, which is a one-off total for a
-- whole project ("this job is 40 hours"). These recur every day/week/month.
--
-- `scope_id` is '' for the workspace default, else the client/project id.
-- No foreign key: scopes are polymorphic, and an orphaned budget is simply
-- never resolved (nothing live references a dead scope).
--
-- Minutes rather than fractional hours, for the same reason money is stored
-- in cents: "7.5 hours" must not drift through a float.
CREATE TABLE IF NOT EXISTS work_hour_budgets (
    id           TEXT PRIMARY KEY NOT NULL,
    scope_type   TEXT NOT NULL CHECK (scope_type IN ('workspace', 'client', 'project')),
    scope_id     TEXT NOT NULL DEFAULT '',
    period       TEXT NOT NULL CHECK (period IN ('daily', 'weekly', 'monthly')),
    minutes      INTEGER NOT NULL CHECK (minutes > 0),
    -- Percentage of the budget at which the approaching-warning fires.
    -- 100 disables the early warning, leaving only the over-budget one.
    warn_percent INTEGER NOT NULL DEFAULT 80 CHECK (warn_percent BETWEEN 1 AND 100),
    created_at   TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
    -- One budget per scope per period: setting the same one again updates it.
    UNIQUE (scope_type, scope_id, period)
);
