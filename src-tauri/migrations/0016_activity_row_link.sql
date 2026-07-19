-- Link a time entry back to the activity-log span it was created from (#190
-- follow-up: "Workday in Review"), so the review surface can tell which
-- spans are still uncategorized instead of relying on client-only memory
-- (activity-review.tsx previously tracked "added" in component state,
-- forgotten on every remount).
--
-- Nullable: only entries created via ActivityReview's "Add" set this.
-- ON DELETE SET NULL, matching entries.project_id / entries.task_id:
-- purging or deleting the raw activity_log row (retention, "Delete
-- activity log now") must never delete the real time entry the user made
-- from it — only the link is dropped.

ALTER TABLE entries ADD COLUMN activity_row_id INTEGER REFERENCES activity_log(id) ON DELETE SET NULL;

-- UNIQUE (not just indexed): at most one entry may link to a given span, so
-- two racing "Add" clicks on the same row can't both succeed and double-log
-- the same span. Partial so NULL (the vast majority of entries) is unconstrained.
CREATE UNIQUE INDEX IF NOT EXISTS entries_activity_row_id_idx
    ON entries(activity_row_id) WHERE activity_row_id IS NOT NULL;
