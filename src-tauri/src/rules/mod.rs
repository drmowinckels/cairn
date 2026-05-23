//! Rules engine. Pure functions over a `SignalSnapshot` — no DB access,
//! no IO. See `docs/RULES_ENGINE.md` for the data model.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SignalSnapshot {
    pub ide_folder: Option<String>,
    pub git_branch: Option<String>,
    pub window_title: Option<String>,
    pub app_name: Option<String>,
    pub browser_domain: Option<String>,
    /// Calendar events active at the snapshot timestamp. A user can be
    /// in zero, one, or many concurrent events (overlapping meetings,
    /// an all-day "OOO" event + a stand-up, etc.); the rules engine
    /// matches `calendar.event` conditions against this whole list.
    #[serde(default)]
    pub calendar: Vec<CalendarEvent>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CalendarEvent {
    pub title: String,
    pub source_label: String,
    #[serde(default)]
    pub attendees: Vec<String>,
    #[serde(default)]
    pub all_day: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "signal", rename_all = "kebab-case")]
pub enum Condition {
    #[serde(rename = "ide.folder")]
    IdeFolder {
        op: Op,
        value: String,
        #[serde(default)]
        any: bool,
    },
    #[serde(rename = "git.branch")]
    GitBranch {
        op: Op,
        value: String,
        #[serde(default)]
        any: bool,
    },
    #[serde(rename = "window.title")]
    WindowTitle {
        op: Op,
        value: String,
        #[serde(default)]
        any: bool,
    },
    #[serde(rename = "app.name")]
    AppName {
        op: Op,
        value: String,
        #[serde(default)]
        any: bool,
    },
    #[serde(rename = "browser.domain")]
    BrowserDomain {
        op: Op,
        value: String,
        #[serde(default)]
        any: bool,
    },
    #[serde(rename = "calendar.event")]
    CalendarEvent {
        op: Op,
        value: String,
        #[serde(default)]
        any: bool,
    },
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Op {
    Contains,
    Equals,
    StartsWith,
    EndsWith,
    Matches,
    IsActive,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Rule {
    pub id: String,
    pub name: String,
    pub enabled: bool,
    pub priority: i64,
    pub when: Vec<Condition>,
    pub then: RuleAction,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RuleAction {
    pub project: Option<String>,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub tags_from_calendar: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RuleMatch {
    pub rule_id: String,
    pub project: Option<String>,
    pub tags: Vec<String>,
}

pub fn evaluate<'a, I>(rules: I, snapshot: &SignalSnapshot) -> Option<RuleMatch>
where
    I: IntoIterator<Item = &'a Rule>,
{
    for rule in rules {
        if !rule.enabled {
            continue;
        }
        if matches(rule, snapshot) {
            return Some(RuleMatch {
                rule_id: rule.id.clone(),
                project: rule.then.project.clone(),
                tags: rule.then.tags.clone(),
            });
        }
    }
    None
}

fn matches(rule: &Rule, snap: &SignalSnapshot) -> bool {
    if rule.when.is_empty() {
        return false;
    }
    let (any_conds, all_conds): (Vec<_>, Vec<_>) =
        rule.when.iter().partition(|c| condition_is_any(c));

    let all_ok = all_conds.iter().all(|c| condition_matches(c, snap));
    if !all_ok {
        return false;
    }
    if any_conds.is_empty() {
        return true;
    }
    any_conds.iter().any(|c| condition_matches(c, snap))
}

fn condition_is_any(c: &Condition) -> bool {
    match c {
        Condition::IdeFolder { any, .. }
        | Condition::GitBranch { any, .. }
        | Condition::WindowTitle { any, .. }
        | Condition::AppName { any, .. }
        | Condition::BrowserDomain { any, .. }
        | Condition::CalendarEvent { any, .. } => *any,
    }
}

fn condition_matches(c: &Condition, snap: &SignalSnapshot) -> bool {
    match c {
        Condition::CalendarEvent { op, value, .. } => calendar_condition_matches(op, value, snap),
        _ => {
            let (target, op, value) = match c {
                Condition::IdeFolder { op, value, .. } => (snap.ide_folder.as_deref(), op, value),
                Condition::GitBranch { op, value, .. } => (snap.git_branch.as_deref(), op, value),
                Condition::WindowTitle { op, value, .. } => {
                    (snap.window_title.as_deref(), op, value)
                }
                Condition::AppName { op, value, .. } => (snap.app_name.as_deref(), op, value),
                Condition::BrowserDomain { op, value, .. } => {
                    (snap.browser_domain.as_deref(), op, value)
                }
                Condition::CalendarEvent { .. } => unreachable!("handled above"),
            };
            let Some(target) = target else { return false };
            scalar_op_matches(op, target, value)
        }
    }
}

fn scalar_op_matches(op: &Op, target: &str, value: &str) -> bool {
    match op {
        Op::Contains => target.contains(value),
        Op::Equals => target == value,
        Op::StartsWith => target.starts_with(value),
        Op::EndsWith => target.ends_with(value),
        Op::Matches => regex_matches(target, value),
        Op::IsActive => !target.is_empty(),
    }
}

/// `calendar.event` matches if **any** currently-active event satisfies
/// the op against its title. `Op::IsActive` ignores the value and is
/// true whenever there is any active event — useful for "I'm in a
/// meeting, log to project=meetings" style rules.
fn calendar_condition_matches(op: &Op, value: &str, snap: &SignalSnapshot) -> bool {
    if matches!(op, Op::IsActive) {
        return !snap.calendar.is_empty();
    }
    snap.calendar
        .iter()
        .any(|ev| scalar_op_matches(op, &ev.title, value))
}

fn regex_matches(_target: &str, _pattern: &str) -> bool {
    // Regex matching is intentionally deferred until we pick a crate
    // (`regex` vs `fancy-regex`) — `contains` is the safe default
    // when a user writes a `matches` op in the prototype data.
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    fn snap() -> SignalSnapshot {
        SignalSnapshot {
            ide_folder: Some("~/code/cairn".into()),
            git_branch: Some("feat/rules-ui".into()),
            window_title: Some("rules.rs — cairn".into()),
            app_name: Some("Zed".into()),
            browser_domain: None,
            calendar: vec![],
        }
    }

    fn event(title: &str) -> CalendarEvent {
        CalendarEvent {
            title: title.into(),
            source_label: "Work".into(),
            attendees: vec![],
            all_day: false,
        }
    }

    #[test]
    fn single_contains_matches() {
        let rule = Rule {
            id: "r1".into(),
            name: "Cairn".into(),
            enabled: true,
            priority: 0,
            when: vec![Condition::IdeFolder {
                op: Op::Contains,
                value: "cairn".into(),
                any: false,
            }],
            then: RuleAction {
                project: Some("cairn".into()),
                tags: vec![],
                tags_from_calendar: false,
            },
        };
        let m = evaluate(std::iter::once(&rule), &snap()).unwrap();
        assert_eq!(m.project.as_deref(), Some("cairn"));
    }

    #[test]
    fn disabled_rule_is_skipped() {
        let rule = Rule {
            id: "r1".into(),
            name: "Disabled".into(),
            enabled: false,
            priority: 0,
            when: vec![Condition::IdeFolder {
                op: Op::Contains,
                value: "cairn".into(),
                any: false,
            }],
            then: RuleAction {
                project: Some("cairn".into()),
                tags: vec![],
                tags_from_calendar: false,
            },
        };
        assert!(evaluate(std::iter::once(&rule), &snap()).is_none());
    }

    #[test]
    fn any_group_matches_when_one_holds() {
        let rule = Rule {
            id: "r1".into(),
            name: "ACME".into(),
            enabled: true,
            priority: 0,
            when: vec![
                Condition::IdeFolder {
                    op: Op::Contains,
                    value: "acme-web".into(),
                    any: true,
                },
                Condition::BrowserDomain {
                    op: Op::Equals,
                    value: "acme.atlassian.net".into(),
                    any: true,
                },
            ],
            then: RuleAction {
                project: Some("acme".into()),
                tags: vec![],
                tags_from_calendar: false,
            },
        };
        let mut s = snap();
        s.ide_folder = None;
        s.browser_domain = Some("acme.atlassian.net".into());
        assert!(evaluate(std::iter::once(&rule), &s).is_some());
    }

    #[test]
    fn calendar_is_active_matches_when_any_event_present() {
        let rule = Rule {
            id: "r1".into(),
            name: "Meetings".into(),
            enabled: true,
            priority: 0,
            when: vec![Condition::CalendarEvent {
                op: Op::IsActive,
                value: String::new(),
                any: false,
            }],
            then: RuleAction {
                project: Some("meetings".into()),
                tags: vec![],
                tags_from_calendar: true,
            },
        };
        let mut s = snap();
        assert!(evaluate(std::iter::once(&rule), &s).is_none());
        s.calendar = vec![event("Stand-up")];
        assert_eq!(
            evaluate(std::iter::once(&rule), &s).unwrap().project.as_deref(),
            Some("meetings"),
        );
    }

    #[test]
    fn calendar_contains_matches_any_concurrent_event() {
        let rule = Rule {
            id: "r1".into(),
            name: "1-on-1 with Alice".into(),
            enabled: true,
            priority: 0,
            when: vec![Condition::CalendarEvent {
                op: Op::Contains,
                value: "Alice".into(),
                any: false,
            }],
            then: RuleAction {
                project: Some("mgmt".into()),
                tags: vec![],
                tags_from_calendar: false,
            },
        };
        let mut s = snap();
        // Two overlapping events: an all-day OOO + a 1:1. Only the 1:1
        // mentions Alice; the rule should still fire.
        s.calendar = vec![event("OOO: vacation"), event("1:1 Alice")];
        assert!(evaluate(std::iter::once(&rule), &s).is_some());
    }
}
