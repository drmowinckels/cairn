//! Exclusion matcher.
//!
//! Per `docs/PRIVACY.md`: the exclusion list applies *at the
//! collector*, before any rule or matcher runs. An app, window-title
//! substring, or browser domain on the list causes the signal to be
//! dropped — it never reaches the rules engine, never gets emitted to
//! the webview, never appears in any log.
//!
//! ## Data model
//!
//! The `exclusions` SQL table stores `{id, kind, value}` rows where
//! `kind` is one of `app | window | domain`. This struct is the
//! in-memory projection used by the snapshot stream.
//!
//! ## Reload semantics
//!
//! Wrapped in `Arc<std::sync::RwLock<_>>` in `AppState` so the
//! `save_exclusion` / `delete_exclusion` IPC handlers can invalidate
//! after a write. Readers (the `apply_event` step of the snapshot
//! stream driver) take a read-lock briefly; the lock is dropped
//! before any `.await`.

use sqlx::{Row, SqlitePool};

use crate::rules::SignalSnapshot;
use crate::signals::window::FrontWindow;

/// Snapshot of the exclusions table at a point in time. The driver
/// takes a read-lock to consult this on every `Window` event; cost
/// is one allocation-free pass over three small `Vec<String>` lists.
#[derive(Debug, Clone, Default)]
pub struct ExclusionMatcher {
    apps: Vec<String>,
    windows: Vec<String>,
    domains: Vec<String>,
}

impl ExclusionMatcher {
    pub fn new(apps: Vec<String>, windows: Vec<String>, domains: Vec<String>) -> Self {
        Self {
            apps,
            windows,
            domains,
        }
    }

    /// True iff the given front-window matches any exclusion rule.
    /// Apps match exactly on `app_name`; window-title rules match by
    /// **case-insensitive** substring on `title`. Case-insensitivity
    /// is a hard requirement of the privacy contract: a user who
    /// excludes `"Banking"` cannot have a window titled `"banking"`
    /// silently leak through.
    pub fn matches_window(&self, fw: &FrontWindow) -> bool {
        if self.apps.iter().any(|a| a == &fw.app_name) {
            return true;
        }
        if let Some(title) = fw.title.as_deref() {
            let title_lower = title.to_ascii_lowercase();
            if self
                .windows
                .iter()
                .any(|w| title_lower.contains(&w.to_ascii_lowercase()))
            {
                return true;
            }
        }
        false
    }

    /// True iff the given app name matches any `app` exclusion. Used
    /// by `redact_snapshot` to filter a `SignalSnapshot` whose
    /// `FrontWindow` has already been consumed (e.g. the cached
    /// `LiveState.front` projected into `publish`'s output).
    pub fn matches_app(&self, app_name: &str) -> bool {
        self.apps.iter().any(|a| a == app_name)
    }

    /// True iff the given window title matches any `window`
    /// exclusion. Same case-insensitive substring rule as
    /// `matches_window`.
    pub fn matches_title(&self, title: &str) -> bool {
        let title_lower = title.to_ascii_lowercase();
        self.windows
            .iter()
            .any(|w| title_lower.contains(&w.to_ascii_lowercase()))
    }

    /// True iff the given browser domain matches any `domain`
    /// exclusion. Exact match — wildcards aren't supported yet (the
    /// UI doesn't expose them either).
    pub fn matches_domain(&self, domain: &str) -> bool {
        self.domains.iter().any(|d| d == domain)
    }

    /// Filter a composed `SignalSnapshot` through the exclusion
    /// matcher: any window/title/domain field that now matches an
    /// exclusion is cleared. Used as defence-in-depth at every
    /// publish site (`stream::publish`, `snapshot::build`,
    /// `current_snapshot` IPC fallback) so a stale `LiveState.front`
    /// from before a mid-session exclusion add can't leak on the
    /// next publish.
    ///
    /// Per `docs/PRIVACY.md`: "While an exclusion is active, Cairn
    /// behaves as if the user has no foreground app at all" — this
    /// is the function that enforces that on the publish-side path.
    pub fn redact_snapshot(&self, snap: &mut SignalSnapshot) {
        let app_excluded = snap
            .app_name
            .as_deref()
            .is_some_and(|a| self.matches_app(a));
        let title_excluded = snap
            .window_title
            .as_deref()
            .is_some_and(|t| self.matches_title(t));
        if app_excluded || title_excluded {
            snap.app_name = None;
            snap.window_title = None;
            snap.ide_folder = None;
            // `git_branch` is cleared too: the rules engine treats
            // the snapshot as a unit, so leaving git_branch alone
            // would mean the rules engine sees `git_branch=Some`
            // with no window context — a confusing partial state
            // that no rule design assumes.
            snap.git_branch = None;
        }
        if let Some(domain) = snap.browser_domain.as_deref() {
            if self.matches_domain(domain) {
                snap.browser_domain = None;
            }
        }
    }

    /// Load every exclusion row from the DB into a fresh matcher.
    /// On query failure, returns an empty matcher and logs — a
    /// totally empty matcher is the wrong fail-safe (it lets
    /// everything through) but the *right* runtime fallback is "best
    /// effort"; the alternative would be to refuse to produce any
    /// snapshot, breaking the popover entirely. The user can re-add
    /// exclusions and the next save invalidates this empty cache.
    pub async fn load(pool: &SqlitePool) -> Self {
        let rows = match sqlx::query("SELECT kind, value FROM exclusions")
            .fetch_all(pool)
            .await
        {
            Ok(rows) => rows,
            Err(e) => {
                log::warn!("exclusions: load failed, treating as empty: {e}");
                return Self::default();
            }
        };
        let mut apps = Vec::new();
        let mut windows = Vec::new();
        let mut domains = Vec::new();
        for r in rows {
            let kind: String = r.get("kind");
            let value: String = r.get("value");
            match kind.as_str() {
                "app" => apps.push(value),
                "window" => windows.push(value),
                "domain" => domains.push(value),
                other => log::warn!("exclusions: ignoring unknown kind '{other}'"),
            }
        }
        Self {
            apps,
            windows,
            domains,
        }
    }

    /// Test-only constructor that doesn't touch the DB.
    #[cfg(test)]
    pub fn for_test(apps: &[&str], windows: &[&str], domains: &[&str]) -> Self {
        Self {
            apps: apps.iter().map(|s| s.to_string()).collect(),
            windows: windows.iter().map(|s| s.to_string()).collect(),
            domains: domains.iter().map(|s| s.to_string()).collect(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fw(app: &str, title: Option<&str>) -> FrontWindow {
        FrontWindow {
            app_name: app.to_string(),
            title: title.map(str::to_string),
        }
    }

    #[test]
    fn matches_window_by_app_name() {
        let m = ExclusionMatcher::for_test(&["1Password"], &[], &[]);
        assert!(m.matches_window(&fw("1Password", None)));
        assert!(!m.matches_window(&fw("Slack", None)));
    }

    #[test]
    fn matches_window_by_title_substring() {
        let m = ExclusionMatcher::for_test(&[], &["Banking"], &[]);
        assert!(m.matches_window(&fw("Chrome", Some("Banking — Chase"))));
        assert!(!m.matches_window(&fw("Chrome", Some("GitHub — cairn"))));
    }

    #[test]
    fn matches_window_title_is_case_insensitive() {
        let m = ExclusionMatcher::for_test(&[], &["Banking"], &[]);
        // Privacy: a user who typed "Banking" must not have
        // "banking" or "BANKING" leak through.
        assert!(m.matches_window(&fw("Chrome", Some("banking — chase"))));
        assert!(m.matches_window(&fw("Chrome", Some("BANKING TIME"))));
    }

    #[test]
    fn redact_snapshot_clears_excluded_app_fields() {
        use crate::rules::SignalSnapshot;
        let m = ExclusionMatcher::for_test(&["1Password"], &[], &[]);
        let mut snap = SignalSnapshot {
            ide_folder: Some("vault".into()),
            git_branch: Some("main".into()),
            window_title: Some("vault open".into()),
            app_name: Some("1Password".into()),
            browser_domain: Some("example.com".into()),
            calendar: vec![],
        };
        m.redact_snapshot(&mut snap);
        assert!(snap.app_name.is_none());
        assert!(snap.window_title.is_none());
        assert!(snap.ide_folder.is_none());
        assert!(snap.git_branch.is_none());
        // Non-excluded domain stays.
        assert_eq!(snap.browser_domain.as_deref(), Some("example.com"));
    }

    #[test]
    fn redact_snapshot_clears_excluded_title_substring() {
        use crate::rules::SignalSnapshot;
        let m = ExclusionMatcher::for_test(&[], &["Banking"], &[]);
        let mut snap = SignalSnapshot {
            ide_folder: Some("/code/banking-app".into()),
            git_branch: Some("feat/y".into()),
            window_title: Some("Banking — Chase".into()),
            app_name: Some("Chrome".into()),
            browser_domain: None,
            calendar: vec![],
        };
        m.redact_snapshot(&mut snap);
        assert!(snap.app_name.is_none());
        assert!(snap.window_title.is_none());
        assert!(snap.ide_folder.is_none());
        assert!(snap.git_branch.is_none());
    }

    #[test]
    fn redact_snapshot_clears_excluded_domain_only() {
        use crate::rules::SignalSnapshot;
        let m = ExclusionMatcher::for_test(&[], &[], &["bank.example.com"]);
        let mut snap = SignalSnapshot {
            ide_folder: None,
            git_branch: None,
            window_title: Some("login — bank".into()),
            app_name: Some("Chrome".into()),
            browser_domain: Some("bank.example.com".into()),
            calendar: vec![],
        };
        m.redact_snapshot(&mut snap);
        // Window fields untouched because no window-rule matched.
        assert_eq!(snap.app_name.as_deref(), Some("Chrome"));
        assert_eq!(snap.window_title.as_deref(), Some("login — bank"));
        // Domain field cleared.
        assert!(snap.browser_domain.is_none());
    }

    #[test]
    fn redact_snapshot_is_noop_for_allowed_snapshot() {
        use crate::rules::SignalSnapshot;
        let m = ExclusionMatcher::for_test(&["NotMatched"], &["NotInTitle"], &["bad.example"]);
        let mut snap = SignalSnapshot {
            ide_folder: Some("cairn".into()),
            git_branch: Some("main".into()),
            window_title: Some("rules.rs — cairn".into()),
            app_name: Some("Zed".into()),
            browser_domain: Some("github.com".into()),
            calendar: vec![],
        };
        let before = snap.clone();
        m.redact_snapshot(&mut snap);
        assert_eq!(snap.app_name, before.app_name);
        assert_eq!(snap.window_title, before.window_title);
        assert_eq!(snap.ide_folder, before.ide_folder);
        assert_eq!(snap.git_branch, before.git_branch);
        assert_eq!(snap.browser_domain, before.browser_domain);
    }

    #[test]
    fn matches_window_no_title_with_window_rule_does_not_match() {
        let m = ExclusionMatcher::for_test(&[], &["Banking"], &[]);
        // App matches no app-rule, title is None → no match.
        assert!(!m.matches_window(&fw("Chrome", None)));
    }

    #[test]
    fn empty_matcher_matches_nothing() {
        let m = ExclusionMatcher::default();
        assert!(!m.matches_window(&fw("anything", Some("anywhere"))));
        assert!(!m.matches_domain("any.example.com"));
    }

    #[test]
    fn matches_domain_exact() {
        let m = ExclusionMatcher::for_test(&[], &[], &["bank.example.com"]);
        assert!(m.matches_domain("bank.example.com"));
        // Substring match is NOT supported — we only do exact.
        assert!(!m.matches_domain("foo.bank.example.com"));
    }

    #[cfg(not(target_os = "windows"))]
    #[tokio::test]
    async fn load_returns_empty_on_fresh_db() {
        let (_dir, db) = crate::test_support::test_db().await;
        let m = ExclusionMatcher::load(&db.pool).await;
        assert!(!m.matches_window(&fw("anything", Some("anywhere"))));
    }

    #[cfg(not(target_os = "windows"))]
    #[tokio::test]
    async fn load_picks_up_rows_by_kind() {
        let (_dir, db) = crate::test_support::test_db().await;
        for (kind, value) in [
            ("app", "1Password"),
            ("window", "Banking"),
            ("domain", "bank.example.com"),
            ("nonsense", "ignored"),
        ] {
            sqlx::query("INSERT INTO exclusions (id, kind, value) VALUES (?1, ?2, ?3)")
                .bind(uuid::Uuid::new_v4().to_string())
                .bind(kind)
                .bind(value)
                .execute(&db.pool)
                .await
                .unwrap();
        }
        let m = ExclusionMatcher::load(&db.pool).await;
        assert!(m.matches_window(&fw("1Password", None)));
        assert!(m.matches_window(&fw("Chrome", Some("Banking — Chase"))));
        assert!(m.matches_domain("bank.example.com"));
        // "nonsense" was ignored — verify by negative assertion.
        assert!(!m.matches_domain("ignored"));
    }
}
