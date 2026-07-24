//! Versioned structured JSON export — the stable contract the billing
//! plugin (#109) and any other downstream consumer reads instead of
//! touching the database. Bump `SCHEMA_VERSION` on any breaking change
//! to the document shape; additive fields are non-breaking.
//!
//! Durations carry both lenses: `duration_seconds` is the raw span and
//! `rounded_duration_seconds` applies the user's rounding preference
//! (#107, per-project overrides included) — consumers must pick one and
//! never round an already-rounded value.

use std::path::Path;

use chrono::{DateTime, Utc};
use serde::Serialize;
use sqlx::{Row, SqlitePool};
use tauri::State;

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
        let ended = match &ended_at {
            Some(s) => {
                parse_ts(s).map_err(|e| format!("entry {id} has unparseable ended_at: {e}"))?
            }
            None => now,
        };
        let duration_seconds = (ended - started).num_seconds().max(0);
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

    ensure_parent_dir(dest).await?;
    let json = serde_json::to_vec_pretty(&doc).map_err(err)?;
    tokio::fs::write(dest, &json).await.map_err(err)?;
    Ok(())
}

#[tauri::command]
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rounding::RoundMode;
    use crate::test_support::test_db;

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
}
