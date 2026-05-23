use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::Row;
use tauri::{Manager, State};

use crate::AppState;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Project {
    pub id: String,
    pub name: String,
    pub client: Option<String>,
    pub color: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub id: String,
    pub project_id: Option<String>,
    pub task: String,
    pub started_at: DateTime<Utc>,
    pub ended_at: Option<DateTime<Utc>>,
    pub source: String,
    pub rule_id: Option<String>,
    pub tags: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Rule {
    pub id: String,
    pub name: String,
    pub enabled: bool,
    pub priority: i64,
    pub body: serde_json::Value,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartEntryInput {
    pub project_id: Option<String>,
    pub task: String,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub source: Option<String>,
    #[serde(default)]
    pub rule_id: Option<String>,
}

#[tauri::command]
pub async fn list_projects(state: State<'_, AppState>) -> Result<Vec<Project>, String> {
    let rows = sqlx::query(
        "SELECT id, name, client, color FROM projects WHERE archived = 0 ORDER BY name",
    )
    .fetch_all(&state.db.pool)
    .await
    .map_err(err)?;
    Ok(rows
        .into_iter()
        .map(|r| Project {
            id: r.get("id"),
            name: r.get("name"),
            client: r.get("client"),
            color: r.get("color"),
        })
        .collect())
}

#[tauri::command]
pub async fn list_today(state: State<'_, AppState>) -> Result<Vec<Entry>, String> {
    let start_of_day = Utc::now()
        .date_naive()
        .and_hms_opt(0, 0, 0)
        .expect("00:00:00 is valid")
        .and_utc();

    let rows = sqlx::query(
        r#"
        SELECT id, project_id, task, started_at, ended_at, source, rule_id
          FROM entries
         WHERE started_at >= ?1
         ORDER BY started_at ASC
        "#,
    )
    .bind(start_of_day.to_rfc3339())
    .fetch_all(&state.db.pool)
    .await
    .map_err(err)?;

    let mut entries = Vec::with_capacity(rows.len());
    for row in rows {
        let id: String = row.get("id");
        let tags = load_tags(&state.db.pool, &id).await?;
        entries.push(Entry {
            id,
            project_id: row.get("project_id"),
            task: row.get("task"),
            started_at: parse_ts(row.get::<String, _>("started_at"))?,
            ended_at: row
                .get::<Option<String>, _>("ended_at")
                .map(parse_ts)
                .transpose()?,
            source: row.get("source"),
            rule_id: row.get("rule_id"),
            tags,
        });
    }
    Ok(entries)
}

#[tauri::command]
pub async fn list_rules(state: State<'_, AppState>) -> Result<Vec<Rule>, String> {
    let rows =
        sqlx::query("SELECT id, name, enabled, priority, body FROM rules ORDER BY priority ASC")
            .fetch_all(&state.db.pool)
            .await
            .map_err(err)?;
    rows.into_iter()
        .map(|r| {
            let body_str: String = r.get("body");
            Ok(Rule {
                id: r.get("id"),
                name: r.get("name"),
                enabled: r.get::<i64, _>("enabled") != 0,
                priority: r.get("priority"),
                body: serde_json::from_str(&body_str).map_err(err)?,
            })
        })
        .collect()
}

#[tauri::command]
pub async fn current_running(state: State<'_, AppState>) -> Result<Option<Entry>, String> {
    let row = sqlx::query(
        r#"
        SELECT id, project_id, task, started_at, ended_at, source, rule_id
          FROM entries
         WHERE ended_at IS NULL
         ORDER BY started_at DESC
         LIMIT 1
        "#,
    )
    .fetch_optional(&state.db.pool)
    .await
    .map_err(err)?;

    let Some(row) = row else { return Ok(None) };
    let id: String = row.get("id");
    let tags = load_tags(&state.db.pool, &id).await?;
    Ok(Some(Entry {
        id,
        project_id: row.get("project_id"),
        task: row.get("task"),
        started_at: parse_ts(row.get::<String, _>("started_at"))?,
        ended_at: row
            .get::<Option<String>, _>("ended_at")
            .map(parse_ts)
            .transpose()?,
        source: row.get("source"),
        rule_id: row.get("rule_id"),
        tags,
    }))
}

#[tauri::command]
pub async fn start_entry(
    state: State<'_, AppState>,
    input: StartEntryInput,
) -> Result<Entry, String> {
    let now = Utc::now();
    let now_str = now.to_rfc3339();

    let mut tx = state.db.pool.begin().await.map_err(err)?;

    // Close any currently-running entry so we never have two timers
    // counting at once. Mirrors the "Stop" button in the UI.
    sqlx::query("UPDATE entries SET ended_at = ?1, updated_at = ?1 WHERE ended_at IS NULL")
        .bind(&now_str)
        .execute(&mut *tx)
        .await
        .map_err(err)?;

    let id = uuid::Uuid::new_v4().to_string();
    let source = input.source.clone().unwrap_or_else(|| "manual".into());
    sqlx::query(
        r#"
        INSERT INTO entries (id, project_id, task, started_at, ended_at, source, rule_id, created_at, updated_at)
        VALUES (?1, ?2, ?3, ?4, NULL, ?5, ?6, ?4, ?4)
        "#,
    )
    .bind(&id)
    .bind(&input.project_id)
    .bind(&input.task)
    .bind(&now_str)
    .bind(&source)
    .bind(&input.rule_id)
    .execute(&mut *tx)
    .await
    .map_err(err)?;

    for tag in &input.tags {
        let tag_id = upsert_tag(&mut tx, tag).await?;
        sqlx::query("INSERT OR IGNORE INTO entry_tags (entry_id, tag_id) VALUES (?1, ?2)")
            .bind(&id)
            .bind(&tag_id)
            .execute(&mut *tx)
            .await
            .map_err(err)?;
    }

    tx.commit().await.map_err(err)?;

    Ok(Entry {
        id,
        project_id: input.project_id,
        task: input.task,
        started_at: now,
        ended_at: None,
        source,
        rule_id: input.rule_id,
        tags: input.tags,
    })
}

#[tauri::command]
pub async fn stop_entry(state: State<'_, AppState>, id: String) -> Result<Entry, String> {
    let now = Utc::now();
    let now_str = now.to_rfc3339();

    let affected = sqlx::query(
        "UPDATE entries SET ended_at = ?1, updated_at = ?1 WHERE id = ?2 AND ended_at IS NULL",
    )
    .bind(&now_str)
    .bind(&id)
    .execute(&state.db.pool)
    .await
    .map_err(err)?
    .rows_affected();

    if affected == 0 {
        return Err(format!("no running entry with id {id}"));
    }

    let row = sqlx::query(
        "SELECT id, project_id, task, started_at, ended_at, source, rule_id FROM entries WHERE id = ?1",
    )
    .bind(&id)
    .fetch_one(&state.db.pool)
    .await
    .map_err(err)?;

    let tags = load_tags(&state.db.pool, &id).await?;
    Ok(Entry {
        id,
        project_id: row.get("project_id"),
        task: row.get("task"),
        started_at: parse_ts(row.get::<String, _>("started_at"))?,
        ended_at: row
            .get::<Option<String>, _>("ended_at")
            .map(parse_ts)
            .transpose()?,
        source: row.get("source"),
        rule_id: row.get("rule_id"),
        tags,
    })
}

#[tauri::command]
pub async fn hide_popover(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("popover") {
        window.hide().map_err(err)?;
    }
    Ok(())
}

async fn load_tags(pool: &sqlx::SqlitePool, entry_id: &str) -> Result<Vec<String>, String> {
    let rows = sqlx::query(
        r#"
        SELECT t.name
          FROM tags t
          JOIN entry_tags et ON et.tag_id = t.id
         WHERE et.entry_id = ?1
         ORDER BY t.name
        "#,
    )
    .bind(entry_id)
    .fetch_all(pool)
    .await
    .map_err(err)?;
    Ok(rows
        .into_iter()
        .map(|r| r.get::<String, _>("name"))
        .collect())
}

async fn upsert_tag(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    name: &str,
) -> Result<String, String> {
    if let Some(row) = sqlx::query("SELECT id FROM tags WHERE name = ?1")
        .bind(name)
        .fetch_optional(&mut **tx)
        .await
        .map_err(err)?
    {
        return Ok(row.get("id"));
    }
    let id = uuid::Uuid::new_v4().to_string();
    sqlx::query("INSERT INTO tags (id, name) VALUES (?1, ?2)")
        .bind(&id)
        .bind(name)
        .execute(&mut **tx)
        .await
        .map_err(err)?;
    Ok(id)
}

fn parse_ts<S: AsRef<str>>(s: S) -> Result<DateTime<Utc>, String> {
    DateTime::parse_from_rfc3339(s.as_ref())
        .map(|d| d.with_timezone(&Utc))
        .map_err(|e| e.to_string())
}

fn err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

#[cfg(test)]
#[cfg(not(target_os = "windows"))]
mod tests {
    use super::*;
    use crate::test_support::mock_app_with_db;
    use tauri::Manager;

    #[tokio::test]
    async fn list_projects_returns_seeded_projects() {
        let (_dir, app, _db) = mock_app_with_db().await;
        let state = app.state::<crate::AppState>();
        let projects = list_projects(state).await.unwrap();
        assert!(!projects.is_empty(), "seed must insert default projects");
        assert!(projects.iter().any(|p| p.name == "Cairn"));
    }

    #[tokio::test]
    async fn list_today_is_empty_on_fresh_db() {
        let (_dir, app, _db) = mock_app_with_db().await;
        let state = app.state::<crate::AppState>();
        let today = list_today(state).await.unwrap();
        assert!(today.is_empty());
    }

    #[tokio::test]
    async fn list_rules_is_empty_on_fresh_db() {
        let (_dir, app, _db) = mock_app_with_db().await;
        let state = app.state::<crate::AppState>();
        let rules = list_rules(state).await.unwrap();
        assert!(rules.is_empty());
    }

    #[tokio::test]
    async fn current_running_is_none_on_fresh_db() {
        let (_dir, app, _db) = mock_app_with_db().await;
        let state = app.state::<crate::AppState>();
        let running = current_running(state).await.unwrap();
        assert!(running.is_none());
    }

    #[tokio::test]
    async fn start_entry_creates_a_running_entry_with_tags() {
        let (_dir, app, _db) = mock_app_with_db().await;
        let state = app.state::<crate::AppState>();
        let entry = start_entry(
            state.clone(),
            StartEntryInput {
                project_id: Some("cairn".into()),
                task: "Rule preview UI".into(),
                tags: vec!["dev".into(), "ui".into()],
                source: Some("manual".into()),
                rule_id: None,
            },
        )
        .await
        .unwrap();
        assert!(entry.ended_at.is_none());
        assert_eq!(entry.task, "Rule preview UI");
        assert_eq!(entry.tags, vec!["dev".to_string(), "ui".to_string()]);

        // current_running now reflects this entry.
        let running = current_running(state.clone()).await.unwrap().unwrap();
        assert_eq!(running.id, entry.id);
        assert_eq!(running.tags, vec!["dev".to_string(), "ui".to_string()]);

        // list_today includes it.
        let today = list_today(state).await.unwrap();
        assert_eq!(today.len(), 1);
    }

    #[tokio::test]
    async fn start_entry_closes_the_previously_running_one() {
        let (_dir, app, _db) = mock_app_with_db().await;
        let state = app.state::<crate::AppState>();
        let first = start_entry(
            state.clone(),
            StartEntryInput {
                project_id: Some("cairn".into()),
                task: "first".into(),
                tags: vec![],
                source: None,
                rule_id: None,
            },
        )
        .await
        .unwrap();
        let second = start_entry(
            state.clone(),
            StartEntryInput {
                project_id: Some("acme".into()),
                task: "second".into(),
                tags: vec![],
                source: None,
                rule_id: None,
            },
        )
        .await
        .unwrap();
        assert_ne!(first.id, second.id);

        // Only the second is still running.
        let running = current_running(state.clone()).await.unwrap().unwrap();
        assert_eq!(running.id, second.id);

        // The first now has ended_at set.
        let today = list_today(state).await.unwrap();
        let first_after = today.iter().find(|e| e.id == first.id).unwrap();
        assert!(first_after.ended_at.is_some());
    }

    #[tokio::test]
    async fn stop_entry_marks_the_entry_ended() {
        let (_dir, app, _db) = mock_app_with_db().await;
        let state = app.state::<crate::AppState>();
        let entry = start_entry(
            state.clone(),
            StartEntryInput {
                project_id: None,
                task: "x".into(),
                tags: vec![],
                source: None,
                rule_id: None,
            },
        )
        .await
        .unwrap();
        let stopped = stop_entry(state.clone(), entry.id.clone()).await.unwrap();
        assert!(stopped.ended_at.is_some());

        let running = current_running(state).await.unwrap();
        assert!(running.is_none());
    }

    #[tokio::test]
    async fn stop_entry_fails_for_unknown_id() {
        let (_dir, app, _db) = mock_app_with_db().await;
        let state = app.state::<crate::AppState>();
        let result = stop_entry(state, "does-not-exist".into()).await;
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("does-not-exist"));
    }

    #[test]
    fn parse_ts_round_trips_rfc3339() {
        let t = "2026-05-23T10:00:00+00:00";
        let parsed = parse_ts(t).unwrap();
        assert_eq!(parsed.to_rfc3339(), t);
    }

    #[test]
    fn parse_ts_rejects_garbage() {
        assert!(parse_ts("not a date").is_err());
    }
}
