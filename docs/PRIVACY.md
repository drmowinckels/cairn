# Privacy

Cairn watches your work to help you. That's exactly why we have to be careful about what it sees, what it remembers, and what leaves your machine.

This document is the contract. The UI commits to these statements; the implementation must back them.

## The four guarantees (visible in the app)

1. **Everything is stored locally** in a SQLite database under `~/.cairn/` (or platform equivalent). Nothing is uploaded.
2. **No accounts. No telemetry. No background phone-home.** No analytics, no crash reporting, no "anonymous usage stats". Period.
3. **Window titles are read locally and never leave the device.** They're evaluated against rules in memory and discarded.
4. **Source on GitHub, Apache 2.0 licensed.** Anyone can audit.

The first three sentences appear verbatim in the **Data tab → Storage** section, beside the storage controls they describe; the fourth (source / licence) appears in **Settings**. If you change behavior, change the sentence too.

## What is stored

| Stored                                                                | Reason                               |
| --------------------------------------------------------------------- | ------------------------------------ |
| Time entries (start, end, project, tags, description, source)         | The app's purpose                    |
| Projects and tags the user has created                                | The app's purpose                    |
| Rules (conditions, actions)                                           | User configuration                   |
| Exclusion list                                                        | User configuration                   |
| Calendar event titles for entries created by the calendar rule        | The user explicitly wanted this rule |
| Calendar source list: label, redacted URL or file path, poll interval | So Cairn knows what to fetch         |
| Idle periods (timestamps only)                                        | To compute idle prompts and reports  |

## What is **not** stored

- Window titles (used in matching, discarded)
- Browser URLs / tab titles (used in matching, discarded)
- File paths (used in matching, discarded)
- Frontmost app name as a _log_ (only the project decided by the rule is logged)
- IP address, hostname, user account, machine ID, OS version — none of it. No reason to collect it.

## Exclusion list

Applies **at the collector**, before any rule or matcher runs.

- Apps (e.g. `1Password`, `Messages`, `Signal`) — frontmost detection returns `None`.
- Domains (e.g. `*.bank.com`, `mail.protonmail.com`) — browser extension never pushes a signal for these tabs.
- Window-title patterns (e.g. `*— Private`) — regex match drops the signal.
- Browser private/incognito windows — dropped unconditionally if the toggle is on (default).

While an exclusion is active, Cairn behaves as if the user has no foreground app at all. No rule can fire. The current timer keeps running unchanged.

## Debug "Capture raw signals"

Hidden in Settings → Advanced. Off by default, **sticky off** on every relaunch.

- Writes the raw `SignalSnapshot` stream to `~/.cairn/debug-signals.ndjson`.
- Big yellow warning text on enable.
- Disabling deletes the file.
- Used only for troubleshooting and reporting rule-detection bugs upstream. The user controls when it runs.

## Calendar integration

Cairn ingests calendars by fetching ICS subscription URLs the user has explicitly added (or reading local `.ics` files). It does not use cloud calendar APIs, OAuth, or per-OS calendar databases. The same code path works on macOS, Windows, and Linux.

- **Read-only** by construction — only HTTP `GET` is ever issued. Cairn cannot modify the source calendar.
- **No analytics, no metadata.** Each request is a plain `GET` with `If-None-Match` / `If-Modified-Since` so that most polls return 304. No query strings, no cookies, no referrer.
- **Network destinations are user-supplied.** Cairn only contacts hosts whose URL the user pasted in Settings → Integrations → Calendar. There is no discovery, no central index, and no calendar provider sees anything other than a plain ICS download.
- **Subscription URLs are bearer credentials and are stored in the OS keychain** (macOS Keychain / Windows Credential Manager / Secret Service), never in `cairn.sqlite`. The DB only holds a redacted display string (`https://calendar.google.com/…`).
- **Event titles, attendees, and descriptions live in memory only.** They are parsed, evaluated against rules, and dropped on the next refresh. Only the _resulting time entry_ (project + tag + description, after the user accepts a suggestion) is persisted — the same contract that already applies to window titles.
- **Attendee emails** are only persisted if the matching calendar rule has `tags_from_calendar: true`. The user can disable that per-rule.
- **Provider-side privacy still applies.** When the user pastes a Google secret-address URL, Google logs Cairn's polling fetches the same way it logs any other ICS subscriber. Cairn cannot prevent that — the user is the one giving the URL to Google. This is documented in the Add Calendar dialog.

## Browser integration

- Implemented via a tiny browser **extension** that pushes the active-tab URL/domain/title to a local Unix-domain socket (or named pipe on Windows) at `~/.cairn/sock`.
- The extension is open-source and ships separately.
- The socket has restrictive permissions (`0600` on Unix).
- **Never** scrape browser history databases or sqlite files. That breaks the trust model.

## Update checks

Cairn can check whether a newer version exists. This is the one outbound request core makes besides user-configured calendar fetches, and it is **off by default**.

- **Opt-in, visible.** Disabled until the user turns on Settings → Updates → "Check for updates". The toggle copy states exactly what the check does.
- **What it sends.** A single HTTPS `GET` of the public release manifest (`https://github.com/drmowinckels/cairn/releases/latest/download/latest.json`) — on launch and once every 24h while the app stays open. No telemetry, no UUID, no custom User-Agent, no query string.
- **What it does.** Compares the manifest version to the running version and, if newer, shows a dismissible banner in the popover footer linking to the release notes. Cairn never downloads or installs anything on its own.
- **Signed.** The manifest is verified against a bundled public key (`tauri-plugin-updater`), so a tampered manifest is rejected.
- **GitHub sees a request.** As with any GitHub download, GitHub logs the fetch (IP, timestamp). That is inherent to the user opting in; turning the toggle off stops all checks.

## Export, restore & delete

- **Export backup**: writes a consistent SQLite snapshot (`VACUUM INTO`) to any path the user picks via the system save dialog. The user can drop the resulting `.sqlite` file into iCloud Drive, Google Drive, Syncthing, or any other folder the OS is already syncing — Cairn never talks to those services itself.
- **Automatic backup**: opt-in. The user picks a destination folder (typically one the OS already syncs) and Cairn writes timestamped `VACUUM INTO` snapshots (`cairn-auto-<timestamp>.sqlite`) on a chosen cadence, retaining the most recent N. These are point-in-time **snapshots**, never the live WAL database, so a sync folder only ever sees whole, self-consistent files and the multi-writer SQLite-corruption hazard never arises. Off by default; the destination, cadence, and retention live in the local DB; **no network leaves the machine** — replication is entirely the OS sync client's job. "Back up now" forces a snapshot on demand.
- **Restore from file**: the user picks any `.sqlite` file with the system open dialog. Cairn stages it next to the live DB as `cairn.sqlite.pending` and swaps it in on next launch (the previous DB is preserved as `cairn.sqlite.bak`). Cancelling the pending restore deletes the staged file. There is no live pool swap, so a restore cannot corrupt an in-flight write.
- **Export CSV**: writes entries in long format with columns `entry_id,started_at,ended_at,project,task,source,tag`. One row per `(entry, tag)` pair — an entry with three tags becomes three rows; an entry with no tags is one row with an empty `tag`. Project is scalar, tags split into rows. Drops cleanly into pandas, dplyr, or any spreadsheet.
- **View what's stored**: reveals the data folder in Finder / Explorer / file manager via the OS — no extra info leaves the device.
- **Delete everything**: shows an OS confirmation dialog, then removes the SQLite file, its `-wal` / `-shm` / `-journal` sidecars, any staged restore (`.pending`), and the rotation backup (`.bak`). The app then exits — relaunch starts from a fresh seed.

A note on cloud-synced folders: backup and restore are explicitly snapshot operations, not live sync. Pointing Cairn's live database at a cloud folder is out of scope for v1 — see [docs/future/sync-relocate.md](future/sync-relocate.md) for the design we'd ship if we ever revisit it.

## What changes can break the contract

Any of these requires a CHANGELOG entry tagged `[privacy]` and explicit reaffirmation in the Settings privacy card:

- Adding any outbound network request (including update checks). The user-configured calendar fetches in Settings → Integrations → Calendar are the one allowed exception, scoped to URLs the user explicitly added.
- Persisting any field marked "not stored" above.
- Adding any third-party SDK (analytics, crash reporting, anything).
- Changing the exclusion list behavior so an excluded signal _is_ observed in any capacity.

When in doubt: don't.
