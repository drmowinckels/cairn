# Rules Engine

The rules engine is what makes Cairn different. It listens to OS signals and assigns time to the right project, asking the user only when it's uncertain.

## 1. Signals

A `SignalSnapshot` is the engine's input. It's reassembled every time any signal changes (debounced 500ms).

```rust
pub struct SignalSnapshot {
    pub timestamp: DateTime<Utc>,
    pub frontmost: Frontmost,
    pub git:       Option<GitContext>,
    pub browser:   Option<BrowserContext>,
    pub calendar:  Vec<CalendarEvent>, // currently-active events
    pub idle:      IdleState,
}

pub struct Frontmost {
    pub app_name:     String,         // "Zed", "Safari"
    pub window_title: String,         // "rules.jsx — cairn"
    pub bundle_id:    Option<String>, // macOS only
    pub pid:          u32,
}

pub struct GitContext {
    pub repo_path: PathBuf,           // root of the repo
    pub branch:    String,            // "feat/rules-ui"
    pub origin:    Option<String>,    // remote URL if any
}

pub struct BrowserContext {
    pub domain:     String,           // "github.com"
    pub url_path:   String,           // "/cairn-app/cairn/pulls"
    pub tab_title:  String,
    pub incognito:  bool,             // if true, snapshot has BrowserContext: None
}

pub struct CalendarEvent {
    pub title:     String,
    pub attendees: Vec<String>,       // emails
    pub source:    String,            // "Personal", "Work"
}

pub enum IdleState {
    Active,
    Idle { since: DateTime<Utc>, seconds: u32 },
}
```

### Signals available in the rule builder

| Signal | Source | Description |
|---|---|---|
| `app.name` | OS frontmost API | The application name |
| `window.title` | OS frontmost API | The full window title string |
| `ide.folder` | IDE detection by app + heuristics on window title (`"file.tsx — cairn"`) and process cwd | The project folder open in the active IDE |
| `git.branch` | Watcher on `.git/HEAD` of currently-relevant repo | The current git branch |
| `git.repo` | Same | The repo path/name |
| `browser.domain` | Browser extension push (Safari/Firefox/Chrome) | Domain of the active tab |
| `browser.tab` | Same | Tab title |
| `browser.url` | Same | Full URL of the active tab |
| `calendar.event` | OS calendar API | Match against title of an event currently active |
| `idle` | OS idle API | Active / idle (with duration) |

## 2. Rule data model

```rust
pub struct Rule {
    pub id:          RuleId,
    pub name:        String,
    pub enabled:     bool,
    pub priority:    u32,                  // lower = tried first
    pub conditions:  Vec<Condition>,       // joined per `combinator`
    pub combinator:  Combinator,           // All (AND) | Any (OR) | Custom(expr)
    pub action:      Action,
    pub confidence:  Confidence,           // Strict | Suggestive
    pub on_ambiguity: AmbiguityBehavior,   // Prompt | Skip | LogToUncategorized
}

pub enum Combinator {
    All,           // every condition must match
    Any,           // any condition matches
    Custom(Expr),  // future — boolean expression tree
}

pub struct Condition {
    pub signal: SignalKey,
    pub op:     Op,
    pub value:  String,
}

pub enum SignalKey {
    AppName, WindowTitle, IdeFolder, GitBranch, GitRepo,
    BrowserDomain, BrowserTab, BrowserUrl,
    CalendarEvent, Idle,
}

pub enum Op {
    Equals,
    Contains,
    StartsWith,
    EndsWith,
    Matches(Regex),    // anchored, case-insensitive by default
    IsActive,          // for calendar.event
}

pub struct Action {
    pub project: Option<ProjectId>,
    pub tags:    Vec<TagId>,
    pub tags_from_calendar: bool,   // for calendar rule: derive tags from attendees
    pub description_template: Option<String>, // e.g. "{calendar.event}", "{git.branch}"
}

pub enum Confidence {
    Strict,        // auto-start timer immediately on match
    Suggestive,    // post a suggestion banner; user confirms
}

pub enum AmbiguityBehavior {
    Prompt,                 // show "Working on X?" suggestion
    Skip,                   // do nothing
    LogToUncategorized,     // start a timer with no project
}
```

## 3. Matching algorithm

```
fn match(snapshot, rules) -> MatchOutcome:
    for rule in rules.sorted_by(priority).filter(|r| r.enabled):
        if rule.evaluate(snapshot):
            return MatchOutcome::Match(rule)
    return MatchOutcome::NoMatch
```

A rule evaluates by reducing its conditions through its combinator:

```
fn evaluate(rule, snap) -> bool:
    let results = rule.conditions.iter().map(|c| c.test(snap));
    match rule.combinator:
        All       => results.all(),
        Any       => results.any(),
        Custom(e) => e.eval(results),
```

A condition tests a signal value through its op. For signals with no current value (e.g. no browser focused, no git repo), the condition is `false` unless explicitly negated.

## 4. Ambiguity & confidence

Matches go through one more gate before action:

- **Strict + match** → auto-start timer (`Action::start`). User can stop or change.
- **Suggestive + match** → post `Event::Suggestion(rule, snapshot)` to the UI. UI shows the suggestion banner. On confirm: `Action::start`. On dismiss: snooze this rule for 5 min.
- **No match** → check the snapshot against the global exclusion list. If excluded, drop. Otherwise post `Event::Uncategorized(snapshot)` only if `on_no_match: PromptCommandPalette` is set globally.

If **multiple rules match** simultaneously, the highest-priority rule wins. (We don't merge actions. If you want a tag added on top of another rule's project, model it as a single rule with `Combinator::All`.)

## 5. Confidence heuristics

When a rule's `confidence: Strict` and it has fewer than 2 conditions OR all conditions are `Op::Contains`, surface a warning in the rule editor: *"This rule may auto-start aggressively. Consider switching to Suggestive."*

## 6. Snooze

A dismissed suggestion suppresses the *same rule* for `SNOOZE_DURATION` (default 5 min). The user can change this in Settings → Detection.

## 7. Test bench

In the Rules view (heavy complexity), a "Test bench" lets the user enter signal values manually and see which rule matches and what action it would take. This shares the same `evaluate` codepath as the live engine.

## 8. Privacy guarantees on signals

- Signals are never persisted by default. They are evaluated in memory, the matching rule's action is applied to a new time entry, and the snapshot is dropped.
- The exclusion list applies at the **collector** level, not the engine — a frontmost window matching an exclusion never produces a signal at all. This means the engine cannot accidentally log a private window even if a rule misfires.
- There is a debug-only "Capture raw signals" mode (off by default, sticky off-ed on every launch, big warning text on enable). It writes signals to `~/.cairn/debug-signals.ndjson` for troubleshooting. Disabling deletes the file.

## 9. Worked example

Snapshot at 14:48 on Thursday:

```
app.name        = "Zed"
window.title    = "rules.jsx — cairn"
ide.folder      = "~/code/cairn"
git.branch      = "feat/rules-ui"
git.repo        = "github.com/cairn-app/cairn"
browser.domain  = null
calendar.event  = []
idle            = Active
```

Rules in priority order:

1. **Cairn dev work** — `ide.folder contains "cairn"` → project `cairn`, tags `[dev]` · Suggestive
2. **Feature branch → tags** — `git.branch starts-with "feat/"` → tags `[feature]` · Suggestive
3. **ACME work** — `(ide.folder contains "acme-web") OR (browser.domain equals "acme.atlassian.net")` → project `acme` · Strict
4. **Calendar meetings** — `calendar.event is-active` → project `meetings` · Strict

Evaluation: rule 1 matches first. Engine posts a suggestion. The banner reads:

> Working on **Cairn** — *Rule preview UI*?
> because `feat/rules-ui` · folder `~/code/cairn`

User presses `↵` → timer starts with project=Cairn, tags=[dev]. (Rule 2's tags would only be applied if the user wanted both rules merged — model that as one rule with All-combinator `ide.folder contains cairn` AND `git.branch starts-with feat/`.)
