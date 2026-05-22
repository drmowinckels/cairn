# Privacy

Cairn watches your work to help you. That's exactly why we have to be careful about what it sees, what it remembers, and what leaves your machine.

This document is the contract. The UI commits to these statements; the implementation must back them.

## The four guarantees (visible in the app)

1. **Everything is stored locally** in a SQLite database under `~/.cairn/` (or platform equivalent). Nothing is uploaded.
2. **No accounts. No telemetry. No background phone-home.** No analytics, no crash reporting, no "anonymous usage stats". Period.
3. **Window titles are read locally and never leave the device.** They're evaluated against rules in memory and discarded.
4. **Source on GitHub, Apache 2.0 licensed.** Anyone can audit.

These four sentences appear verbatim in `Settings → Privacy`. If you change behavior, change the sentence too.

## What is stored

| Stored                                                         | Reason                               |
| -------------------------------------------------------------- | ------------------------------------ |
| Time entries (start, end, project, tags, description, source)  | The app's purpose                    |
| Projects and tags the user has created                         | The app's purpose                    |
| Rules (conditions, actions)                                    | User configuration                   |
| Exclusion list                                                 | User configuration                   |
| Calendar event titles for entries created by the calendar rule | The user explicitly wanted this rule |
| Idle periods (timestamps only)                                 | To compute idle prompts and reports  |

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

- **Read-only** access. Permission requested via the OS calendar API (EventKit on macOS, etc.).
- Cairn never modifies the user's calendar.
- Only event title + attendee emails are read, and only when actively matching a calendar rule.
- Attendee emails are **not** stored unless the matching rule has `tags_from_calendar: true`, in which case they become tags on the time entry. The user can disable that per-rule.

## Browser integration

- Implemented via a tiny browser **extension** that pushes the active-tab URL/domain/title to a local Unix-domain socket (or named pipe on Windows) at `~/.cairn/sock`.
- The extension is open-source and ships separately.
- The socket has restrictive permissions (`0600` on Unix).
- **Never** scrape browser history databases or sqlite files. That breaks the trust model.

## Export, restore & delete

- **Export backup**: writes a consistent SQLite snapshot (`VACUUM INTO`) to any path the user picks via the system save dialog. The user can drop the resulting `.sqlite` file into iCloud Drive, Google Drive, Syncthing, or any other folder the OS is already syncing — Cairn never talks to those services itself.
- **Restore from file**: the user picks any `.sqlite` file with the system open dialog. Cairn stages it next to the live DB as `cairn.sqlite.pending` and swaps it in on next launch (the previous DB is preserved as `cairn.sqlite.bak`). Cancelling the pending restore deletes the staged file. There is no live pool swap, so a restore cannot corrupt an in-flight write.
- **Export CSV**: writes entries in long format with columns `entry_id,started_at,ended_at,project,task,source,tag`. One row per `(entry, tag)` pair — an entry with three tags becomes three rows; an entry with no tags is one row with an empty `tag`. Project is scalar, tags split into rows. Drops cleanly into pandas, dplyr, or any spreadsheet.
- **View what's stored**: reveals the data folder in Finder / Explorer / file manager via the OS — no extra info leaves the device.
- **Delete everything**: shows an OS confirmation dialog, then removes the SQLite file, its `-wal` / `-shm` / `-journal` sidecars, any staged restore (`.pending`), and the rotation backup (`.bak`). The app then exits — relaunch starts from a fresh seed.

A note on cloud-synced folders: backup and restore are explicitly snapshot operations, not live sync. Pointing Cairn's live database at a cloud folder is out of scope for v1 — see [docs/future/sync-relocate.md](future/sync-relocate.md) for the design we'd ship if we ever revisit it.

## What changes can break the contract

Any of these requires a CHANGELOG entry tagged `[privacy]` and explicit reaffirmation in the Settings privacy card:

- Adding any outbound network request (including update checks).
- Persisting any field marked "not stored" above.
- Adding any third-party SDK (analytics, crash reporting, anything).
- Changing the exclusion list behavior so an excluded signal _is_ observed in any capacity.

When in doubt: don't.
