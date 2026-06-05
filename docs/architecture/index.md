# Architecture overview

Cairn is a Tauri 2 desktop app: a Rust backend handles signal collection, rule matching, and SQLite storage; a React + TypeScript frontend renders the popover UI.

## Components

- **Tray + popover** — `tauri-plugin-positioner` anchors a 500px window under the tray icon. Closes on focus loss.
- **Signal collectors** — per-OS modules in `src-tauri/src/signals/` that read the frontmost window, git branch, and idle state (core's always-on, fully-local signals). Window titles are matched in memory and discarded — never persisted by default. Optional sources (calendar, browser URL via a local IPC socket from a browser extension) are **plugins** under `src-tauri/src/plugins/`, behind the [plugin boundary](/PLUGINS) — they feed the same `SignalSnapshot` the rules engine consumes, so the engine can't tell a plugin's signal from a core one.
- **Rules engine** — pure Rust, no I/O. Takes a `SignalSnapshot`, returns `RuleMatch | None`. See the [rules engine doc](/RULES_ENGINE) for the data model and the matching algorithm.
- **Storage** — SQLite via `sqlx`. Schema: `projects`, `entries`, `tags`, `entry_tags`. Migrations bundled with `sqlx::migrate!`.
- **IPC** — `#[tauri::command]` handlers typed via `specta` + `tauri-specta` so the TS bindings are generated from Rust.

## Privacy posture

Several architectural decisions exist solely to keep the [privacy contract](/PRIVACY) enforceable:

- Exclusion list runs in the collector, not the rules engine — excluded signals never reach memory at the engine layer.
- Window titles are read, matched, and dropped. The only thing that gets stored is the resolved time entry (project + tag + description).
- No network code in the main process. The browser extension talks over a local IPC socket, not HTTP to a remote server.

## Deeper reading

- [Rules engine](/RULES_ENGINE) — signals, ambiguity handling, the matching algorithm.
- [Design spec](/DESIGN_SPEC) — visual tokens, screen-by-screen reference.
- [Privacy contract](/PRIVACY) — the four guarantees and how they translate to code.
