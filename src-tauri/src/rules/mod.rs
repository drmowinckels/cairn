//! Rules engine. Pure functions over a `SignalSnapshot` — no DB access,
//! no IO. See `docs/RULES_ENGINE.md` for the data model.
//!
//! The engine ships ahead of its consumers (the snapshot stream that
//! drives it lands in M1). `#![allow(dead_code)]` keeps `cargo clippy
//! --all-targets -- -D warnings` happy until the wiring lands; remove
//! it the moment a non-test caller exists.
#![allow(dead_code)]

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

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "kebab-case")]
pub enum Confidence {
    /// Default. A match posts an `Event::Suggestion` to the UI; the
    /// user confirms before a timer starts. See
    /// `docs/RULES_ENGINE.md` §4.
    #[default]
    Suggestive,
    /// A match auto-starts the timer with no UI prompt. The user can
    /// still stop or change it after. Reserved for rules the user
    /// trusts enough not to need a confirmation step.
    Strict,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Rule {
    pub id: String,
    pub name: String,
    pub enabled: bool,
    pub priority: i64,
    /// `Suggestive` (default) or `Strict`. See `docs/RULES_ENGINE.md`
    /// §4. New rules default to Suggestive so a matching rule never
    /// starts a timer behind the user's back unless they opt in.
    #[serde(default)]
    pub confidence: Confidence,
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
#[serde(rename_all = "camelCase")]
pub struct RuleMatch {
    pub rule_id: String,
    pub rule_name: String,
    pub confidence: Confidence,
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
                rule_name: rule.name.clone(),
                confidence: rule.confidence,
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
            confidence: Confidence::Suggestive,
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
            confidence: Confidence::Suggestive,
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
            confidence: Confidence::Suggestive,
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

    fn rule_with(id: &str, project: &str, conds: Vec<Condition>) -> Rule {
        Rule {
            id: id.into(),
            name: id.into(),
            enabled: true,
            priority: 0,
            confidence: Confidence::Suggestive,
            when: conds,
            then: RuleAction {
                project: Some(project.into()),
                tags: vec![],
                tags_from_calendar: false,
            },
        }
    }

    #[test]
    fn empty_conditions_never_match() {
        let rule = rule_with("r1", "cairn", vec![]);
        assert!(evaluate(std::iter::once(&rule), &snap()).is_none());
    }

    #[test]
    fn first_match_wins_in_order() {
        let snap = snap();
        let r1 = rule_with(
            "first",
            "cairn",
            vec![Condition::IdeFolder {
                op: Op::Contains,
                value: "cairn".into(),
                any: false,
            }],
        );
        let r2 = rule_with(
            "second",
            "other",
            vec![Condition::GitBranch {
                op: Op::StartsWith,
                value: "feat/".into(),
                any: false,
            }],
        );
        let m = evaluate([&r1, &r2], &snap).unwrap();
        assert_eq!(m.rule_id, "first");
    }

    #[test]
    fn no_signal_no_match() {
        let mut s = snap();
        s.ide_folder = None;
        let rule = rule_with(
            "r1",
            "cairn",
            vec![Condition::IdeFolder {
                op: Op::Contains,
                value: "cairn".into(),
                any: false,
            }],
        );
        assert!(evaluate(std::iter::once(&rule), &s).is_none());
    }

    #[test]
    fn op_starts_with_and_ends_with() {
        let snap = snap();
        let starts = rule_with(
            "s",
            "p",
            vec![Condition::GitBranch {
                op: Op::StartsWith,
                value: "feat/".into(),
                any: false,
            }],
        );
        let ends = rule_with(
            "e",
            "p",
            vec![Condition::WindowTitle {
                op: Op::EndsWith,
                value: "cairn".into(),
                any: false,
            }],
        );
        assert!(evaluate(std::iter::once(&starts), &snap).is_some());
        assert!(evaluate(std::iter::once(&ends), &snap).is_some());
    }

    #[test]
    fn op_equals_is_exact() {
        let mut s = snap();
        s.app_name = Some("Zed".into());
        let exact = rule_with(
            "x",
            "p",
            vec![Condition::AppName {
                op: Op::Equals,
                value: "Zed".into(),
                any: false,
            }],
        );
        let off = rule_with(
            "off",
            "p",
            vec![Condition::AppName {
                op: Op::Equals,
                value: "zed".into(), // wrong case
                any: false,
            }],
        );
        assert!(evaluate(std::iter::once(&exact), &s).is_some());
        assert!(evaluate(std::iter::once(&off), &s).is_none());
    }

    #[test]
    fn all_conditions_must_match_when_no_any_flag() {
        let mut s = snap();
        s.git_branch = Some("main".into()); // does not start with feat/
        let rule = rule_with(
            "r",
            "cairn",
            vec![
                Condition::IdeFolder {
                    op: Op::Contains,
                    value: "cairn".into(),
                    any: false,
                },
                Condition::GitBranch {
                    op: Op::StartsWith,
                    value: "feat/".into(),
                    any: false,
                },
            ],
        );
        // ide matches, git doesn't → rule fails
        assert!(evaluate(std::iter::once(&rule), &s).is_none());

        // both match → rule fires
        s.git_branch = Some("feat/x".into());
        assert!(evaluate(std::iter::once(&rule), &s).is_some());
    }

    #[test]
    fn any_group_with_all_anchor_requires_anchor_too() {
        // RULES_ENGINE.md §3: when conditions mix `any: false` (anchor) with
        // `any: true` (alternatives), the anchor MUST match and at least one
        // alternative must match.
        let mut s = snap();
        s.ide_folder = Some("~/code/cairn".into());
        s.git_branch = None;
        s.browser_domain = None;

        let rule = rule_with(
            "r",
            "cairn",
            vec![
                Condition::IdeFolder {
                    op: Op::Contains,
                    value: "cairn".into(),
                    any: false, // anchor
                },
                Condition::GitBranch {
                    op: Op::StartsWith,
                    value: "feat/".into(),
                    any: true, // alt
                },
                Condition::BrowserDomain {
                    op: Op::Equals,
                    value: "github.com".into(),
                    any: true, // alt
                },
            ],
        );
        // anchor matches, no alt does → no match
        assert!(evaluate(std::iter::once(&rule), &s).is_none());

        // anchor + one alt matches
        s.git_branch = Some("feat/x".into());
        assert!(evaluate(std::iter::once(&rule), &s).is_some());
    }

    #[test]
    fn match_returns_rule_id_project_and_tags() {
        let rule = Rule {
            id: "tagged".into(),
            name: "tagged".into(),
            enabled: true,
            priority: 0,
            confidence: Confidence::Suggestive,
            when: vec![Condition::IdeFolder {
                op: Op::Contains,
                value: "cairn".into(),
                any: false,
            }],
            then: RuleAction {
                project: Some("cairn".into()),
                tags: vec!["dev".into(), "rules".into()],
                tags_from_calendar: false,
            },
        };
        let m = evaluate(std::iter::once(&rule), &snap()).unwrap();
        assert_eq!(m.rule_id, "tagged");
        assert_eq!(m.project.as_deref(), Some("cairn"));
        assert_eq!(m.tags, vec!["dev", "rules"]);
    }

    #[test]
    fn matches_op_is_currently_a_no_op() {
        // The `Matches` op is intentionally unimplemented until a regex
        // crate is picked. Pin the behavior so an accidental wire-up
        // surfaces here.
        let rule = rule_with(
            "r",
            "p",
            vec![Condition::IdeFolder {
                op: Op::Matches,
                value: "^cairn$".into(),
                any: false,
            }],
        );
        assert!(evaluate(std::iter::once(&rule), &snap()).is_none());
    }

    #[test]
    fn rule_json_roundtrip_kebab_case() {
        let body = serde_json::json!({
            "id": "r1",
            "name": "Cairn",
            "enabled": true,
            "priority": 0,
            "when": [
                {"signal": "ide.folder", "op": "contains", "value": "cairn"}
            ],
            "then": {"project": "cairn", "tags": ["dev"]}
        });
        let rule: Rule = serde_json::from_value(body.clone()).unwrap();
        assert_eq!(rule.name, "Cairn");
        assert_eq!(rule.then.tags, vec!["dev".to_string()]);

        let reserialized = serde_json::to_value(&rule).unwrap();
        assert_eq!(reserialized["when"][0]["signal"], "ide.folder");
        assert_eq!(reserialized["when"][0]["op"], "contains");
    }

    #[test]
    fn calendar_is_active_matches_when_any_event_present() {
        let rule = Rule {
            id: "r1".into(),
            name: "Meetings".into(),
            enabled: true,
            priority: 0,
            confidence: Confidence::Suggestive,
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
            evaluate(std::iter::once(&rule), &s)
                .unwrap()
                .project
                .as_deref(),
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
            confidence: Confidence::Suggestive,
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
