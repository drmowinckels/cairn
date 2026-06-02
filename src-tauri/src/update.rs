//! Opt-in update checker (#45).
//!
//! This is the *only* outbound network Cairn core makes besides the
//! user-configured calendar fetches (see `docs/PRIVACY.md`). It is inert
//! unless the user turns on "Check for updates" in Settings: the frontend
//! is the sole caller of the `check_for_update` command (in `lib.rs`,
//! where the Tauri-runtime shim lives), and it only calls it when the
//! opt-in toggle is on. No telemetry, no identifier, no custom
//! User-Agent — `tauri-plugin-updater` performs a single HTTPS GET of the
//! release manifest and compares versions.
//!
//! This module holds the pure, unit-testable core: the UI payload type
//! and its mapping from manifest fields. The command itself is a thin
//! wrapper around `app.updater().check()` and lives in `lib.rs` with the
//! rest of the Tauri-only wiring that has no mockable surface.

use serde::Serialize;

const RELEASES_TAG_BASE: &str = "https://github.com/drmowinckels/cairn/releases/tag";

/// What the UI needs to render the "update available" banner. Mirrors a
/// `camelCase` TS interface in `src/lib/ipc.ts`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UpdateInfo {
    /// The newer version offered by the release manifest.
    pub version: String,
    /// The version currently running.
    pub current_version: String,
    /// Release notes from the manifest, if any.
    pub notes: Option<String>,
    /// Canonical GitHub release-notes page for `version`.
    pub release_url: String,
}

/// Canonical release-notes URL for a tag. Pure so it is unit-testable
/// without a Tauri runtime.
fn release_url(version: &str) -> String {
    format!("{RELEASES_TAG_BASE}/v{version}")
}

/// Assemble the UI payload from manifest fields. Pure core, extracted so
/// the mapping (including the release-URL derivation) is testable without
/// the network or a Tauri runtime.
pub(crate) fn build_update_info(
    version: &str,
    current_version: &str,
    notes: Option<String>,
) -> UpdateInfo {
    UpdateInfo {
        version: version.to_string(),
        current_version: current_version.to_string(),
        // Normalise empty release notes to `None` so the UI doesn't render
        // an empty body.
        notes: notes.filter(|n| !n.trim().is_empty()),
        release_url: release_url(version),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn release_url_points_at_the_tag_page() {
        assert_eq!(
            release_url("1.2.3"),
            "https://github.com/drmowinckels/cairn/releases/tag/v1.2.3"
        );
    }

    #[test]
    fn build_update_info_maps_fields_and_derives_url() {
        let info = build_update_info("0.2.0", "0.1.0", Some("Fixes and polish".to_string()));
        assert_eq!(info.version, "0.2.0");
        assert_eq!(info.current_version, "0.1.0");
        assert_eq!(info.notes.as_deref(), Some("Fixes and polish"));
        assert_eq!(
            info.release_url,
            "https://github.com/drmowinckels/cairn/releases/tag/v0.2.0"
        );
    }

    #[test]
    fn build_update_info_normalises_blank_notes_to_none() {
        let info = build_update_info("0.2.0", "0.1.0", Some("   ".to_string()));
        assert_eq!(info.notes, None);
        let info = build_update_info("0.2.0", "0.1.0", None);
        assert_eq!(info.notes, None);
    }
}
