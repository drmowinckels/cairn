# Design prototype

The files here are the **interactive design reference** for Cairn — an HTML/React prototype that captures the final visual language, layout, interactions, and component vocabulary.

**These are not production code.** They are a spec for what to build. Re-implement them in the Tauri + React/TypeScript app.

## Run it locally

Open `Cairn.html` in any modern browser. No build step.

```bash
# from this directory
open Cairn.html              # macOS
xdg-open Cairn.html          # Linux
start Cairn.html             # Windows
```

A small floating "Tweaks" panel in the bottom-right lets you flip between states and variants:

- **Theme** — light / dark (mirror system preference in production)
- **Density** — compact / comfy
- **Today layout** — default / projects-first quick-pick
- **Rule-builder depth** — light / medium / heavy (progressive disclosure of rule engine power)
- **Try states** — toggle the auto-detect suggestion banner and the idle modal

## File map

| File | What it is |
|---|---|
| `Cairn.html` | Entry point. Mounts React, wires the popover + tabs, hosts theme/density tweaks. Inline `<style>` block carries the full stylesheet for portability. |
| `tweaks-panel.jsx` | The runtime tweaks helper (panel + form controls + persistence protocol). Library code — copy as-is or replace with your own dev panel. |
| `common.jsx` | Hairline `<Icon>` set, `<ProjectChip>`, `<Tag>`, `<Kbd>`, `<LocalBadge>`. The atomic vocabulary used everywhere. |
| `today.jsx` | The "Today" view: running timer, suggestion banner, idle modal, day timeline, recent, upcoming. |
| `rules.jsx` | The "Rules" view: list, expandable inline editor, test bench, live-signals panel. |
| `reports.jsx` | The "Reports" view: weekly stacked-bar chart, by-project breakdown, honesty meter. |
| `settings.jsx` | The "Settings" view: privacy card, exclusion list, accessibility, shortcuts, integrations. |
| `data.js` | Fixture data — projects, today's entries, week totals, rules, live signals. Drop-in mock until the backend is real. |

## Where the *spec* lives

The prose specification — exact tokens, accessibility checklist, animation timings — is in [`../docs/DESIGN_SPEC.md`](../docs/DESIGN_SPEC.md). When in doubt, the HTML is the visual source of truth and the spec is the prose source.
