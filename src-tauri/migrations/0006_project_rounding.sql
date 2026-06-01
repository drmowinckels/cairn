-- Per-project rounding override (issue #107).
--
-- NULL on both columns means "inherit the global rounding preference".
-- A non-NULL pair overrides the global setting for every entry whose
-- project_id points at this project row.  The application layer enforces
-- that both columns are either both NULL or both non-NULL; SQLite has no
-- cross-column NOT-NULL constraint, so the invariant is upheld in Rust.
--
-- rounding_interval_minutes: 0 = rounding disabled for this project;
--   any positive integer = interval in minutes.
-- rounding_mode: "nearest" | "up" | "down" — mirrors RoundMode in
--   src-tauri/src/rounding.rs.

ALTER TABLE projects ADD COLUMN rounding_interval_minutes INTEGER;
ALTER TABLE projects ADD COLUMN rounding_mode TEXT;
