<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/public/img/logo-mark-dark.svg" />
    <img src="docs/public/img/logo-mark-light.svg" alt="Cairn logo" width="160" />
  </picture>
</p>

# Cairn

> A quiet, local-first time tracker that watches your work signals so you don't have to.

Cairn is an open-source desktop time tracker. It does what Toggl does — start/stop a timer, attach a project, tag, and description, see reports — but it also **passively listens to your work signals** (the folder open in your IDE, your git branch, your browser domain, your calendar) and uses **user-defined rules** to assign time to projects automatically. If a rule isn't sure, Cairn asks a subtle "Working on X?" instead of guessing.

All data stays on your machine. No accounts, no telemetry, no cloud.

## Stack

- **Tauri 2** (Rust backend, system-native webview frontend)
- **Rust** for tracking daemon, rules engine, SQLite storage
- **React + TypeScript** for the popover UI (rebuild from the HTML prototypes in `design/`)

## Repo layout

```
cairn/
├── README.md            ← you are here
├── CLAUDE.md            ← context for Claude Code
├── LICENSE              ← Apache-2.0
├── NOTICE               ← attribution notice
├── package.json         ← npm scripts (dev, build, test, tauri)
├── index.html           ← Vite entry
├── vite.config.ts       ← Vite config (port 1420, ignores src-tauri)
├── tsconfig.json        ← strict TS
├── vitest.config.ts     ← unit tests
├── design/              ← interactive HTML design prototype (source of visual truth)
│   └── Cairn.html         · open in a browser to explore
├── docs/                ← spec, rules engine, privacy contract
├── src/                 ← React + TS popover UI
│   ├── App.tsx
│   ├── main.tsx
│   ├── brand.css        · ported design tokens + popover CSS
│   ├── error-boundary.tsx
│   ├── lib/             · icon, components, ipc, time, types
│   ├── test-fixtures/   · sample data ported from design/data.js
│   └── views/
│       ├── popover/     · header / nav / body / footer shell
│       ├── today/
│       ├── reports/
│       ├── rules/
│       └── settings/
└── src-tauri/           ← Rust backend
    ├── Cargo.toml
    ├── tauri.conf.json
    ├── capabilities/
    ├── icons/
    ├── migrations/      · sqlx SQLite migrations
    └── src/
        ├── lib.rs       · plugin wiring, setup
        ├── main.rs
        ├── db.rs        · sqlx pool + migrate
        ├── ipc.rs       · #[tauri::command] handlers
        ├── popover.rs   · tray-anchored popover toggle + global shortcut
        ├── tray.rs      · NSStatusBar tray icon
        ├── rules/       · pure-Rust rules engine (no IO)
        └── signals/     · per-source signal collectors (window, idle, …)
```

## Getting started

```bash
# 1. Install JS deps
npm install

# 2. Run the popover in dev (spawns Tauri + Vite)
npm run tauri dev

# 3. Type-check & test
npm run typecheck
npm test
cd src-tauri && cargo test
```

## Design status

The interactive prototype in `design/Cairn.html` is **hi-fi** — final palette, typography, spacing, and interactions. Build the Tauri+React UI to match it.

Open `design/Cairn.html` directly in a browser. The Tweaks panel (bottom-right) lets you flip:

- **Theme**: light / dark
- **Density**: compact / comfy
- **Today layout**: default / projects-first
- **Rule-builder depth**: light / medium / heavy (showcases progressive disclosure of the rule engine)
- **Try states**: auto-detect suggestion banner, idle-detection modal

## Palette

| Token               | Hex       | Use                                                      |
| ------------------- | --------- | -------------------------------------------------------- |
| `--eggshell`        | `#f4f1de` | Soft light surface                                       |
| `--burnt-peach`     | `#e07a5f` | Accent — running timer, primary actions, rule highlights |
| `--twilight-indigo` | `#3d405b` | Ink / primary text                                       |
| `--muted-teal`      | `#81b29a` | "Local only" / privacy / positive states                 |
| `--apricot-cream`   | `#f2cc8f` | Auto-detect suggestion banner                            |

See `docs/DESIGN_SPEC.md` for the full token map (semantic colors, density scales, type system, hairlines).

## License

[Apache License 2.0](LICENSE). See [NOTICE](NOTICE) for attribution.
