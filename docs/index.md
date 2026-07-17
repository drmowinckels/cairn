---
layout: home

hero:
  name: Cairn
  text: A quiet, local-first time tracker.
  tagline: Watches your work signals so you don't have to. No accounts, no telemetry, no cloud.
  image:
    light: /img/logo-mark-light.svg
    dark: /img/logo-mark-dark.svg
    alt: Cairn logo
  actions:
    - theme: brand
      text: Download
      link: /guide/install
    - theme: alt
      text: See all features
      link: /features
    - theme: alt
      text: Rules engine
      link: /RULES_ENGINE

features:
  - icon: 🪨
    title: Local-first by design
    details: Everything lives in a SQLite database on your machine. No accounts, no telemetry, no background phone-home. Period.
    link: /PRIVACY
    linkText: The privacy contract
  - icon: 🛰️
    title: Passive signal detection
    details: Cairn watches your window title, git branch, IDE folder, and idle state — core signals, always local — then matches them against rules you define to assign time automatically.
    link: /features#passive-signal-detection
    linkText: How matching works
  - icon: 🤔
    title: Asks when it isn't sure
    details: A subtle "Working on X?" banner instead of a guess. Strict-confidence rules can auto-start; everything else proposes.
    link: /RULES_ENGINE#ambiguity
    linkText: Ambiguity handling
  - icon: 🔌
    title: Opt-in plugins, not defaults
    details: Calendar (ICS), a browser-domain extension, and read-only GitHub/GitLab/Trello connectors — each behind an explicit toggle with a Network/Secrets badge, never on by default.
    link: /features#plugins-you-opt-into
    linkText: What each plugin touches
  - icon: 🚫
    title: Exclusions before rules
    details: Apps and domains you exclude never reach the rules engine and never appear in any log. The collector drops them at the source.
    link: /PRIVACY
    linkText: What gets dropped
  - icon: 🦀
    title: Native and lightweight
    details: Tauri 2 with a Rust backend and React/TypeScript popover. Small binary, low idle CPU, no Electron — macOS, Windows, and Linux from one codebase.
    link: /architecture/
    linkText: Architecture overview
---

::: warning Public beta
Cairn is in public beta (`v0.0.1-beta`) — [download a build](/guide/install) for macOS, Windows, or Linux, or [build from source](/guide/getting-started).
:::

## See it in action

![Cairn's Today view: a live timer, the day's timeline, and recent entries](/img/screenshots/today-timer.png)

[See every feature →](/features)
