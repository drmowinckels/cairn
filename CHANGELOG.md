# Changelog

All notable changes to Cairn are documented here. The release pipeline
(`.github/workflows/release.yml`) auto-extracts the topmost `##` section
as the GitHub Release body, so keep the most recent version at the top.

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
