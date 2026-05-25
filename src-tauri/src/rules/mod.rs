//! Rules engine. Pure functions over a `SignalSnapshot` — no DB access,
//! no IO. See `docs/RULES_ENGINE.md` for the data model.
//!
//! The engine ships ahead of its consumers (the snapshot stream that
//! drives it lands in M1). `#![allow(dead_code)]` keeps `cargo clippy
//! --all-targets -- -D warnings` happy until the wiring lands; remove
//! it the moment a non-test caller exists.
#![allow(dead_code)]

use serde::{Deserialize, Serialize};

pub mod snoozer;
pub use snoozer::{SnoozeSnapshot, Snoozer};

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
#[serde(rename_all = "camelCase")]
pub struct RuleAction {
    pub project: Option<String>,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub tags_from_calendar: bool,
    /// Optional description template applied to the started entry's
    /// task field. Supported placeholders:
    /// - `{calendar.event}` → matched event's title
    ///
    /// Per M1 #10. Empty template ≡ no template ≡ entry description
    /// stays empty (or whatever the user later types).
    #[serde(default)]
    pub description_template: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuleMatch {
    pub rule_id: String,
    pub rule_name: String,
    pub confidence: Confidence,
    pub project: Option<String>,
    pub tags: Vec<String>,
    /// Pre-substituted description (template placeholders already
    /// resolved against the matching snapshot). Empty string when
    /// the rule has no `description_template`.
    pub description: String,
}

pub fn evaluate<'a, I>(rules: I, snapshot: &SignalSnapshot) -> Option<RuleMatch>
where
    I: IntoIterator<Item = &'a Rule>,
{
    evaluate_full(rules, snapshot, None, None, chrono::Utc::now())
}

/// Same as `evaluate` but with snooze-gating. Rules that are
/// currently snoozed (per-rule or globally) are skipped. The fanout
/// passes a `Some(snoozer)` so the live evaluate path respects
/// dismissed suggestions; tests that don't care about snooze pass
/// `None` to keep the call site terse.
///
/// `now` is taken as a parameter so tests can pin a deterministic
/// time without monkey-patching `Utc::now()`.
pub fn evaluate_with_snoozer<'a, I>(
    rules: I,
    snapshot: &SignalSnapshot,
    snoozer: Option<&mut Snoozer>,
    now: chrono::DateTime<chrono::Utc>,
) -> Option<RuleMatch>
where
    I: IntoIterator<Item = &'a Rule>,
{
    evaluate_full(rules, snapshot, snoozer, None, now)
}

/// Trait for any opaque attendee-email exclusion check the matcher
/// can consult before adding `tags_from_calendar` entries.
///
/// Defined as a trait (rather than passing `&ExclusionMatcher`
/// directly) so the `rules` module stays free of a `signals` import
/// — the matcher remains a pure-state module with no IO or cross-
/// module coupling. The fanout supplies an adapter that delegates
/// to `signals::exclusions::ExclusionMatcher::matches_domain`.
pub trait AttendeeExclusionCheck {
    /// True iff this attendee should be dropped from
    /// `RuleMatch.tags`. Implementations typically extract the
    /// email's domain part and consult an exclusion list.
    fn attendee_is_excluded(&self, attendee: &str) -> bool;
}

/// Full evaluate path — superset of `evaluate` + `evaluate_with_snoozer`
/// that also accepts an `AttendeeExclusionCheck`. The fanout uses
/// this signature in production so attendee emails added via
/// `tags_from_calendar` are filtered through the user's exclusion
/// list before reaching `RuleMatch.tags`.
pub fn evaluate_full<'a, I>(
    rules: I,
    snapshot: &SignalSnapshot,
    snoozer: Option<&mut Snoozer>,
    attendee_filter: Option<&dyn AttendeeExclusionCheck>,
    now: chrono::DateTime<chrono::Utc>,
) -> Option<RuleMatch>
where
    I: IntoIterator<Item = &'a Rule>,
{
    let mut snoozer = snoozer;
    for rule in rules {
        if !rule.enabled {
            continue;
        }
        if let Some(s) = snoozer.as_deref_mut() {
            if s.is_snoozed(&rule.id, now) {
                continue;
            }
        }
        if matches(rule, snapshot) {
            // Find the first active calendar event that satisfies
            // any `calendar.event` condition on the rule — used for
            // template substitution + attendee tagging. `None` when
            // the rule has no calendar.event condition or no event
            // is active.
            let matched_event = first_matching_calendar_event(rule, snapshot);

            // Resolve description: substitute `{calendar.event}` with
            // the matched event's title when a template is present.
            let description = rule
                .then
                .description_template
                .as_deref()
                .map(|tpl| resolve_description_template(tpl, matched_event))
                .unwrap_or_default();

            // Tags: start from the rule's static tags; if
            // `tags_from_calendar` is set AND an event matched,
            // append the event's attendees. Two privacy gates
            // apply before an attendee enters `tags`:
            // 1. The user's exclusion list (`attendee_filter`)
            //    drops attendees whose email domain matches a
            //    `domain` exclusion — same opt-out as the browser
            //    collector uses. Without this, an attendee on a
            //    privacy-sensitive address would persist as a tag
            //    just because the calendar invite includes them.
            // 2. De-dup against the static tag list so repeated
            //    matches don't accumulate duplicates.
            let mut tags = rule.then.tags.clone();
            if rule.then.tags_from_calendar {
                if let Some(ev) = matched_event {
                    for a in &ev.attendees {
                        if let Some(filter) = attendee_filter {
                            if filter.attendee_is_excluded(a) {
                                continue;
                            }
                        }
                        if !tags.contains(a) {
                            tags.push(a.clone());
                        }
                    }
                }
            }

            return Some(RuleMatch {
                rule_id: rule.id.clone(),
                rule_name: rule.name.clone(),
                confidence: rule.confidence,
                project: rule.then.project.clone(),
                tags,
                description,
            });
        }
    }
    None
}

/// Return the first active calendar event in `snap` that satisfies
/// any `calendar.event` condition on `rule`. If the rule has no
/// `calendar.event` condition at all, returns `None` — the matcher
/// uses this only for enrichment, not for membership.
fn first_matching_calendar_event<'a>(
    rule: &Rule,
    snap: &'a SignalSnapshot,
) -> Option<&'a CalendarEvent> {
    let cal_conds: Vec<&Condition> = rule
        .when
        .iter()
        .filter(|c| matches!(c, Condition::CalendarEvent { .. }))
        .collect();
    if cal_conds.is_empty() {
        return None;
    }
    snap.calendar.iter().find(|ev| {
        cal_conds.iter().all(|c| {
            let Condition::CalendarEvent { op, value, .. } = c else {
                return false;
            };
            if matches!(op, Op::IsActive) {
                return true;
            }
            scalar_op_matches(op, &ev.title, value)
        })
    })
}

/// Substitute supported placeholders in a description template.
///
/// Currently supported: `{calendar.event}` → matched event's title
/// (or empty string when no event matched).
///
/// Escape rules (same shape as `str::format` / Python's `.format`):
/// - `{{` → literal `{`
/// - `}}` → literal `}`
///
/// So `{{calendar.event}}` (= `{{` + `calendar.event` + `}}`)
/// emits the literal text `{calendar.event}` rather than
/// substituting. Unknown placeholders are emitted verbatim so a
/// user typo is visible rather than silently dropped.
fn resolve_description_template(tpl: &str, matched_event: Option<&CalendarEvent>) -> String {
    let event_title = matched_event.map(|e| e.title.as_str()).unwrap_or("");
    let mut out = String::with_capacity(tpl.len());
    let bytes = tpl.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'{' if i + 1 < bytes.len() && bytes[i + 1] == b'{' => {
                // `{{` → literal `{`
                out.push('{');
                i += 2;
            }
            b'}' if i + 1 < bytes.len() && bytes[i + 1] == b'}' => {
                // `}}` → literal `}`
                out.push('}');
                i += 2;
            }
            b'{' => {
                // Placeholder. Find the matching `}`. Search in
                // the remaining string so we get a byte offset
                // relative to `tpl`.
                let rest = &tpl[i + 1..];
                match rest.find('}') {
                    Some(close_offset) => {
                        let key = &rest[..close_offset];
                        match key {
                            "calendar.event" => out.push_str(event_title),
                            _ => {
                                // Unknown placeholder — passthrough
                                // literally so typos are visible.
                                out.push('{');
                                out.push_str(key);
                                out.push('}');
                            }
                        }
                        i += 1 + close_offset + 1;
                    }
                    None => {
                        // Unterminated placeholder — emit the
                        // remainder verbatim.
                        out.push_str(&tpl[i..]);
                        break;
                    }
                }
            }
            _ => {
                // ASCII path stays simple; for non-ASCII bytes
                // we still advance one byte at a time which is
                // safe because UTF-8 continuation bytes never
                // collide with `{` / `}` (0x7B / 0x7D are pure
                // ASCII).
                // Copy the next UTF-8 character to preserve
                // multibyte sequences intact.
                let ch_start = i;
                // Find the next char boundary in the original str.
                let next = tpl[ch_start..]
                    .chars()
                    .next()
                    .map(|c| ch_start + c.len_utf8())
                    .unwrap_or(ch_start + 1);
                out.push_str(&tpl[ch_start..next]);
                i = next;
            }
        }
    }
    out
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

    #[test]
    fn confidence_serialises_to_kebab_case() {
        // Pins the wire format that the TS `Confidence` type relies
        // on. If a future variant gets added (e.g. `StrictWithWarning`),
        // this test will fail with the new kebab-case form so the TS
        // side knows to update.
        assert_eq!(
            serde_json::to_string(&Confidence::Suggestive).unwrap(),
            "\"suggestive\""
        );
        assert_eq!(
            serde_json::to_string(&Confidence::Strict).unwrap(),
            "\"strict\""
        );
    }

    #[test]
    fn confidence_default_is_suggestive() {
        // The privacy guarantee: a new rule never auto-starts a
        // timer unless the user explicitly opts into Strict. Default
        // is Suggestive — pin that.
        assert_eq!(Confidence::default(), Confidence::Suggestive);
    }

    #[test]
    fn evaluate_with_snoozer_skips_snoozed_rules() {
        let rule = Rule {
            id: "r-snoozed".into(),
            name: "Snoozed".into(),
            enabled: true,
            priority: 0,
            confidence: Confidence::Suggestive,
            when: vec![Condition::AppName {
                op: Op::Equals,
                value: "Zed".into(),
                any: false,
            }],
            then: RuleAction {
                project: Some("cairn".into()),
                tags: vec![],
                tags_from_calendar: false,
                description_template: None,
            },
        };
        let snap_v = snap();
        let now = chrono::Utc::now();
        let mut snoozer = Snoozer::new();
        snoozer.snooze_rule("r-snoozed", chrono::Duration::seconds(3600), now);
        // Without snoozer: rule fires.
        assert!(evaluate([&rule], &snap_v).is_some());
        // With snoozer: rule is skipped.
        assert!(
            evaluate_with_snoozer([&rule], &snap_v, Some(&mut snoozer), now).is_none(),
            "snoozed rule must be skipped"
        );
        // After the snooze window expires, the rule fires again.
        let later = now + chrono::Duration::seconds(7200);
        assert!(evaluate_with_snoozer([&rule], &snap_v, Some(&mut snoozer), later).is_some());
    }

    #[test]
    fn evaluate_with_snoozer_global_silences_all_rules() {
        let r1 = Rule {
            id: "r1".into(),
            name: "A".into(),
            enabled: true,
            priority: 0,
            confidence: Confidence::Suggestive,
            when: vec![Condition::AppName {
                op: Op::Equals,
                value: "Zed".into(),
                any: false,
            }],
            then: RuleAction {
                project: Some("cairn".into()),
                tags: vec![],
                tags_from_calendar: false,
                description_template: None,
            },
        };
        let r2 = Rule {
            id: "r2".into(),
            name: "B".into(),
            enabled: true,
            priority: 1,
            confidence: Confidence::Suggestive,
            when: vec![Condition::AppName {
                op: Op::Equals,
                value: "Zed".into(),
                any: false,
            }],
            then: RuleAction {
                project: Some("other".into()),
                tags: vec![],
                tags_from_calendar: false,
                description_template: None,
            },
        };
        let snap_v = snap();
        let now = chrono::Utc::now();
        let mut snoozer = Snoozer::new();
        snoozer.snooze_all(chrono::Duration::seconds(3600), now);
        assert!(
            evaluate_with_snoozer([&r1, &r2], &snap_v, Some(&mut snoozer), now).is_none(),
            "snooze_all must silence every rule"
        );
    }

    #[test]
    fn description_template_substitutes_calendar_event_title() {
        // Rule with template + calendar.event condition. When an
        // active event matches, the description should be the
        // template with `{calendar.event}` replaced by the
        // event's title.
        let rule = Rule {
            id: "r-cal".into(),
            name: "Meetings".into(),
            enabled: true,
            priority: 0,
            confidence: Confidence::Strict,
            when: vec![Condition::CalendarEvent {
                op: Op::IsActive,
                value: String::new(),
                any: false,
            }],
            then: RuleAction {
                project: Some("meetings".into()),
                tags: vec![],
                tags_from_calendar: false,
                description_template: Some("Meeting: {calendar.event}".into()),
            },
        };
        let mut s = snap();
        s.calendar = vec![event("Stand-up")];
        let m = evaluate(std::iter::once(&rule), &s).unwrap();
        assert_eq!(m.description, "Meeting: Stand-up");
    }

    #[test]
    fn description_template_passes_through_when_no_placeholder() {
        // Template without `{calendar.event}` is emitted verbatim
        // — the user can pin a static description on every rule
        // match.
        let rule = Rule {
            id: "r1".into(),
            name: "x".into(),
            enabled: true,
            priority: 0,
            confidence: Confidence::Strict,
            when: vec![Condition::AppName {
                op: Op::Equals,
                value: "Zed".into(),
                any: false,
            }],
            then: RuleAction {
                project: Some("cairn".into()),
                tags: vec![],
                tags_from_calendar: false,
                description_template: Some("Daily sync".into()),
            },
        };
        let s = snap();
        let m = evaluate(std::iter::once(&rule), &s).unwrap();
        assert_eq!(m.description, "Daily sync");
    }

    #[test]
    fn description_template_double_brace_escapes_literal() {
        // `{{calendar.event}}` → `{calendar.event}` in the output
        // — so users can describe the placeholder syntax itself.
        let rule = Rule {
            id: "r-cal".into(),
            name: "x".into(),
            enabled: true,
            priority: 0,
            confidence: Confidence::Strict,
            when: vec![Condition::CalendarEvent {
                op: Op::IsActive,
                value: String::new(),
                any: false,
            }],
            then: RuleAction {
                project: Some("meetings".into()),
                tags: vec![],
                tags_from_calendar: false,
                description_template: Some("Use {{calendar.event}} for {calendar.event}".into()),
            },
        };
        let mut s = snap();
        s.calendar = vec![event("Stand-up")];
        let m = evaluate(std::iter::once(&rule), &s).unwrap();
        assert_eq!(m.description, "Use {calendar.event} for Stand-up");
    }

    #[test]
    fn description_template_unknown_placeholder_passes_through() {
        // A typo like `{foo.bar}` is emitted literally rather than
        // silently dropped — the user sees their typo and can fix
        // it.
        let rule = Rule {
            id: "r1".into(),
            name: "x".into(),
            enabled: true,
            priority: 0,
            confidence: Confidence::Strict,
            when: vec![Condition::AppName {
                op: Op::Equals,
                value: "Zed".into(),
                any: false,
            }],
            then: RuleAction {
                project: Some("cairn".into()),
                tags: vec![],
                tags_from_calendar: false,
                description_template: Some("typo: {foo.bar}".into()),
            },
        };
        let s = snap();
        let m = evaluate(std::iter::once(&rule), &s).unwrap();
        assert_eq!(m.description, "typo: {foo.bar}");
    }

    #[test]
    fn description_template_with_empty_event_title() {
        let rule = Rule {
            id: "r-cal".into(),
            name: "x".into(),
            enabled: true,
            priority: 0,
            confidence: Confidence::Strict,
            when: vec![Condition::CalendarEvent {
                op: Op::IsActive,
                value: String::new(),
                any: false,
            }],
            then: RuleAction {
                project: Some("meetings".into()),
                tags: vec![],
                tags_from_calendar: false,
                description_template: Some("Meeting: {calendar.event}".into()),
            },
        };
        let mut s = snap();
        s.calendar = vec![CalendarEvent {
            title: "".into(),
            source_label: "Work".into(),
            attendees: vec![],
            all_day: false,
        }];
        let m = evaluate(std::iter::once(&rule), &s).unwrap();
        assert_eq!(m.description, "Meeting: ");
    }

    #[test]
    fn attendee_exclusion_filter_drops_matching_addresses() {
        // The fanout supplies an attendee filter that delegates
        // to `signals::exclusions::ExclusionMatcher::matches_attendee`.
        // Pin the matcher's contract via a synthetic
        // implementation that excludes `*@blocked.com`.
        struct DropBlockedCom;
        impl AttendeeExclusionCheck for DropBlockedCom {
            fn attendee_is_excluded(&self, attendee: &str) -> bool {
                attendee.ends_with("@blocked.com")
            }
        }

        let rule = Rule {
            id: "r-cal".into(),
            name: "x".into(),
            enabled: true,
            priority: 0,
            confidence: Confidence::Strict,
            when: vec![Condition::CalendarEvent {
                op: Op::IsActive,
                value: String::new(),
                any: false,
            }],
            then: RuleAction {
                project: Some("meetings".into()),
                tags: vec![],
                tags_from_calendar: true,
                description_template: None,
            },
        };
        let mut s = snap();
        s.calendar = vec![CalendarEvent {
            title: "Stand-up".into(),
            source_label: "Work".into(),
            attendees: vec![
                "alice@allowed.com".into(),
                "bob@blocked.com".into(),
                "carol@allowed.com".into(),
            ],
            all_day: false,
        }];
        let m = evaluate_full(
            std::iter::once(&rule),
            &s,
            None,
            Some(&DropBlockedCom),
            chrono::Utc::now(),
        )
        .unwrap();
        // bob@blocked.com is filtered; the other two pass.
        assert_eq!(
            m.tags,
            vec![
                "alice@allowed.com".to_string(),
                "carol@allowed.com".to_string()
            ]
        );
    }

    #[test]
    fn description_template_empty_string_when_no_template() {
        let rule = Rule {
            id: "r1".into(),
            name: "x".into(),
            enabled: true,
            priority: 0,
            confidence: Confidence::Strict,
            when: vec![Condition::AppName {
                op: Op::Equals,
                value: "Zed".into(),
                any: false,
            }],
            then: RuleAction {
                project: Some("cairn".into()),
                tags: vec![],
                tags_from_calendar: false,
                description_template: None,
            },
        };
        let s = snap();
        let m = evaluate(std::iter::once(&rule), &s).unwrap();
        assert_eq!(m.description, "");
    }

    #[test]
    fn tags_from_calendar_appends_attendees_when_event_matches() {
        let rule = Rule {
            id: "r-cal".into(),
            name: "Meetings".into(),
            enabled: true,
            priority: 0,
            confidence: Confidence::Strict,
            when: vec![Condition::CalendarEvent {
                op: Op::IsActive,
                value: String::new(),
                any: false,
            }],
            then: RuleAction {
                project: Some("meetings".into()),
                tags: vec!["meeting".into()],
                tags_from_calendar: true,
                description_template: None,
            },
        };
        let mut s = snap();
        s.calendar = vec![CalendarEvent {
            title: "Stand-up".into(),
            source_label: "Work".into(),
            attendees: vec!["alice@example.com".into(), "bob@example.com".into()],
            all_day: false,
        }];
        let m = evaluate(std::iter::once(&rule), &s).unwrap();
        assert_eq!(
            m.tags,
            vec![
                "meeting".to_string(),
                "alice@example.com".to_string(),
                "bob@example.com".to_string()
            ],
        );
    }

    #[test]
    fn tags_from_calendar_skipped_when_flag_off() {
        let rule = Rule {
            id: "r-cal".into(),
            name: "Meetings".into(),
            enabled: true,
            priority: 0,
            confidence: Confidence::Strict,
            when: vec![Condition::CalendarEvent {
                op: Op::IsActive,
                value: String::new(),
                any: false,
            }],
            then: RuleAction {
                project: Some("meetings".into()),
                tags: vec!["meeting".into()],
                tags_from_calendar: false,
                description_template: None,
            },
        };
        let mut s = snap();
        s.calendar = vec![CalendarEvent {
            title: "Stand-up".into(),
            source_label: "Work".into(),
            attendees: vec!["alice@example.com".into()],
            all_day: false,
        }];
        let m = evaluate(std::iter::once(&rule), &s).unwrap();
        assert_eq!(m.tags, vec!["meeting".to_string()]);
    }

    #[test]
    fn tags_from_calendar_dedupes_attendees_against_static_tags() {
        let rule = Rule {
            id: "r-cal".into(),
            name: "Meetings".into(),
            enabled: true,
            priority: 0,
            confidence: Confidence::Strict,
            when: vec![Condition::CalendarEvent {
                op: Op::IsActive,
                value: String::new(),
                any: false,
            }],
            then: RuleAction {
                project: Some("meetings".into()),
                tags: vec!["alice@example.com".into()],
                tags_from_calendar: true,
                description_template: None,
            },
        };
        let mut s = snap();
        s.calendar = vec![CalendarEvent {
            title: "Stand-up".into(),
            source_label: "Work".into(),
            attendees: vec!["alice@example.com".into(), "bob@example.com".into()],
            all_day: false,
        }];
        let m = evaluate(std::iter::once(&rule), &s).unwrap();
        assert_eq!(
            m.tags,
            vec![
                "alice@example.com".to_string(),
                "bob@example.com".to_string()
            ],
        );
    }

    #[test]
    fn rule_match_includes_confidence_from_rule() {
        let rule = Rule {
            id: "r-strict".into(),
            name: "ACME work".into(),
            enabled: true,
            priority: 0,
            confidence: Confidence::Strict,
            when: vec![Condition::AppName {
                op: Op::Equals,
                value: "Zed".into(),
                any: false,
            }],
            then: RuleAction {
                project: Some("acme".into()),
                tags: vec![],
                tags_from_calendar: false,
                description_template: None,
            },
        };
        let snap_v = snap();
        let m = evaluate([&rule], &snap_v).expect("rule fires for app=Zed");
        assert_eq!(m.confidence, Confidence::Strict);
        assert_eq!(m.rule_name, "ACME work");
    }

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
                description_template: None,
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
                description_template: None,
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
                description_template: None,
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
                description_template: None,
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
                description_template: None,
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
                description_template: None,
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
                description_template: None,
            },
        };
        let mut s = snap();
        // Two overlapping events: an all-day OOO + a 1:1. Only the 1:1
        // mentions Alice; the rule should still fire.
        s.calendar = vec![event("OOO: vacation"), event("1:1 Alice")];
        assert!(evaluate(std::iter::once(&rule), &s).is_some());
    }
}
