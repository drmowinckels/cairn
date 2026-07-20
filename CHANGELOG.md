# Changelog

All notable changes to Cairn are documented here. The release pipeline
(`.github/workflows/release.yml`) auto-extracts the topmost `##` section
as the GitHub Release body, so keep the most recent version at the top.

## Unreleased

### Added

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

### Fixed

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
