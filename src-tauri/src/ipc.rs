use chrono::{DateTime, Datelike, Duration, Local, NaiveDate, Utc, Weekday};
use serde::{Deserialize, Serialize};
use sqlx::Row;
use tauri::{Manager, State};

use crate::signals::calendar::{ActiveEvent, CalendarKind, CalendarSource, SyncStatus};
use crate::AppState;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Client {
    pub id: String,
    pub name: String,
    pub color: Option<String>,
    pub archived: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientInput {
    #[serde(default)]
    pub id: Option<String>,
    pub name: String,
    #[serde(default)]
    pub color: Option<String>,
    #[serde(default)]
    pub archived: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub id: String,
    pub name: String,
    pub client_id: Option<String>,
    pub color: String,
    pub archived: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectInput {
    #[serde(default)]
    pub id: Option<String>,
    pub name: String,
    #[serde(default)]
    pub client_id: Option<String>,
    pub color: String,
    #[serde(default)]
    pub archived: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Task {
    pub id: String,
    pub project_id: String,
    pub name: String,
    pub archived: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskInput {
    #[serde(default)]
    pub id: Option<String>,
    pub project_id: String,
    pub name: String,
    #[serde(default)]
    pub archived: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub id: String,
    pub project_id: Option<String>,
    pub task_id: Option<String>,
    pub description: String,
    pub started_at: DateTime<Utc>,
    pub ended_at: Option<DateTime<Utc>>,
    pub source: String,
    pub rule_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Exclusion {
    pub id: String,
    pub kind: String,
    pub value: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExclusionInput {
    pub kind: String,
    pub value: String,
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
pub struct RuleInput {
    /// `None` to create a new rule; `Some` to upsert an existing one.
    #[serde(default)]
    pub id: Option<String>,
    pub name: String,
    pub enabled: bool,
    pub priority: i64,
    pub body: serde_json::Value,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WeekDayAgg {
    pub day: String,
    pub date: String,
    pub hours: f64,
    pub segments: Vec<(String, f64)>,
    pub today: bool,
    pub future: bool,
    pub weekend: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartEntryInput {
    pub project_id: Option<String>,
    #[serde(default)]
    pub task_id: Option<String>,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub source: Option<String>,
    #[serde(default)]
    pub rule_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateEntryInput {
    pub id: String,
    #[serde(default)]
    pub project_id: Option<Option<String>>,
    #[serde(default)]
    pub task_id: Option<Option<String>>,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub started_at: Option<String>,
    #[serde(default)]
    pub ended_at: Option<Option<String>>,
}

#[tauri::command]
pub async fn list_clients(state: State<'_, AppState>) -> Result<Vec<Client>, String> {
    let rows = sqlx::query(
        "SELECT id, name, color, archived FROM clients ORDER BY archived ASC, name ASC",
    )
    .fetch_all(&state.db.pool)
    .await
    .map_err(err)?;
    Ok(rows
        .into_iter()
        .map(|r| Client {
            id: r.get("id"),
            name: r.get("name"),
            color: r.get("color"),
            archived: r.get::<i64, _>("archived") != 0,
        })
        .collect())
}

#[tauri::command]
pub async fn save_client(
    state: State<'_, AppState>,
    client: ClientInput,
) -> Result<Client, String> {
    let id = client
        .id
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let now = Utc::now().to_rfc3339();
    sqlx::query(
        r#"
        INSERT INTO clients (id, name, color, archived, created_at, updated_at)
        VALUES (?1, ?2, ?3, ?4, ?5, ?5)
        ON CONFLICT(id) DO UPDATE SET
            name = excluded.name,
            color = excluded.color,
            archived = excluded.archived,
            updated_at = excluded.updated_at
        "#,
    )
    .bind(&id)
    .bind(&client.name)
    .bind(&client.color)
    .bind(client.archived as i64)
    .bind(&now)
    .execute(&state.db.pool)
    .await
    .map_err(err)?;
    Ok(Client {
        id,
        name: client.name,
        color: client.color,
        archived: client.archived,
    })
}

#[tauri::command]
pub async fn delete_client(state: State<'_, AppState>, id: String) -> Result<(), String> {
    sqlx::query("DELETE FROM clients WHERE id = ?1")
        .bind(&id)
        .execute(&state.db.pool)
        .await
        .map_err(err)?;
    Ok(())
}

#[tauri::command]
pub async fn list_projects(state: State<'_, AppState>) -> Result<Vec<Project>, String> {
    let rows = sqlx::query(
        "SELECT id, name, client_id, color, archived FROM projects WHERE archived = 0 ORDER BY name",
    )
    .fetch_all(&state.db.pool)
    .await
    .map_err(err)?;
    Ok(rows
        .into_iter()
        .map(|r| Project {
            id: r.get("id"),
            name: r.get("name"),
            client_id: r.get("client_id"),
            color: r.get("color"),
            archived: r.get::<i64, _>("archived") != 0,
        })
        .collect())
}

#[tauri::command]
pub async fn save_project(
    state: State<'_, AppState>,
    project: ProjectInput,
) -> Result<Project, String> {
    let id = project
        .id
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let now = Utc::now().to_rfc3339();
    sqlx::query(
        r#"
        INSERT INTO projects (id, name, client_id, color, archived, created_at, updated_at)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)
        ON CONFLICT(id) DO UPDATE SET
            name = excluded.name,
            client_id = excluded.client_id,
            color = excluded.color,
            archived = excluded.archived,
            updated_at = excluded.updated_at
        "#,
    )
    .bind(&id)
    .bind(&project.name)
    .bind(&project.client_id)
    .bind(&project.color)
    .bind(project.archived as i64)
    .bind(&now)
    .execute(&state.db.pool)
    .await
    .map_err(err)?;
    Ok(Project {
        id,
        name: project.name,
        client_id: project.client_id,
        color: project.color,
        archived: project.archived,
    })
}

#[tauri::command]
pub async fn delete_project(state: State<'_, AppState>, id: String) -> Result<(), String> {
    sqlx::query("DELETE FROM projects WHERE id = ?1")
        .bind(&id)
        .execute(&state.db.pool)
        .await
        .map_err(err)?;
    Ok(())
}

#[tauri::command]
pub async fn list_tasks(
    state: State<'_, AppState>,
    project_id: Option<String>,
) -> Result<Vec<Task>, String> {
    let rows = match project_id {
        Some(pid) => {
            sqlx::query(
                "SELECT id, project_id, name, archived FROM tasks WHERE project_id = ?1 AND archived = 0 ORDER BY name",
            )
            .bind(&pid)
            .fetch_all(&state.db.pool)
            .await
        }
        None => {
            sqlx::query(
                "SELECT id, project_id, name, archived FROM tasks WHERE archived = 0 ORDER BY project_id, name",
            )
            .fetch_all(&state.db.pool)
            .await
        }
    }
    .map_err(err)?;
    Ok(rows
        .into_iter()
        .map(|r| Task {
            id: r.get("id"),
            project_id: r.get("project_id"),
            name: r.get("name"),
            archived: r.get::<i64, _>("archived") != 0,
        })
        .collect())
}

#[tauri::command]
pub async fn save_task(state: State<'_, AppState>, task: TaskInput) -> Result<Task, String> {
    let id = task.id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let now = Utc::now().to_rfc3339();
    sqlx::query(
        r#"
        INSERT INTO tasks (id, project_id, name, archived, created_at, updated_at)
        VALUES (?1, ?2, ?3, ?4, ?5, ?5)
        ON CONFLICT(id) DO UPDATE SET
            project_id = excluded.project_id,
            name = excluded.name,
            archived = excluded.archived,
            updated_at = excluded.updated_at
        "#,
    )
    .bind(&id)
    .bind(&task.project_id)
    .bind(&task.name)
    .bind(task.archived as i64)
    .bind(&now)
    .execute(&state.db.pool)
    .await
    .map_err(err)?;
    Ok(Task {
        id,
        project_id: task.project_id,
        name: task.name,
        archived: task.archived,
    })
}

#[tauri::command]
pub async fn delete_task(state: State<'_, AppState>, id: String) -> Result<(), String> {
    sqlx::query("DELETE FROM tasks WHERE id = ?1")
        .bind(&id)
        .execute(&state.db.pool)
        .await
        .map_err(err)?;
    Ok(())
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
        SELECT id, project_id, task_id, description, started_at, ended_at, source, rule_id
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
        entries.push(Entry {
            id: row.get("id"),
            project_id: row.get("project_id"),
            task_id: row.get("task_id"),
            description: row.get("description"),
            started_at: parse_ts(row.get::<String, _>("started_at"))?,
            ended_at: row
                .get::<Option<String>, _>("ended_at")
                .map(parse_ts)
                .transpose()?,
            source: row.get("source"),
            rule_id: row.get("rule_id"),
        });
    }
    Ok(entries)
}

#[tauri::command]
pub async fn list_week(state: State<'_, AppState>) -> Result<Vec<WeekDayAgg>, String> {
    // This Monday in the user's local timezone.
    let today_local = Local::now().date_naive();
    let monday = monday_of(today_local);
    let week_end = monday + Duration::days(7);

    let start_utc = local_midnight_utc(monday);
    let end_utc = local_midnight_utc(week_end);

    let rows = sqlx::query(
        r#"
        SELECT project_id, started_at, ended_at
          FROM entries
         WHERE started_at >= ?1 AND started_at < ?2
        "#,
    )
    .bind(start_utc.to_rfc3339())
    .bind(end_utc.to_rfc3339())
    .fetch_all(&state.db.pool)
    .await
    .map_err(err)?;

    // Accumulator: day_offset (0=Mon..6=Sun) -> project_id -> hours
    let mut buckets: [std::collections::BTreeMap<String, f64>; 7] = Default::default();
    let now_utc = Utc::now();

    for row in rows {
        let project_id: Option<String> = row.get("project_id");
        let started_at: String = row.get("started_at");
        let ended_at: Option<String> = row.get("ended_at");
        let start = parse_ts(started_at)?;
        let end = match ended_at {
            Some(s) => parse_ts(s)?,
            None => now_utc,
        };
        if end <= start {
            continue;
        }
        let local_date = start.with_timezone(&Local).date_naive();
        let offset = (local_date - monday).num_days();
        if !(0..7).contains(&offset) {
            continue;
        }
        let hours = (end - start).num_seconds() as f64 / 3600.0;
        let key = project_id.unwrap_or_else(|| "_none".into());
        *buckets[offset as usize].entry(key).or_insert(0.0) += hours;
    }

    let labels = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
    let mut out = Vec::with_capacity(7);
    for (i, label) in labels.iter().enumerate() {
        let date = monday + Duration::days(i as i64);
        let segments: Vec<(String, f64)> = buckets[i]
            .iter()
            .map(|(k, v)| (k.clone(), round2(*v)))
            .collect();
        let hours: f64 = segments.iter().map(|(_, h)| h).sum();
        out.push(WeekDayAgg {
            day: label.to_string(),
            date: date.to_string(),
            hours: round2(hours),
            segments,
            today: date == today_local,
            future: date > today_local,
            weekend: matches!(date.weekday(), Weekday::Sat | Weekday::Sun),
        });
    }
    Ok(out)
}

fn monday_of(d: NaiveDate) -> NaiveDate {
    let offset = d.weekday().num_days_from_monday() as i64;
    d - Duration::days(offset)
}

fn local_midnight_utc(d: NaiveDate) -> DateTime<Utc> {
    let naive = d.and_hms_opt(0, 0, 0).expect("00:00:00 is valid");
    let local_midnight = naive
        .and_local_timezone(Local)
        .single()
        .unwrap_or_else(|| naive.and_utc().with_timezone(&Local));
    local_midnight.with_timezone(&Utc)
}

fn round2(v: f64) -> f64 {
    (v * 100.0).round() / 100.0
}

#[tauri::command]
pub async fn save_rule(state: State<'_, AppState>, rule: RuleInput) -> Result<Rule, String> {
    let id = rule.id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let now = Utc::now().to_rfc3339();
    let body_str = serde_json::to_string(&rule.body).map_err(err)?;

    sqlx::query(
        r#"
        INSERT INTO rules (id, name, enabled, priority, body, created_at, updated_at)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)
        ON CONFLICT(id) DO UPDATE SET
            name = excluded.name,
            enabled = excluded.enabled,
            priority = excluded.priority,
            body = excluded.body,
            updated_at = excluded.updated_at
        "#,
    )
    .bind(&id)
    .bind(&rule.name)
    .bind(rule.enabled as i64)
    .bind(rule.priority)
    .bind(&body_str)
    .bind(&now)
    .execute(&state.db.pool)
    .await
    .map_err(err)?;

    Ok(Rule {
        id,
        name: rule.name,
        enabled: rule.enabled,
        priority: rule.priority,
        body: rule.body,
    })
}

#[tauri::command]
pub async fn delete_rule(state: State<'_, AppState>, id: String) -> Result<(), String> {
    sqlx::query("DELETE FROM rules WHERE id = ?1")
        .bind(&id)
        .execute(&state.db.pool)
        .await
        .map_err(err)?;
    Ok(())
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
pub async fn list_exclusions(state: State<'_, AppState>) -> Result<Vec<Exclusion>, String> {
    let rows = sqlx::query("SELECT id, kind, value FROM exclusions ORDER BY kind ASC, value ASC")
        .fetch_all(&state.db.pool)
        .await
        .map_err(err)?;
    Ok(rows
        .into_iter()
        .map(|r| Exclusion {
            id: r.get("id"),
            kind: r.get("kind"),
            value: r.get("value"),
        })
        .collect())
}

#[tauri::command]
pub async fn save_exclusion(
    state: State<'_, AppState>,
    input: ExclusionInput,
) -> Result<Exclusion, String> {
    let value = input.value.trim().to_string();
    if value.is_empty() {
        return Err("value cannot be empty".into());
    }
    let kind = input.kind.trim().to_string();
    if !matches!(kind.as_str(), "app" | "domain" | "window") {
        return Err(format!("unknown exclusion kind: {kind}"));
    }
    let id = uuid::Uuid::new_v4().to_string();
    sqlx::query("INSERT INTO exclusions (id, kind, value) VALUES (?1, ?2, ?3)")
        .bind(&id)
        .bind(&kind)
        .bind(&value)
        .execute(&state.db.pool)
        .await
        .map_err(err)?;
    Ok(Exclusion { id, kind, value })
}

#[tauri::command]
pub async fn delete_exclusion(state: State<'_, AppState>, id: String) -> Result<(), String> {
    sqlx::query("DELETE FROM exclusions WHERE id = ?1")
        .bind(&id)
        .execute(&state.db.pool)
        .await
        .map_err(err)?;
    Ok(())
}

#[tauri::command]
pub async fn current_running(state: State<'_, AppState>) -> Result<Option<Entry>, String> {
    let row = sqlx::query(
        r#"
        SELECT id, project_id, task_id, description, started_at, ended_at, source, rule_id
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
    Ok(Some(Entry {
        id: row.get("id"),
        project_id: row.get("project_id"),
        task_id: row.get("task_id"),
        description: row.get("description"),
        started_at: parse_ts(row.get::<String, _>("started_at"))?,
        ended_at: row
            .get::<Option<String>, _>("ended_at")
            .map(parse_ts)
            .transpose()?,
        source: row.get("source"),
        rule_id: row.get("rule_id"),
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
        INSERT INTO entries (id, project_id, task_id, description, started_at, ended_at, source, rule_id, created_at, updated_at)
        VALUES (?1, ?2, ?3, ?4, ?5, NULL, ?6, ?7, ?5, ?5)
        "#,
    )
    .bind(&id)
    .bind(&input.project_id)
    .bind(&input.task_id)
    .bind(&input.description)
    .bind(&now_str)
    .bind(&source)
    .bind(&input.rule_id)
    .execute(&mut *tx)
    .await
    .map_err(err)?;

    tx.commit().await.map_err(err)?;

    Ok(Entry {
        id,
        project_id: input.project_id,
        task_id: input.task_id,
        description: input.description,
        started_at: now,
        ended_at: None,
        source,
        rule_id: input.rule_id,
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
        "SELECT id, project_id, task_id, description, started_at, ended_at, source, rule_id FROM entries WHERE id = ?1",
    )
    .bind(&id)
    .fetch_one(&state.db.pool)
    .await
    .map_err(err)?;

    Ok(Entry {
        id,
        project_id: row.get("project_id"),
        task_id: row.get("task_id"),
        description: row.get("description"),
        started_at: parse_ts(row.get::<String, _>("started_at"))?,
        ended_at: row
            .get::<Option<String>, _>("ended_at")
            .map(parse_ts)
            .transpose()?,
        source: row.get("source"),
        rule_id: row.get("rule_id"),
    })
}

#[tauri::command]
pub async fn update_entry(
    state: State<'_, AppState>,
    input: UpdateEntryInput,
) -> Result<Entry, String> {
    let now = Utc::now().to_rfc3339();
    let mut tx = state.db.pool.begin().await.map_err(err)?;

    if let Some(description) = &input.description {
        sqlx::query("UPDATE entries SET description = ?1, updated_at = ?2 WHERE id = ?3")
            .bind(description)
            .bind(&now)
            .bind(&input.id)
            .execute(&mut *tx)
            .await
            .map_err(err)?;
    }
    if let Some(project_id) = &input.project_id {
        // Changing project invalidates the linked task (tasks are project-scoped).
        sqlx::query(
            "UPDATE entries SET project_id = ?1, task_id = NULL, updated_at = ?2 WHERE id = ?3",
        )
        .bind(project_id.as_deref())
        .bind(&now)
        .bind(&input.id)
        .execute(&mut *tx)
        .await
        .map_err(err)?;
    }
    if let Some(task_id) = &input.task_id {
        sqlx::query("UPDATE entries SET task_id = ?1, updated_at = ?2 WHERE id = ?3")
            .bind(task_id.as_deref())
            .bind(&now)
            .bind(&input.id)
            .execute(&mut *tx)
            .await
            .map_err(err)?;
    }
    if let Some(started_at) = &input.started_at {
        sqlx::query("UPDATE entries SET started_at = ?1, updated_at = ?2 WHERE id = ?3")
            .bind(started_at)
            .bind(&now)
            .bind(&input.id)
            .execute(&mut *tx)
            .await
            .map_err(err)?;
    }
    if let Some(ended_at) = &input.ended_at {
        sqlx::query("UPDATE entries SET ended_at = ?1, updated_at = ?2 WHERE id = ?3")
            .bind(ended_at.as_deref())
            .bind(&now)
            .bind(&input.id)
            .execute(&mut *tx)
            .await
            .map_err(err)?;
    }

    tx.commit().await.map_err(err)?;

    let row = sqlx::query(
        "SELECT id, project_id, task_id, description, started_at, ended_at, source, rule_id FROM entries WHERE id = ?1",
    )
    .bind(&input.id)
    .fetch_one(&state.db.pool)
    .await
    .map_err(err)?;
    Ok(Entry {
        id: input.id,
        project_id: row.get("project_id"),
        task_id: row.get("task_id"),
        description: row.get("description"),
        started_at: parse_ts(row.get::<String, _>("started_at"))?,
        ended_at: row
            .get::<Option<String>, _>("ended_at")
            .map(parse_ts)
            .transpose()?,
        source: row.get("source"),
        rule_id: row.get("rule_id"),
    })
}

#[tauri::command]
pub async fn delete_entry(state: State<'_, AppState>, id: String) -> Result<(), String> {
    sqlx::query("DELETE FROM entries WHERE id = ?1")
        .bind(&id)
        .execute(&state.db.pool)
        .await
        .map_err(err)?;
    Ok(())
}

#[tauri::command]
pub async fn hide_popover(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("popover") {
        window.hide().map_err(err)?;
    }
    Ok(())
}

#[tauri::command]
pub fn set_pinned(state: State<'_, AppState>, pinned: bool) -> Result<(), String> {
    state
        .pinned
        .store(pinned, std::sync::atomic::Ordering::Relaxed);
    Ok(())
}

#[tauri::command]
pub fn set_popover_size(app: tauri::AppHandle, width: f64, height: f64) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("popover") {
        window
            .set_size(tauri::LogicalSize::new(width, height))
            .map_err(err)?;
    }
    Ok(())
}

fn parse_ts<S: AsRef<str>>(s: S) -> Result<DateTime<Utc>, String> {
    DateTime::parse_from_rfc3339(s.as_ref())
        .map(|d| d.with_timezone(&Utc))
        .map_err(|e| e.to_string())
}

fn err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddCalendarInput {
    pub kind: CalendarKind,
    pub label: String,
    /// For `url` kind: the full subscription URL including any secret
    /// token. For `file` kind: the absolute path on disk.
    pub raw: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCalendarInput {
    pub id: String,
    #[serde(default)]
    pub label: Option<String>,
    #[serde(default)]
    pub poll_seconds: Option<i64>,
    #[serde(default)]
    pub enabled: Option<bool>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActiveCalendarEvent {
    pub source_id: String,
    pub source_label: String,
    pub uid: String,
    pub summary: String,
    pub start: DateTime<Utc>,
    pub end: DateTime<Utc>,
    pub all_day: bool,
    pub attendees: Vec<String>,
}

impl From<ActiveEvent> for ActiveCalendarEvent {
    fn from(a: ActiveEvent) -> Self {
        ActiveCalendarEvent {
            source_id: a.source_id,
            source_label: a.source_label,
            uid: a.event.uid,
            summary: a.event.summary,
            start: a.event.start,
            end: a.event.end,
            all_day: a.event.all_day,
            attendees: a.event.attendees,
        }
    }
}

#[tauri::command]
pub async fn list_calendar_sources(
    state: State<'_, AppState>,
) -> Result<Vec<CalendarSource>, String> {
    state
        .calendar
        .list_sources()
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn add_calendar_source(
    state: State<'_, AppState>,
    input: AddCalendarInput,
) -> Result<CalendarSource, String> {
    if input.label.trim().is_empty() {
        return Err("label cannot be empty".into());
    }
    if input.raw.trim().is_empty() {
        return Err("URL or path cannot be empty".into());
    }
    state
        .calendar
        .add_source(input.kind, input.label.trim().to_string(), input.raw)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn update_calendar_source(
    state: State<'_, AppState>,
    input: UpdateCalendarInput,
) -> Result<CalendarSource, String> {
    state
        .calendar
        .update_source(&input.id, input.label, input.poll_seconds, input.enabled)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn remove_calendar_source(state: State<'_, AppState>, id: String) -> Result<(), String> {
    state
        .calendar
        .remove_source(&id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn refresh_calendar_source(
    state: State<'_, AppState>,
    id: String,
) -> Result<CalendarSource, String> {
    state.calendar.refresh(&id).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn current_calendar_events(
    state: State<'_, AppState>,
) -> Result<Vec<ActiveCalendarEvent>, String> {
    let events = state.calendar.active_events_at(Utc::now()).await;
    Ok(events.into_iter().map(Into::into).collect())
}

#[tauri::command]
pub async fn calendar_sync_status(state: State<'_, AppState>) -> Result<Vec<SyncStatus>, String> {
    Ok(state.calendar.sync_status().await)
}

#[tauri::command]
pub async fn current_snapshot(
    state: State<'_, AppState>,
) -> Result<crate::rules::SignalSnapshot, String> {
    Ok(crate::signals::snapshot::build(&state.calendar, Utc::now()).await)
}
