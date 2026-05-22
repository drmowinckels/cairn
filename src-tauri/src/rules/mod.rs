//! Rules engine. Pure functions over a `SignalSnapshot` — no DB access,
//! no IO. See `docs/RULES_ENGINE.md` for the data model.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SignalSnapshot {
    pub ide_folder: Option<String>,
    pub git_branch: Option<String>,
    pub window_title: Option<String>,
    pub app_name: Option<String>,
    pub browser_domain: Option<String>,
    pub calendar_event: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "signal", rename_all = "kebab-case")]
pub enum Condition {
    #[serde(rename = "ide.folder")]    IdeFolder    { op: Op, value: String, #[serde(default)] any: bool },
    #[serde(rename = "git.branch")]    GitBranch    { op: Op, value: String, #[serde(default)] any: bool },
    #[serde(rename = "window.title")]  WindowTitle  { op: Op, value: String, #[serde(default)] any: bool },
    #[serde(rename = "app.name")]      AppName      { op: Op, value: String, #[serde(default)] any: bool },
    #[serde(rename = "browser.domain")] BrowserDomain { op: Op, value: String, #[serde(default)] any: bool },
    #[serde(rename = "calendar.event")] CalendarEvent { op: Op, value: String, #[serde(default)] any: bool },
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
    let (target, op, value) = match c {
        Condition::IdeFolder { op, value, .. } => (snap.ide_folder.as_deref(), op, value),
        Condition::GitBranch { op, value, .. } => (snap.git_branch.as_deref(), op, value),
        Condition::WindowTitle { op, value, .. } => (snap.window_title.as_deref(), op, value),
        Condition::AppName { op, value, .. } => (snap.app_name.as_deref(), op, value),
        Condition::BrowserDomain { op, value, .. } => (snap.browser_domain.as_deref(), op, value),
        Condition::CalendarEvent { op, value, .. } => (snap.calendar_event.as_deref(), op, value),
    };
    let Some(target) = target else { return false };
    match op {
        Op::Contains => target.contains(value),
        Op::Equals => target == value,
        Op::StartsWith => target.starts_with(value),
        Op::EndsWith => target.ends_with(value),
        Op::Matches => regex_matches(target, value),
        Op::IsActive => !target.is_empty(),
    }
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
            calendar_event: None,
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
            then: RuleAction { project: Some("cairn".into()), tags: vec![], tags_from_calendar: false },
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
                Condition::IdeFolder    { op: Op::Contains, value: "acme-web".into(),         any: true },
                Condition::BrowserDomain { op: Op::Equals,   value: "acme.atlassian.net".into(), any: true },
            ],
            then: RuleAction { project: Some("acme".into()), tags: vec![], tags_from_calendar: false },
        };
        let mut s = snap();
        s.ide_folder = None;
        s.browser_domain = Some("acme.atlassian.net".into());
        assert!(evaluate(std::iter::once(&rule), &s).is_some());
    }
}
