# Getting started

Cairn is in early development — there are no tagged binaries yet. To try it, build from source.

## Prerequisites

- **Node.js** ≥ 20
- **Rust** (stable toolchain via [rustup](https://rustup.rs/))
- Platform toolchain for Tauri 2 — see the [Tauri prerequisites guide](https://v2.tauri.app/start/prerequisites/)

## Build and run

```bash
git clone https://github.com/drmowinckels/cairn.git
cd cairn

npm install
npm run tauri dev
```

The first build pulls and compiles the Rust dependencies — expect a few minutes. Subsequent runs are fast.

## Verifying

Once the app launches:

1. A tray icon appears (top bar on macOS, system tray on Windows/Linux).
2. Clicking it opens the 500px popover anchored under the icon.
3. The popover closes on focus loss.

## Next steps

- Read the [privacy contract](/PRIVACY) — Cairn's non-negotiables for what it stores and what it doesn't.
- Read the [rules engine](/RULES_ENGINE) doc — how Cairn maps OS signals to projects.
- Read the [design spec](/DESIGN_SPEC) if you want to contribute UI changes.
