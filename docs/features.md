# Features

Cairn does what Toggl or Clockify do — start/stop a timer, attach a project, tag, and description, see reports — and then does the part most trackers leave to you: noticing what you're actually working on.

Everything below runs on your machine. Nothing here requires an account, and nothing described on this page sends a byte anywhere unless its own section says so explicitly.

![Cairn's Today view: a live timer, the day's timeline, and recent entries](/img/screenshots/today-timer.png)

![The same Today view in dark mode](/img/screenshots/today-dark.png)

## Passive signal detection

Cairn watches a handful of OS-level signals in memory — never on disk — and matches them against rules you define:

- **Active window** — the frontmost app name and window title (e.g. `Zed`, `"rules.tsx — cairn"`).
- **Git branch** — a watcher on `.git/HEAD` across your configured code folders, so switching branches can switch what you're tracking.
- **IDE folder** — the project root your editor has open, derived from the window title and process working directory.
- **App category** — a bundled table maps app names to coarse categories (`meeting`, `editor`, `terminal`, `browser`), so one rule covers Zoom, Teams, and Webex without naming each.
- **Idle** — whether there's been OS input recently, and for how long.

These four are **core**: always on, zero-config, fully local, and free. Two more signals exist behind an explicit opt-in — see [Plugins](#plugins-you-opt-into) below.

Every signal is read, matched against your rules, and discarded. The only thing that ever reaches disk is the time entry a matched rule (or you) actually created. See the [privacy contract](/PRIVACY) for the exact list of what's stored and what isn't.

## Rules that ask when they're not sure

Rules are `when` a set of conditions match `then` an action — assign a project, tags, and an optional description template. Each rule carries a **confidence**:

- **Strict** rules auto-start a timer the moment they match. Reserve these for signals you trust completely (a dedicated client repo, a specific meeting app).
- **Suggestive** rules (the default) post a subtle "Working on **X**?" banner instead of guessing. You confirm, dismiss, or change it — Cairn never starts a timer behind your back on a suggestive match.

Ambiguity is a first-class outcome, not an edge case: a suggestive rule can be set to **prompt**, **skip silently**, or **log to uncategorized** so you can clean it up later. Bundled **starter rules** (Meetings, Coding) give you a working example to edit rather than a blank form.

![The suggestion banner: "Working on Cairn — Cairn dev work?" with the matched signal shown as evidence](/img/screenshots/suggestion-banner.png)

![The Rules view's condition/action editor, expanded for a calendar-matching rule](/img/screenshots/rules-editor.png)

## Idle handling done right

Long stretch with no input? Cairn doesn't silently keep the clock running and it doesn't silently throw the time away — it asks. The idle prompt shows exactly how long you were away and lets you choose: keep it on the current entry, discard the gap and keep tracking, discard and start a fresh entry, or discard and stop. Whatever you pick, it's a decision you made — never one Cairn made for you.

![The idle prompt, showing the length of the gap and the four choices](/img/screenshots/idle-prompt.png)

## Reports you can trust

- A weekly stacked view broken down by project, plus a by-project summary.
- Configurable **rounding** (nearest / up / down, to any interval), globally or per-project.
- An **honesty meter** that surfaces how much of your tracked time came from suggestions you confirmed versus manual entry, so the reports stay legible about their own provenance.
- **CSV export** — one row per entry (`entry_id, started_at, ended_at, duration_minutes, client, project, task, description, source`) — drops cleanly into a spreadsheet, pandas, or dplyr.

![This week's report: a stacked daily chart and a by-project breakdown](/img/screenshots/reports-week.png)

## Plugins you opt into

Core never phones home. Two signal sources and a set of read-only connectors exist behind an explicit opt-in boundary — installing one is you consciously opening a door core never opens on its own. Each declares exactly what it touches, and Settings → Plugins shows a **Network** / **Secrets** capability badge for every one that has them.

**Calendar** — reads ICS subscription URLs (or local `.ics` files) you add yourself; no OAuth, no cloud calendar API. It's read-only (`GET` requests only), the subscription URL is stored in your OS keychain — never in the SQLite database — and event titles/attendees live in memory only, matched and discarded like every other signal. A calendar rule can pull the event title into an entry's description or its attendees into tags, entirely locally.

**Browser extension** — a small Safari/Chrome/Firefox/Edge extension pushes the **domain** of your active tab (never the full URL, page title, or contents) to Cairn over a local socket. No network egress at all — the transport never leaves the machine, and private/incognito tabs are dropped before they ever reach the extension's own send path.

**PM connectors** — Cairn doesn't build a planner. It reads your task list from one you already use — GitHub Projects, GitLab, and Trello ship built in — so you can attribute tracked time to a real task instead of retyping its name. Each connector is read-only in this release: it pulls project and task names in, caches the last successful read for offline use, and never pushes anything back out. Tokens live in your OS keychain, never in the database, and are write-only across the IPC boundary — Settings shows whether a token is stored, never its value.

![Extensions: Calendar/Git/Browser integrations plus GitHub, GitLab, and Trello connectors, each with Remote/Network/Secrets badges](/img/screenshots/settings-plugins.png)

## Privacy by construction

- **Local-first, period.** Everything lives in a SQLite database on your machine. No accounts, no telemetry, no crash reporting, no background phone-home.
- **Exclusions run before rules.** Apps, domains, and window-title patterns you exclude are dropped at the collector — they never reach the rules engine and never appear in any log.
- **Nothing raw persists by default.** Window titles, browser URLs, and calendar event details are matched in memory and discarded; only the resulting entry (project + tag + description) is stored.
- **Two opt-in, clearable exceptions**, both off by default: a suggestion-feedback log (used to learn repeated patterns into rules) and an "activity log" for reviewing your day, which redacts window titles to the part before the first separator and purges completely the moment you turn it off.
- **Export, backup, restore, delete** — all local. Export a CSV or a full SQLite snapshot to any folder (including one your OS already syncs via iCloud Drive, Syncthing, etc. — Cairn never talks to those services itself), restore from a snapshot, or wipe everything in place.

![Settings' Storage card: the same guarantees, next to the controls that back them — export, restore, delete](/img/screenshots/settings-privacy.png)

Read the full [privacy contract](/PRIVACY) for the exact guarantees and what would have to change (and be disclosed) to break them.

## Accessibility floor

Every accessibility option is a real, wired toggle, not a decoration: adjustable text scale, a high-contrast mode, `prefers-reduced-motion` support, a colorblind-safe palette option, always-visible focus rings, and screen-reader announcements for state changes like a suggestion appearing or a timer starting. Minimum 16px body text (12px tertiary), 4.5:1 contrast in both themes, full keyboard navigation.

## Native and lightweight

Built on **Tauri 2** — a Rust backend and a native system webview, not a bundled Chromium. Small binary, low idle CPU, no Electron. The same codebase ships to macOS, Windows, and Linux.

---

Curious how the matching actually works? Read the [rules engine](/RULES_ENGINE) doc. Building or auditing a plugin? Start with the [plugin architecture](/PLUGINS).
