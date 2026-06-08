//! Connector manifests Cairn ships compiled in (#110) — both ready-to-use
//! connectors and worked references for the manifest format documented in
//! `docs/PM_CONNECTORS.md`. They are registered by [`ConnectorHost::load`]
//! alongside any user manifests in the connectors dir; a user manifest
//! sharing a builtin's id overrides it.
//!
//! A builtin carries no secret — only the keychain *key* its token lives
//! under (`github_token`). The user supplies the token through Settings →
//! Connectors, so a bundled manifest is safe to ship and to share.
//!
//! [`ConnectorHost::load`]: super::ConnectorHost::load

/// GitHub Projects (v2), read through the GraphQL API. Needs a personal
/// access token with the `read:project` scope, stored in the keychain
/// under `github_token`.
pub const GITHUB_PROJECTS: &str = include_str!("manifests/github-projects.json");

/// Every compiled-in manifest, as raw JSON. A manifest that fails to parse
/// is a build-time authoring bug, not a user error — `builtins_all_parse`
/// guards that so a broken one never ships.
pub const ALL: &[&str] = &[GITHUB_PROJECTS];
