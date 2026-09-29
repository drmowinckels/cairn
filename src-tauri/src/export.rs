//! Every export contract Cairn offers, in one place (#276).
//!
//! Two formats, one home:
//!
//! * **Versioned structured JSON** — the stable contract the billing plugin
//!   (#109) and any other downstream consumer reads instead of touching the
//!   database. Bump `SCHEMA_VERSION` on any breaking change to the document
//!   shape; additive fields are non-breaking.
//! * **Long-format CSV** — one row per entry, for tabular tools (pandas /
//!   dplyr / Excel) and invoice plugins (#1).
//!
//! The CSV export previously lived in `backup.rs`, which left that module a
//! grab-bag of backup/restore *and* an export contract. `backup.rs` now owns
//! backup, restore and delete-everything only.
//!
//! Durations carry both lenses in JSON: `duration_seconds` is the raw span and
//! `rounded_duration_seconds` applies the user's rounding preference (#107,
//! per-project overrides included) — consumers must pick one and never round
//! an already-rounded value. Both formats measure a span the same way (see
//! [`span_seconds`]) but degrade differently when a stored timestamp won't
//! parse: CSV leaves the cell empty, JSON fails the whole export. That
//! difference is deliberate — a CSV is read by a human who can see the gap,
//! while the JSON document is a machine contract where a silently missing
//! duration would be taken as real.

use std::path::{Path, PathBuf};

use chrono::{DateTime, Utc};
use serde::Serialize;
use sqlx::{Row, SqlitePool};
use tauri::State;
use tokio::io::AsyncWriteExt;

use crate::ipc::{ensure_parent_dir, err, parse_ts};
use crate::rounding::{effective_rounding, project_rounding_from_row, Rounding};
use crate::AppState;

pub const SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportDocument {
    pub schema_version: u32,
    pub generated_at: DateTime<Utc>,
    /// The global rounding preference the rounded durations were
    /// computed with (per-project overrides still win per entry).
    pub rounding: Rounding,
    /// Entry filter actually applied, echoed back so consumers can
    /// tell a partial export from a full one.
    pub from: Option<DateTime<Utc>>,
    pub to: Option<DateTime<Utc>>,
    pub clients: Vec<ExportClient>,
    pub projects: Vec<ExportProject>,
    pub tasks: Vec<ExportTask>,
    pub entries: Vec<ExportEntry>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportClient {
    pub id: String,
    pub name: String,
    pub archived: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportProject {
    pub id: String,
    pub name: String,
    pub client_id: Option<String>,
    pub archived: bool,
    pub estimate_hours: Option<f64>,
    pub rounding: Option<Rounding>,
    pub billable_default: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportTask {
    pub id: String,
    pub project_id: Option<String>,
    pub name: String,
    pub archived: bool,
    pub connector_id: Option<String>,
    pub remote_id: Option<String>,
    pub remote_url: Option<String>,
    pub remote_project_name: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportEntry {
    pub id: String,
    pub project_id: Option<String>,
    pub task_id: Option<String>,
    pub description: String,
    /// Raw timestamps, never mutated by rounding (#107).
    pub started_at: String,
    pub ended_at: Option<String>,
    pub source: String,
    pub rule_id: Option<String>,
    pub billable: bool,
    /// Raw span in seconds; open entries measure to `generated_at`.
    pub duration_seconds: i64,
    /// The raw span passed through the effective rounding for this
    /// entry's project (project override, else the global preference).
    pub rounded_duration_seconds: i64,
}

fn parse_range_bound(label: &str, value: Option<&str>) -> Result<Option<DateTime<Utc>>, String> {
    value
        .map(parse_ts)
        .transpose()
        .map_err(|e| format!("invalid {label}: {e}"))
}

pub async fn export_json_to(
    pool: &SqlitePool,
    dest: &Path,
    global_rounding: Rounding,
    from: Option<String>,
    to: Option<String>,
) -> Result<(), String> {
    let from = parse_range_bound("from", from.as_deref())?;
    let to = parse_range_bound("to", to.as_deref())?;
    if let (Some(f), Some(t)) = (from, to) {
        if t <= f {
            return Err("to must be strictly after from".into());
        }
    }
    let now = Utc::now();

    let clients = sqlx::query("SELECT id, name, archived FROM clients ORDER BY name")
        .fetch_all(pool)
        .await
        .map_err(err)?
        .into_iter()
        .map(|r| ExportClient {
            id: r.get("id"),
            name: r.get("name"),
            archived: r.get::<i64, _>("archived") != 0,
        })
        .collect();

    let projects = sqlx::query(
        "SELECT id, name, client_id, archived, estimate_hours, \
         rounding_interval_minutes, rounding_mode, billable_default \
         FROM projects ORDER BY name",
    )
    .fetch_all(pool)
    .await
    .map_err(err)?
    .into_iter()
    .map(|r| ExportProject {
        id: r.get("id"),
        name: r.get("name"),
        client_id: r.get("client_id"),
        archived: r.get::<i64, _>("archived") != 0,
        estimate_hours: r.get("estimate_hours"),
        rounding: project_rounding_from_row(&r),
        billable_default: r.get::<i64, _>("billable_default") != 0,
    })
    .collect();

    let tasks = sqlx::query(
        "SELECT id, project_id, name, archived, connector_id, remote_id, \
         remote_url, remote_project_name FROM tasks ORDER BY name",
    )
    .fetch_all(pool)
    .await
    .map_err(err)?
    .into_iter()
    .map(|r| ExportTask {
        id: r.get("id"),
        project_id: r.get("project_id"),
        name: r.get("name"),
        archived: r.get::<i64, _>("archived") != 0,
        connector_id: r.get("connector_id"),
        remote_id: r.get("remote_id"),
        remote_url: r.get("remote_url"),
        remote_project_name: r.get("remote_project_name"),
    })
    .collect();

    // Range filter on started_at: inclusive `from`, exclusive `to`, so
    // consecutive exports over adjacent ranges never double-count an entry.
    let entry_rows = sqlx::query(
        "SELECT e.id, e.project_id, e.task_id, e.description, e.started_at, \
                e.ended_at, e.source, e.rule_id, e.billable, \
                p.rounding_interval_minutes, p.rounding_mode \
           FROM entries e \
           LEFT JOIN projects p ON p.id = e.project_id \
          WHERE (?1 IS NULL OR e.started_at >= ?1) \
            AND (?2 IS NULL OR e.started_at < ?2) \
          ORDER BY e.started_at ASC",
    )
    .bind(from.map(|t| t.to_rfc3339()))
    .bind(to.map(|t| t.to_rfc3339()))
    .fetch_all(pool)
    .await
    .map_err(err)?;

    let mut entries = Vec::with_capacity(entry_rows.len());
    for r in entry_rows {
        let id: String = r.get("id");
        let started_at: String = r.get("started_at");
        let ended_at: Option<String> = r.get("ended_at");
        let started = parse_ts(&started_at)
            .map_err(|e| format!("entry {id} has unparseable started_at: {e}"))?;
        // `None` (an open entry) is handed to `span_seconds`, which measures
        // it to `now`. An unparseable stored timestamp fails the whole export
        // — unlike the CSV, this document is a machine contract, and a
        // silently wrong duration would be consumed as real.
        let ended = match &ended_at {
            Some(s) => {
                Some(parse_ts(s).map_err(|e| format!("entry {id} has unparseable ended_at: {e}"))?)
            }
            None => None,
        };
        let duration_seconds = span_seconds(started, ended, now);
        let rounding = effective_rounding(project_rounding_from_row(&r), global_rounding);
        entries.push(ExportEntry {
            id,
            project_id: r.get("project_id"),
            task_id: r.get("task_id"),
            description: r.get("description"),
            started_at,
            ended_at,
            source: r.get("source"),
            rule_id: r.get("rule_id"),
            billable: r.get::<i64, _>("billable") != 0,
            duration_seconds,
            rounded_duration_seconds: rounding.round_secs(duration_seconds),
        });
    }

    let doc = ExportDocument {
        schema_version: SCHEMA_VERSION,
        generated_at: now,
        rounding: global_rounding,
        from,
        to,
        clients,
        projects,
        tasks,
        entries,
    };

    let json = serde_json::to_vec_pretty(&doc).map_err(err)?;
    write_export(dest, &json).await
}

/// Write the JSON export, returning the path written. The `#[tauri::command]`
/// shim is in `lib.rs`: the macro's generated wrapper is only ever reached
/// through Tauri's IPC, so keeping it here would leave an untestable line in
/// a module that is otherwise fully covered.
pub async fn export_entries_json(
    state: State<'_, AppState>,
    dest: String,
    rounding: Option<Rounding>,
    from: Option<String>,
    to: Option<String>,
) -> Result<String, String> {
    let dest = std::path::PathBuf::from(dest);
    export_json_to(
        &state.db.pool,
        &dest,
        rounding.unwrap_or_default(),
        from,
        to,
    )
    .await?;
    Ok(dest.to_string_lossy().to_string())
}

#[tauri::command]
pub async fn suggested_json_name() -> String {
    format!("cairn-export-{}.json", Utc::now().format("%Y-%m-%d"))
}

// ── Shared span + write plumbing ──────────────────────────────────────

/// Seconds between `started` and `ended`, measuring an open entry to `now`.
///
/// Clamped at zero: a backwards span means a bad row or clock skew, and a
/// negative duration is never a meaningful answer in either format. Both
/// exporters call this so they can't drift on how a span is measured — only
/// on how they report a timestamp that wouldn't parse in the first place.
pub(crate) fn span_seconds(
    started: DateTime<Utc>,
    ended: Option<DateTime<Utc>>,
    now: DateTime<Utc>,
) -> i64 {
    (ended.unwrap_or(now) - started).num_seconds().max(0)
}

/// Create the export file, making its parent directory first.
///
/// Every export writes to a path the user picked in a save dialog, which may
/// name a directory that doesn't exist yet.
async fn create_export_file(dest: &Path) -> Result<tokio::fs::File, String> {
    ensure_parent_dir(dest).await?;
    tokio::fs::File::create(dest).await.map_err(err)
}

/// Write a whole export in one shot, making its parent directory first.
async fn write_export(dest: &Path, bytes: &[u8]) -> Result<(), String> {
    ensure_parent_dir(dest).await?;
    tokio::fs::write(dest, bytes).await.map_err(err)
}

// ── CSV entries export ────────────────────────────────────────────────

/// Single source of truth for the CSV export header. Documented in
/// `docs/PRIVACY.md`; the `csv_header_matches_const_and_documented_columns`
/// test guards against silent drift between the two.
pub const CSV_HEADER: &str =
    "entry_id,started_at,ended_at,duration_minutes,client,project,task,description,source";

/// Rounded entry duration in whole minutes for the CSV `duration_minutes`
/// column. Open entries (no `ended_at`) measure to `now`.
///
/// Returns an empty string if a timestamp can't be parsed, rather than
/// failing the export the way the JSON contract does. A CSV row with a blank
/// duration is visibly incomplete to whoever opens it; aborting a whole
/// export over one unparseable row would be worse. (DB values are RFC3339, so
/// this is defensive.)
fn csv_duration_minutes(
    started: &str,
    ended: Option<&str>,
    now: DateTime<Utc>,
    rounding: Rounding,
) -> String {
    let Ok(start) = DateTime::parse_from_rfc3339(started) else {
        return String::new();
    };
    let end = match ended {
        Some(s) => match DateTime::parse_from_rfc3339(s) {
            Ok(e) => Some(e.with_timezone(&Utc)),
            Err(_) => return String::new(),
        },
        None => None,
    };
    let secs = span_seconds(start.with_timezone(&Utc), end, now);
    (rounding.round_secs(secs) / 60).to_string()
}

/// Long-format CSV: one row per entry. Tabular tools (pandas / dplyr /
/// Excel) and invoice plugins (see issue #1) consume this directly.
pub async fn export_csv_to(
    pool: &SqlitePool,
    dest: &Path,
    rounding: Rounding,
) -> Result<(), String> {
    let now = Utc::now();

    let rows = sqlx::query(
        r#"
        SELECT e.id,
               e.started_at,
               e.ended_at,
               c.name AS client,
               p.name AS project,
               t.name AS task,
               e.description,
               e.source
          FROM entries e
          LEFT JOIN projects p ON p.id = e.project_id
          LEFT JOIN clients  c ON c.id = p.client_id
          LEFT JOIN tasks    t ON t.id = e.task_id
         ORDER BY e.started_at ASC
        "#,
    )
    .fetch_all(pool)
    .await
    .map_err(err)?;

    let mut file = create_export_file(dest).await?;
    file.write_all(format!("{CSV_HEADER}\n").as_bytes())
        .await
        .map_err(err)?;

    for row in rows {
        let id: String = row.get("id");
        let started: String = row.get("started_at");
        let ended: Option<String> = row.get("ended_at");
        let client: Option<String> = row.get("client");
        let project: Option<String> = row.get("project");
        let task: Option<String> = row.get("task");
        let description: String = row.get("description");
        let source: String = row.get("source");
        let duration = csv_duration_minutes(&started, ended.as_deref(), now, rounding);
        let line = format!(
            "{},{},{},{},{},{},{},{},{}\n",
            csv_escape(&id),
            csv_escape(&started),
            csv_escape(ended.as_deref().unwrap_or("")),
            csv_escape(&duration),
            csv_escape(client.as_deref().unwrap_or("")),
            csv_escape(project.as_deref().unwrap_or("")),
            csv_escape(task.as_deref().unwrap_or("")),
            csv_escape(&description),
            csv_escape(&source),
        );
        file.write_all(line.as_bytes()).await.map_err(err)?;
    }
    file.flush().await.map_err(err)?;
    Ok(())
}

pub(crate) fn csv_escape(s: &str) -> String {
    if s.contains(',') || s.contains('"') || s.contains('\n') {
        let escaped = s.replace('"', "\"\"");
        format!("\"{escaped}\"")
    } else {
        s.to_string()
    }
}

/// Write the CSV export, returning the path written. `#[tauri::command]` shim
/// in `lib.rs`, for the same reason as `export_entries_json`.
pub async fn export_csv(
    state: State<'_, AppState>,
    dest: String,
    rounding: Option<Rounding>,
) -> Result<String, String> {
    let dest = PathBuf::from(dest);
    export_csv_to(&state.db.pool, &dest, rounding.unwrap_or_default()).await?;
    Ok(dest.to_string_lossy().to_string())
}

#[tauri::command]
pub async fn suggested_csv_name() -> String {
    format!("cairn-entries-{}.csv", Utc::now().format("%Y-%m-%d"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backup::db_path;
    use crate::db::Db;
    use crate::rounding::RoundMode;
    use crate::test_support::test_db;
    #[cfg(not(target_os = "windows"))]
    use tauri::Manager;

    async fn insert_entry(pool: &SqlitePool, description: &str) -> String {
        let now = Utc::now().to_rfc3339();
        let id = uuid::Uuid::new_v4().to_string();
        sqlx::query(
            r#"INSERT INTO entries (id, project_id, task_id, description, started_at, ended_at, source, rule_id, created_at, updated_at)
               VALUES (?1, 'cairn', NULL, ?2, ?3, NULL, 'manual', NULL, ?3, ?3)"#,
        )
        .bind(&id)
        .bind(description)
        .bind(&now)
        .execute(pool)
        .await
        .unwrap();
        id
    }

    async fn seed(pool: &SqlitePool) {
        let now = "2026-07-01T00:00:00+00:00";
        sqlx::query(
            "INSERT INTO clients (id, name, created_at, updated_at) VALUES ('c1', 'Acme', ?1, ?1)",
        )
        .bind(now)
        .execute(pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO projects (id, name, client_id, color, archived, billable_default, created_at, updated_at) \
             VALUES ('p-bill', 'Consulting', 'c1', '#0f0', 0, 1, ?1, ?1)",
        )
        .bind(now)
        .execute(pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO projects (id, name, client_id, color, archived, billable_default, \
             rounding_interval_minutes, rounding_mode, created_at, updated_at) \
             VALUES ('p-exact', 'Internal', NULL, '#00f', 0, 0, 0, 'nearest', ?1, ?1)",
        )
        .bind(now)
        .execute(pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO tasks (id, project_id, name, archived, created_at, updated_at) \
             VALUES ('t1', 'p-bill', 'Audit', 0, ?1, ?1)",
        )
        .bind(now)
        .execute(pool)
        .await
        .unwrap();
        // 7 minutes on the billable project (global rounding applies).
        sqlx::query(
            "INSERT INTO entries (id, project_id, task_id, description, started_at, ended_at, source, billable, created_at, updated_at) \
             VALUES ('e1', 'p-bill', 't1', 'eight minutes', '2026-07-01T09:00:00+00:00', '2026-07-01T09:08:00+00:00', 'manual', 1, ?1, ?1)",
        )
        .bind(now)
        .execute(pool)
        .await
        .unwrap();
        // 7 minutes on the project whose override disables rounding.
        sqlx::query(
            "INSERT INTO entries (id, project_id, task_id, description, started_at, ended_at, source, billable, created_at, updated_at) \
             VALUES ('e2', 'p-exact', NULL, 'exact minutes', '2026-07-02T09:00:00+00:00', '2026-07-02T09:08:00+00:00', 'manual', 0, ?1, ?1)",
        )
        .bind(now)
        .execute(pool)
        .await
        .unwrap();
    }

    async fn export_doc(
        pool: &SqlitePool,
        dir: &std::path::Path,
        rounding: Rounding,
        from: Option<String>,
        to: Option<String>,
    ) -> serde_json::Value {
        let dest = dir.join("export.json");
        export_json_to(pool, &dest, rounding, from, to)
            .await
            .unwrap();
        let raw = std::fs::read_to_string(&dest).unwrap();
        serde_json::from_str(&raw).unwrap()
    }

    fn nearest_15() -> Rounding {
        Rounding {
            interval_minutes: 15,
            mode: RoundMode::Nearest,
        }
    }

    #[tokio::test]
    async fn exports_every_section_with_billable_and_raw_timestamps() {
        let (dir, db) = test_db().await;
        seed(&db.pool).await;
        let doc = export_doc(&db.pool, dir.path(), Rounding::off(), None, None).await;

        assert_eq!(doc["schemaVersion"], 1);
        // The DB seeds demo clients/projects — assert on the seeded rows
        // by id rather than by position.
        let clients = doc["clients"].as_array().unwrap();
        let acme = clients.iter().find(|c| c["id"] == "c1").unwrap();
        assert_eq!(acme["name"], "Acme");
        let tasks = doc["tasks"].as_array().unwrap();
        let audit = tasks.iter().find(|t| t["id"] == "t1").unwrap();
        assert_eq!(audit["name"], "Audit");
        assert_eq!(audit["projectId"], "p-bill");
        let projects = doc["projects"].as_array().unwrap();
        let billable_project = projects.iter().find(|p| p["id"] == "p-bill").unwrap();
        assert_eq!(billable_project["billableDefault"], true);
        assert_eq!(billable_project["clientId"], "c1");

        let entries = doc["entries"].as_array().unwrap();
        assert_eq!(entries.len(), 2);
        let e1 = entries.iter().find(|e| e["id"] == "e1").unwrap();
        assert_eq!(e1["billable"], true);
        assert_eq!(e1["startedAt"], "2026-07-01T09:00:00+00:00");
        assert_eq!(e1["endedAt"], "2026-07-01T09:08:00+00:00");
        assert_eq!(e1["durationSeconds"], 480);
        assert_eq!(e1["taskId"], "t1");
        let e2 = entries.iter().find(|e| e["id"] == "e2").unwrap();
        assert_eq!(e2["billable"], false);
    }

    #[tokio::test]
    async fn rounds_per_entry_but_never_the_raw_span() {
        let (dir, db) = test_db().await;
        seed(&db.pool).await;
        let doc = export_doc(&db.pool, dir.path(), nearest_15(), None, None).await;

        let entries = doc["entries"].as_array().unwrap();
        let e1 = entries.iter().find(|e| e["id"] == "e1").unwrap();
        // 7 min under nearest-15 → 15 min; the raw span stays 7 min.
        assert_eq!(e1["roundedDurationSeconds"], 900);
        assert_eq!(e1["durationSeconds"], 480);
        assert_eq!(e1["startedAt"], "2026-07-01T09:00:00+00:00");
        // The project-level "off" override beats the active global.
        let e2 = entries.iter().find(|e| e["id"] == "e2").unwrap();
        assert_eq!(e2["roundedDurationSeconds"], 480);
    }

    #[tokio::test]
    async fn range_filter_is_inclusive_from_exclusive_to() {
        let (dir, db) = test_db().await;
        seed(&db.pool).await;
        let doc = export_doc(
            &db.pool,
            dir.path(),
            Rounding::off(),
            Some("2026-07-01T09:00:00+00:00".into()),
            Some("2026-07-02T09:00:00+00:00".into()),
        )
        .await;
        let entries = doc["entries"].as_array().unwrap();
        assert_eq!(
            entries.len(),
            1,
            "e2 starts exactly at `to` and is excluded"
        );
        assert_eq!(entries[0]["id"], "e1");
        assert_eq!(doc["from"], "2026-07-01T09:00:00Z");
        assert_eq!(doc["to"], "2026-07-02T09:00:00Z");
    }

    #[tokio::test]
    async fn empty_range_still_yields_a_full_document() {
        let (dir, db) = test_db().await;
        seed(&db.pool).await;
        let doc = export_doc(
            &db.pool,
            dir.path(),
            Rounding::off(),
            Some("2030-01-01T00:00:00+00:00".into()),
            None,
        )
        .await;
        assert_eq!(doc["entries"].as_array().unwrap().len(), 0);
        assert_eq!(doc["schemaVersion"], 1);
        assert!(!doc["projects"].as_array().unwrap().is_empty());
    }

    #[tokio::test]
    async fn open_entries_measure_to_now_with_null_ended_at() {
        let (dir, db) = test_db().await;
        let started = (Utc::now() - chrono::Duration::minutes(30)).to_rfc3339();
        sqlx::query(
            "INSERT INTO entries (id, project_id, task_id, description, started_at, ended_at, source, created_at, updated_at) \
             VALUES ('open', NULL, NULL, 'running', ?1, NULL, 'manual', ?1, ?1)",
        )
        .bind(&started)
        .execute(&db.pool)
        .await
        .unwrap();
        let doc = export_doc(&db.pool, dir.path(), Rounding::off(), None, None).await;
        let entry = &doc["entries"][0];
        assert!(entry["endedAt"].is_null());
        let secs = entry["durationSeconds"].as_i64().unwrap();
        assert!((1790..=1810).contains(&secs), "got {secs}");
    }

    #[tokio::test]
    async fn rejects_inverted_ranges_and_bad_timestamps() {
        let (dir, db) = test_db().await;
        let dest = dir.path().join("nope.json");
        let inverted = export_json_to(
            &db.pool,
            &dest,
            Rounding::off(),
            Some("2026-07-02T00:00:00+00:00".into()),
            Some("2026-07-01T00:00:00+00:00".into()),
        )
        .await
        .unwrap_err();
        assert!(inverted.contains("strictly after"));

        let garbage = export_json_to(
            &db.pool,
            &dest,
            Rounding::off(),
            Some("not a date".into()),
            None,
        )
        .await
        .unwrap_err();
        assert!(garbage.contains("invalid from"));
        let garbage_to =
            export_json_to(&db.pool, &dest, Rounding::off(), None, Some("nope".into()))
                .await
                .unwrap_err();
        assert!(garbage_to.contains("invalid to"));
        assert!(!dest.exists(), "no file is written on a rejected range");
    }

    #[tokio::test]
    async fn surfaces_unparseable_stored_timestamps_as_errors() {
        let (dir, db) = test_db().await;
        sqlx::query(
            "INSERT INTO entries (id, project_id, task_id, description, started_at, ended_at, source, created_at, updated_at) \
             VALUES ('corrupt', NULL, NULL, '', 'not-a-date', NULL, 'manual', 'x', 'x')",
        )
        .execute(&db.pool)
        .await
        .unwrap();
        let dest = dir.path().join("bad.json");
        let e = export_json_to(&db.pool, &dest, Rounding::off(), None, None)
            .await
            .unwrap_err();
        assert!(e.contains("unparseable started_at"), "got: {e}");

        sqlx::query("UPDATE entries SET started_at = '2026-07-01T09:00:00+00:00', ended_at = 'also-bad' WHERE id = 'corrupt'")
            .execute(&db.pool)
            .await
            .unwrap();
        let e = export_json_to(&db.pool, &dest, Rounding::off(), None, None)
            .await
            .unwrap_err();
        assert!(e.contains("unparseable ended_at"), "got: {e}");
    }

    // Tauri's MockRuntime (mock_app_with_db) is unavailable on Windows.
    #[cfg(not(target_os = "windows"))]
    #[tokio::test]
    async fn export_entries_json_command_writes_a_file() {
        use tauri::Manager;
        let (dir, app, db) = crate::test_support::mock_app_with_db().await;
        seed(&db.pool).await;
        let state = app.state::<crate::AppState>();
        let dest = dir.path().join("cmd.json");
        let out = export_entries_json(state, dest.to_string_lossy().to_string(), None, None, None)
            .await
            .unwrap();
        assert!(out.contains("cmd.json"));
        let doc: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&dest).unwrap()).unwrap();
        assert_eq!(doc["schemaVersion"], 1);
        assert_eq!(doc["entries"].as_array().unwrap().len(), 2);
    }

    #[tokio::test]
    async fn suggested_json_name_is_dated() {
        let name = suggested_json_name().await;
        assert!(name.starts_with("cairn-export-"));
        assert!(name.ends_with(".json"));
    }

    #[tokio::test]
    async fn suggested_csv_name_is_dated() {
        // Came across from backup.rs untested, while its JSON counterpart
        // above always had one — the asymmetry codecov caught.
        let name = suggested_csv_name().await;
        assert!(name.starts_with("cairn-entries-"), "got {name}");
        assert!(name.ends_with(".csv"), "got {name}");
        // The date is what makes repeated exports distinguishable, so assert
        // it's actually there rather than just the affixes.
        assert!(
            name.contains(&chrono::Utc::now().format("%Y-%m-%d").to_string()),
            "got {name}"
        );
    }

    // ── CSV entries export (moved here from backup.rs, #276) ──────────

    async fn insert_entry_with_task(
        pool: &SqlitePool,
        description: &str,
        task_name: &str,
    ) -> String {
        let now = Utc::now().to_rfc3339();
        let task_id = uuid::Uuid::new_v4().to_string();
        sqlx::query(
            r#"INSERT INTO tasks (id, project_id, name, archived, created_at, updated_at)
               VALUES (?1, 'cairn', ?2, 0, ?3, ?3)"#,
        )
        .bind(&task_id)
        .bind(task_name)
        .bind(&now)
        .execute(pool)
        .await
        .unwrap();
        let id = uuid::Uuid::new_v4().to_string();
        sqlx::query(
            r#"INSERT INTO entries (id, project_id, task_id, description, started_at, ended_at, source, rule_id, created_at, updated_at)
               VALUES (?1, 'cairn', ?2, ?3, ?4, NULL, 'manual', NULL, ?4, ?4)"#,
        )
        .bind(&id)
        .bind(&task_id)
        .bind(description)
        .bind(&now)
        .execute(pool)
        .await
        .unwrap();
        id
    }

    #[test]
    fn csv_escapes_commas_and_quotes() {
        assert_eq!(csv_escape("plain"), "plain");
        assert_eq!(csv_escape("has,comma"), "\"has,comma\"");
        assert_eq!(csv_escape("has\"quote"), "\"has\"\"quote\"");
        assert_eq!(csv_escape("line\nbreak"), "\"line\nbreak\"");
    }

    #[tokio::test]
    async fn csv_has_one_row_per_entry_with_client_project_task_description() {
        let dir = tempfile::tempdir().unwrap();
        let db = Db::open(&db_path(dir.path())).await.unwrap();
        insert_entry(&db.pool, "lone description").await;
        insert_entry_with_task(&db.pool, "with-task description", "Bug fixing").await;

        let csv_path = dir.path().join("out.csv");
        export_csv_to(&db.pool, &csv_path, Rounding::off())
            .await
            .unwrap();

        let csv = tokio::fs::read_to_string(&csv_path).await.unwrap();
        let lines: Vec<&str> = csv.lines().collect();
        assert_eq!(lines[0], CSV_HEADER);
        // Header + one row per entry. No tag fan-out anymore.
        assert_eq!(lines.len(), 3);

        let with_task = lines
            .iter()
            .find(|l| l.contains("with-task description"))
            .unwrap();
        assert!(with_task.contains(",Bug fixing,"), "{with_task}");

        let lone = lines
            .iter()
            .find(|l| l.contains("lone description"))
            .unwrap();
        // Task field is empty when entry has no task_id.
        assert!(lone.contains(",,lone description,"), "{lone}");
    }

    #[tokio::test]
    async fn csv_header_matches_const_and_documented_columns() {
        let dir = tempfile::tempdir().unwrap();
        let db = Db::open(&db_path(dir.path())).await.unwrap();
        let csv_path = dir.path().join("header.csv");
        export_csv_to(&db.pool, &csv_path, Rounding::off())
            .await
            .unwrap();

        let csv = tokio::fs::read_to_string(&csv_path).await.unwrap();
        // The produced first line is exactly the source-of-truth const,
        // which docs/PRIVACY.md documents verbatim.
        assert_eq!(csv.lines().next().unwrap(), CSV_HEADER);
        for column in [
            "entry_id",
            "started_at",
            "ended_at",
            "duration_minutes",
            "client",
            "project",
            "task",
            "description",
            "source",
        ] {
            assert!(
                CSV_HEADER.split(',').any(|c| c == column),
                "documented column {column} missing from CSV_HEADER"
            );
        }
    }

    #[tokio::test]
    async fn csv_duration_column_respects_rounding() {
        let dir = tempfile::tempdir().unwrap();
        let db = Db::open(&db_path(dir.path())).await.unwrap();
        // A closed 8-minute entry.
        let id = uuid::Uuid::new_v4().to_string();
        sqlx::query(
            r#"INSERT INTO entries (id, project_id, task_id, description, started_at, ended_at, source, rule_id, created_at, updated_at)
               VALUES (?1, NULL, NULL, 'eight minutes', '2026-05-25T09:00:00+00:00', '2026-05-25T09:08:00+00:00', 'manual', NULL, '2026-05-25T09:00:00+00:00', '2026-05-25T09:08:00+00:00')"#,
        )
        .bind(&id)
        .execute(&db.pool)
        .await
        .unwrap();

        // duration_minutes is the 4th column (index 3).
        let duration_col = |csv: &str| -> String {
            csv.lines()
                .nth(1)
                .unwrap()
                .split(',')
                .nth(3)
                .unwrap()
                .to_string()
        };

        let p_off = dir.path().join("off.csv");
        export_csv_to(&db.pool, &p_off, Rounding::off())
            .await
            .unwrap();
        assert_eq!(
            duration_col(&tokio::fs::read_to_string(&p_off).await.unwrap()),
            "8"
        );

        let r15 = Rounding {
            interval_minutes: 15,
            mode: crate::rounding::RoundMode::Nearest,
        };
        let p_on = dir.path().join("on.csv");
        export_csv_to(&db.pool, &p_on, r15).await.unwrap();
        assert_eq!(
            duration_col(&tokio::fs::read_to_string(&p_on).await.unwrap()),
            "15"
        );
    }

    #[test]
    fn csv_duration_minutes_handles_open_and_unparseable() {
        let now = DateTime::parse_from_rfc3339("2026-05-25T10:00:00+00:00")
            .unwrap()
            .with_timezone(&Utc);
        let off = Rounding::off();
        let start = "2026-05-25T09:00:00+00:00";
        // Closed 8-minute entry.
        assert_eq!(
            csv_duration_minutes(start, Some("2026-05-25T09:08:00+00:00"), now, off),
            "8"
        );
        // Open entry measures to `now` (60 minutes).
        assert_eq!(csv_duration_minutes(start, None, now, off), "60");
        // Unparseable start or end degrades to an empty cell.
        assert_eq!(csv_duration_minutes("nope", Some(start), now, off), "");
        assert_eq!(csv_duration_minutes(start, Some("nope"), now, off), "");
    }

    // Tauri's MockRuntime (mock_app_with_db) is unavailable on Windows.
    #[cfg(not(target_os = "windows"))]
    #[tokio::test]
    async fn export_csv_command_writes_a_file() {
        let (dir, app, _db) = crate::test_support::mock_app_with_db().await;
        let state = app.state::<crate::AppState>();
        let dest = dir.path().join("cmd.csv");
        let out = export_csv(state, dest.to_string_lossy().to_string(), None)
            .await
            .unwrap();
        assert!(out.contains("cmd.csv"));
        assert!(tokio::fs::try_exists(&dest).await.unwrap());
    }

    // ── Shared span core (#276) ───────────────────────────────────────

    #[test]
    fn span_seconds_measures_a_closed_entry() {
        let start = parse_ts("2026-05-25T09:00:00+00:00").unwrap();
        let end = parse_ts("2026-05-25T09:08:00+00:00").unwrap();
        let now = parse_ts("2026-05-25T12:00:00+00:00").unwrap();
        assert_eq!(span_seconds(start, Some(end), now), 480);
    }

    #[test]
    fn span_seconds_measures_an_open_entry_to_now() {
        let start = parse_ts("2026-05-25T09:00:00+00:00").unwrap();
        let now = parse_ts("2026-05-25T10:00:00+00:00").unwrap();
        assert_eq!(span_seconds(start, None, now), 3600);
    }

    #[test]
    fn span_seconds_clamps_a_backwards_span_to_zero() {
        // Clock skew or a bad row. Before #276 the CSV path didn't clamp and
        // could emit a negative duration_minutes; the JSON path always did.
        // Both go through this now.
        let start = parse_ts("2026-05-25T10:00:00+00:00").unwrap();
        let end = parse_ts("2026-05-25T09:00:00+00:00").unwrap();
        let now = parse_ts("2026-05-25T12:00:00+00:00").unwrap();
        assert_eq!(span_seconds(start, Some(end), now), 0);
    }

    #[tokio::test]
    async fn csv_duration_never_goes_negative() {
        // The user-visible half of the clamp above: a backwards entry reports
        // 0, not "-60", in the column a spreadsheet will sum.
        let now = Utc::now();
        assert_eq!(
            csv_duration_minutes(
                "2026-05-25T10:00:00+00:00",
                Some("2026-05-25T09:00:00+00:00"),
                now,
                Rounding::off(),
            ),
            "0"
        );
    }

    #[tokio::test]
    async fn both_exports_agree_on_the_same_entry_duration() {
        // The point of sharing `span_seconds`: CSV minutes and JSON seconds
        // are two renderings of one measurement, and must not drift.
        let (_dir, db) = test_db().await;
        sqlx::query(
            r#"INSERT INTO entries (id, project_id, task_id, description, started_at, ended_at, source, rule_id, created_at, updated_at)
               VALUES ('e-dur', NULL, NULL, 'span', '2026-05-25T09:00:00+00:00', '2026-05-25T09:30:00+00:00', 'manual', NULL, '2026-05-25T09:00:00+00:00', '2026-05-25T09:00:00+00:00')"#,
        )
        .execute(&db.pool)
        .await
        .unwrap();

        let dir = tempfile::tempdir().unwrap();
        let csv_path = dir.path().join("e.csv");
        export_csv_to(&db.pool, &csv_path, Rounding::off())
            .await
            .unwrap();
        let csv = tokio::fs::read_to_string(&csv_path).await.unwrap();
        let minutes: i64 = csv
            .lines()
            .nth(1)
            .unwrap()
            .split(',')
            .nth(3)
            .unwrap()
            .parse()
            .unwrap();

        let json_path = dir.path().join("e.json");
        export_json_to(&db.pool, &json_path, Rounding::off(), None, None)
            .await
            .unwrap();
        let doc: serde_json::Value =
            serde_json::from_slice(&tokio::fs::read(&json_path).await.unwrap()).unwrap();
        let seconds = doc["entries"][0]["durationSeconds"].as_i64().unwrap();

        assert_eq!(seconds, 1800);
        assert_eq!(minutes, seconds / 60);
    }

    // ── Write-path failures (#276) ────────────────────────────────────
    //
    // Both exports write to a path the user picked in a save dialog, so an
    // unwritable destination is a real outcome, not a hypothetical. Each
    // must surface it as an error rather than reporting a successful export
    // that wrote nothing.

    #[tokio::test]
    async fn csv_export_errors_when_the_parent_cannot_be_created() {
        let (_dir, db) = test_db().await;
        let tmp = tempfile::tempdir().unwrap();
        // A *file* where the export wants a directory.
        let blocker = tmp.path().join("blocker");
        tokio::fs::write(&blocker, b"x").await.unwrap();

        let err = export_csv_to(&db.pool, &blocker.join("out.csv"), Rounding::off())
            .await
            .unwrap_err();
        assert!(!err.is_empty(), "the failure is reported, not swallowed");
    }

    #[tokio::test]
    async fn csv_export_errors_when_the_destination_is_a_directory() {
        let (_dir, db) = test_db().await;
        let tmp = tempfile::tempdir().unwrap();
        let as_dir = tmp.path().join("out.csv");
        tokio::fs::create_dir(&as_dir).await.unwrap();

        assert!(export_csv_to(&db.pool, &as_dir, Rounding::off())
            .await
            .is_err());
    }

    #[tokio::test]
    async fn json_export_errors_when_the_parent_cannot_be_created() {
        let (_dir, db) = test_db().await;
        let tmp = tempfile::tempdir().unwrap();
        let blocker = tmp.path().join("blocker");
        tokio::fs::write(&blocker, b"x").await.unwrap();

        let err = export_json_to(
            &db.pool,
            &blocker.join("out.json"),
            Rounding::off(),
            None,
            None,
        )
        .await
        .unwrap_err();
        assert!(!err.is_empty());
    }

    #[tokio::test]
    async fn json_export_errors_when_the_destination_is_a_directory() {
        let (_dir, db) = test_db().await;
        let tmp = tempfile::tempdir().unwrap();
        let as_dir = tmp.path().join("out.json");
        tokio::fs::create_dir(&as_dir).await.unwrap();

        assert!(
            export_json_to(&db.pool, &as_dir, Rounding::off(), None, None)
                .await
                .is_err()
        );
    }
}
