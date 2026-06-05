//! [todo.txt](https://github.com/todotxt/todo.txt) parser.
//!
//! One task per line. A leading `x ` marks completion; an optional
//! `(A)` priority and leading `YYYY-MM-DD` dates are stripped from the
//! label. A task's project is its first `+project` tag (all `+tags` are
//! dropped from the label, `@context` tags are kept); a task with no
//! `+project` falls into a synthetic **Inbox**.

use super::{Builder, Parsed};

const INBOX_ID: &str = "inbox";
const INBOX_NAME: &str = "Inbox";

pub(super) fn parse(content: &str) -> Parsed {
    let mut b = Builder::new();
    for raw in content.lines() {
        let line = raw.trim();
        if line.is_empty() {
            continue;
        }

        let mut tokens: Vec<&str> = line.split_whitespace().collect();
        let done = tokens.first() == Some(&"x");
        if done {
            tokens.remove(0);
        }
        if tokens.first().is_some_and(|t| is_priority(t)) {
            tokens.remove(0);
        }
        while tokens.first().is_some_and(|t| is_date(t)) {
            tokens.remove(0);
        }

        let project = tokens
            .iter()
            .find(|t| is_project_tag(t))
            .map(|t| t[1..].to_string());
        let label = tokens
            .iter()
            .filter(|t| !is_project_tag(t))
            .copied()
            .collect::<Vec<_>>()
            .join(" ");
        if label.is_empty() {
            continue;
        }

        let pid = match project {
            Some(tag) => b.project(tag.clone(), tag),
            None => b.project(INBOX_ID, INBOX_NAME),
        };
        b.task(&pid, &label, None, done);
    }
    b.finish()
}

fn is_priority(token: &str) -> bool {
    let bytes = token.as_bytes();
    bytes.len() == 3 && bytes[0] == b'(' && bytes[1].is_ascii_uppercase() && bytes[2] == b')'
}

fn is_date(token: &str) -> bool {
    let bytes = token.as_bytes();
    bytes.len() == 10
        && bytes[4] == b'-'
        && bytes[7] == b'-'
        && bytes
            .iter()
            .enumerate()
            .all(|(i, b)| matches!(i, 4 | 7) || b.is_ascii_digit())
}

fn is_project_tag(token: &str) -> bool {
    token.starts_with('+') && token.len() > 1
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn groups_by_project_tag_and_keeps_context() {
        let parsed = parse(
            "(A) 2026-01-02 Write spec +cairn @home\n\
             x 2026-01-03 2026-01-01 Ship release +cairn\n\
             Buy milk +groceries\n",
        );
        let names: Vec<_> = parsed.projects.iter().map(|p| p.name.as_str()).collect();
        assert_eq!(names, vec!["cairn", "groceries"]);

        let cairn = &parsed.tasks["cairn"];
        assert_eq!(cairn.len(), 2);
        assert_eq!(cairn[0].label, "Write spec @home");
        assert!(!cairn[0].done);
        assert_eq!(cairn[1].label, "Ship release");
        assert!(cairn[1].done, "leading `x` marks completion");

        assert_eq!(parsed.tasks["groceries"][0].label, "Buy milk");
    }

    #[test]
    fn untagged_tasks_fall_into_inbox() {
        let parsed = parse("Call the bank\nRenew passport\n");
        assert_eq!(parsed.projects.len(), 1);
        assert_eq!(parsed.projects[0].id, "inbox");
        assert_eq!(parsed.tasks["inbox"].len(), 2);
    }

    #[test]
    fn blank_lines_and_bare_project_tags_are_skipped() {
        let parsed = parse("\n   \n+cairn\nReal task +cairn\n");
        assert_eq!(
            parsed.tasks["cairn"].len(),
            1,
            "a tag-only line has no label"
        );
        assert_eq!(parsed.tasks["cairn"][0].label, "Real task");
    }
}
