# Cairn — Design Spec

This is the implementer's reference. Every screen, component, token, and interaction the engineer needs is described here. The HTML in `design/Cairn.html` is the visual source of truth — when in doubt, open it and inspect.

## Fidelity

**Hi-fi.** Final palette, typography, spacing, and interactions. Recreate pixel-accurately in the Tauri + React build using the codebase's existing patterns. Treat the HTML as a spec, not as code to copy.

---

## 1. Design tokens

### 1.1 Color (brand)

| Token               | Hex       | Use                                                    |
| ------------------- | --------- | ------------------------------------------------------ |
| `--eggshell`        | `#f4f1de` | Soft light surface                                     |
| `--burnt-peach`     | `#e07a5f` | Accent: running timer, primary action, rule highlights |
| `--twilight-indigo` | `#3d405b` | Ink / primary text in light mode                       |
| `--muted-teal`      | `#81b29a` | "Local only" / privacy / positive states               |
| `--apricot-cream`   | `#f2cc8f` | Auto-detect suggestion banner                          |

### 1.2 Color (semantic — light theme)

| Token               | Value                                                                                   |
| ------------------- | --------------------------------------------------------------------------------------- |
| `--bg`              | `#ece8d3` (desktop background)                                                          |
| `--bg-soft`         | `#f4f1de` (nested surfaces)                                                             |
| `--surface`         | `#fbf9ee` (the popover)                                                                 |
| `--surface-2`       | `#f4f1de` (kbd, segmented controls)                                                     |
| `--ink`             | `#3d405b`                                                                               |
| `--ink-soft`        | `rgba(61, 64, 91, .66)`                                                                 |
| `--ink-mute`        | `rgb(61 64 91 / 78%)` (darkened from the original `.42` for ≥4.5:1 contrast — see #136) |
| `--ink-faint`       | `rgba(61, 64, 91, .18)`                                                                 |
| `--hairline`        | `rgba(61, 64, 91, .12)`                                                                 |
| `--hairline-strong` | `rgba(61, 64, 91, .22)`                                                                 |
| `--accent`          | `#e07a5f`                                                                               |
| `--accent-soft`     | `rgba(224, 122, 95, .14)`                                                               |
| `--teal-soft`       | `rgba(129, 178, 154, .18)`                                                              |
| `--apricot-soft`    | `rgba(242, 204, 143, .35)`                                                              |
| `--indigo-soft`     | `rgba(61, 64, 91, .08)`                                                                 |

### 1.3 Color (semantic — dark theme)

| Token               | Value                                                              |
| ------------------- | ------------------------------------------------------------------ |
| `--bg`              | `#1b1d29`                                                          |
| `--bg-soft`         | `#232636`                                                          |
| `--surface`         | `#262a3c`                                                          |
| `--surface-2`       | `#2e3245`                                                          |
| `--ink`             | `#f4f1de`                                                          |
| `--ink-soft`        | `rgba(244, 241, 222, .72)`                                         |
| `--ink-mute`        | `rgb(244 241 222 / 65%)` (darkened from `.46` for contrast — #136) |
| `--ink-faint`       | `rgba(244, 241, 222, .18)`                                         |
| `--hairline`        | `rgba(244, 241, 222, .10)`                                         |
| `--hairline-strong` | `rgba(244, 241, 222, .20)`                                         |

Light/dark are toggled with `data-theme="light|dark"` on the document. Default = follow system (`prefers-color-scheme`).

### 1.4 Type system

Fonts are **self-hosted** — vendored as woff2 via `@fontsource` and bundled by Vite, with no Google Fonts CDN request at runtime (#146). Each family is OFL-1.1; see `NOTICE`.

- **Serif** — `Newsreader Variable` (6..72 optical size, weights 400/500/600). Use for: app name, view titles, running timer numeric, suggestion-banner body, idle modal body, settings section titles, privacy card title.
- **Sans** — `Geist Variable` (300–700). Default UI font.
- **Mono** — `Geist Mono Variable` (400–600). Use for: timestamps, durations, tags, kbd, code snippets in rules, signal values.

### 1.5 Density scale

The popover has a `data-density` attribute (`compact` or `comfy`). Comfy is the default.

| Variable         | Comfy  | Compact |
| ---------------- | ------ | ------- |
| `--pad-x`        | 24px   | 18px    |
| `--pad-y`        | 22px   | 16px    |
| `--gap`          | 22px   | 16px    |
| `--font-base`    | 17.5px | 14.5px  |
| `--font-small`   | 15px   | 13px    |
| `--font-tiny`    | 13px   | 12px    |
| `--font-display` | 45px   | 34px    |
| `--line-base`    | 1.55   | 1.5     |
| popover width    | 500px  | 420px   |

> Comfy type runs slightly larger than the original prototype (base 16→17.5, small 14→15, tiny 12.5→13, display 42→45) for readability. Density padding was not re-tuned to match, so dense Today states can crowd the 500px popover — tracked as a follow-up in #145.

### 1.6 Radii, shadows, hairlines

- `--radius-lg: 16px` — popover, large cards
- `--radius-md: 10px` — inner cards (suggest, now, idle, privacy)
- `--radius-sm: 6px` — chips, kbd, small buttons
- Hairlines: `.5px solid var(--hairline)` (subtle) and `var(--hairline-strong)` (defined)
- Popover shadow: `0 1px 0 rgba(255,255,255,.6) inset, 0 14px 40px -16px rgba(34,28,50,.35), 0 4px 14px -8px rgba(34,28,50,.2)`

---

## 2. Surface — the popover

A floating panel anchored under the macOS tray icon. 500×variable, max-height `calc(100vh - 56px)`. It has a tail (a 14×14 rotated square) at the top pointing up to the tray icon, positioned 38px from the right edge.

Structure (top → bottom):

1. **Header** — `.pop-head`: brand mark + "Cairn" wordmark + `LocalBadge` + spacer + icon buttons (search ⌘K, plus = new manual entry).
2. **Nav tabs** — `.pop-nav`: Today / Reports / Rules / Data / Settings / Extensions, with hairline underline indicator on active. Right-aligned hint shows the open/hide shortcut `⌃⌥T`.
3. **Body** — `.pop-body`: scrollable container, the active view renders here.
4. **Footer** — `.pop-foot`: status strip with "4h 12m today · 3 rules active" and `⌃⌥␣ stop` hint.

Open / close: triggered by the tray icon (`⌃⌥T`). Closes on `Esc` and on focus loss. Window: borderless, no traffic lights, transparent.

---

## 3. Views

### 3.1 Today

The default view. Top-to-bottom:

#### a. Auto-detect suggestion (`.suggest`)

Shown inline in the Today view when a rule has matched at non-strict confidence and the user hasn't confirmed yet — **only** for the "Subtle" detection-prompt tier (Settings → Accessibility). The "Notification" tier does not render this inline; see §3.1h.

- Background: `linear-gradient(180deg, var(--apricot-soft) 0%, rgba(242,204,143,.12) 100%)`
- Border: `.5px solid rgba(242, 204, 143, .55)`
- Header label: `DETECTED` (12.5px, 600 weight, .08em letter-spacing, uppercase) with a 13px sparkle icon in `var(--accent)` and a small × dismiss button top-right.
- Body: serif 19px, e.g. `Working on [Cairn chip] — *Rule preview UI*?`
- "Why" line: small text `because feat/rules-ui · folder ~/code/cairn`, where the values are in mono inside a faint code chip (`rgba(61,64,91,.06)` background, 1px 5px padding, 3px radius). On the right, a `view rule` link button (`--accent`, underline) that jumps to Rules and expands the rule.
- Actions row: a primary "Confirm" button (✓ icon + label) and a ghost "Change…" button.
- Keyboard: `↵` confirms, `Esc` or × dismisses.

> The task-switch (§3.1 "switched task?" banner, #105) and working-hours-reminder (#99) banners still reuse a heavier `.suggest--modal` CSS variant for the "Notification" tier (unchanged by #267 — they were not converted to the dedicated window; see the #267 PR notes for the scope call).

#### b. Idle modal (`.idle`)

Shown when idle detected on resume.

- Body: `No input detected from <strong>14:50</strong> to <strong>15:02</strong>`, with `12 min` mono right-aligned.
- Actions: primary "Keep", ghost "Discard idle", ghost "Move to break".

#### c. Running timer (`.now`)

- Wrapper card: `--bg-soft` background, hairline border.
- `now-meta` row: "NOW · RUNNING" eyebrow + "✦ rule" badge in `--accent` indicating the timer was started by a rule.
- `now-time` — the elapsed running time, serif 42px (comfy), tabular numerals, colons in `--ink-mute`.
- `now-task` — editable task description input. Borderless except for a dashed underline that becomes solid `--accent` on focus.
- `now-row` — project chip + tags on the left, "Stop" button (`--accent` filled, white text, square icon) on the right.

#### d. Quick start (`.quick`, only in `layoutVariant: "projects-first"`)

A 2×2 grid of quick-start cards, each with a project color dot + name.

#### e. Today timeline (`.timeline`)

- Section label: "TODAY'S PATH" + meta on the right: "4h 12m logged · 18h 34m this week"
- Horizontal track 26px tall, light gradient background. Each entry is a segment positioned by start/end (08:00–19:00 spans the full width). The running entry has a diagonal-stripe animated background (respects `prefers-reduced-motion`).
- A vertical "now" needle with a dot at top and a small mono label showing the current time, drawn above the entries.
- Axis row beneath: tick marks at hours 8, 10, 12, 14, 16, 18.
- Legend below: project dot + name for each project that appears today.

#### f. Recent (hidden in compact density and in `projects-first` layout)

List of last 4 entries: time, project dot, task, duration, source icon (✦ for rule, 📅 for calendar).

#### g. Upcoming (`.upcoming`)

A small list of the next 2–3 calendar items / focus blocks. Each row: time · label · duration.

#### h. Suggestion notification window (`.notify-win`, separate window — #267)

The "Notification" detection-prompt tier's presentation surface. Not part of the popover — a dedicated, small, undecorated, always-on-top Tauri window (`?win=notify`, 380×240, transparent, centered on screen — same native `.center()` the idle window uses, not a hand-rolled corner position, since `tauri_plugin_positioner`'s `Position::TopRight`/`Position::Tray*` panics without a monitor/tray rect), shown/hidden by the backend independently of whether the popover is open or which tab is active. Mirrors the idle-prompt window's card chrome and its click-through-until-painted hardening (#261/#262), but is **not** a forced choice:

- No backdrop, no focus trap, no `aria-modal` — a dismissible proposal the user can ignore, marked up the same non-dialog way as `.suggest` (`aria-label` + `aria-live="assertive"`, no `role="dialog"`/`"alertdialog"`).
- The backend never steals OS focus when showing or painting it (unlike the idle window, which does).
- Content mirrors `.suggest`'s body (project chip + rule name + tags + "why" evidence line) but drops the "Change…" action — only **Confirm** and **Dismiss**. Picking a different project requires opening the popover.
- Card chrome: `var(--surface)` background, `var(--hairline-strong)` border, `var(--radius-lg)`, `var(--shadow-soft)` — same tokens as `.idle-win`.
- Re-showing while already on screen (the same rule keeps matching on the ~2Hz snapshot tick) only refreshes its content, not its position — no re-arm flicker.

### 3.2 Reports

- **Header**: a serif view title that tracks the range ("Today" / "This week" / "This month") with a date-range subtitle beneath; the Day / Week / Month segmented control sits on the right. (The implementation uses this `view-head` + subtitle pattern rather than the prototype's inline `rep-big` number; the headline figures live in the totals grid below.)
- **Totals**: a 3-up grid directly under the header — tracked hours (mono `Xh`), the delta versus the previous period (a directional ▲/▼/◆ arrow + mono percentage, colored by direction, labelled "vs last…"), and the project count.
- **Chart**: 160px tall. 7 vertical bars, one per weekday, each a stacked column of project-colored segments. Today's bar has a 1.5px inset ring in `--ink`. Future days are 35% opacity. Horizontal gridlines at 0/2/4/6/8 hours with mono numeric labels (#148); the axis ceiling is anchored at ≥8h and rounded up to the next even hour so bars never overflow it.
- **By project**: list of rows, each `[dot + name] [horizontal bar with fill] [hours] [%]`. Sorted by descending hours.
- **Honesty meter**: a single 8px horizontal stacked bar showing the share of time logged by rule (`--burnt-peach`) / calendar (`--muted-teal`) / manual (`--twilight-indigo` 60% opacity). Legend below.

### 3.3 Rules

- **Header**: "Rules" serif title + sub "Tried in order from top. First match wins. Each rule may combine multiple signals." (last clause hidden in `light` complexity). "New" button top-right.
- **Live signals** (medium / heavy only): a card listing the four currently observed signals (IDE folder, git branch, window title, browser domain) with their values in mono and the source app on the right. These are clickable affordances to use them as conditions (future).
- **Rule list**: each row is `.rule`, collapsed by default. Header row shows:
  - drag handle (visible on hover)
  - rule number (mono)
  - rule name (semibold 500)
  - condition summary pill (or "N conditions" badge if >1)
  - "→" arrow
  - project chip OR "+ tags" italic label
  - "N× today" mono counter
  - toggle switch (teal when on)
  - chevron-right (right when closed, down when open)
- **Expanded rule body**:
  - **When** section listing conditions. Each condition: signal icon + label + op `<select>` + value `<input>` + × button (medium/heavy). For 2+ conditions, an "AND" or "OR" join label sits above each subsequent row. "+ add condition" link at bottom (medium/heavy).
  - **Then** section: Project select + Tags row with chips and "+ tag" button. Show "from calendar attendees" italic note for the calendar rule.
  - **Confidence + Ambiguity** (heavy only): two rows — "Confidence threshold: strict" and "If ambiguous: prompt me".
  - **Foot**: "Duplicate" + "Delete" link buttons.
- **Test bench** (heavy only): three input fields (IDE folder, git branch, window title) prefilled with sample values, and a result row "→ matches **Cairn dev work** → assigns [chip] [#dev #feature]".

### 3.4 Settings

Ordered to put the most important things first.

1. **Privacy card** — large card, teal tint, shield icon + "Your data stays here" serif title, 4-bullet list of guarantees, three actions: "Export all data…", "View what's stored", "Delete everything…".
2. **Never track these** — exclusion list. Each row: lock icon + value in mono code + kind label (app/domain/window) + × remove. Last row is an inline add input. Below: checkbox "Pause tracking on private/incognito browser windows" (default on).
3. **Accessibility** — toggles for text size (4-position segmented), high contrast, reduce motion, colorblind-safe palette, screen reader announcements, focus rings always visible, detection prompts (segmented: Off / Subtle / Notification — renamed from "Modal" in #267: "Notification" opens the dedicated overlay window in §3.1h rather than a heavier CSS treatment of the inline banner).
4. **Shortcuts** — list of keyboard shortcuts with `<Kbd>` chips.
5. **Foot** — version, Apache-2.0, GitHub link.

> Integrations no longer live under Settings — everything optional and opt-in moved to its own **Extensions** tab (§3.5).

### 3.5 Extensions

Everything optional and opt-in: integrations, signal-source plugins, and the PM connectors Cairn reads tasks from. Kept separate from Settings so day-to-day preferences stay clear of the things you plug in. Three cards, top → bottom:

1. **Integrations** — Calendar / Git / Browsers, each with a status line and a "Configure…" / "Manage…" / "Install…" action.
2. **Plugins** — the signal-source plugins core never starts on its own. Each row: name + capability badges (**Network**, **Secrets**) + an enable/disable toggle. **Calendar** is the first such plugin: opt-in, it fetches ICS feeds (Network) and stores credentials in the OS keychain (Secrets), which is why it sits behind the plugin boundary rather than on core's always-on path. Disabling it stops all fetching and clears its events from rule matching, persisting across launches. A rule that references a calendar signal stays valid while the plugin is off — it simply never matches.
3. **Connectors** — the PM connectors (GitHub / GitLab / Trello) Cairn reads tasks from, each with per-connector enable/disable and credential management.

---

## 4. Components reference

### 4.1 `ProjectChip`

Inline pill with a colored dot + project name. Two sizes: `sm` (default, 12px dot 6px) and `lg` (13.5px). Background: `rgba(61,64,91,.06)`. Made interactive when used in the running timer.

### 4.2 `Tag`

Mono 12px, `--ink-mute`, prefixed with `#`. No background.

### 4.3 `Kbd`

Mono 12px, surface-2 background, hairline-strong border, 4px radius, 1px 5px padding.

### 4.4 `LocalBadge`

Teal-tinted pill, 12px text. A small teal dot with a soft glow ring (no animation). Tooltip: "All data stays on your machine. No telemetry, no accounts."

### 4.5 `Icon`

Hairline 1.5 stroke SVG, 24×24 viewBox. Sized via `size` prop. Names used in the design:

play, stop, pause, today, reports, rules, settings, check, x, plus, edit, chevron-right, chevron-down, lock, branch, folder, globe, calendar, sparkle, shield, moon, type, drag, info, search, command, keyboard, list, grid, arrow-right.

### 4.6 `Toggle`

iOS-style switch. 32×18px. `--accent` when on. Focus ring: 2px `--accent` 2px offset.

### 4.7 Buttons

- `.btn--primary` — ink background, eggshell text. Dark theme: eggshell bg, indigo text.
- `.btn--ghost` — transparent, hairline-strong border, ink-soft text. Hover: `indigo-soft` background.
- `.btn--stop` — accent background, white text. Used only on the running timer.
- `.icon-btn` — 26×26 circle/square, transparent. Hover: `indigo-soft`.

All buttons: focus-visible outline `2px solid var(--accent)`, offset 1px.

---

## 5. Interactions

| Action                           | Trigger                                    | Result                                                 |
| -------------------------------- | ------------------------------------------ | ------------------------------------------------------ |
| Show / hide popover              | Tray click; `⌃⌥T`                          | Anchored under tray icon; fade-in 80ms                 |
| Switch view                      | Click tab or press `1`–`4`                 | Body re-renders; tab indicator slides                  |
| Start timer                      | Click project chip in quick-start or `⌃⌥␣` | Running timer card appears                             |
| Stop timer                       | Stop button or `⌃⌥␣`                       | Entry committed to today's timeline                    |
| Confirm suggestion               | `↵` or click ✓ Confirm                     | Timer auto-starts with rule's project + tags           |
| Change suggestion                | Click "Change…"                            | Opens project picker (`⌘K` command palette)            |
| Dismiss suggestion               | × or `Esc`                                 | Banner hides; next match won't re-trigger within 5 min |
| Idle: keep / discard / move      | Click button                               | Entry trimmed accordingly; resumes timer               |
| Toggle rule on/off               | Click switch                               | Rule enters/leaves the matching pool immediately       |
| Reorder rules                    | Drag handle                                | Persisted; matching order updates                      |
| Open rule detail from suggestion | Click "view rule" link                     | Switches to Rules tab, expands matching rule           |
| Reduce motion                    | OS setting or accessibility toggle         | Disables tray pulse + running-timer stripe shift       |

---

## 6. Animations

All ≤200ms unless noted. All respect `prefers-reduced-motion`.

- Tray icon pulse: 2s ease-in-out infinite (box-shadow ring)
- Running entry stripes: 6s linear infinite background-position shift
- Tab switch: 120ms ease
- Toggle slide: 150ms ease
- Suggestion fade-in: 200ms ease

---

## 7. Accessibility checklist

- All interactive elements reach via `Tab`; visible focus rings (`2px solid var(--accent)`).
- `role="dialog"` on the popover; `aria-label="Cairn time tracker"`.
- Tabs: `role="tablist"` / `role="tab"` / `aria-selected`.
- Timer time announced via `aria-live="polite"` on the elapsed-time wrapper.
- Idle modal: `role="alertdialog"`, `aria-labelledby="idle-h"`.
- Toggles: `role="switch"`, `aria-checked`.
- Color is never the only signal: source icons accompany the source-color on entries; honesty meter has a textual legend; today's bar in the chart has a ring outline in addition to color contrast.
- Minimum body text 16px in comfy, 14.5px in compact. Tertiary labels ≥12px.
- All accessibility toggles in Settings must be wired to real CSS/JS effects:
  - **Text size** → multiplies all `--font-*` variables.
  - **High contrast** → swaps `--ink-soft`/`--ink-mute`/`--hairline` for darker variants; bumps `--hairline` opacity.
  - **Reduce motion** → adds `[data-reduce-motion]` to body that disables all `animation` and `transition` declarations.
  - **Colorblind-safe palette** → swaps project colors for Okabe–Ito set.
  - **Screen reader announcements** → adds aria-live status messages on timer events.
  - **Focus rings always visible** → adds `[data-always-focus]` that turns `:focus-visible` into `:focus`.
