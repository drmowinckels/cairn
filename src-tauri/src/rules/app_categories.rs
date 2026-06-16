//! App-name → category lookup for the `app.category` rule condition (#189).
//!
//! Pure and zero-IO: the mapping is compiled into the binary from
//! `app_categories.json` and parsed once into a static table. It lives in
//! `rules/` (not `signals/`) because the matcher is its only consumer and the
//! rules engine must stay free of cross-module coupling — a static lookup
//! table keeps `condition_matches` a pure field reader with no `signals`
//! import.
//!
//! Matching is case-insensitive and exact against the OS-reported app name
//! (macOS `localizedName`, Linux window class, Windows executable basename).
//! Categories are checked in file order; the first match wins.

use std::collections::HashMap;
use std::sync::LazyLock;

use serde::{Deserialize, Serialize};

const RAW: &str = include_str!("app_categories.json");

/// One category and the app names that map to it. Serialisable so the rule
/// editor can render "meeting apps: Zoom, Teams, …" helper text from the same
/// source of truth the matcher uses (#189).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AppCategory {
    pub category: String,
    pub label: String,
    pub apps: Vec<String>,
}

#[derive(Debug, Deserialize)]
struct RawTable {
    categories: Vec<AppCategory>,
}

struct Table {
    categories: Vec<AppCategory>,
    /// Lowercased app name → index into `categories`.
    lookup: HashMap<String, usize>,
}

static TABLE: LazyLock<Table> = LazyLock::new(|| {
    let raw: RawTable =
        serde_json::from_str(RAW).expect("app_categories.json is valid JSON baked into the binary");
    let mut lookup = HashMap::new();
    for (idx, cat) in raw.categories.iter().enumerate() {
        for app in &cat.apps {
            // First category listing an app wins (file order), so a name can
            // never resolve to two categories.
            lookup.entry(app.to_lowercase()).or_insert(idx);
        }
    }
    Table {
        categories: raw.categories,
        lookup,
    }
});

/// The category for a foreground app name, or `None` if uncategorised.
/// Case-insensitive exact match against the bundled table.
pub fn categorize(app_name: &str) -> Option<&'static str> {
    let idx = *TABLE.lookup.get(&app_name.to_lowercase())?;
    Some(TABLE.categories[idx].category.as_str())
}

/// All known categories with their display label and member apps, in file
/// order. Surfaced to the rule editor so it can list the matched apps without
/// hardcoding them in the frontend (#189).
pub fn categories() -> &'static [AppCategory] {
    &TABLE.categories
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    #[test]
    fn categorizes_known_apps_across_categories() {
        assert_eq!(categorize("zoom.us"), Some("meeting"));
        assert_eq!(categorize("Microsoft Teams"), Some("meeting"));
        assert_eq!(categorize("Code"), Some("editor"));
        assert_eq!(categorize("iTerm2"), Some("terminal"));
        assert_eq!(categorize("Safari"), Some("browser"));
    }

    #[test]
    fn matching_is_case_insensitive() {
        assert_eq!(categorize("VISUAL STUDIO CODE"), Some("editor"));
        assert_eq!(categorize("google chrome"), Some("browser"));
        assert_eq!(categorize("ZOOM.US"), Some("meeting"));
    }

    #[test]
    fn unknown_app_is_uncategorised() {
        assert_eq!(categorize("Some Random App 123"), None);
        assert_eq!(categorize(""), None);
    }

    #[test]
    fn categories_expose_the_four_starter_groups() {
        let keys: Vec<&str> = categories().iter().map(|c| c.category.as_str()).collect();
        assert_eq!(keys, ["meeting", "editor", "terminal", "browser"]);
        for c in categories() {
            assert!(!c.label.is_empty(), "{} has no label", c.category);
            assert!(!c.apps.is_empty(), "{} has no apps", c.category);
        }
    }

    #[test]
    fn no_app_name_maps_to_two_categories() {
        // Table hygiene: a case-insensitive app name must appear in exactly
        // one category, or `categorize` would silently pick whichever comes
        // first and the other listing would be dead data.
        let mut seen: HashSet<String> = HashSet::new();
        for c in categories() {
            for app in &c.apps {
                let key = app.to_lowercase();
                assert!(
                    seen.insert(key.clone()),
                    "app name {app:?} listed under more than one category"
                );
            }
        }
    }
}
