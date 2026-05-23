-- Client → Project → Task model.
-- A Client is optional (Toggl-style: a Project may stand alone).
-- A Task is project-scoped: "Bug fixing" under Project A is a different row
-- from "Bug fixing" under Project B.
-- Entries link to a Project and (optionally) a Task, plus a free-text
-- description.

CREATE TABLE IF NOT EXISTS clients (
    id          TEXT PRIMARY KEY NOT NULL,
    name        TEXT NOT NULL UNIQUE,
    color       TEXT,
    archived    INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
);

-- Migrate the projects table:
--   - add client_id FK (nullable) replacing the loose `client` text column
--   - for each distinct projects.client value, create a Client row, then
--     point the project at it.
CREATE TABLE projects_new (
    id          TEXT PRIMARY KEY NOT NULL,
    name        TEXT NOT NULL,
    client_id   TEXT REFERENCES clients(id) ON DELETE SET NULL,
    color       TEXT NOT NULL,
    archived    INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
);

INSERT INTO clients (id, name, created_at, updated_at)
SELECT lower(hex(randomblob(16))), TRIM(client), datetime('now'), datetime('now')
  FROM projects
 WHERE client IS NOT NULL AND TRIM(client) <> ''
 GROUP BY TRIM(client);

INSERT INTO projects_new (id, name, client_id, color, archived, created_at, updated_at)
SELECT p.id,
       p.name,
       (SELECT c.id FROM clients c WHERE c.name = TRIM(p.client)),
       p.color,
       p.archived,
       p.created_at,
       p.updated_at
  FROM projects p;

DROP TABLE projects;
ALTER TABLE projects_new RENAME TO projects;

CREATE INDEX IF NOT EXISTS projects_client_idx ON projects(client_id);

-- Project-scoped tasks.
CREATE TABLE IF NOT EXISTS tasks (
    id          TEXT PRIMARY KEY NOT NULL,
    project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    archived    INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL,
    UNIQUE(project_id, name)
);

CREATE INDEX IF NOT EXISTS tasks_project_idx ON tasks(project_id);

-- Migrate entries:
--   - rename `task` (the free-text description) to `description`
--   - add `task_id` FK to the new tasks table (nullable)
--   - the legacy many-to-many tags table is dropped at the bottom; any
--     historical tag data is lost (intentional — Toggl-style 1:1 task model)
CREATE TABLE entries_new (
    id            TEXT PRIMARY KEY NOT NULL,
    project_id    TEXT REFERENCES projects(id) ON DELETE SET NULL,
    task_id       TEXT REFERENCES tasks(id)    ON DELETE SET NULL,
    description   TEXT NOT NULL DEFAULT '',
    started_at    TEXT NOT NULL,
    ended_at      TEXT,
    source        TEXT NOT NULL DEFAULT 'manual',
    rule_id       TEXT,
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL
);

INSERT INTO entries_new (
    id, project_id, task_id, description, started_at, ended_at, source, rule_id, created_at, updated_at
)
SELECT id, project_id, NULL, task, started_at, ended_at, source, rule_id, created_at, updated_at
  FROM entries;

DROP TABLE entries;
ALTER TABLE entries_new RENAME TO entries;

CREATE INDEX IF NOT EXISTS entries_started_at_idx ON entries(started_at);
CREATE INDEX IF NOT EXISTS entries_project_idx    ON entries(project_id);
CREATE INDEX IF NOT EXISTS entries_task_idx       ON entries(task_id);

-- Drop the legacy tag tables.
DROP TABLE IF EXISTS entry_tags;
DROP TABLE IF EXISTS tags;
