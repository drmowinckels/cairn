//! GitHub-style Markdown checklist parser.
//!
//! `#`-headings become projects; `- [ ]` / `- [x]` task-list items
//! become their tasks (`*` and `+` bullets too, with nesting allowed —
//! every checklist item under a heading belongs to that heading). Items
//! that appear before the first heading fall into a synthetic **Tasks**
//! project.

use super::{slug, Builder, Parsed};

const DEFAULT_ID: &str = "tasks";
const DEFAULT_NAME: &str = "Tasks";

pub(super) fn parse(content: &str) -> Parsed {
    let mut b = Builder::new();
    let mut current: Option<String> = None;
    for raw in content.lines() {
        let line = raw.trim_end();
        if let Some(heading) = heading_text(line) {
            current = Some(b.project(slug(heading), heading));
            continue;
        }
        if let Some((label, done)) = checklist_item(line) {
            if label.is_empty() {
                continue;
            }
            let pid = current
                .clone()
                .unwrap_or_else(|| b.project(DEFAULT_ID, DEFAULT_NAME));
            current = Some(pid.clone());
            b.task(&pid, label, None, done);
        }
    }
    b.finish()
}

/// The text of an ATX heading (`# Foo`), or `None`. Requires whitespace
/// after the `#`-run, per CommonMark — `#Foo` is not a heading.
fn heading_text(line: &str) -> Option<&str> {
    let trimmed = line.trim_start();
    let rest = trimmed.strip_prefix('#')?.trim_start_matches('#');
    if !rest.starts_with(char::is_whitespace) {
        return None;
    }
    let text = rest.trim();
    (!text.is_empty()).then_some(text)
}

/// `(label, done)` for a task-list item, or `None` for any other line.
fn checklist_item(line: &str) -> Option<(&str, bool)> {
    let trimmed = line.trim_start();
    let after_bullet = ["- ", "* ", "+ "]
        .iter()
        .find_map(|p| trimmed.strip_prefix(p))?;
    let rest = after_bullet.trim_start().strip_prefix('[')?;
    let mark = *rest.as_bytes().first()?;
    if !matches!(mark, b' ' | b'x' | b'X') {
        return None;
    }
    let label = rest.get(1..)?.strip_prefix(']')?.trim();
    Some((label, matches!(mark, b'x' | b'X')))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn headings_are_projects_and_checkboxes_are_tasks() {
        let parsed = parse(
            "# Backend (API)\n\
             - [ ] Add endpoint\n\
             - [x] Write migration\n\
             ## Frontend\n\
             * [ ] Build form\n",
        );
        let names: Vec<_> = parsed.projects.iter().map(|p| p.name.as_str()).collect();
        assert_eq!(names, vec!["Backend (API)", "Frontend"]);

        let backend = &parsed.tasks["backend-api"];
        assert_eq!(backend.len(), 2);
        assert_eq!(backend[0].label, "Add endpoint");
        assert!(!backend[0].done);
        assert!(backend[1].done, "[x] marks completion");

        assert_eq!(parsed.tasks["frontend"][0].label, "Build form");
    }

    #[test]
    fn items_before_a_heading_fall_into_default_project() {
        let parsed = parse("- [ ] Loose task\n# Real\n- [ ] Scoped\n");
        assert_eq!(parsed.projects[0].id, "tasks");
        assert_eq!(parsed.tasks["tasks"][0].label, "Loose task");
        assert_eq!(parsed.tasks["real"][0].label, "Scoped");
    }

    #[test]
    fn non_checklist_lines_and_empty_labels_are_ignored() {
        let parsed = parse(
            "# Notes\n\
             Just prose, not a task.\n\
             - A bullet without a checkbox\n\
             - [-] A non-checkbox marker\n\
             - [ ]   \n\
             - [ ] Kept\n",
        );
        assert_eq!(parsed.tasks["notes"].len(), 1);
        assert_eq!(parsed.tasks["notes"][0].label, "Kept");
    }

    #[test]
    fn hash_without_space_is_not_a_heading() {
        let parsed = parse("#NotAHeading\n- [ ] orphan\n");
        assert_eq!(parsed.projects[0].id, "tasks", "no heading recognized");
    }
}
