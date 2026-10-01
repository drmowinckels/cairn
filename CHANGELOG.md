# Changelog

All notable changes to Cairn are documented here. The release pipeline
(`.github/workflows/release.yml`) auto-extracts the topmost `##` section
as the GitHub Release body, so keep the most recent version at the top.

## Unreleased

### Fixed

- `[browser]` **macOS: the browser IPC socket moved again**, to
  `~/Library/Group Containers/ZA246B9H75.group.io.drmowinckels.cairn/ipc/sock`
  (#250). The App Group it previously used carried no Apple Team ID
  prefix, and macOS only grants the `application-groups` entitlement for a
  group owned by the signing team — so the old id could never have been a
  real App Group, only a directory Cairn created for itself. That worked
  for Chrome and Firefox, whose native host isn't sandboxed, and would
  have failed for the Safari extension, which is the entire reason the
  socket lives there. The main app now also _declares_ the entitlement.
  **If you installed the Chrome/Firefox native host from an earlier
  Cairn, rebuild and reinstall it** (`browser-extension/native-host`) —
  otherwise Settings → Integrations silently reads disconnected. Safari is
  unaffected; its handler ships inside the app.
- `[deps]` Cleared every advisory the dependency audit was reporting.
  `rustls` (TLS 1.3 handshake messages accepted at the wrong encryption
  level, RUSTSEC-2026-0285), `h2`, `anyhow` and the yanked `spin` are
  lockfile bumps; `plist` 1.9 → 1.10 pulls in `quick-xml` 0.42, which
  fixes the two XML parser denial-of-service advisories the old version
  carried. On the frontend, `vite` and `vitest` move above the ranges
  their advisories name — dev-tooling only, but the dev server's
  `server.fs.deny` bypass and `@vitest/mocker`'s arbitrary file read are
  worth not carrying. `cargo deny check` and `npm audit` are both clean.

- `[billing]` Rates and invoices now store and show money in the
  currency's **own** minor unit instead of assuming hundredths (#109).
  Hourly rates in a currency with no minor unit (yen, won, króna) were
  stored a hundredfold too large for the documented contract and
  rendered on invoices with cents that don't exist ("JPY 1500.00"), and
  a rate in a thousandth-unit currency (Kuwaiti dinar and its fils) lost
  its third decimal at entry — 15.505 became 15.51 before it was ever
  saved. Existing rows in an affected currency are rescaled on upgrade;
  the two-decimal majority is untouched.

### Added

- `[packaging]` Cairn is installable with **Scoop** on Windows (#319):
  `scoop bucket add cairn https://github.com/drmowinckels/cairn` then
  `scoop install cairn/cairn-timetracker`. The suffix avoids an existing,
  unrelated `cairn` on Scoop. Releases now also carry a portable
  `*-x64-portable.zip` — the bare exe, no installer — which is what the
  bucket installs and is usable on its own.
- `[packaging]` Windows releases now also ship an **NSIS setup `.exe`**
  that installs per-user into `%LOCALAPPDATA%` and needs no
  administrator rights (#299). The MSI still installs per-machine into
  `C:\Program Files` for personal machines and managed deployment, but
  it can't be used where that path is locked down — which is most work
  and school machines.
- `[activity]` A **minimum activity length** for the day's review
  (Settings → Activity log; default and lowest value 5 minutes, #313).
  Foreground blips shorter than it are no longer offered as entries to
  add and no longer trigger the "Workday in Review" reminder — a note
  under the list says how many were held back and reveals them on
  request. Nothing is dropped from the log itself, so "Time by app"
  totals still account for every minute.
- `[billing]` The billing plugin scaffold (#109): Extensions → Plugins
  now lists **Billing (Pro)** — opt-in, off by default, with "Pro" and
  "Network" capability badges. Enabling it reveals the license row:
  paste a Pro license key and Cairn activates it directly with Lemon
  Squeezy (the same approach as the sister app Entracte), then re-checks
  it when the card is opened. A licensing call sends only the key and a
  device id — never any tracked time data — and reading the stored
  status needs no network, so the app stays usable offline. No billing
  features ship behind the gate yet; rates and invoicing come in later
  slices, always outside core.
- `[billing]` Projects have a "Billable by default" setting; new entries
  snapshot it at creation (changing the project default later never
  rewrites existing entries). The flag is categorization only — rates,
  currency, and invoicing stay out of core, reserved for the opt-in Pro
  plugin (#109).
- `[export]` "Export JSON…" in Data → Storage writes a versioned
  structured export (`schemaVersion: 1`): clients, projects, tasks, and
  entries with raw timestamps, raw + rounded durations (respecting
  per-project rounding overrides), and the billable flag. This is the
  stable contract downstream plugins consume instead of reading the
  database (#109).
- `[settings]` **Work-hour budgets** — recurring daily, weekly and monthly
  caps on how much you work, with a warning as you approach one and again once
  you pass it. Budgets can apply to everything, to a client, or to a single
  project, and the most specific one speaks first (project ▸ client ▸
  everything). A running timer counts toward the cap in real time, so you're
  warned before the overrun rather than after it.

  A cap, not a target, and deliberately advisory: Cairn never stops a timer to
  enforce one — that would destroy real tracked time over a number you set as
  guidance. It also lives in core rather than behind the billing plugin;
  knowing you've worked too much this week is not a billing feature. Distinct
  from a project's estimate, which is a one-off total for the whole job (#307).

- `[settings]` **Dates & times** — a new Settings section to choose how Cairn
  renders clocks and dates. **Time format** is System / 24-hour / 12-hour and
  **Date format** is System / D/M/Y / M/D/Y / Y-M-D, each with a live preview.
  `System` follows your OS region. Cairn previously hard-coded a zero-padded
  24-hour clock everywhere with no way to ask for anything else, so a 12-hour
  user had no option at all; dates followed the OS but couldn't be overridden.
  The choice applies to the timeline axis and now-marker, entry rows, the
  activity log, Up Next, the running timer and the idle prompt, and it reaches
  the separate overlay windows live — switching it in the popover repaints the
  idle prompt's clock without a reload. Durations (`1h 15m`) are unaffected;
  the preference is a _clock_, not a number format (#308).
- `[settings]` Every date and time **field you type into** now follows that
  same preference — the manual-entry Start/End, the running timer's start
  edit, working-hours start/end, the invoice range and a rate's effective
  date. These were native `<input type="date" | "time" | "datetime-local">`
  controls, which render in the _webview's_ locale; WKWebView reports that as
  `en-US` no matter the machine's region, so they showed a 12-hour clock and a
  month-first date to everyone and ignored both the OS locale and the new
  preference. A native picker's format isn't scriptable, so they're replaced
  with fields Cairn renders itself. They accept what you'd actually type
  (`1405`, `14.05`, `9:05pm`, `25-12-2026`, or an ISO date in any field order)
  and normalise on blur; an unparseable entry is flagged with the expected
  format instead of being silently dropped; and Up/Down step by a minute or a
  day. What's stored is unchanged — 24-hour `HH:MM` and ISO dates — so
  switching the preference never rewrites an entry. The trade is the loss of
  the OS calendar popup (#308).

### Security

- `[capabilities]` Every window's capability granted `log:default`, but the
  frontend has never used the log plugin — `@tauri-apps/plugin-log` is not a
  dependency and nothing in `src/` imports it. Logging is entirely Rust-side
  and needs no webview permission, so the grant is dropped from all four
  capabilities on least-privilege grounds. It had already propagated once:
  `notify.json` inherited it in #301 by copying `idle.json`'s list rather than
  re-deriving what that window needs (#305).

### Fixed

- `[export]` A time entry whose end precedes its start (clock skew, or a bad
  row) no longer reports a **negative** `duration_minutes` in the CSV export —
  a value a spreadsheet would happily sum. Both exports now measure a span
  through one shared, zero-clamped helper, so the CSV minutes and the JSON
  `durationSeconds` can't disagree about the same entry. The JSON export
  already clamped (#276).

- `[tray]` The About window no longer becomes an invisible window in
  the middle of the screen that cannot be dismissed when its webview fails to paint. It
  was the one overlay still missing the #261/#267 hardening: it is now
  shown click-through until the frontend confirms first paint, takes
  focus only once it is actually visible, and is hidden by a watchdog if
  no paint arrives — so a blank overlay can never swallow clicks with no
  way to close it. Its title bar can also be dragged again (the ACL was
  missing `core:window:allow-start-dragging`). The show/watchdog/paint-ack
  logic behind all three overlay windows now lives in one place
  (`src-tauri/src/overlay.rs`) instead of being copied per window (#300).

- `[detection]` Suggestion notifications actually appear now. The `notify`
  window was matched by **no capability at all**, so the ACL denied its
  `listen()` for `signal:match`; no suggestion ever reached it, it rendered
  nothing, and the paint watchdog hid it 4s after every show — every
  notification-tier prompt was silently lost. The rejected subscribe was
  swallowed as an unhandled promise, which is why it went unnoticed: both
  overlay hooks now log it. A test asserts every window declared in
  `tauri.conf.json` is covered by a capability (and vice versa), so the
  next window can't ship without one (#301).
- `[startup]` A fatal startup failure now shows a native error dialog with
  the underlying reason instead of dying with a silent `SIGABRT`. Tauri
  raises a setup-hook `Err` by panicking from inside the event loop's
  `Ready` callback — an `extern "C"` context that can't unwind — so the
  process aborted with the real cause (e.g. a database migration mismatch)
  visible only when running the binary from a terminal (#302).

- `[autostart]` Startup now detects and repairs a stale macOS
  launch-at-login LaunchAgent left over from before #263's dev-build
  guard existed — one still pointing at a removed `target/debug`
  binary, or at a relocated/uninstalled bundle. It's repointed at the
  installed app when one is found, or cleared otherwise, with a
  one-time notice in Settings → Integrations explaining what happened
  (#264). Scoped to macOS for this fix; Windows' startup registry key
  and Linux's `.desktop` autostart entry are the same class of bug,
  tracked as separate follow-up work (#270).

## v0.0.1-beta

First public beta. Local-first time tracking with passive auto-detection.

### Signals

- Active-window collector (macOS / Windows / Linux).
- Git branch watcher over your code directories.
- IDE folder detection.
- Read-only calendar integration (EventKit / ICS), with cross-platform
  credential storage (macOS Keychain / Windows Credential Manager / Linux
  D-Bus Secret Service, falling back to an encrypted file when no OS
  keyring is reachable) (#40).
- Idle detection with an ambiguity prompt (never auto-discarded).
- Browser-domain signal via an opt-in, **fully local** plugin (Chrome /
  Edge / Brave / Firefox) over a local IPC socket — domain only, never
  the URL; no network egress, no keychain (#37).
- `app.category` rule condition matches on app category (`meeting` ·
  `editor` · `terminal` · `browser`) instead of exact app name, so one
  rule covers a whole class of apps (#189).

### Rules & suggestions

- Rules engine matching OS signals to projects/tags, with a test bench
  and a confidence heuristic.
- Drag-to-reorder rules; per-rule ambiguity behaviour.
- Suggestions are proposed, not auto-logged (strict-confidence rules may
  auto-start, per rule).
- Starter-rule suggestions (Meetings, Coding) in the Rules view — opt-in,
  bundled, and dismissible (#189).

### Today, reports & entries

- Live timer and real timeline, with an optional vertical day-timeline
  view (drag-to-resize entries, snapped to 5 min) (#188).
- Manual entry CRUD; recent + upcoming.
- Reports with an honesty meter.
- A visible warning chip when required fields are missing on Stop,
  instead of an easy-to-miss text line (#108).

### Privacy & trust

- No window-title persistence by default; raw-signal capture is a debug
  toggle that defaults off and warns on enable.
- Exclusion list applied at the collector, before any rule.
- "View what's stored" panel and a visible privacy contract.
- Opt-in, retention-bounded activity log for "review your day" (redacted
  window-title fragments only, purged on disable), with its own
  dedicated CSV export (#190).
- Opt-in update checker — a single signed-manifest HTTPS GET on launch,
  no telemetry, no identifier (#45).

### Accessibility

- Full keyboard navigation + ARIA audit; contrast-audited tokens.
- Real, wired toggles for each accessibility option.

### Onboarding & shortcuts

- First-run guided flow, global shortcuts, and a ⌘K command palette.

### Packaging

- macOS: signed + notarized universal `.dmg` when signing secrets are
  configured; unsigned otherwise (#43).
- Windows: signed WiX MSI (Start-menu shortcut + uninstaller) when
  signing secrets are configured; unsigned otherwise (#43).
- Linux: `.deb` (Debian 12 / Ubuntu 22.04+) and AppImage (Ubuntu 22.04
  LTS, Fedora 39+) (#44).

### Known beta limitations

- macOS bundle requires the user to grant Accessibility permission to
  read window titles.
- Windows and macOS installers are unsigned unless signing secrets are
  configured for the build; SmartScreen/Gatekeeper will warn (#43).
- Safari extension support is built but dormant — not shipped by default
  pending demand (#37).
