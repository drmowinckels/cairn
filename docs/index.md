---
layout: home

hero:
  name: Cairn
  text: A quiet, local-first time tracker.
  tagline: Watches your work signals so you don't have to. No accounts, no telemetry, no cloud.
  actions:
    - theme: brand
      text: Get started
      link: /guide/getting-started
    - theme: alt
      text: Privacy contract
      link: /PRIVACY
    - theme: alt
      text: Rules engine
      link: /RULES_ENGINE
    - theme: alt
      text: View on GitHub
      link: https://github.com/drmowinckels/cairn

features:
  - icon: 🪨
    title: Local-first by design
    details: Everything lives in a SQLite database on your machine. No accounts, no telemetry, no background phone-home. Period.
    link: /PRIVACY
    linkText: The privacy contract
  - icon: 🛰️
    title: Passive signal detection
    details: Cairn watches your window title, git branch, browser domain, and calendar — then matches them against rules you define to assign time automatically.
    link: /RULES_ENGINE
    linkText: How matching works
  - icon: 🤔
    title: Asks when it isn't sure
    details: A subtle "Working on X?" banner instead of a guess. Strict-confidence rules can auto-start; everything else proposes.
    link: /RULES_ENGINE#ambiguity
    linkText: Ambiguity handling
  - icon: 🚫
    title: Exclusions before rules
    details: Apps and domains you exclude never reach the rules engine and never appear in any log. The collector drops them at the source.
    link: /PRIVACY
    linkText: What gets dropped
  - icon: 🎨
    title: Designed, not just built
    details: A hi-fi prototype settled the visual decisions before any code shipped — palette, typography, spacing, and interaction states are all locked in.
    link: /DESIGN_SPEC
    linkText: Design spec
  - icon: 🦀
    title: Native and lightweight
    details: Tauri 2 with a Rust backend and React/TypeScript popover. Small binary, low idle CPU, no Electron.
    link: /architecture/
    linkText: Architecture overview
---

::: warning Pre-release
Cairn is in early development. There are no tagged binaries yet — see [Getting started](/guide/getting-started) to build from source.
:::
