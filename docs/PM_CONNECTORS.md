# Project-management connectors

Cairn does not build a planner. It connects to the one you already use —
GitHub Projects, GitLab, Linear, Trello, a local `todo.txt` — pulls your
task list in, and lets you attribute tracked time to those tasks. The
planner owns _intent_ (status, deadlines, ordering); Cairn owns
_actuals_ (where time really went). See epic #110.

This document specifies the **connector API**, and — the point of it —
a **declarative JSON manifest** so anyone can add support for a PM Cairn
doesn't ship natively, **without writing or compiling Rust**. You write
data; Cairn runs a fixed interpreter.

> Status: design. No connector code has landed yet. This locks the
> format and the author-facing instructions first, because the manifest
> format is the hardest thing to change once people have written
> connectors against it.

## Two layers

1. **The `PmConnector` trait** — the internal Rust contract the rest of
   Cairn talks to (cache, attribution, UI). A handful of built-ins
   implement it directly when a PM needs real code (e.g. a fiddly OAuth
   flow).
2. **One generic interpreter** — `DeclarativeConnector` implements that
   trait by _reading a JSON manifest_. This is the bring-your-own-PM
   path. A community connector is a manifest file, not a binary. The
   interpreter is fixed, audited Rust; the manifest can only fill in
   request templates and read response fields — **it cannot run logic**.

That data-not-code split is what makes it safe to let strangers write
connectors: the worst a manifest can do is described entirely by this
spec.

## Scope: read-only v1

| Direction                | What                        | Risk                                       | Phase                    |
| ------------------------ | --------------------------- | ------------------------------------------ | ------------------------ |
| Read task lists **in**   | `listProjects`, `listTasks` | Low — pulls data in                        | **v1**                   |
| Write time-spent **out** | `pushTime`                  | High — sends your entries to a third party | v2, per-connector opt-in |

v1 connectors can only _read_. They never send a time entry, description,
or project name outward, so there is no exfiltration surface beyond the
auth token reaching its own API. `pushTime` is a separately-consented
capability added later, per connector.

## The manifest

Every connector — built-in or community — is described by a manifest.
`kind` selects the interpreter:

- `kind: "http"` — the declarative HTTP interpreter (the main event).
- `kind: "file"` — a built-in local-file parser (zero network/secrets).

```json
{
  "manifest": 1,
  "id": "todoist",
  "name": "Todoist",
  "kind": "http",
  "capabilities": ["network", "secrets"],
  "auth": { "type": "bearer", "secret": "todoist_token" },
  "baseUrl": "https://api.todoist.com/rest/v2",
  "operations": { "listProjects": { … }, "listTasks": { … } }
}
```

Common top-level fields:

| Field          | Required | Notes                                                                                              |
| -------------- | -------- | -------------------------------------------------------------------------------------------------- |
| `manifest`     | yes      | Schema version. Currently `1`.                                                                     |
| `id`           | yes      | Stable machine id, kebab-case (e.g. `github-projects`).                                            |
| `name`         | yes      | Human label shown in Settings → Connectors.                                                        |
| `kind`         | yes      | `"http"` or `"file"`.                                                                              |
| `capabilities` | yes      | Subset of `["network","secrets"]`. Surfaced as badges; the connector may only do what it declares. |

## `kind: "http"` — the declarative HTTP connector

Adds `auth`, `baseUrl`, and `operations`.

### `baseUrl`

`https://` only. **Every request is built relative to this base** — a
manifest cannot template a full URL to some other host. That is the
core egress guarantee: the only host a connector ever contacts is
`baseUrl`'s host, which Cairn shows you on import. Redirects to a
different host are refused.

### `auth`

Authentication is **declarative** — you describe it, the interpreter
applies it. The token itself is never in the manifest; it lives in the
OS keychain under the `secret` key, and the user enters it once in
Settings → Connectors.

| `type`   | Effect                                                               |
| -------- | -------------------------------------------------------------------- |
| `none`   | No auth.                                                             |
| `bearer` | `Authorization: Bearer <token>`.                                     |
| `header` | `<name>: <token>` (give `name`).                                     |
| `query`  | Adds `?<name>=<token>` (give `name`).                                |
| `basic`  | `Authorization: Basic base64(<username>:<token>)` (give `username`). |

```json
"auth": { "type": "header", "name": "X-Api-Key", "secret": "acme_key" }
```

There is deliberately **no <code v-pre>{{secret}}</code> template variable** — sprinkling
the token through templates is a footgun and a leak risk. Auth is the
one thing you declare, not template.

### `operations`

v1 defines two: `listProjects` and `listTasks`. Each is a `request` +
a `response` mapping.

```json
"listTasks": {
  "request": {
    "method": "GET",
    "path": "/tasks",
    "query": { "project_id": "{{project.id}}" },
    "headers": { "Accept": "application/json" }
  },
  "response": {
    "items": "",
    "map": { "id": "id", "label": "content", "url": "url", "done": "is_completed" }
  }
}
```

**`request`**

| Field     | Notes                                                                                    |
| --------- | ---------------------------------------------------------------------------------------- |
| `method`  | `GET` or `POST` (v1 read; `POST` is for GraphQL).                                        |
| `path`    | Appended to `baseUrl`. Templated.                                                        |
| `query`   | Object of `key → templated value`. URL-encoded.                                          |
| `headers` | Object of `key → templated value`.                                                       |
| `body`    | String, templated. For GraphQL `POST`s. Defaults the content type to `application/json`. |

**`response`**

- `items` — a **dotted path** to the array of items in the JSON
  response. `""` means _the response body is itself the array_.
  `"data.issues.nodes"` walks objects by key.
- `map` — projects each item into Cairn's shape by dotted path:
  - `listProjects` → required `id`, `name`; optional `description`.
  - `listTasks` → required `id`, `label`; optional `url`, `status`,
    `done` (truthy → completed).

Dotted paths (not full JSONPath) keep manifests easy to hand-write and
the interpreter small and auditable. `a.b.c` walks object keys; that is
enough for every REST and GraphQL list response we've looked at.

### Templating

Request templates are filled by **value substitution only**, escaped for
where they land (URL-encoded in `query`, JSON-escaped in `body`), so a
value can never inject request _structure_.

| Variable                            | Available in           | Is                                                   |
| ----------------------------------- | ---------------------- | ---------------------------------------------------- |
| <code v-pre>{{project.id}}</code>   | `listTasks`            | the id of the project being listed                   |
| <code v-pre>{{project.name}}</code> | `listTasks`            | its name                                             |
| <code v-pre>{{cursor}}</code>       | any, with `pagination` | the current page cursor (empty on the first request) |

### Pagination (optional)

Most PMs page their lists. Declare how to follow pages; the interpreter
loops, capped (see Limits).

```json
"listTasks": {
  "request": { … "query": { "cursor": "{{cursor}}" } },
  "response": { "items": "data.issues.nodes", "map": { … } },
  "pagination": {
    "type": "cursor",
    "cursorPath": "data.issues.pageInfo.endCursor",
    "hasMorePath": "data.issues.pageInfo.hasNextPage"
  }
}
```

Two strategies: `cursor` (above) and `offset` (`{ "type": "offset",
"limit": 100 }`, the interpreter advances the <code v-pre>{{offset}}</code>
template variable by `limit` until a page returns fewer than `limit`
items — reference it in a request `query` value, e.g.
`"query": { "offset": "{{offset}}" }`).

## `kind: "file"` — local-file connectors

For the zero-network case. No `auth`/`baseUrl`/network; a built-in parser
reads a local file. This is the connector to start with if you just want
a checklist attributed to time.

```json
{
  "manifest": 1,
  "id": "my-todo",
  "name": "Project TODO",
  "kind": "file",
  "capabilities": [],
  "file": { "format": "todotxt", "path": "~/code/cairn/TODO.txt" }
}
```

`format` ∈ `todotxt` · `markdown` (GitHub-style `- [ ]` checklists) ·
`taskpaper`. Projects come from the file's sections / `+project` tags;
tasks from its lines. `capabilities` is empty — fully local, no keychain.

## Worked examples

**GitHub Projects (GraphQL):**

```json
{
  "manifest": 1,
  "id": "github-projects",
  "name": "GitHub Projects",
  "kind": "http",
  "capabilities": ["network", "secrets"],
  "auth": { "type": "bearer", "secret": "github_token" },
  "baseUrl": "https://api.github.com",
  "operations": {
    "listProjects": {
      "request": {
        "method": "POST",
        "path": "/graphql",
        "body": "{\"query\":\"{ viewer { projectsV2(first:20){nodes{id title}} } }\"}"
      },
      "response": {
        "items": "data.viewer.projectsV2.nodes",
        "map": { "id": "id", "name": "title" }
      }
    },
    "listTasks": {
      "request": {
        "method": "POST",
        "path": "/graphql",
        "body": "{\"query\":\"{ node(id:\\\"{{project.id}}\\\"){ ... on ProjectV2 { items(first:50){nodes{id content{... on Issue{title url}}}} } } }\"}"
      },
      "response": {
        "items": "data.node.items.nodes",
        "map": { "id": "id", "label": "content.title", "url": "content.url" }
      }
    }
  }
}
```

> **Bundled version notes.** The shipped `github-projects` manifest spreads
> all three `ProjectV2ItemContent` members (`DraftIssue`/`Issue`/`PullRequest`)
> so every card yields a `label` — covering only `Issue` makes one draft or PR
> fail the whole list (`label` is required, mapping fails fast). It reads the
> first page only (`first:20` projects / `first:50` items); cursor pagination
> is a tracked follow-up. Values templated into a GraphQL **string literal**
> (`id:"{{project.id}}"`) are JSON-escaped but not GraphQL-string-escaped —
> safe here because the id is an opaque GitHub node id from `listProjects`, and
> the host is pinned, so the worst case is a malformed read-only query.

**Trello (REST, token in query):**

```json
{
  "manifest": 1,
  "id": "trello",
  "name": "Trello",
  "kind": "http",
  "capabilities": ["network", "secrets"],
  "auth": { "type": "query", "name": "token", "secret": "trello_token" },
  "baseUrl": "https://api.trello.com/1",
  "operations": {
    "listProjects": {
      "request": { "method": "GET", "path": "/members/me/boards" },
      "response": { "items": "", "map": { "id": "id", "name": "name" } }
    },
    "listTasks": {
      "request": { "method": "GET", "path": "/boards/{{project.id}}/cards" },
      "response": {
        "items": "",
        "map": {
          "id": "id",
          "label": "name",
          "url": "url",
          "done": "dueComplete"
        }
      }
    }
  }
}
```

## The internal trait

What the interpreter (and any native connector) implements. Cairn caches
the results locally so attribution works offline.

```rust
pub trait PmConnector: Send + Sync {
    fn manifest(&self) -> &ConnectorManifest;            // id, name, capabilities
    async fn list_projects(&self) -> Result<Vec<RemoteProject>>;
    async fn list_tasks(&self, project: &RemoteProjectRef) -> Result<Vec<RemoteTask>>;
    // v2, behind an explicit per-connector write grant:
    // async fn push_time(&self, task: &RemoteTaskRef, dur: Duration) -> Result<()>;
}

pub struct RemoteProject { pub id: String, pub name: String, pub description: Option<String> }
pub struct RemoteTask {
    pub id: String, pub label: String,
    pub url: Option<String>, pub status: Option<String>, pub done: bool,
}
```

A Cairn `Task` collapses to a thin reference — the planner owns the rest:

```rust
pub struct Task { pub external_ref: ExternalRef, pub label: String }
pub struct ExternalRef { pub connector: String, pub remote_id: String }
```

## Where it plugs in

PM connectors are not signal sources — they don't feed the rules engine.
They get a sibling registry, **`ConnectorHost`**, that reuses the plugin
machinery already built for signal sources (`docs/PLUGINS.md`):
`PluginManifest` / `Capability`, per-connector enable/disable persisted in
`plugin_state`, and the Settings card with capability badges + a toggle.
Connectors are loaded from built-ins plus user-imported manifests in
`<data_dir>/connectors/*.json`.

## Safety & trust

A manifest is data, but importing one is still a trust decision — the
same "installing a plugin opens a door" model as calendar. The
guarantees that bound what a door can be:

- **Data, not code.** The interpreter is fixed Rust. A manifest fills
  templates and reads fields — it cannot branch, loop (beyond declared
  pagination), or call out.
- **One fixed host.** All requests are relative to `baseUrl`; cross-host
  redirects are refused. The only host a connector contacts is the one
  shown to you on import.
- **Read-only v1.** No `pushTime`, so no entry/description leaves the
  machine. Write is a separate, later, per-connector grant.
- **Declared capabilities.** `network` / `secrets` are shown as badges
  and surfaced (with the live host) while a sync runs; the connector may
  only do what it declared.
- **Token in the keychain**, under the manifest's `secret` key, entered
  by the user — never in the manifest, never in `cairn.sqlite`.
- **Import consent.** On import Cairn validates the manifest against the
  schema below and shows: name, the host it will contact, its
  capabilities, and "read-only" — then asks you to confirm before it is
  enabled.

Interpreter limits (enforced regardless of manifest): `https` only,
request timeout, response-size cap, ≤ N pages and ≤ M total items per
list, and no redirect off `baseUrl`'s host.

## Manifest JSON Schema

Cairn validates every manifest against this on import; you can use it to
check yours (it is published at `/schemas/pm-connector.json`).

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "Cairn PM connector manifest",
  "type": "object",
  "required": ["manifest", "id", "name", "kind", "capabilities"],
  "properties": {
    "manifest": { "const": 1 },
    "id": { "type": "string", "pattern": "^[a-z0-9-]+$" },
    "name": { "type": "string", "minLength": 1 },
    "kind": { "enum": ["http", "file"] },
    "capabilities": {
      "type": "array",
      "items": { "enum": ["network", "secrets"] },
      "uniqueItems": true
    }
  },
  "allOf": [
    {
      "if": { "properties": { "kind": { "const": "http" } } },
      "then": {
        "required": ["auth", "baseUrl", "operations"],
        "properties": {
          "baseUrl": {
            "type": "string",
            "format": "uri",
            "pattern": "^https://"
          },
          "auth": {
            "type": "object",
            "required": ["type"],
            "properties": {
              "type": {
                "enum": ["none", "bearer", "header", "query", "basic"]
              },
              "name": { "type": "string" },
              "username": { "type": "string" },
              "secret": { "type": "string" }
            }
          },
          "operations": {
            "type": "object",
            "required": ["listProjects", "listTasks"],
            "additionalProperties": {
              "type": "object",
              "required": ["request", "response"],
              "properties": {
                "request": {
                  "type": "object",
                  "required": ["method", "path"],
                  "properties": {
                    "method": { "enum": ["GET", "POST"] },
                    "path": { "type": "string" },
                    "query": {
                      "type": "object",
                      "additionalProperties": { "type": "string" }
                    },
                    "headers": {
                      "type": "object",
                      "additionalProperties": { "type": "string" }
                    },
                    "body": { "type": "string" }
                  }
                },
                "response": {
                  "type": "object",
                  "required": ["items", "map"],
                  "properties": {
                    "items": { "type": "string" },
                    "map": {
                      "type": "object",
                      "additionalProperties": { "type": "string" }
                    }
                  }
                },
                "pagination": {
                  "type": "object",
                  "required": ["type"],
                  "properties": {
                    "type": { "enum": ["cursor", "offset"] },
                    "cursorPath": { "type": "string" },
                    "hasMorePath": { "type": "string" },
                    "limit": { "type": "integer" }
                  }
                }
              }
            }
          }
        }
      }
    },
    {
      "if": { "properties": { "kind": { "const": "file" } } },
      "then": {
        "required": ["file"],
        "properties": {
          "file": {
            "type": "object",
            "required": ["format", "path"],
            "properties": {
              "format": { "enum": ["todotxt", "markdown", "taskpaper"] },
              "path": { "type": "string" }
            }
          }
        }
      }
    }
  ]
}
```

## Roadmap

1. ✅ **This doc** — lock the format + author instructions.
2. ✅ Local-file connector (`kind: "file"`) end-to-end: the `PmConnector`
   trait, the `ConnectorHost`, the `Task` model, attribution — zero
   network, proves the spine.
3. ✅ The `DeclarativeConnector` (`kind: "http"`) + schema validation +
   the Settings → Connectors card + keychain-backed token management.
4. ✅ Bundled manifests as both features and worked references. **GitHub
   Projects** (GraphQL) and **GitLab** (REST issues) ship compiled in
   (`connectors/manifests/*.json`, registered by `ConnectorHost::load`,
   listed in `builtin::ALL`). Both read the first page only (see #193).
   Trello needs an app key per install, so it stays a doc example.
5. ✅ Offline cache (`connector_cache`) so attribution survives a dropped
   network — a failed read falls back to the last snapshot, marked stale.
6. `pushTime` (v2): a per-connector write grant, with the outbound
   payload shown before the first push.
