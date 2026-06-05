# CLAUDE.md — Claude Code working notes

This file is for **Claude Code** (or any AI coding agent) picking up the Cairn implementation. Read this before making changes.

## What this project is

Cairn is a **local-first** time tracker for macOS / Windows / Linux built with **Tauri + Rust + React/TypeScript**. The differentiator vs. Toggl: passive auto-detection of what the user is working on, via user-defined rules over OS signals (window title, IDE folder, git branch, browser URL, calendar event).

## Where the design lives

- `design/Cairn.html` — open in a browser to interact with the full prototype. **All visual decisions are settled here.** Match it.
- `docs/DESIGN_SPEC.md` — written description of every screen, component, and design token. Use when the HTML alone is ambiguous.
- `docs/RULES_ENGINE.md` — the rules data model, the matching algorithm, and the ambiguity-handling flow.
- `docs/PRIVACY.md` — the privacy contract. These guarantees are **non-negotiable** and must be visible in the UI.

When implementing a screen, **always open `design/Cairn.html` and inspect with devtools** — the CSS variables, padding, font sizes, and component structures are all there.

## Stack decisions (already made)

- **Backend**: Rust. SQLite via `sqlx` for storage. `tauri-plugin-autostart` for login-item, `tauri-plugin-positioner` to anchor the popover to the tray icon, `tauri-plugin-global-shortcut` for hotkeys.
- **Frontend**: React + TypeScript + Vite. **No** UI framework — recreate the design with CSS modules or vanilla CSS, matching the variables in `design/Cairn.html`.
- **Core / plugin split.** Keep core light. The dividing line:
  - **Core** = always-on, zero-config, fully-local, free signals: `window` · `git` · `idle`.
  - **Plugins** = anything optional, networked, secrets-bearing, or paid: `calendar` · `browser` · PM connectors · billing. Each lives behind a plugin boundary the user opts into; installing one is the user consciously opening a door core never opens on its own.
- **Core signal collectors** (each its own module):
  - `signals/window` — frontmost window title + app name (per platform: AppKit `NSWorkspace` on macOS, `EnumWindows` on Windows, `xdotool`/`hyprland-ipc` on Linux)
  - `signals/git` — watch `~/code/**/.git/HEAD` for branch changes
  - `signals/idle` — `CGEventSourceSecondsSinceLastEventType` / `GetLastInputInfo` / X11 idle
- **Plugin signal sources** (feed the rules engine via the same `SignalSnapshot` contract, but live behind the plugin boundary):
  - `browser` — receive pushes from a small browser extension (Safari/Firefox/Chrome) via a local IPC socket; **never** scrape browser DBs (#37)
  - `calendar` — a signal-source plugin under `src-tauri/src/plugins/calendar/*` (#111): the `SignalSource` wrapper (`plugin.rs`), the `CalendarRegistry`, ICS `fetcher` (network), `parser`, `store`, `secrets` (keychain), and `autostop`. It fetches ICS feeds and stores credentials, so it is a plugin on both the "optional" and "networked/secrets" counts. Started + toggled through the plugin host (`plugins::SignalSourceHost`), enabled state in the `plugin_state` table; see `docs/PLUGINS.md`.
- **Plugin sync connectors** (not signals — bidirectional task/time sync): PM connectors (#110), billing (#109).
- **Rules engine**: pure-Rust module, no DB access. Takes a `SignalSnapshot`, returns `RuleMatch | None`. Origin-agnostic — a snapshot from a plugin signal source is indistinguishable from a core one. See `docs/RULES_ENGINE.md`.
- **Tray popover**: 500px wide, anchored under the tray icon (use `tauri-plugin-positioner`). Closes on focus loss.

## Constraints (don't break these)

1. **Core is local only.** Core makes no network calls except (a) optional update checker the user opts into, (b) the browser extension's local IPC. If you find yourself reaching for `reqwest` in core, stop and check the privacy doc. Network egress is permitted **only inside opt-in plugins** (calendar ICS fetch, PM connectors, billing) — each must declare what leaves the machine in `docs/PRIVACY.md` and surface network activity in the UI while active.
2. **No window-title persistence by default.** Window titles are read, matched against rules in memory, and discarded. Only the _resulting time entry_ (project + tag + description) is stored. There is a debug "Capture raw signals" toggle but it must default off and warn on enable.
3. **Exclusion list applies before any rule.** If an app/domain matches the exclusion list, the signal is dropped at the collector — it never reaches the rules engine and never appears in any log.
4. **Idle = ambiguous, not auto-resolved.** Always ask the user (subtle prompt by default; modal optional) what to do with idle time. Never silently discard or keep.
5. **Suggestion ≠ auto-log.** When a rule matches with non-strict confidence, we _propose_ — we don't start a timer without the user's tap. Strict-confidence rules can auto-start; that's per-rule.
6. **Accessibility floor**: min 16px body / 12px tertiary, ≥4.5:1 contrast both themes, focus rings on every control, `prefers-reduced-motion` honored. The settings panel exposes a real toggle for each accessibility option — wire them up, don't leave them as decoration.

## Suggested first PRs

1. **Scaffold Tauri** with the empty popover window and tray icon. Verify it shows/hides on tray click.
2. **Port the static UI** from `design/Cairn.html` into React. Use fixture data from `design/data.js`. No backend wiring yet.
3. **Local SQLite + entry CRUD.** Schema: `projects`, `entries`, `tags`, `entry_tags`. Migrations via `sqlx::migrate!`.
4. **Window-title collector** for macOS first. Wire it to a debug overlay so you can see the live signal.
5. **Rules engine + matcher.** Pure-Rust, unit-tested.
6. **Suggestion flow.** When a rule matches, post to the UI; show the banner; on confirm, start the timer.
7. **Idle detection + modal.**
8. **Reports view with real data.**

## Code style notes

- **Rust**: `cargo fmt`, `cargo clippy -- -D warnings`. Prefer `anyhow` for app-level errors, `thiserror` for library-level. No `unwrap()` in non-test code.
- **TypeScript**: strict mode on. No `any`. Prefer discriminated unions for the IPC messages between Rust and the webview.
- **Tauri IPC**: messages are typed via `specta` + `tauri-specta` so the TS types are generated from Rust.

## What's intentionally left undecided

- **Billable rates / invoicing** — not in core, ever. Promoted to the roadmap as an opt-in **Pro plugin** (rates + profitability + invoicing). No network call-home for licensing. Epic #109, invoice output #1.
- **Project management** — Cairn does not build a planner and there is no third sister app for it. PM is delivered as **connector plugins** to existing tools (GitHub Projects / GitLab / Codeberg / Trello / local file): read task definitions in, attribute time, optionally write time-spent back. `Task` is a thin reference to the remote planner. Epic #110.
- **Multi-device sync** — explicitly out of scope. If anyone asks, the answer is "export to CSV, sync via your own filesystem tool (Syncthing, iCloud Drive)."
- **Mobile** — out of scope.
- **Pomodoro / focus timers** — out of scope. Owned by **Entracte**, the sister app. Route via the Cairn↔Entracte integration (#48), don't build into Cairn core.
