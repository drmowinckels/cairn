# Future: live data-location relocate (single-device-at-a-time)

> Status: parked. Convert to a GitHub issue once the repo is pushed.

## Problem

Today (path A, shipped) gives users a manual export/restore loop. They can drop
the backup into iCloud / Drive / Syncthing and pull it onto another machine,
but they have to remember to do it.

The natural extension is letting them point Cairn's live SQLite file at a
synced folder so the OS handles replication. That works fine **for one
device at a time** — opening the popover on two machines that are both
syncing the same `cairn.sqlite` will corrupt the database, because SQLite
assumes exclusive local access.

## Out of scope

- Multi-device concurrent sync. That's a different product (server, CRDTs,
  conflict resolution) and explicitly off the table per
  [docs/PRIVACY.md](../PRIVACY.md) and CLAUDE.md.
- Any Cairn-controlled cloud service or account.

## What we'd ship

1. **"Data location" setting** in Settings → Privacy. Default: app data dir.
   User can pick any folder; on save, Cairn migrates the existing SQLite
   file (and `cairn.sqlite.bak` rotation) to the new location and reopens
   the pool against it.
2. **Lockfile guard.** Alongside `cairn.sqlite`, write `cairn.sqlite.lock`
   containing `{ hostname, pid, opened_at }`. On startup, if the lockfile
   exists and the host/pid don't match this process:
   - Show a modal: "Cairn is open on **<hostname>** (since 14:02). Opening
     here would risk corrupting your data. [Open read-only] [Take over]
     [Cancel]."
   - "Take over" overwrites the lockfile and proceeds — the other instance
     will see the change on its next poll and self-close with the same modal.
3. **Read-only mode.** When the user opts into it, the popover renders but
   the Stop / Start / rule-edit paths are disabled with a banner. Useful
   for "I just want to glance at today's totals from the other laptop."
4. **Heartbeat.** Touch the lockfile every N seconds while open so a crashed
   instance's stale lock can be detected (e.g. lock older than 5× heartbeat
   with no host process is offered for takeover without the scary modal).
5. **Docs.** Update [docs/PRIVACY.md](../PRIVACY.md) and CLAUDE.md to note
   that the relocate feature is OS-sync-aware but does not change the
   "no Cairn-controlled network" guarantee.

## Trade-offs

- The lockfile dance is the right primitive but it's UX-heavy. A clear
  "another machine has this open" modal carries the feature.
- SQLite-in-iCloud has a known materialization quirk on macOS (the file
  can briefly appear as `cairn.sqlite.icloud` while downloading). The
  open path should retry / wait for materialization rather than fail.
- WAL mode + cloud sync is hazardous (the `-wal` and `-shm` sidecars
  matter). Force `journal_mode=DELETE` whenever the data dir looks like
  a known cloud folder.

## Effort

Rough: 1–2 days of implementation, plus a manual cross-device test pass
(iCloud Drive between two Macs, Syncthing between Mac + Linux).
