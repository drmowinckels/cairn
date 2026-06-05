//! Connector manifest model + validation. See `docs/PM_CONNECTORS.md`.
//!
//! A manifest is *data* describing how to reach a project-management
//! tool. This module is the single boundary where untrusted manifest
//! JSON becomes a typed, validated value — everything downstream works
//! on [`ConnectorManifest`], never on raw JSON, which is what keeps the
//! "data, not code" safety story enforceable.
//!
//! Slice 1 implements only `kind: "file"` (local files, zero network /
//! secrets). `kind: "http"` (the declarative HTTP interpreter) is a
//! recognized-but-unsupported kind for now: a manifest declaring it
//! parses far enough to be rejected with a clear message, so importing
//! one fails loudly instead of silently doing nothing.

use serde::{Deserialize, Serialize};

use crate::plugins::Capability;

/// The only manifest schema version this build understands.
pub const SUPPORTED_VERSION: u32 = 1;

/// A validated connector manifest. Construct via [`ConnectorManifest::from_json`];
/// the fields are guaranteed to satisfy the invariants documented there.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ConnectorManifest {
    /// Stable machine id, kebab-case (`^[a-z0-9-]+$`).
    pub id: String,
    /// Human label shown in Settings → Connectors.
    pub name: String,
    /// Declared capabilities, surfaced as badges. A file connector
    /// declares none (it is fully local).
    pub capabilities: Vec<Capability>,
    /// The interpreter + its kind-specific configuration.
    pub kind: ConnectorKind,
}

/// Which interpreter runs the connector, plus that interpreter's config.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ConnectorKind {
    /// A local file read by a built-in parser. Zero network / secrets.
    File(FileSpec),
}

/// Configuration for a `kind: "file"` connector.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FileSpec {
    pub format: FileFormat,
    /// Path to the file. A leading `~` is expanded to the home dir when
    /// the connector reads it (see `connectors::file`).
    pub path: String,
}

/// Local-file formats the built-in parser understands.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FileFormat {
    Todotxt,
    Markdown,
    Taskpaper,
}

/// Why a manifest was rejected. Library-level, so callers (the host's
/// directory load, the future import command) can surface a precise
/// reason without string-matching.
#[derive(Debug, thiserror::Error)]
pub enum ManifestError {
    #[error("manifest is not valid JSON: {0}")]
    Json(#[from] serde_json::Error),
    #[error("unsupported manifest version {0} (this build understands {SUPPORTED_VERSION})")]
    Version(u32),
    #[error("connector id {0:?} must be non-empty and kebab-case ([a-z0-9-])")]
    Id(String),
    #[error("connector name must not be empty")]
    Name,
    #[error("{kind} connector is missing its {section:?} section")]
    MissingSection { kind: String, section: &'static str },
    #[error("file connectors are fully local and must declare no capabilities (got {0:?})")]
    FileCapabilities(Vec<Capability>),
    #[error("connector kind {0:?} is not supported in this version yet")]
    UnsupportedKind(String),
}

/// The wire shape of a manifest: flat top-level fields plus one sibling
/// object named after the kind (`file`). Parsed leniently, then validated
/// into a [`ConnectorManifest`] so every error is specific.
#[derive(Deserialize)]
struct RawManifest {
    manifest: u32,
    #[serde(default)]
    id: String,
    #[serde(default)]
    name: String,
    kind: String,
    #[serde(default)]
    capabilities: Vec<Capability>,
    #[serde(default)]
    file: Option<FileSpec>,
}

impl ConnectorManifest {
    /// Parse and validate a manifest from JSON.
    ///
    /// Enforces: schema version, non-empty kebab-case id, non-empty name,
    /// and the kind-specific shape (a `file` connector needs a `file`
    /// section and may declare no capabilities). An unknown or
    /// not-yet-supported `kind` (e.g. `"http"`) is rejected.
    pub fn from_json(json: &str) -> Result<Self, ManifestError> {
        let raw: RawManifest = serde_json::from_str(json)?;

        if raw.manifest != SUPPORTED_VERSION {
            return Err(ManifestError::Version(raw.manifest));
        }
        if !is_valid_id(&raw.id) {
            return Err(ManifestError::Id(raw.id));
        }
        if raw.name.trim().is_empty() {
            return Err(ManifestError::Name);
        }

        let kind = match raw.kind.as_str() {
            "file" => {
                if !raw.capabilities.is_empty() {
                    return Err(ManifestError::FileCapabilities(raw.capabilities));
                }
                let spec = raw.file.ok_or(ManifestError::MissingSection {
                    kind: "file".to_string(),
                    section: "file",
                })?;
                ConnectorKind::File(spec)
            }
            other => return Err(ManifestError::UnsupportedKind(other.to_string())),
        };

        Ok(ConnectorManifest {
            id: raw.id,
            name: raw.name,
            capabilities: raw.capabilities,
            kind,
        })
    }
}

/// `^[a-z0-9-]+$` without pulling in a regex engine.
fn is_valid_id(id: &str) -> bool {
    !id.is_empty()
        && id
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

#[cfg(test)]
mod tests {
    use super::*;

    const FILE_JSON: &str = r#"{
        "manifest": 1,
        "id": "my-todo",
        "name": "Project TODO",
        "kind": "file",
        "capabilities": [],
        "file": { "format": "todotxt", "path": "~/code/cairn/TODO.txt" }
    }"#;

    #[test]
    fn parses_a_valid_file_manifest() {
        let m = ConnectorManifest::from_json(FILE_JSON).unwrap();
        assert_eq!(m.id, "my-todo");
        assert_eq!(m.name, "Project TODO");
        assert!(m.capabilities.is_empty());
        assert_eq!(
            m.kind,
            ConnectorKind::File(FileSpec {
                format: FileFormat::Todotxt,
                path: "~/code/cairn/TODO.txt".to_string(),
            })
        );
    }

    #[test]
    fn each_file_format_parses() {
        for (token, want) in [
            ("todotxt", FileFormat::Todotxt),
            ("markdown", FileFormat::Markdown),
            ("taskpaper", FileFormat::Taskpaper),
        ] {
            let json = FILE_JSON.replace("todotxt", token);
            let m = ConnectorManifest::from_json(&json).unwrap();
            assert_eq!(
                m.kind,
                ConnectorKind::File(FileSpec {
                    format: want,
                    path: "~/code/cairn/TODO.txt".to_string()
                })
            );
        }
    }

    #[test]
    fn rejects_invalid_json() {
        let err = ConnectorManifest::from_json("{ not json").unwrap_err();
        assert!(matches!(err, ManifestError::Json(_)));
    }

    #[test]
    fn rejects_wrong_version() {
        let json = FILE_JSON.replace("\"manifest\": 1", "\"manifest\": 2");
        let err = ConnectorManifest::from_json(&json).unwrap_err();
        assert!(matches!(err, ManifestError::Version(2)));
    }

    #[test]
    fn rejects_non_kebab_id() {
        for bad in ["", "My_Todo", "todo list", "Café"] {
            let json = FILE_JSON.replace("\"id\": \"my-todo\"", &format!("\"id\": \"{bad}\""));
            let err = ConnectorManifest::from_json(&json).unwrap_err();
            assert!(
                matches!(err, ManifestError::Id(_)),
                "{bad:?} should be rejected"
            );
        }
    }

    #[test]
    fn rejects_empty_name() {
        let json = FILE_JSON.replace("\"name\": \"Project TODO\"", "\"name\": \"   \"");
        let err = ConnectorManifest::from_json(&json).unwrap_err();
        assert!(matches!(err, ManifestError::Name));
    }

    #[test]
    fn file_connector_must_declare_no_capabilities() {
        let json = FILE_JSON.replace("\"capabilities\": []", "\"capabilities\": [\"network\"]");
        let err = ConnectorManifest::from_json(&json).unwrap_err();
        assert!(matches!(err, ManifestError::FileCapabilities(_)));
    }

    #[test]
    fn file_connector_without_file_section_is_rejected() {
        let json = r#"{
            "manifest": 1, "id": "x", "name": "X", "kind": "file", "capabilities": []
        }"#;
        let err = ConnectorManifest::from_json(json).unwrap_err();
        assert!(matches!(
            err,
            ManifestError::MissingSection {
                section: "file",
                ..
            }
        ));
    }

    #[test]
    fn http_kind_is_recognized_but_unsupported() {
        let json = r#"{
            "manifest": 1, "id": "todoist", "name": "Todoist", "kind": "http",
            "capabilities": ["network", "secrets"]
        }"#;
        let err = ConnectorManifest::from_json(json).unwrap_err();
        assert!(matches!(err, ManifestError::UnsupportedKind(k) if k == "http"));
    }

    #[test]
    fn unknown_kind_is_rejected() {
        let json = FILE_JSON.replace("\"kind\": \"file\"", "\"kind\": \"smoke-signals\"");
        let err = ConnectorManifest::from_json(&json).unwrap_err();
        assert!(matches!(err, ManifestError::UnsupportedKind(_)));
    }
}
