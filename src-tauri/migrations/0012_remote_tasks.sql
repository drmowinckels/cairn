-- DB task attribution (#110): let an entry point at a task pulled from a PM
-- connector, not just a hand-named local task.
--
-- A `Task` is "a thin reference to the remote planner" (CLAUDE.md), so the
-- remote reference lives ON the existing tasks table rather than as a parallel
-- set of columns on `entries` — entries keep their `task_id` FK unchanged.
--
--   - `project_id` becomes NULLABLE: a remote task may have no local Cairn
--     project (direct attribution; reports group by `remote_project_name`).
--   - `connector_id` / `remote_id` / `remote_url` / `remote_project_name` are
--     the remote identity. All NULL ⇒ a pure-local task, exactly as before.
--   - `connector_id` is deliberately NOT a foreign key: connectors live in
--     JSON manifests, not a table (the `connector_cache` table stores a bare
--     `connector_id` string for the same reason). If a connector is later
--     removed, the task row degrades to a harmless local reference — its
--     `name` + `remote_url` still render.
--
-- SQLite can't relax NOT NULL or add columns with the constraints we need in
-- place, so rebuild the table and copy existing local tasks across unchanged.

CREATE TABLE tasks_new (
    id                  TEXT PRIMARY KEY NOT NULL,
    project_id          TEXT REFERENCES projects(id) ON DELETE CASCADE,
    name                TEXT NOT NULL,
    connector_id        TEXT,
    remote_id           TEXT,
    remote_url          TEXT,
    remote_project_name TEXT,
    archived            INTEGER NOT NULL DEFAULT 0,
    created_at          TEXT NOT NULL,
    updated_at          TEXT NOT NULL
);

INSERT INTO tasks_new (id, project_id, name, archived, created_at, updated_at)
SELECT id, project_id, name, archived, created_at, updated_at FROM tasks;

-- Preserve entry→task attribution across the rebuild. Migrations run with
-- foreign_keys ON inside a transaction (so `PRAGMA foreign_keys=OFF` is a
-- no-op here), and `DROP TABLE tasks` fires `entries.task_id`'s ON DELETE SET
-- NULL — silently wiping every existing link. Stash the links, then restore
-- them once `tasks_new` (same ids) takes the original table's place.
CREATE TEMP TABLE _entry_task_links AS
SELECT id AS entry_id, task_id FROM entries WHERE task_id IS NOT NULL;

DROP TABLE tasks;
ALTER TABLE tasks_new RENAME TO tasks;

UPDATE entries
   SET task_id = (SELECT task_id FROM _entry_task_links WHERE entry_id = entries.id)
 WHERE id IN (SELECT entry_id FROM _entry_task_links);

DROP TABLE _entry_task_links;

-- A pure-local task is unique per (project, name) — the old table constraint,
-- now a PARTIAL index so it only governs local rows. A remote task (NULL
-- project_id, possibly a colliding name) must not trip it.
CREATE UNIQUE INDEX tasks_local_name_idx
    ON tasks(project_id, name) WHERE connector_id IS NULL;

-- A remote task is interned once per (connector, remote_id): re-attributing
-- the same issue reuses the row instead of duplicating it.
CREATE UNIQUE INDEX tasks_remote_idx
    ON tasks(connector_id, remote_id) WHERE connector_id IS NOT NULL;

CREATE INDEX tasks_project_idx ON tasks(project_id);
