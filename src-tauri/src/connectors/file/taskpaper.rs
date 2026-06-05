//! [TaskPaper](https://www.taskpaper.com/) parser.
//!
//! A line ending in `:` is a project; a line starting with `- ` is a
//! task belonging to the most recent project (hierarchy is flattened in
//! v1); anything else is a note and ignored. A task with an `@done` tag
//! is complete (the `@done` tag is stripped from the label, other `@tags`
//! are kept). Tasks before the first project fall into a synthetic
//! **Inbox**.

use super::{slug, Builder, Parsed};

const INBOX_ID: &str = "inbox";
const INBOX_NAME: &str = "Inbox";

pub(super) fn parse(content: &str) -> Parsed {
    let mut b = Builder::new();
    let mut current: Option<String> = None;
    for raw in content.lines() {
        let line = raw.trim();
        if line.is_empty() {
            continue;
        }
        if let Some(task) = line.strip_prefix("- ") {
            let (label, done) = split_done(task);
            if label.is_empty() {
                continue;
            }
            let pid = current
                .clone()
                .unwrap_or_else(|| b.project(INBOX_ID, INBOX_NAME));
            current = Some(pid.clone());
            b.task(&pid, &label, None, done);
        } else if let Some(name) = project_name(line) {
            current = Some(b.project(slug(name), name));
        }
    }
    b.finish()
}

/// The name of a project line (`Foo:`), or `None`.
fn project_name(line: &str) -> Option<&str> {
    let name = line.strip_suffix(':')?.trim();
    (!name.is_empty()).then_some(name)
}

/// Split a task body into `(label, done)`, dropping any `@done` tag.
fn split_done(task: &str) -> (String, bool) {
    let mut done = false;
    let kept: Vec<&str> = task
        .split_whitespace()
        .filter(|tok| {
            if *tok == "@done" || tok.starts_with("@done(") {
                done = true;
                false
            } else {
                true
            }
        })
        .collect();
    (kept.join(" "), done)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn projects_tasks_and_done_tags() {
        let parsed = parse(
            "Release:\n\
             \t- Cut tag @done(2026-01-02)\n\
             \t- Announce @blog\n\
             Notes here are ignored\n\
             Chores:\n\
             - Water plants @done\n",
        );
        let names: Vec<_> = parsed.projects.iter().map(|p| p.name.as_str()).collect();
        assert_eq!(names, vec!["Release", "Chores"]);

        let release = &parsed.tasks["release"];
        assert_eq!(release.len(), 2);
        assert_eq!(release[0].label, "Cut tag");
        assert!(release[0].done, "@done(...) marks completion");
        assert_eq!(release[1].label, "Announce @blog", "other tags are kept");
        assert!(!release[1].done);

        let chores = &parsed.tasks["chores"];
        assert_eq!(chores[0].label, "Water plants");
        assert!(chores[0].done, "bare @done marks completion");
    }

    #[test]
    fn tasks_before_a_project_fall_into_inbox() {
        let parsed = parse("- Floating task\nInbox-like:\n- Scoped\n");
        assert_eq!(parsed.projects[0].id, "inbox");
        assert_eq!(parsed.tasks["inbox"][0].label, "Floating task");
        assert_eq!(parsed.tasks["inbox-like"][0].label, "Scoped");
    }

    #[test]
    fn blank_lines_and_empty_task_labels_are_skipped() {
        let parsed = parse("Work:\n\n- @done\n- Real one\n");
        assert_eq!(
            parsed.tasks["work"].len(),
            1,
            "the @done-only line has no label"
        );
        assert_eq!(parsed.tasks["work"][0].label, "Real one");
    }

    #[test]
    fn a_task_ending_in_colon_is_not_a_project() {
        let parsed = parse("Work:\n- Email Bob about the thing:\n");
        assert_eq!(parsed.projects.len(), 1, "only `Work:` is a project");
        assert_eq!(parsed.tasks["work"][0].label, "Email Bob about the thing:");
    }
}
