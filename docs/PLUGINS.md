# Plugin architecture

This document defines Cairn's plugin host: the boundary that lets
optional, networked, secrets-bearing, or paid features live outside
core without bloating it or breaking the [privacy contract](/PRIVACY).

It is the design that #111 (extract calendar), #110 (PM connectors),
and #109 (billing) all build on. Read this before adding a plugin.

## The core/plugin line

> **Core** = always-on, zero-config, fully-local, free signals:
> `window` · `git` · `idle`.
>
> **Plugins** = anything optional, networked, secrets-bearing, or
> paid: `calendar` · `browser` · PM connectors · billing.

Installing a plugin is the user consciously opening a door core never
opens on its own. Core makes no network calls (except the opt-in
update check and the browser extension's local IPC). Every byte that
leaves the machine leaves from inside a plugin the user enabled, and
that egress is declared here and surfaced in the UI while active.

## Isolation model: in-process, compiled-in

Cairn is a single local-first desktop binary, not a marketplace. The
plugin host is therefore **in-process**: plugins are Rust modules
compiled into the binary, behind a trait and a manifest, gated by a
runtime **enable/disable** flag and a declared **capability set**.

There is deliberately **no dynamic loader** (no dylib/wasm ABI) and
**no per-plugin sidecar process** in v1:

- A dynamic loader would mean an ABI surface, sandboxing, signing, and
  version skew — premature for the in-tree plugins we actually need.
- A sidecar-per-plugin would mean lifecycle + IPC plumbing for every
  plugin. The browser extension stays a sidecar because it must (it
  runs inside the browser); nothing else needs to.

"Plugin boundary" here is therefore **architectural, not a runtime
loader**: a trait every plugin implements, a host that owns lifecycle,
a manifest that declares capabilities, and the rule that core never
links a plugin's networked/secrets code on the always-on path.

What in-process still buys us:

- **One toggle.** A disabled plugin contributes nothing — no source
  task spawned, no network, no keychain read.
- **Capability honesty.** The manifest is the single place that says
  "this plugin touches the network / the keychain / is paid," and the
  UI reads it. A plugin cannot quietly acquire a capability it didn't
  declare, because the host only hands it the resources its manifest
  names.
- **Testability.** Pure-Rust, no IPC, no ABI — plugins are unit-tested
  like any other module.

## The two kinds of plugin

| Kind               | Direction     | Feeds                                  | Examples                             |
| ------------------ | ------------- | -------------------------------------- | ------------------------------------ |
| **Signal source**  | inbound       | the rules engine, via `SignalSnapshot` | calendar, browser                    |
| **Sync connector** | bidirectional | task list in / time-spent out          | PM connectors (#110), billing (#109) |

They share the same host (register / enable / disable / manifest) but
plug into different seams. This doc specifies the **signal-source**
seam in full (it is the one #111 needs first); the sync-connector seam
reuses the host and is sketched at the end.

## Signal-source plugins

### The seam already (almost) exists

The rules engine is already origin-agnostic: it consumes a
`SignalSnapshot` and has no idea which collector produced each field
(`docs/RULES_ENGINE.md`). The snapshot stream's driver
(`signals/stream.rs`) folds `SignalEvent`s pushed by source tasks
(`window` · `git` · `idle` · `browser`) into that snapshot. Each of
those sources is already decoupled: it owns a clone of the stream's
`mpsc::Sender<SignalEvent>` and pushes; the driver never reaches back
into a source.

**A signal-source plugin is just another task holding that sender.**
A snapshot assembled from a plugin's events is indistinguishable from
one assembled from core's — exactly the property the engine needs.

### The one coupling to remove first

Calendar was the exception. The driver held an `Arc<CalendarRegistry>`
and _pulled_ `active_events_at(now)` on every `publish`. That made the
driver — the heart of the stream — depend on a specific source's
concrete type. No plugin could supply calendar events without the
driver knowing about calendar.

The enabling refactor (PR 1, landed with this doc) flips calendar to
**push** like every other source:

- `SignalEvent::Calendar(Vec<CalendarEvent>)` carries the payload.
- A `calendar_source` task owns the `CalendarRegistry`, queries it on
  its tick, and pushes the resulting events.
- The driver and `publish` no longer take a `CalendarRegistry`; they
  read the latest events from `LiveState`, like every other field.

After this, the driver depends only on `SignalEvent`. Any source —
core or plugin — feeds it identically. (Calendar freshness becomes
bounded by the source's tick interval rather than evaluated exactly at
publish time; for a 30s tick against minute-granularity event
boundaries this is immaterial, and it is the same cadence at which
calendar already armed a publish.)

### The contract

```rust
/// A source of signals that feed the rules engine. Origin-agnostic:
/// the driver cannot tell a plugin's events from a core collector's.
trait SignalSource {
    /// Static identity + declared capabilities. Read by the host and
    /// the settings UI; a source may only use capabilities it names.
    fn manifest(&self) -> &PluginManifest;

    /// Spawn the source's task(s). The source pushes `SignalEvent`s
    /// through `tx` (`try_send`/drop-on-full — never block the driver)
    /// and exits when `tx` is closed.
    fn start(&self, tx: mpsc::Sender<SignalEvent>);
}
```

This is what landed first (`src-tauri/src/plugins/`): the trait, a
`PluginManifest` carrying `Capability::{Network, Secrets}`, and a
`SignalSourceHost` that registers sources, exposes their manifests, and
starts them. `CalendarPlugin` is the first implementation and wires the
existing `CalendarRegistry` in behind the boundary; startup logs every
plugin it starts and the capabilities it declared. Two things are
deliberately deferred to later slices of the stack so the first PR stays
reviewable: **per-source stop/disable** (an abort-handle on `start` plus
a persisted enabled set, landing with the settings UI) and
**`Capability::Paid`** (landing with billing, #109).

A plugin that contributes a _new_ kind of signal (not one of today's
`SignalEvent` variants) adds a variant to `SignalEvent` and a field to
`SignalSnapshot`, plus the matching `Condition` in the rules engine.
That is a core change reviewed on its own merits — the plugin host
does not let a plugin invent snapshot fields at runtime. In-tree
plugins are few and known; this keeps the snapshot a closed, typed,
auditable shape rather than an open map.

### Privacy obligations (non-negotiable)

A signal-source plugin sits _before_ the rules engine, so the same
choke points apply to it as to core collectors:

1. **Exclusion list first.** A plugin must apply the user's exclusion
   list before pushing, exactly as the `browser` collector does — the
   driver's `apply_event` re-checks window events, but a plugin's own
   signal types are the plugin's responsibility to filter at the
   source. Excluded signals never reach the engine.
2. **No raw-signal persistence by default.** A plugin reads, matches
   in memory, and discards. Only the resolved time entry is stored.
3. **Declared egress.** If the plugin makes network calls, its
   manifest's `network` capability lists the hosts/feeds, those are
   reproduced in `docs/PRIVACY.md`, and the UI shows network activity
   while the plugin is active.
4. **Secrets stay in the plugin.** Credentials live in the OS keychain
   under the plugin's ownership (`secrets.rs`), never in SQLite, and
   core does not link the secrets code.

### Degrading when a plugin is absent

Rules can reference a signal a plugin provides (e.g. a `calendar.*`
condition). When that plugin is not installed/enabled:

- The condition simply never matches (the field is absent from the
  snapshot) — rules do not error, they go quiet.
- The rule editor flags such a condition as "needs the _Calendar_
  plugin" rather than silently rendering a dead rule.
- Disabling a plugin is reversible and lossless: re-enabling restores
  matching with no rule rewrite.

## Sync-connector plugins (sketch — #110, #109)

Sync connectors do not feed the snapshot stream; they bind Cairn's
local entries to a remote planner or billing target. Same host
(register / enable / disable / manifest, same capability honesty), a
different trait:

```rust
trait PmConnector {
    fn list_projects(&self) -> Vec<RemoteProject>;
    fn list_tasks(&self, project: ProjectRef) -> Vec<RemoteTask>; // read — v1
    fn push_time(&self, task: TaskRef, dur: Duration) -> Result<()>; // write — v2, opt-in
}
```

Read-in is low-risk and ships first; write-out exfiltrates entries to
a third party and is a separately-consented capability (`network` +
an explicit write grant) added per provider later. See #110.

## Host lifecycle

The host owns the registry of plugins and their enabled state
(persisted), and is the only thing that:

- reads a plugin's manifest and exposes it to the settings UI,
- starts a plugin's task(s) on enable (handing it the resources its
  manifest declares, and no others),
- signals cancellation on disable and at shutdown,
- gates network/secrets access behind the declared capability.

Core's always-on sources (`window` · `git` · `idle`) are _not_
plugins — they are unconditional and need no manifest. The host
manages only the opt-in set.

## Migration path

1. **PR 1 (with this doc):** decouple the driver from
   `CalendarRegistry` via `SignalEvent::Calendar`. Behaviour-
   preserving — the calendar source primes on its first (immediate)
   tick and calendar freshness becomes tick-bounded rather than
   evaluated exactly at publish (immaterial at a 30s tick; see above).
   This is the seam; it ships before any host code so the host has
   something origin-agnostic to plug into.
2. **Done:** introduce `PluginManifest` + `SignalSource` trait + the
   `SignalSourceHost` (register / manifests / start), and wrap calendar
   as `CalendarPlugin: SignalSource` started through the host. Calendar
   code is still compiled into core here — this slice validates the
   boundary without moving files.
3. Add per-source enable/disable: an abort-handle on `start`, a
   persisted enabled set, a `list_plugins` IPC, and the settings UI that
   lists plugins (with their declared capabilities) and toggles them.
   Rules referencing a disabled plugin's signal degrade per above.
4. Move `signals/calendar/*` + `calendar_autostop` + keychain ownership
   physically behind the plugin; core stops linking the ICS fetcher and
   secrets code on the always-on path (#111).
5. Reclassify calendar as a plugin in `docs/PRIVACY.md`,
   `docs/DESIGN_SPEC.md`, `docs/RULES_ENGINE.md`, and `CLAUDE.md`.
6. Build PM connectors (#110) and billing (#109) on the same host;
   billing introduces `Capability::Paid`.
