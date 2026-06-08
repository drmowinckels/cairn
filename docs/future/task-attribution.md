# Future: DB task attribution (entry → remote PM task)

> Status: design agreed, not built. Convert to a GitHub issue under epic #110
> once this note is reviewed. This is the payoff slice of the PM-connectors
> epic — the connectors can already read projects/tasks; nothing yet lets a
> tracked entry _point at_ one.

## Problem

A PM connector (#110) reads `RemoteProject` / `RemoteTask` from a remote
planner (GitHub Projects, GitLab, a local file). Today those live in a
separate universe from time entries:

- `entries.task_id` is an FK to the **local** `tasks` table
  ([0002_clients_tasks.sql](../../src-tauri/migrations/0002_clients_tasks.sql)) —
  a project-scoped, hand-named Cairn task.
- `RemoteTask` ([connectors/mod.rs:48](../../src-tauri/src/connectors/mod.rs))
  is fetched, listed in the Settings → Connectors card, and discarded.

There is **no way to attribute tracked time to a remote task**. That link is
the reason the epic exists: read task definitions in, attribute time, (later)
write time-spent back. This note covers the read-side attribution only;
`pushTime` write-back stays a separate v2 slice.

## Decisions (settled)

Two product forks were decided before design:

1. **Where the remote reference lives — extend the `tasks` table.** A `tasks`
   row gains optional `connector_id` / `remote_id` / `remote_url` /
   `remote_project_name`. Entries keep using the existing `task_id` FK
   unchanged. This honours the CLAUDE.md line _"`Task` is a thin reference to
   the remote planner"_ — local and remote tasks are one type behind one FK,
   one picker, and the `ON DELETE SET NULL` already wired on `entries.task_id`
   covers deletion. We do **not** add a parallel attribution axis to
   `entries`.

2. **Direct attribution — no local-project mapping required.** An entry can
   point at a remote task with no local Cairn project. Reports group by the
   remote project name carried on the task when there is no `project_id`.
   Connector tasks are usable the moment the connector is enabled — no setup
   step. A user _may_ still also set a local `project_id` on the same entry
   (for colour/grouping), but it is never required.

## Out of scope

- **`pushTime` write-back.** Per-connector write grant, outbound time sync.
  Tracked separately (epic #110 roadmap item 5).
- **Live remote-task search across connectors.** v1 browses one connector →
  one project → its tasks, reusing the existing `list_connector_tasks` read.
  A unified "search all my issues" box is a later nicety.
- **Backfill / auto-attribution by rule.** Rules matching a branch name to a
  remote issue is a natural follow-up but not this slice.

## Data model

Rebuild `tasks` (SQLite can't add FKs / relax NOT NULL in place) in migration
**`0012_remote_tasks`**:

```sql
CREATE TABLE tasks_new (
    id                  TEXT PRIMARY KEY NOT NULL,
    project_id          TEXT REFERENCES projects(id) ON DELETE CASCADE,  -- now NULLABLE
    name                TEXT NOT NULL,
    connector_id        TEXT,   -- manifest id, e.g. "github-projects"; NULL = pure local task
    remote_id           TEXT,   -- task id in the remote planner
    remote_url          TEXT,   -- cached deep link to the task
    remote_project_name TEXT,   -- for report grouping when project_id IS NULL
    archived            INTEGER NOT NULL DEFAULT 0,
    created_at          TEXT NOT NULL,
    updated_at          TEXT NOT NULL
);

INSERT INTO tasks_new (id, project_id, name, archived, created_at, updated_at)
SELECT id, project_id, name, archived, created_at, updated_at FROM tasks;

DROP TABLE tasks;
ALTER TABLE tasks_new RENAME TO tasks;

-- A pure-local task is still unique per (project, name).
CREATE UNIQUE INDEX tasks_local_name_idx
    ON tasks(project_id, name) WHERE connector_id IS NULL;
-- A remote task is interned once per (connector, remote_id) — re-attributing
-- the same issue reuses the row instead of duplicating it.
CREATE UNIQUE INDEX tasks_remote_idx
    ON tasks(connector_id, remote_id) WHERE connector_id IS NOT NULL;

CREATE INDEX tasks_project_idx ON tasks(project_id);
```

Notes:

- The old `UNIQUE(project_id, name)` table constraint becomes the **partial**
  `tasks_local_name_idx` (local rows only) — a remote task with a NULL
  `project_id` and a duplicate name must not collide with a local one.
- `connector_id` is **not** an FK. Connectors live in JSON manifests, not a
  table; the existing cache table (`connector_cache`) also stores a bare
  `connector_id` string ([0010_connector_cache.sql](../../src-tauri/migrations/0010_connector_cache.sql)),
  so this matches precedent. If the connector is later removed, the task row
  becomes a dangling-but-harmless local reference (its `name` + `remote_url`
  still render).
- `entries` is **untouched**. `entries.task_id` already
  `REFERENCES tasks(id) ON DELETE SET NULL` — deleting/archiving a remote task
  degrades the entry gracefully exactly as for local tasks today.

### Interning a remote task

When the user attributes an entry to a `RemoteTask`, the backend upserts a
`tasks` row keyed by `(connector_id, remote_id)`:

- **miss** → insert `{ id: new uuid, project_id: <chosen local project or NULL>,
name: task.label, connector_id, remote_id: task.id, remote_url: task.url,
remote_project_name: <project.name from the browse step> }`.
- **hit** → refresh `name` / `remote_url` (the label may have changed
  upstream), return the existing `id`.

Then set `entries.task_id` to that row's id via the existing `update_entry` /
`create_entry` path. The remote read stays cache-backed, so attribution works
offline against the last-seen task list (the `CachedList.stale` flag already
surfaces this in the UI).

## Backend changes

- **Migration** `0012_remote_tasks` as above.
- **`Task` IPC struct** ([ipc.rs:80](../../src-tauri/src/ipc.rs)) gains the new
  optional fields: `connector_id`, `remote_id`, `remote_url`,
  `remote_project_name`. `project_id` becomes `Option<String>`.
- **New IPC command** `attribute_entry_to_remote_task(entry_id, connector_id,
remote_project, remote_task)`: enforces `ensure_connector_enabled`, interns
  the task (the upsert above), points the entry at it, returns the updated
  `Entry` + `Task`. Keeping it one command (rather than "create task" then
  "patch entry") makes the intern + link atomic in a single transaction.
- **Listing** (`list_today`, `current_running`) already joins tasks; extend the
  row mapping to carry the new columns so the UI can render a remote chip +
  deep-link without a second round-trip.
- Reports grouping: where an entry has a task with `project_id IS NULL`, group
  under `remote_project_name` (fall back to the connector id if even that is
  absent).

## Frontend changes

- **`Task` TS type** ([ipc.ts](../../src/lib/ipc.ts)) mirrors the new fields
  (manually authored — there is no specta codegen here, confirmed).
- **Entry editor** ([manual-entry-modal.tsx](../../src/views/today/manual-entry-modal.tsx)
  and the running-timer editor): add a "Link a task" affordance that, when a
  connector is enabled, lets the user drill connector → project → task
  (reusing `listConnectorProjects` / `listConnectorTasks`). Picking one calls
  `attributeEntryToRemoteTask`. The local-task picker stays for non-connector
  users.
- **Entry chip**: a linked entry shows the task label as a chip linking out to
  `remote_url` (opened via the OS, wrapped in `withPopoverPinned` so the
  popover doesn't hide — native open/save dialogs steal focus and hide it). A `stale`
  badge if the underlying connector list was served from cache.
- Reuse `<CapabilityBadges>` / existing connector hooks; no new connector
  surface beyond the picker.

## Privacy

- The interned task row persists **project name + task label + a deep-link
  URL** locally — already-authorized metadata the connector read returned,
  same class as the offline cache already documents in
  [docs/PRIVACY.md](../PRIVACY.md). Update the PM-connectors section to note
  that attribution writes a durable copy of the task label/url into `tasks`
  (the cache is best-effort/evictable; an attributed task is permanent until
  the entry/task is deleted). Wiped by "Delete everything".
- No token or connector secret is ever copied into `tasks` — only the public
  task identity. No new network egress: attribution reuses the existing
  cache-backed read.

## Testing

- Migration round-trip: existing local tasks survive `0012` unchanged; partial
  unique indexes enforce the two distinct uniqueness rules (a local and a
  remote task may share a name).
- Intern upsert: miss inserts, hit refreshes label/url and reuses the id
  (no duplicate rows on re-attribution).
- `attribute_entry_to_remote_task`: rejects a disabled connector; offline
  (stale cache) path still attributes; entry → task → remote_url survives a
  connector being removed.
- Reports grouping with `project_id IS NULL` groups by `remote_project_name`.
- Frontend: picker drill-down, chip deep-link wrapped in `withPopoverPinned`,
  stale badge, and an `ipc.test.ts` case for the new command (card tests mock
  ipc, so the wire shape needs its own test).

## Effort

One migration + one new IPC command + struct/type plumbing + the editor picker.
Roughly a 2–3 PR stack: (1) migration + model + intern/attribute command with
unit tests; (2) entry-editor picker + chip + ipc.test; (3) reports grouping by
remote project. No GraphQL/pagination work needed (reuses the existing
cache-backed reads).
