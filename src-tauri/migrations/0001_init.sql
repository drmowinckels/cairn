CREATE TABLE IF NOT EXISTS projects (
    id          TEXT PRIMARY KEY NOT NULL,
    name        TEXT NOT NULL,
    client      TEXT,
    color       TEXT NOT NULL,
    archived    INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS entries (
    id            TEXT PRIMARY KEY NOT NULL,
    project_id    TEXT REFERENCES projects(id) ON DELETE SET NULL,
    task          TEXT NOT NULL DEFAULT '',
    started_at    TEXT NOT NULL,
    ended_at      TEXT,
    source        TEXT NOT NULL DEFAULT 'manual',
    rule_id       TEXT,
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS entries_started_at_idx ON entries(started_at);
CREATE INDEX IF NOT EXISTS entries_project_idx    ON entries(project_id);

CREATE TABLE IF NOT EXISTS tags (
    id    TEXT PRIMARY KEY NOT NULL,
    name  TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS entry_tags (
    entry_id  TEXT NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
    tag_id    TEXT NOT NULL REFERENCES tags(id)    ON DELETE CASCADE,
    PRIMARY KEY (entry_id, tag_id)
);

CREATE TABLE IF NOT EXISTS rules (
    id            TEXT PRIMARY KEY NOT NULL,
    name          TEXT NOT NULL,
    enabled       INTEGER NOT NULL DEFAULT 1,
    priority      INTEGER NOT NULL DEFAULT 0,
    body          TEXT NOT NULL,
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS rules_priority_idx ON rules(priority);

CREATE TABLE IF NOT EXISTS exclusions (
    id     TEXT PRIMARY KEY NOT NULL,
    kind   TEXT NOT NULL,
    value  TEXT NOT NULL
);
