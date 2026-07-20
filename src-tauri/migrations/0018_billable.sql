-- Billable categorization (#109). The flag is semantic, not money —
-- rates, currency, and amounts live only in the billing plugin's own
-- tables. Entries snapshot the project's default at creation time so
-- later default changes never rewrite history.
ALTER TABLE projects ADD COLUMN billable_default INTEGER NOT NULL DEFAULT 0;
ALTER TABLE entries  ADD COLUMN billable         INTEGER NOT NULL DEFAULT 0;
