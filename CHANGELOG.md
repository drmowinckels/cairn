# Changelog

All notable changes to Cairn are documented here. The release pipeline
(`.github/workflows/release.yml`) auto-extracts the topmost `##` section
as the GitHub Release body, so keep the most recent version at the top.

## Unreleased

### Fixed

- `[today]` The "required fields to stop" notice (#108) is now a visible warning
  chip — amber background, border, and a warning icon — instead of plain text.
  With "require a project/description to stop" enabled, clicking Stop on an
  unfilled entry previously surfaced an easy-to-miss line that read as "the
  button did nothing"; it now clearly signals an action is needed.

### Privacy

- `[privacy]` Opt-in activity log for the "review your day" flow (#190). Off by
  default. When enabled (Settings → Detection → "Save activity log"), Cairn
  records compact foreground spans — app name, a **redacted** window-title
  fragment (only the segment before the first dash separator; never the full
  title), and timestamps — to the local `activity_log` table. It reads the same
  redacted snapshots the rules engine sees, so the exclusion list (and
  incognito windows) keep excluded apps out entirely. Retention-bounded
  (default 7 days, purged on launch); disabling the toggle stops recording and
  purges every row immediately. Local only — no network. See `docs/PRIVACY.md`.
- `[privacy]` Separate "Export CSV" for the activity log (#190). The standard
  entries export never touches the `activity_log` table; this dedicated action
  (Settings → Activity log, shown only while the log is on) writes the redacted
  spans (`activity_id,started_at,ended_at,duration_minutes,app_name,title_hint,source`)
  to a path picked via the system save dialog. It carries only the same
  redacted `title_hint` already stored — never the full title.

### Signals

- `[rules]` New `app.category` rule condition (#189). Matches the _category_
  of the foreground app — `meeting` · `editor` · `terminal` · `browser` —
  rather than its exact name, so a single "Meetings" rule covers Zoom, Teams,
  Webex, … without one rule per app. The mapping ships compiled-in
  (`app_categories.json`) and the editor lists the matched apps as helper
  text. Derived in the matcher from the already-redacted `app.name`, so an
  excluded app contributes no category — no change to the privacy contract.
- `[rules]` Starter-rule suggestions (#189). The Rules view now shows a
  collapsible "Suggestions" section with bundled, disabled-by-default rules
  (Meetings → meeting apps, Coding → editors). Adding one creates the named
  project if absent and a real rule; nothing is tracked until the user opts
  in. Dismissals persist locally; an adopted/dismissed starter stops
  suggesting.
- `[calendar]` Cross-platform parity for calendar URL secrets (#40). Linux
  now uses the persistent D-Bus Secret Service (was the kernel keyutils
  keyring, which was wiped on reboot). When no OS keychain is reachable —
  e.g. a headless box with no keyring daemon — secrets fall back to an
  encrypted file in the data dir (XChaCha20-Poly1305, machine-id-derived
  key, owner-only), a documented downgrade described in `docs/PRIVACY.md`.
  Adds an end-to-end ICS integration test (fake HTTP server → fetch →
  parse → active event) so the platform-agnostic path is covered in CI.
- `[git]` The git watcher now seeds every discovered repo's branch on
  startup without dropping events. It previously `try_send`-ed the startup
  batch into a bounded channel and silently dropped most of it on machines
  with many repos (logging a burst of "startup try_send dropped event: no
  available capacity"); it now awaits each send, applying backpressure
  instead — first-launch branch state seeds cleanly.

### Packaging

- `[windows]` The release pipeline now builds a WiX **MSI** (Start-menu
  shortcut + uninstaller) and Authenticode-signs it when the optional
  `WINDOWS_CERTIFICATE` secrets are set, falling back to an unsigned
  installer otherwise — the same opt-in pattern as the macOS signing
  secrets (#43). See `RELEASING.md` for setup and the SmartScreen
  caveat.
- `[linux]` The release pipeline pins the Linux bundles to a `.deb`
  (Debian 12 / Ubuntu 22.04+) and an AppImage (Ubuntu 22.04 LTS,
  Fedora 39+), built on `ubuntu-22.04` for broad glibc compatibility.
  `rpm` is no longer shipped — AppImage covers Fedora (#44).

### Updates

- `[privacy]` Opt-in update checker (#45). Off by default; when enabled in
  Settings → Updates, Cairn asks GitHub once on launch (and daily while
  open) whether a newer version exists and shows a dismissible banner if
  so. No telemetry, no identifier, no custom User-Agent — a single HTTPS
  GET of the signed release manifest via `tauri-plugin-updater`. This is
  the only outbound network Cairn core makes besides user-configured
  calendar fetches.

### Today

- `[feature]` Vertical day timeline (#188). The Today entries surface has a
  list / timeline toggle (in the section header, persisted): the timeline
  renders the day's entries as colour-coded blocks down a scrollable time
  axis, height proportional to duration, with gaps left as empty surface and
  a live "now" rule. Clicking a block opens the entry editor, and dragging a
  block's top/bottom edge resizes its start/end time (snapped to 5 min,
  persisted via `update_entry`). List stays the default.

## Beta v0.1.0

First public beta. Local-first time tracking with passive auto-detection.

### Signals

- Active-window collector (macOS / Windows / Linux).
- Git branch watcher over your code directories.
- IDE folder detection.
- Read-only calendar integration (EventKit / ICS).
- Idle detection with an ambiguity prompt (never auto-discarded).
- Browser-domain signal via the Cairn browser extension (Chrome / Edge /
  Brave / Firefox) over a local IPC socket - domain only, never the URL.

### Rules & suggestions

- Rules engine matching OS signals to projects/tags, with a test bench
  and a confidence heuristic.
- Drag-to-reorder rules; per-rule ambiguity behaviour.
- Suggestions are proposed, not auto-logged (strict-confidence rules may
  auto-start, per rule).

### Today, reports & entries

- Live timer and real timeline.
- Manual entry CRUD; recent + upcoming.
- Reports with an honesty meter.

### Privacy & trust

- No window-title persistence by default; raw-signal capture is a debug
  toggle that defaults off and warns on enable.
- Exclusion list applied at the collector, before any rule.
- "View what's stored" panel and a visible privacy contract.

### Accessibility

- Full keyboard navigation + ARIA audit; contrast-audited tokens.
- Real, wired toggles for each accessibility option.

### Onboarding & shortcuts

- First-run guided flow, global shortcuts, and a ⌘K command palette.

### Known beta limitations

- macOS bundle requires the user to grant Accessibility permission to
  read window titles.
- Windows ships an unsigned/self-signed installer for the beta
  (SmartScreen will warn); see #43.
- Linux packaged as `.deb` + AppImage; calendar parity on Windows/Linux
  is still being verified (#40).
