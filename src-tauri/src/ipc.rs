use chrono::{DateTime, Datelike, Duration, Local, NaiveDate, Utc, Weekday};
use serde::{Deserialize, Serialize};
use sqlx::Row;
use tauri::{Manager, State};

use crate::signals::browser_extension::BrowserExtensionStatus;
use crate::signals::calendar::{ActiveEvent, CalendarKind, CalendarSource, SyncStatus};
use crate::signals::git_watcher::GitWatcherStatus;
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

/// Manual entry creation (#21). Unlike `start_entry`, the caller
/// provides explicit `started_at` and optionally `ended_at`. When
/// `ended_at` is `None` the entry is open-ended (running); the IPC
/// closes any other running entry first so two timers can't overlap.
/// When both are provided the entry is a closed historical row that
/// does not affect the currently-running timer.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateEntryInput {
    #[serde(default)]
    pub project_id: Option<String>,
    #[serde(default)]
    pub task_id: Option<String>,
    #[serde(default)]
    pub description: String,
    /// RFC 3339 timestamp. Required.
    pub started_at: String,
    /// RFC 3339 timestamp. `None` ⇒ open-ended (running).
    #[serde(default)]
    pub ended_at: Option<String>,
    /// Defaults to `"manual"`. The frontend wires this for clarity but
    /// the backend would default it anyway.
    #[serde(default)]
    pub source: Option<String>,
}

/// How the user resolved the idle-detection modal. Mirrors the three
/// buttons in the Today view per issue #7. The IPC `resolve_idle`
/// performs the appropriate combination of close-entry / start-entry
/// / no-op atomically in a single transaction.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum IdleChoice {
    /// User intends the idle period to count as work. No DB change.
    Keep,
    /// "Discard idle": trim the running entry's `ended_at` to
    /// `since` so the [since, until] window doesn't count.
    Discard,
    /// "Move to break": close the running entry at `since`, insert
    /// a no-project entry from `since → until` tagged
    /// `source = "idle-break"`, then start a new entry at `until`
    /// with the prior entry's project/task/description so the user
    /// resumes the same work after the gap.
    Break,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolveIdleInput {
    /// The entry that was running when the user went idle. Required
    /// because the snapshot stream doesn't itself touch the DB.
    pub entry_id: String,
    /// Wall-clock when the idle period started (the `since` field
    /// of the `signal:idle-resume` event). RFC 3339.
    pub since: String,
    /// Wall-clock when the user returned (`until` from the event).
    /// RFC 3339. Required even for `keep` so the IPC payload shape
    /// is uniform across choices.
    pub until: String,
    /// How the user resolved the modal.
    pub choice: IdleChoice,
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

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReportProjectSlice {
    pub project_id: Option<String>,
    pub seconds: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReportDayBucket {
    pub date: String,
    pub by_project: Vec<ReportProjectSlice>,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReportSourceSplit {
    pub rule: i64,
    pub calendar: i64,
    pub manual: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReportSummary {
    pub total_seconds: i64,
    pub prev_total_seconds: i64,
    pub by_day: Vec<ReportDayBucket>,
    pub by_project: Vec<ReportProjectSlice>,
    pub by_source: ReportSourceSplit,
}

/// One entry reduced to what the report needs: project, signal source,
/// and a concrete [start, end] (open entries are resolved to `now`
/// before they reach the pure aggregator).
#[derive(Debug, Clone)]
struct ReportRow {
    project_id: Option<String>,
    source: String,
    start: DateTime<Utc>,
    end: DateTime<Utc>,
}

/// Local-date half-open window [start, end) for `range`, anchored on
/// `anchor` (today, normally). Unknown ranges fall back to the week.
fn report_window(range: &str, anchor: NaiveDate) -> (NaiveDate, NaiveDate) {
    match range {
        "day" => (anchor, anchor + Duration::days(1)),
        "month" => {
            let first = first_of_month(anchor);
            (first, first_of_next_month(first))
        }
        _ => {
            let monday = monday_of(anchor);
            (monday, monday + Duration::days(7))
        }
    }
}

/// The window immediately preceding `report_window(range, anchor)` —
/// the "vs last period" baseline.
fn prev_report_window(range: &str, anchor: NaiveDate) -> (NaiveDate, NaiveDate) {
    let (start, _) = report_window(range, anchor);
    match range {
        "day" => (start - Duration::days(1), start),
        "month" => (first_of_month(start - Duration::days(1)), start),
        _ => (start - Duration::days(7), start),
    }
}

fn first_of_month(d: NaiveDate) -> NaiveDate {
    NaiveDate::from_ymd_opt(d.year(), d.month(), 1).expect("day 1 is valid")
}

fn first_of_next_month(first: NaiveDate) -> NaiveDate {
    if first.month() == 12 {
        NaiveDate::from_ymd_opt(first.year() + 1, 1, 1)
    } else {
        NaiveDate::from_ymd_opt(first.year(), first.month() + 1, 1)
    }
    .expect("first of next month is valid")
}

fn source_bucket<'a>(split: &'a mut ReportSourceSplit, source: &str) -> &'a mut i64 {
    if source.starts_with("rule") {
        &mut split.rule
    } else if source == "calendar" {
        &mut split.calendar
    } else {
        &mut split.manual
    }
}

fn total_seconds(rows: &[ReportRow]) -> i64 {
    rows.iter()
        .map(|r| (r.end - r.start).num_seconds())
        .filter(|s| *s > 0)
        .sum()
}

/// Pure heart of `report_summary`: from the rows in [start, end) (open
/// entries pre-resolved to `now`), produce the total, per-project
/// rollup, one per-day bucket for every calendar day in the window (in
/// order, empty days included), and the rule/calendar/manual split.
fn aggregate_report(
    rows: &[ReportRow],
    start_day: NaiveDate,
    end_day: NaiveDate,
) -> (
    i64,
    Vec<ReportProjectSlice>,
    Vec<ReportDayBucket>,
    ReportSourceSplit,
) {
    use std::collections::BTreeMap;
    let mut by_project: BTreeMap<Option<String>, i64> = BTreeMap::new();
    let mut by_day: BTreeMap<NaiveDate, BTreeMap<Option<String>, i64>> = BTreeMap::new();
    let mut by_source = ReportSourceSplit::default();
    let mut total = 0i64;

    for r in rows {
        let secs = (r.end - r.start).num_seconds();
        if secs <= 0 {
            continue;
        }
        total += secs;
        *by_project.entry(r.project_id.clone()).or_insert(0) += secs;
        let date = r.start.with_timezone(&Local).date_naive();
        *by_day
            .entry(date)
            .or_default()
            .entry(r.project_id.clone())
            .or_insert(0) += secs;
        *source_bucket(&mut by_source, &r.source) += secs;
    }

    let by_project_vec = by_project
        .into_iter()
        .map(|(project_id, seconds)| ReportProjectSlice {
            project_id,
            seconds,
        })
        .collect();

    let mut day_buckets = Vec::new();
    let mut d = start_day;
    while d < end_day {
        let slices = by_day
            .get(&d)
            .map(|m| {
                m.iter()
                    .map(|(p, s)| ReportProjectSlice {
                        project_id: p.clone(),
                        seconds: *s,
                    })
                    .collect()
            })
            .unwrap_or_default();
        day_buckets.push(ReportDayBucket {
            date: d.to_string(),
            by_project: slices,
        });
        d += Duration::days(1);
    }

    (total, by_project_vec, day_buckets, by_source)
}

async fn fetch_report_rows(
    pool: &sqlx::SqlitePool,
    start_day: NaiveDate,
    end_day: NaiveDate,
    now: DateTime<Utc>,
) -> Result<Vec<ReportRow>, String> {
    let start_utc = local_midnight_utc(start_day);
    let end_utc = local_midnight_utc(end_day);
    let sqlrows = sqlx::query(
        r#"
        SELECT project_id, source, started_at, ended_at
          FROM entries
         WHERE started_at >= ?1 AND started_at < ?2
        "#,
    )
    .bind(start_utc.to_rfc3339())
    .bind(end_utc.to_rfc3339())
    .fetch_all(pool)
    .await
    .map_err(err)?;

    let mut rows = Vec::with_capacity(sqlrows.len());
    for row in sqlrows {
        let start = parse_ts(row.get::<String, _>("started_at"))?;
        let end = match row.get::<Option<String>, _>("ended_at") {
            Some(s) => parse_ts(s)?,
            None => now,
        };
        rows.push(ReportRow {
            project_id: row.get("project_id"),
            source: row.get("source"),
            start,
            end,
        });
    }
    Ok(rows)
}

#[tauri::command]
pub async fn report_summary(
    state: State<'_, AppState>,
    range: String,
) -> Result<ReportSummary, String> {
    let anchor = Local::now().date_naive();
    let now = Utc::now();

    let (start_day, end_day) = report_window(&range, anchor);
    let (prev_start, prev_end) = prev_report_window(&range, anchor);

    let cur_rows = fetch_report_rows(&state.db.pool, start_day, end_day, now).await?;
    let prev_rows = fetch_report_rows(&state.db.pool, prev_start, prev_end, now).await?;

    let (total, by_project, by_day, by_source) = aggregate_report(&cur_rows, start_day, end_day);

    Ok(ReportSummary {
        total_seconds: total,
        prev_total_seconds: total_seconds(&prev_rows),
        by_day,
        by_project,
        by_source,
    })
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

/// Maximum character length for a rule's name. A compromised
/// webview or held-down keypress could otherwise submit a multi-MB
/// `name`; the matcher's `evaluate` would then walk it on every
/// snapshot tick. Bounded so the worst-case storage + clone is
/// trivial.
pub const MAX_RULE_NAME_LEN: usize = 200;

/// Maximum size (in bytes) of the serialized `body` JSON for a
/// single rule. Keeps the rules cache + per-tick clone bounded.
/// 16 KB is generous — a 32-condition rule with 500-char values
/// fits comfortably under this.
pub const MAX_RULE_BODY_BYTES: usize = 16 * 1024;

/// Validate user-controlled inputs on `save_rule`. Front-line
/// defence against DoS-by-pathological-payload (compromised webview
/// or held-down keypress). Frontend mirrors these via `maxLength`
/// for nice UX, but a frontend gate can always be bypassed — the
/// backend is the source of truth.
fn validate_rule_input(input: &RuleInput, body_str: &str) -> Result<(), String> {
    if input.name.chars().count() > MAX_RULE_NAME_LEN {
        return Err(format!(
            "rule name too long: max {MAX_RULE_NAME_LEN} characters",
        ));
    }
    if body_str.len() > MAX_RULE_BODY_BYTES {
        return Err(format!(
            "rule body too large: max {MAX_RULE_BODY_BYTES} bytes",
        ));
    }
    Ok(())
}

#[tauri::command]
pub async fn save_rule(state: State<'_, AppState>, rule: RuleInput) -> Result<Rule, String> {
    let now = Utc::now().to_rfc3339();
    let body_str = serde_json::to_string(&rule.body).map_err(err)?;

    validate_rule_input(&rule, &body_str)?;

    let id = rule
        .id
        .clone()
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());

    // Serialize (INSERT, reload) so concurrent mutator IPCs can't
    // interleave such that the rules cache ends up reflecting a
    // stale DB snapshot. The leading underscore tells the compiler
    // it's an RAII guard — its lifetime is what holds the lock.
    let _guard = state.rules_mutator.lock().await;
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
    reload_rules(&state).await;

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
    let _guard = state.rules_mutator.lock().await;
    sqlx::query("DELETE FROM rules WHERE id = ?1")
        .bind(&id)
        .execute(&state.db.pool)
        .await
        .map_err(err)?;
    reload_rules(&state).await;
    Ok(())
}

/// Maximum length of an ids list on `reorder_rules`. Two orders of
/// magnitude over any realistic rule count — keeps a forged
/// invocation from triggering an unbounded SQL transaction.
pub const MAX_REORDER_RULES: usize = 10_000;

/// Max length of a single rule id (in bytes). Real ids are 36-char
/// UUIDs — 128 leaves headroom for any future id scheme while still
/// providing a tight bound against forged megastrings.
pub const MAX_RULE_ID_LEN: usize = 128;

/// Reorder rules by rewriting their `priority` columns in a single
/// transaction (issue #15). The caller supplies the desired order as
/// a list of rule ids; the backend assigns priorities `10, 20, 30, …`
/// in that order — dense, unique, evenly spaced so future inserts
/// between two existing rules don't need a renumber.
///
/// Validation rules:
/// - `ids` must contain every existing rule id exactly once. A
///   partial or duplicate list is rejected — silently dropping an id
///   would make a rule un-orderable from the UI, and tolerating
///   duplicates would assign two priorities to one rule.
/// - Empty `ids` is only allowed when the DB itself has zero rules.
///
/// On success, the rules cache is reloaded so the matcher uses the
/// new order on the next snapshot tick. No app restart required.
#[tauri::command]
pub async fn reorder_rules(state: State<'_, AppState>, ids: Vec<String>) -> Result<(), String> {
    if ids.len() > MAX_REORDER_RULES {
        return Err(format!(
            "reorder_rules: too many ids (max {MAX_REORDER_RULES})"
        ));
    }
    // Per-id length cap. Real rule ids are 36-char UUIDs; reject
    // anything noticeably longer before allocating the dedup HashSet,
    // so a forged caller passing 10k × MB-sized strings can't OOM us
    // before the count check helps.
    for id in &ids {
        if id.len() > MAX_RULE_ID_LEN {
            return Err(format!(
                "reorder_rules: id too long (max {MAX_RULE_ID_LEN} bytes)"
            ));
        }
    }
    let mut seen = std::collections::HashSet::with_capacity(ids.len());
    for id in &ids {
        if !seen.insert(id) {
            return Err(format!("reorder_rules: duplicate id {id}"));
        }
    }

    let _guard = state.rules_mutator.lock().await;

    // Cross-check against the DB: caller's ids must equal the DB's
    // id set exactly. Anything else (extra id, missing id) is a
    // logic error and we refuse to write a partial reorder.
    let rows = sqlx::query("SELECT id FROM rules")
        .fetch_all(&state.db.pool)
        .await
        .map_err(err)?;
    let db_ids: std::collections::HashSet<String> =
        rows.iter().map(|r| r.get::<String, _>("id")).collect();
    if db_ids.len() != ids.len() {
        return Err(format!(
            "reorder_rules: ids length {} != db count {}",
            ids.len(),
            db_ids.len()
        ));
    }
    for id in &ids {
        if !db_ids.contains(id) {
            return Err(format!("reorder_rules: unknown id {id}"));
        }
    }

    let now = Utc::now().to_rfc3339();
    let mut tx = state.db.pool.begin().await.map_err(err)?;
    for (idx, id) in ids.iter().enumerate() {
        // 1-based × 10: priorities are dense (10, 20, 30, …) and
        // never collide with the "+10 above max" pattern `add()`
        // uses for new rules. Inserts after a reorder land below
        // the reordered set, which is the natural read-order.
        let priority: i64 = ((idx as i64) + 1) * 10;
        sqlx::query("UPDATE rules SET priority = ?1, updated_at = ?2 WHERE id = ?3")
            .bind(priority)
            .bind(&now)
            .bind(id)
            .execute(&mut *tx)
            .await
            .map_err(err)?;
    }
    tx.commit().await.map_err(err)?;
    reload_rules(&state).await;
    Ok(())
}

/// Reload the in-memory rules cache from the DB. Called after every
/// `save_rule` / `delete_rule` so the fanout and calendar-autostop
/// tasks see the new state on the very next tick. Mirrors
/// `reload_exclusions`.
///
/// On SQL failure (e.g. transient `SQLITE_BUSY`) the cache is
/// *retained* rather than blanked — overwriting with `Vec::new()`
/// would silently disable every rule until the next mutator runs.
/// The DB write that triggered the reload has already succeeded;
/// the cache lag converges as soon as the next mutator (or app
/// restart) loads cleanly.
pub(crate) async fn reload_rules(state: &State<'_, AppState>) {
    let fresh = match crate::signals::fanout::load_engine_rules(&state.db.pool).await {
        Ok(rules) => rules,
        Err(e) => {
            log::warn!("rules: reload skipped — DB query failed: {e}; cache retained");
            return;
        }
    };
    match state.rules_cache.write() {
        Ok(mut guard) => *guard = fresh,
        Err(poisoned) => {
            let mut guard = poisoned.into_inner();
            *guard = fresh;
            log::warn!("rules: recovered from poisoned RwLock and reloaded");
        }
    }
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

/// Maximum length of a single field on a dry-run snapshot, counted
/// in UTF-16 code units to match the DOM `<input maxLength>`
/// semantics the frontend bench uses (see `src/views/rules/test-bench.tsx`).
/// The bench's `MAX_BENCH_FIELD` mirrors this number. Without the
/// same unit on both sides, an emoji-heavy paste could pass the
/// frontend cap and fail the backend's, producing a confusing error.
/// 2048 UTF-16 code units is generous — real titles + folders +
/// branches are well under this.
pub const MAX_DRY_RUN_FIELD_LEN: usize = 2 * 1024;

fn dry_run_field_too_long(field: &str, value: &Option<String>) -> Option<String> {
    if let Some(v) = value {
        if v.encode_utf16().count() > MAX_DRY_RUN_FIELD_LEN {
            return Some(format!(
                "dry_run_rules: {field} too long (max {MAX_DRY_RUN_FIELD_LEN} UTF-16 units)"
            ));
        }
    }
    None
}

/// Evaluate the current rule set against a user-supplied snapshot —
/// the engine path that powers the Test bench (#13).
///
/// Uses the same `evaluate` codepath the live fanout uses, but with
/// no snoozer (dry-runs aren't user-triggered timer starts and
/// shouldn't be suppressed by a dismissed suggestion) and no
/// attendee filter (the bench doesn't yet surface calendar events).
///
/// Returns `Some(RuleMatch)` for the first matching rule (priority
/// asc), `None` for no match.
#[tauri::command]
pub async fn dry_run_rules(
    state: State<'_, AppState>,
    snapshot: crate::rules::SignalSnapshot,
) -> Result<Option<crate::rules::RuleMatch>, String> {
    for (label, val) in [
        ("ideFolder", &snapshot.ide_folder),
        ("gitBranch", &snapshot.git_branch),
        ("windowTitle", &snapshot.window_title),
        ("appName", &snapshot.app_name),
        ("browserDomain", &snapshot.browser_domain),
    ] {
        if let Some(err) = dry_run_field_too_long(label, val) {
            return Err(err);
        }
    }

    // Clone out of the cache so we don't hold the RwLock across the
    // evaluate call (evaluate is pure CPU — no awaits — but keeping
    // the read window narrow is good hygiene).
    let rules: Vec<crate::rules::Rule> = match state.rules_cache.read() {
        Ok(guard) => guard.clone(),
        Err(poisoned) => {
            let guard = poisoned.into_inner();
            log::warn!("dry_run_rules: recovered from poisoned RwLock");
            guard.clone()
        }
    };
    Ok(crate::rules::evaluate(&rules, &snapshot))
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
    // Serialize (INSERT, reload) so concurrent mutator IPCs can't
    // interleave such that the matcher ends up stale.
    let _mutator = state.exclusions_mutator.lock().await;
    let id = uuid::Uuid::new_v4().to_string();
    sqlx::query("INSERT INTO exclusions (id, kind, value) VALUES (?1, ?2, ?3)")
        .bind(&id)
        .bind(&kind)
        .bind(&value)
        .execute(&state.db.pool)
        .await
        .map_err(err)?;
    reload_exclusions(&state).await;
    Ok(Exclusion { id, kind, value })
}

#[tauri::command]
pub async fn delete_exclusion(state: State<'_, AppState>, id: String) -> Result<(), String> {
    let _mutator = state.exclusions_mutator.lock().await;
    sqlx::query("DELETE FROM exclusions WHERE id = ?1")
        .bind(&id)
        .execute(&state.db.pool)
        .await
        .map_err(err)?;
    reload_exclusions(&state).await;
    Ok(())
}

/// Reload the in-memory exclusion matcher from the DB. Called after
/// every `save_exclusion` / `delete_exclusion` so the snapshot
/// stream driver sees the new state on the very next event.
pub(crate) async fn reload_exclusions(state: &State<'_, AppState>) {
    let fresh = crate::signals::exclusions::ExclusionMatcher::load(&state.db.pool).await;
    match state.exclusions.write() {
        Ok(mut guard) => *guard = fresh,
        Err(poisoned) => {
            // RwLock poisoning means a previous writer panicked.
            // Replace the contents anyway — the lock is logically
            // valid; the panic was in user code, not in us.
            let mut guard = poisoned.into_inner();
            *guard = fresh;
            log::warn!("exclusions: recovered from poisoned RwLock and reloaded");
        }
    }
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
pub async fn create_entry(
    state: State<'_, AppState>,
    input: CreateEntryInput,
) -> Result<Entry, String> {
    let started_at: DateTime<Utc> = input
        .started_at
        .parse::<DateTime<Utc>>()
        .map_err(|e| format!("invalid started_at: {e}"))?;
    let ended_at: Option<DateTime<Utc>> = match &input.ended_at {
        Some(s) => Some(
            s.parse::<DateTime<Utc>>()
                .map_err(|e| format!("invalid ended_at: {e}"))?,
        ),
        None => None,
    };
    if let Some(end) = ended_at {
        if end <= started_at {
            return Err("ended_at must be strictly after started_at".into());
        }
    }

    let now_str = Utc::now().to_rfc3339();
    let started_str = started_at.to_rfc3339();
    let ended_str = ended_at.map(|t| t.to_rfc3339());
    let id = uuid::Uuid::new_v4().to_string();
    let source = input.source.clone().unwrap_or_else(|| "manual".into());

    let mut tx = state.db.pool.begin().await.map_err(err)?;

    // Open-ended manual entries follow the same "only one running
    // timer at a time" invariant as start_entry — close any other
    // currently-running entry first.
    if ended_at.is_none() {
        sqlx::query("UPDATE entries SET ended_at = ?1, updated_at = ?1 WHERE ended_at IS NULL")
            .bind(&now_str)
            .execute(&mut *tx)
            .await
            .map_err(err)?;
    }

    sqlx::query(
        r#"
        INSERT INTO entries (id, project_id, task_id, description, started_at, ended_at, source, rule_id, created_at, updated_at)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, NULL, ?8, ?8)
        "#,
    )
    .bind(&id)
    .bind(&input.project_id)
    .bind(&input.task_id)
    .bind(&input.description)
    .bind(&started_str)
    .bind(ended_str.as_deref())
    .bind(&source)
    .bind(&now_str)
    .execute(&mut *tx)
    .await
    .map_err(err)?;

    tx.commit().await.map_err(err)?;

    Ok(Entry {
        id,
        project_id: input.project_id,
        task_id: input.task_id,
        description: input.description,
        started_at,
        ended_at,
        source,
        rule_id: None,
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

/// Resolve the idle-detection modal. Performs the three button
/// outcomes (Keep / Discard / Move-to-break) atomically so the
/// entry rows are never in a half-applied state.
///
/// Returns the entry the user is "now running" after the action:
/// - Keep: the same entry (still running).
/// - Discard: the same entry with `ended_at = since`. The user has
///   no running timer afterwards — the UI should reflect that.
/// - Break: a new entry started at `until` with the same project /
///   task / description as the entry that was running before the
///   idle. That new entry is what's returned.
#[tauri::command]
pub async fn resolve_idle(
    state: State<'_, AppState>,
    input: ResolveIdleInput,
) -> Result<Option<Entry>, String> {
    // Validate timestamps up front — bad input shouldn't open a
    // half-committed transaction.
    let now = Utc::now();
    let since: DateTime<Utc> = input
        .since
        .parse::<DateTime<Utc>>()
        .map_err(|e| format!("invalid since: {e}"))?;
    let until: DateTime<Utc> = input
        .until
        .parse::<DateTime<Utc>>()
        .map_err(|e| format!("invalid until: {e}"))?;
    if until < since {
        return Err("until must be >= since".into());
    }
    // Defence-in-depth: reject far-future timestamps that could
    // only come from a corrupted event payload or a malicious
    // caller. 60s of slop accommodates real clock drift.
    let future_slop = chrono::Duration::seconds(60);
    if until > now + future_slop {
        return Err("until is in the future".into());
    }

    let now_str = now.to_rfc3339();
    let since_str = since.to_rfc3339();
    let until_str = until.to_rfc3339();

    // Open the transaction FIRST. Every read and write that needs
    // a consistent view of the entry runs inside it so a concurrent
    // `start_entry` / `update_entry` / `stop_entry` can't slip
    // between the SELECT and the UPDATE.
    let mut tx = state.db.pool.begin().await.map_err(err)?;

    // Fetch the entry inside the transaction so the project /
    // task / description / started_at / ended_at we copy into the
    // resumed entry reflects the same snapshot we'll UPDATE below.
    let row = sqlx::query(
        "SELECT project_id, task_id, description, started_at, ended_at \
         FROM entries WHERE id = ?1",
    )
    .bind(&input.entry_id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(err)?
    .ok_or_else(|| format!("no entry with id {}", input.entry_id))?;

    let project_id: Option<String> = row.get("project_id");
    let task_id: Option<String> = row.get("task_id");
    let description: String = row.get("description");
    let started_at: DateTime<Utc> = parse_ts(row.get::<String, _>("started_at"))?;
    let prior_ended_at: Option<DateTime<Utc>> = row
        .get::<Option<String>, _>("ended_at")
        .map(parse_ts)
        .transpose()?;

    // `since` must lie inside the entry's [started_at, until]
    // window — otherwise the user is trying to resolve idle for
    // an entry that never overlapped the idle period.
    if since < started_at {
        return Err("since precedes the entry's started_at".into());
    }
    // The entry must still be open at `since`. If the user
    // already stopped it manually before the idle window started,
    // applying Discard / Break would silently rewrite history that
    // contradicts the user's explicit action.
    if let Some(e) = prior_ended_at {
        if e < since {
            return Err("entry was already stopped before the idle window".into());
        }
    }

    match input.choice {
        IdleChoice::Keep => {
            // No-op. Leave the entry untouched. We still rolled the
            // tx open to take the read lock — drop it explicitly so
            // we don't hold a pointless write lock open across the
            // current_running roundtrip.
            drop(tx);
            current_running(state).await
        }
        IdleChoice::Discard => {
            // Close the entry at `since`. Any idle time after that
            // moment is dropped from the user's logged work.
            let updated = sqlx::query(
                "UPDATE entries SET ended_at = ?1, updated_at = ?2 WHERE id = ?3 \
                 AND (ended_at IS NULL OR ended_at > ?1)",
            )
            .bind(&since_str)
            .bind(&now_str)
            .bind(&input.entry_id)
            .execute(&mut *tx)
            .await
            .map_err(err)?
            .rows_affected();
            if updated == 0 {
                // Either the row vanished or its ended_at is
                // already <= since. The pre-checks above should
                // catch the latter; if we got here, the row was
                // deleted/closed concurrently. Roll back rather
                // than commit a no-op pretending it succeeded.
                return Err("entry no longer in a discardable state".into());
            }
            tx.commit().await.map_err(err)?;
            // No new running entry — the user has to start the next
            // work segment themselves.
            Ok(None)
        }
        IdleChoice::Break => {
            // 1. Close the original entry at `since`.
            let updated = sqlx::query(
                "UPDATE entries SET ended_at = ?1, updated_at = ?2 WHERE id = ?3 \
                 AND (ended_at IS NULL OR ended_at > ?1)",
            )
            .bind(&since_str)
            .bind(&now_str)
            .bind(&input.entry_id)
            .execute(&mut *tx)
            .await
            .map_err(err)?
            .rows_affected();
            if updated == 0 {
                return Err("entry no longer in a breakable state".into());
            }

            // 1b. Close any OTHER running entry. The Break path
            //     is about to insert a new running entry, and we
            //     mirror `start_entry`'s invariant that at most
            //     one timer ever has `ended_at IS NULL`. Without
            //     this, a concurrent manual `start_entry` between
            //     the modal opening and the user clicking Break
            //     would leave two open timers.
            sqlx::query(
                "UPDATE entries SET ended_at = ?1, updated_at = ?1 \
                 WHERE ended_at IS NULL AND id != ?2",
            )
            .bind(&now_str)
            .bind(&input.entry_id)
            .execute(&mut *tx)
            .await
            .map_err(err)?;

            // 2. Insert a [since, until] break entry (no project,
            //    source = "idle-break") so the time accounts for the
            //    period the user was away.
            let break_id = uuid::Uuid::new_v4().to_string();
            sqlx::query(
                r#"
                INSERT INTO entries (id, project_id, task_id, description, started_at, ended_at, source, rule_id, created_at, updated_at)
                VALUES (?1, NULL, NULL, '', ?2, ?3, 'idle-break', NULL, ?4, ?4)
                "#,
            )
            .bind(&break_id)
            .bind(&since_str)
            .bind(&until_str)
            .bind(&now_str)
            .execute(&mut *tx)
            .await
            .map_err(err)?;

            // 3. Start a new entry at `until` with the prior
            //    entry's project/task/description so the user
            //    resumes "the same work" after the gap. The source
            //    is `"idle-resume"` so the resumed entry is
            //    distinguishable in the timeline from a fresh
            //    manual start.
            let resumed_id = uuid::Uuid::new_v4().to_string();
            sqlx::query(
                r#"
                INSERT INTO entries (id, project_id, task_id, description, started_at, ended_at, source, rule_id, created_at, updated_at)
                VALUES (?1, ?2, ?3, ?4, ?5, NULL, 'idle-resume', NULL, ?6, ?6)
                "#,
            )
            .bind(&resumed_id)
            .bind(&project_id)
            .bind(&task_id)
            .bind(&description)
            .bind(&until_str)
            .bind(&now_str)
            .execute(&mut *tx)
            .await
            .map_err(err)?;

            tx.commit().await.map_err(err)?;

            Ok(Some(Entry {
                id: resumed_id,
                project_id,
                task_id,
                description,
                started_at: until,
                ended_at: None,
                source: "idle-resume".into(),
                rule_id: None,
            }))
        }
    }
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

#[cfg(test)]
mod report_pure_tests {
    use super::*;
    use chrono::TimeZone;

    fn row(project: Option<&str>, source: &str, ymdh: (i32, u32, u32, u32), dur: i64) -> ReportRow {
        let s = Utc
            .with_ymd_and_hms(ymdh.0, ymdh.1, ymdh.2, ymdh.3, 0, 0)
            .unwrap();
        ReportRow {
            project_id: project.map(str::to_string),
            source: source.to_string(),
            start: s,
            end: s + Duration::seconds(dur),
        }
    }

    #[test]
    fn report_window_day_week_month() {
        let anchor = NaiveDate::from_ymd_opt(2026, 5, 30).unwrap(); // Saturday
        assert_eq!(
            report_window("day", anchor),
            (anchor, NaiveDate::from_ymd_opt(2026, 5, 31).unwrap())
        );
        let (ws, we) = report_window("week", anchor);
        assert_eq!(ws.weekday(), Weekday::Mon);
        assert_eq!((we - ws).num_days(), 7);
        assert_eq!(
            report_window("month", anchor),
            (
                NaiveDate::from_ymd_opt(2026, 5, 1).unwrap(),
                NaiveDate::from_ymd_opt(2026, 6, 1).unwrap()
            )
        );
        // Unknown range falls back to the current week (matches the
        // command's lenient deserialization of the `range` arg).
        assert_eq!(
            report_window("bogus", anchor),
            report_window("week", anchor)
        );
    }

    #[test]
    fn month_window_rolls_over_year_in_december() {
        let dec = NaiveDate::from_ymd_opt(2026, 12, 15).unwrap();
        assert_eq!(
            report_window("month", dec),
            (
                NaiveDate::from_ymd_opt(2026, 12, 1).unwrap(),
                NaiveDate::from_ymd_opt(2027, 1, 1).unwrap()
            )
        );
    }

    #[test]
    fn prev_window_precedes_current() {
        let anchor = NaiveDate::from_ymd_opt(2026, 5, 30).unwrap();
        let (cs, _) = report_window("day", anchor);
        let (ps, pe) = prev_report_window("day", anchor);
        assert_eq!(pe, cs);
        assert_eq!(ps, cs - Duration::days(1));

        let (ms, _) = report_window("month", anchor);
        let (pms, pme) = prev_report_window("month", anchor);
        assert_eq!(pme, ms);
        assert_eq!(pms, NaiveDate::from_ymd_opt(2026, 4, 1).unwrap());
    }

    #[test]
    fn aggregate_totals_projects_days_and_sources() {
        let start_day = NaiveDate::from_ymd_opt(2026, 5, 25).unwrap(); // Monday
        let end_day = start_day + Duration::days(7);
        let rows = vec![
            row(Some("a"), "manual", (2026, 5, 25, 9), 3600),
            row(Some("a"), "rule:branch=x", (2026, 5, 26, 9), 1800),
            row(Some("b"), "calendar", (2026, 5, 27, 9), 1200),
            row(None, "manual", (2026, 5, 27, 11), 600),
            row(Some("a"), "manual", (2026, 5, 30, 9), 0), // zero-length, ignored
        ];
        let (total, by_project, by_day, by_source) = aggregate_report(&rows, start_day, end_day);

        assert_eq!(total, 3600 + 1800 + 1200 + 600);
        // One bucket per calendar day in the window, tz-independent.
        assert_eq!(by_day.len(), 7);
        let a = by_project
            .iter()
            .find(|s| s.project_id.as_deref() == Some("a"))
            .unwrap();
        assert_eq!(a.seconds, 5400);
        let none = by_project.iter().find(|s| s.project_id.is_none()).unwrap();
        assert_eq!(none.seconds, 600);
        assert_eq!(by_source.manual, 3600 + 600);
        assert_eq!(by_source.rule, 1800);
        assert_eq!(by_source.calendar, 1200);
    }

    #[test]
    fn total_seconds_ignores_negative_spans() {
        let s = Utc.with_ymd_and_hms(2026, 5, 25, 9, 0, 0).unwrap();
        let rows = vec![
            ReportRow {
                project_id: None,
                source: "manual".into(),
                start: s,
                end: s + Duration::seconds(60),
            },
            ReportRow {
                project_id: None,
                source: "manual".into(),
                start: s,
                end: s - Duration::seconds(10),
            },
        ];
        assert_eq!(total_seconds(&rows), 60);
    }
}

#[cfg(test)]
#[cfg(not(target_os = "windows"))]
mod tests {
    use super::*;
    use crate::test_support::mock_app_with_db;
    use tauri::Manager;

    #[tokio::test]
    async fn report_summary_on_fresh_db_is_zero_with_full_day_buckets() {
        let (_dir, app, _db) = mock_app_with_db().await;
        let state = app.state::<crate::AppState>();
        let summary = report_summary(state, "week".into()).await.unwrap();
        assert_eq!(summary.total_seconds, 0);
        assert_eq!(summary.prev_total_seconds, 0);
        assert_eq!(summary.by_day.len(), 7);
        assert!(summary.by_project.is_empty());
        assert_eq!(summary.by_source.manual, 0);
    }

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

    fn start_input(project_id: Option<&str>, description: &str) -> StartEntryInput {
        StartEntryInput {
            project_id: project_id.map(|s| s.into()),
            task_id: None,
            description: description.into(),
            source: Some("manual".into()),
            rule_id: None,
        }
    }

    #[tokio::test]
    async fn start_entry_creates_a_running_entry() {
        let (_dir, app, _db) = mock_app_with_db().await;
        let state = app.state::<crate::AppState>();
        let entry = start_entry(state.clone(), start_input(Some("cairn"), "Rule preview UI"))
            .await
            .unwrap();
        assert!(entry.ended_at.is_none());
        assert_eq!(entry.description, "Rule preview UI");
        assert_eq!(entry.project_id.as_deref(), Some("cairn"));

        // current_running now reflects this entry.
        let running = current_running(state.clone()).await.unwrap().unwrap();
        assert_eq!(running.id, entry.id);
        assert_eq!(running.description, "Rule preview UI");

        // list_today includes it.
        let today = list_today(state).await.unwrap();
        assert_eq!(today.len(), 1);
    }

    #[tokio::test]
    async fn start_entry_closes_the_previously_running_one() {
        let (_dir, app, _db) = mock_app_with_db().await;
        let state = app.state::<crate::AppState>();
        let first = start_entry(state.clone(), start_input(Some("cairn"), "first"))
            .await
            .unwrap();
        let second = start_entry(state.clone(), start_input(Some("acme"), "second"))
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
        let entry = start_entry(state.clone(), start_input(None, "x"))
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

    // ---------------- resolve_idle (M1 #7) ----------------

    /// Helper: start an entry one minute ago, return the entry and
    /// the canonical `since` / `until` timestamps an idle modal
    /// would carry (5 minutes ago → 30 seconds ago).
    async fn setup_idle_entry(
        state: tauri::State<'_, crate::AppState>,
    ) -> (Entry, DateTime<Utc>, DateTime<Utc>) {
        // Start the entry "10 minutes ago" so the idle window
        // (`since` 5 min ago) lies after `started_at`.
        let started = Utc::now() - Duration::minutes(10);
        let id = uuid::Uuid::new_v4().to_string();
        let now_str = Utc::now().to_rfc3339();
        sqlx::query(
            r#"
            INSERT INTO entries (id, project_id, task_id, description, started_at, ended_at, source, rule_id, created_at, updated_at)
            VALUES (?1, 'cairn', NULL, 'work', ?2, NULL, 'manual', NULL, ?3, ?3)
            "#,
        )
        .bind(&id)
        .bind(started.to_rfc3339())
        .bind(&now_str)
        .execute(&state.db.pool)
        .await
        .unwrap();
        let entry = current_running(state).await.unwrap().unwrap();
        let since = Utc::now() - Duration::minutes(5);
        let until = Utc::now() - Duration::seconds(30);
        (entry, since, until)
    }

    // ---------------- snooze IPCs (M1 #9) ----------------

    #[tokio::test]
    async fn snooze_rule_records_entry_and_blocks_matcher() {
        let (_dir, app, _db) = mock_app_with_db().await;
        let state = app.state::<crate::AppState>();
        snooze_rule(
            state.clone(),
            SnoozeRuleInput {
                rule_id: "r1".into(),
                duration_seconds: 300,
            },
        )
        .await
        .unwrap();
        let snapshot = list_snoozes(state.clone()).await.unwrap();
        assert_eq!(snapshot.rules.len(), 1);
        assert_eq!(snapshot.rules[0].0, "r1");
        assert!(snapshot.global.is_none());
        // End-to-end: the matcher path in `rules::evaluate_with_snoozer`
        // must now treat "r1" as snoozed when called with the same
        // snoozer. Pin via the live AppState.
        let mut guard = state.snoozer.lock().unwrap();
        assert!(
            guard.is_snoozed("r1", Utc::now()),
            "the stored entry must actually silence the matcher"
        );
        assert!(!guard.is_snoozed("r2", Utc::now()));
    }

    #[tokio::test]
    async fn snooze_all_records_global_expiration() {
        let (_dir, app, _db) = mock_app_with_db().await;
        let state = app.state::<crate::AppState>();
        snooze_all(
            state.clone(),
            SnoozeAllInput {
                duration_seconds: 3600,
            },
        )
        .await
        .unwrap();
        let snapshot = list_snoozes(state).await.unwrap();
        assert!(snapshot.global.is_some());
    }

    #[tokio::test]
    async fn unsnooze_all_clears_per_rule_and_global() {
        let (_dir, app, _db) = mock_app_with_db().await;
        let state = app.state::<crate::AppState>();
        snooze_rule(
            state.clone(),
            SnoozeRuleInput {
                rule_id: "r1".into(),
                duration_seconds: 300,
            },
        )
        .await
        .unwrap();
        snooze_all(
            state.clone(),
            SnoozeAllInput {
                duration_seconds: 3600,
            },
        )
        .await
        .unwrap();
        unsnooze_all(state.clone()).await.unwrap();
        let snapshot = list_snoozes(state).await.unwrap();
        assert!(snapshot.rules.is_empty());
        assert!(snapshot.global.is_none());
    }

    #[tokio::test]
    async fn snooze_rule_rejects_zero_or_negative_duration() {
        let (_dir, app, _db) = mock_app_with_db().await;
        let state = app.state::<crate::AppState>();
        let r0 = snooze_rule(
            state.clone(),
            SnoozeRuleInput {
                rule_id: "r1".into(),
                duration_seconds: 0,
            },
        )
        .await;
        assert!(r0.is_err());
        let rn = snooze_rule(
            state,
            SnoozeRuleInput {
                rule_id: "r1".into(),
                duration_seconds: -1,
            },
        )
        .await;
        assert!(rn.is_err());
    }

    #[tokio::test]
    async fn snooze_rule_rejects_absurdly_long_duration() {
        let (_dir, app, _db) = mock_app_with_db().await;
        let state = app.state::<crate::AppState>();
        // 30 days — far past the 7-day cap.
        let result = snooze_rule(
            state,
            SnoozeRuleInput {
                rule_id: "r1".into(),
                duration_seconds: 30 * 24 * 3600,
            },
        )
        .await;
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("7 days"));
    }

    #[tokio::test]
    async fn resolve_idle_keep_leaves_entry_running() {
        let (_dir, app, _db) = mock_app_with_db().await;
        let state = app.state::<crate::AppState>();
        let (entry, since, until) = setup_idle_entry(state.clone()).await;

        let result = resolve_idle(
            state.clone(),
            ResolveIdleInput {
                entry_id: entry.id.clone(),
                since: since.to_rfc3339(),
                until: until.to_rfc3339(),
                choice: IdleChoice::Keep,
            },
        )
        .await
        .unwrap();

        // Keep returns the still-running entry.
        let running = result.expect("Keep returns the same running entry");
        assert_eq!(running.id, entry.id);
        assert!(running.ended_at.is_none());

        // DB state: entry untouched.
        let still_running = current_running(state).await.unwrap().unwrap();
        assert_eq!(still_running.id, entry.id);
        assert!(still_running.ended_at.is_none());
    }

    #[tokio::test]
    async fn resolve_idle_discard_trims_ended_at_to_since() {
        let (_dir, app, _db) = mock_app_with_db().await;
        let state = app.state::<crate::AppState>();
        let (entry, since, until) = setup_idle_entry(state.clone()).await;

        let result = resolve_idle(
            state.clone(),
            ResolveIdleInput {
                entry_id: entry.id.clone(),
                since: since.to_rfc3339(),
                until: until.to_rfc3339(),
                choice: IdleChoice::Discard,
            },
        )
        .await
        .unwrap();

        // Discard leaves no running entry.
        assert!(result.is_none());
        let running = current_running(state.clone()).await.unwrap();
        assert!(running.is_none());

        // The original entry exists but is closed at `since`.
        let row = sqlx::query("SELECT ended_at FROM entries WHERE id = ?1")
            .bind(&entry.id)
            .fetch_one(&state.db.pool)
            .await
            .unwrap();
        let ended_at: String = row.get::<Option<String>, _>("ended_at").unwrap();
        let parsed: DateTime<Utc> = ended_at.parse().unwrap();
        // Allow 1s slop for the comparison since we round-trip via
        // RFC3339.
        assert!(
            (parsed - since).num_seconds().abs() <= 1,
            "ended_at {parsed} should be close to since {since}"
        );
    }

    #[tokio::test]
    async fn resolve_idle_break_closes_inserts_break_and_resumes() {
        let (_dir, app, _db) = mock_app_with_db().await;
        let state = app.state::<crate::AppState>();
        let (entry, since, until) = setup_idle_entry(state.clone()).await;

        let result = resolve_idle(
            state.clone(),
            ResolveIdleInput {
                entry_id: entry.id.clone(),
                since: since.to_rfc3339(),
                until: until.to_rfc3339(),
                choice: IdleChoice::Break,
            },
        )
        .await
        .unwrap();

        let resumed = result.expect("Break returns the resumed entry");
        assert_eq!(resumed.project_id.as_deref(), Some("cairn"));
        assert_eq!(resumed.source, "idle-resume");
        assert!(resumed.ended_at.is_none());
        // The resumed entry starts at `until`.
        assert!((resumed.started_at - until).num_seconds().abs() <= 1);

        // The original entry is now closed at `since`.
        let row = sqlx::query("SELECT ended_at FROM entries WHERE id = ?1")
            .bind(&entry.id)
            .fetch_one(&state.db.pool)
            .await
            .unwrap();
        let orig_ended: String = row.get::<Option<String>, _>("ended_at").unwrap();
        let orig_ended_dt: DateTime<Utc> = orig_ended.parse().unwrap();
        assert!((orig_ended_dt - since).num_seconds().abs() <= 1);

        // A break entry exists between since and until with source=idle-break.
        let break_row = sqlx::query(
            "SELECT id, project_id, started_at, ended_at, source FROM entries \
             WHERE source = 'idle-break' AND id != ?1 AND id != ?2",
        )
        .bind(&entry.id)
        .bind(&resumed.id)
        .fetch_one(&state.db.pool)
        .await
        .unwrap();
        let break_started: DateTime<Utc> =
            break_row.get::<String, _>("started_at").parse().unwrap();
        let break_ended: DateTime<Utc> = break_row
            .get::<Option<String>, _>("ended_at")
            .unwrap()
            .parse()
            .unwrap();
        let break_project: Option<String> = break_row.get("project_id");
        assert!(break_project.is_none(), "break entry must have no project");
        assert!((break_started - since).num_seconds().abs() <= 1);
        assert!((break_ended - until).num_seconds().abs() <= 1);

        // current_running now reflects the resumed entry.
        let running = current_running(state).await.unwrap().unwrap();
        assert_eq!(running.id, resumed.id);
    }

    #[tokio::test]
    async fn resolve_idle_rejects_unknown_entry() {
        let (_dir, app, _db) = mock_app_with_db().await;
        let state = app.state::<crate::AppState>();
        let since = Utc::now() - Duration::minutes(5);
        let until = Utc::now();
        let result = resolve_idle(
            state,
            ResolveIdleInput {
                entry_id: "does-not-exist".into(),
                since: since.to_rfc3339(),
                until: until.to_rfc3339(),
                choice: IdleChoice::Keep,
            },
        )
        .await;
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("does-not-exist"));
    }

    #[tokio::test]
    async fn resolve_idle_rejects_inverted_window() {
        let (_dir, app, _db) = mock_app_with_db().await;
        let state = app.state::<crate::AppState>();
        let (entry, since, until) = setup_idle_entry(state.clone()).await;
        // Swap since and until so since > until.
        let result = resolve_idle(
            state,
            ResolveIdleInput {
                entry_id: entry.id,
                since: until.to_rfc3339(),
                until: since.to_rfc3339(),
                choice: IdleChoice::Discard,
            },
        )
        .await;
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("until"));
    }

    #[tokio::test]
    async fn resolve_idle_rejects_future_until() {
        let (_dir, app, _db) = mock_app_with_db().await;
        let state = app.state::<crate::AppState>();
        let (entry, since, _) = setup_idle_entry(state.clone()).await;
        // until 1 hour in the future — well past the 60s slop.
        let bad_until = Utc::now() + Duration::hours(1);
        let result = resolve_idle(
            state,
            ResolveIdleInput {
                entry_id: entry.id,
                since: since.to_rfc3339(),
                until: bad_until.to_rfc3339(),
                choice: IdleChoice::Discard,
            },
        )
        .await;
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("future"));
    }

    #[tokio::test]
    async fn resolve_idle_rejects_already_stopped_entry() {
        // If the user manually stopped the entry BEFORE the idle
        // window started, `Discard` would silently rewrite the
        // explicit stop time. Reject instead.
        let (_dir, app, _db) = mock_app_with_db().await;
        let state = app.state::<crate::AppState>();
        let (entry, since, until) = setup_idle_entry(state.clone()).await;
        // Stop the entry at a time earlier than `since`.
        let stop_at = since - Duration::minutes(1);
        sqlx::query("UPDATE entries SET ended_at = ?1 WHERE id = ?2")
            .bind(stop_at.to_rfc3339())
            .bind(&entry.id)
            .execute(&state.db.pool)
            .await
            .unwrap();

        let result = resolve_idle(
            state,
            ResolveIdleInput {
                entry_id: entry.id,
                since: since.to_rfc3339(),
                until: until.to_rfc3339(),
                choice: IdleChoice::Discard,
            },
        )
        .await;
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("already stopped"));
    }

    #[tokio::test]
    async fn resolve_idle_break_closes_other_open_entries() {
        // If a manual `start_entry` happened between the modal
        // opening and the user clicking Break, the Break path must
        // not leave two open timers.
        let (_dir, app, _db) = mock_app_with_db().await;
        let state = app.state::<crate::AppState>();
        let (entry, since, until) = setup_idle_entry(state.clone()).await;
        // Insert a second open entry concurrently (simulates a
        // race window where the user hit Start in the popover).
        let interloper = uuid::Uuid::new_v4().to_string();
        let now_str = Utc::now().to_rfc3339();
        sqlx::query(
            r#"
            INSERT INTO entries (id, project_id, task_id, description, started_at, ended_at, source, rule_id, created_at, updated_at)
            VALUES (?1, 'cairn', NULL, 'interloper', ?2, NULL, 'manual', NULL, ?2, ?2)
            "#,
        )
        .bind(&interloper)
        .bind(&now_str)
        .execute(&state.db.pool)
        .await
        .unwrap();

        let result = resolve_idle(
            state.clone(),
            ResolveIdleInput {
                entry_id: entry.id.clone(),
                since: since.to_rfc3339(),
                until: until.to_rfc3339(),
                choice: IdleChoice::Break,
            },
        )
        .await
        .unwrap();
        let resumed = result.unwrap();

        // The interloper must now be closed.
        let row = sqlx::query("SELECT ended_at FROM entries WHERE id = ?1")
            .bind(&interloper)
            .fetch_one(&state.db.pool)
            .await
            .unwrap();
        let ended_at: Option<String> = row.get("ended_at");
        assert!(
            ended_at.is_some(),
            "Break must close any other open entries"
        );

        // current_running is exactly the resumed entry.
        let running = current_running(state).await.unwrap().unwrap();
        assert_eq!(running.id, resumed.id);
    }

    #[tokio::test]
    async fn resolve_idle_rejects_since_before_entry_start() {
        let (_dir, app, _db) = mock_app_with_db().await;
        let state = app.state::<crate::AppState>();
        let (entry, _since, until) = setup_idle_entry(state.clone()).await;
        // `since` 30 minutes ago — before the entry started 10 min ago.
        let bad_since = Utc::now() - Duration::minutes(30);
        let result = resolve_idle(
            state,
            ResolveIdleInput {
                entry_id: entry.id,
                since: bad_since.to_rfc3339(),
                until: until.to_rfc3339(),
                choice: IdleChoice::Discard,
            },
        )
        .await;
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("started_at"));
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

    // ---------------- client CRUD ----------------

    fn client_input(id: Option<&str>, name: &str, color: Option<&str>) -> ClientInput {
        ClientInput {
            id: id.map(|s| s.into()),
            name: name.into(),
            color: color.map(|s| s.into()),
            archived: false,
        }
    }

    #[tokio::test]
    async fn list_clients_returns_seeded_clients() {
        let (_dir, app, _db) = mock_app_with_db().await;
        let state = app.state::<crate::AppState>();
        let clients = list_clients(state).await.unwrap();
        assert!(!clients.is_empty(), "seed must insert default clients");
        assert!(clients.iter().any(|c| c.name == "ACME Co."));
    }

    #[tokio::test]
    async fn save_client_inserts_when_id_missing() {
        let (_dir, app, _db) = mock_app_with_db().await;
        let state = app.state::<crate::AppState>();
        let saved = save_client(
            state.clone(),
            client_input(None, "New Client", Some("#abcdef")),
        )
        .await
        .unwrap();
        assert_eq!(saved.name, "New Client");
        assert_eq!(saved.color.as_deref(), Some("#abcdef"));
        assert!(!saved.archived);
        // Returned id should be a non-empty UUID-style string.
        assert!(!saved.id.is_empty());

        let after = list_clients(state).await.unwrap();
        assert!(after.iter().any(|c| c.id == saved.id));
    }

    #[tokio::test]
    async fn save_client_updates_existing_row() {
        let (_dir, app, _db) = mock_app_with_db().await;
        let state = app.state::<crate::AppState>();
        let first = save_client(state.clone(), client_input(None, "Initial", None))
            .await
            .unwrap();
        let updated = save_client(
            state.clone(),
            client_input(Some(&first.id), "Renamed", Some("#111111")),
        )
        .await
        .unwrap();
        assert_eq!(updated.id, first.id);
        assert_eq!(updated.name, "Renamed");
        assert_eq!(updated.color.as_deref(), Some("#111111"));

        let after = list_clients(state).await.unwrap();
        let same = after.iter().find(|c| c.id == first.id).unwrap();
        assert_eq!(same.name, "Renamed");
    }

    #[tokio::test]
    async fn delete_client_removes_row() {
        let (_dir, app, _db) = mock_app_with_db().await;
        let state = app.state::<crate::AppState>();
        let made = save_client(state.clone(), client_input(None, "Doomed", None))
            .await
            .unwrap();
        delete_client(state.clone(), made.id.clone()).await.unwrap();
        let after = list_clients(state).await.unwrap();
        assert!(after.iter().all(|c| c.id != made.id));
    }

    // ---------------- project CRUD ----------------

    fn project_input(
        id: Option<&str>,
        name: &str,
        color: &str,
        client_id: Option<&str>,
    ) -> ProjectInput {
        ProjectInput {
            id: id.map(|s| s.into()),
            name: name.into(),
            client_id: client_id.map(|s| s.into()),
            color: color.into(),
            archived: false,
        }
    }

    #[tokio::test]
    async fn save_project_inserts_when_id_missing() {
        let (_dir, app, _db) = mock_app_with_db().await;
        let state = app.state::<crate::AppState>();
        let saved = save_project(
            state.clone(),
            project_input(None, "Side project", "#abcdef", None),
        )
        .await
        .unwrap();
        assert_eq!(saved.name, "Side project");
        assert!(!saved.id.is_empty());

        let after = list_projects(state).await.unwrap();
        assert!(after.iter().any(|p| p.id == saved.id));
    }

    #[tokio::test]
    async fn save_project_updates_existing_row() {
        let (_dir, app, _db) = mock_app_with_db().await;
        let state = app.state::<crate::AppState>();
        let first = save_project(state.clone(), project_input(None, "Old", "#000000", None))
            .await
            .unwrap();
        let updated = save_project(
            state.clone(),
            project_input(Some(&first.id), "New", "#ffffff", Some("client-acme")),
        )
        .await
        .unwrap();
        assert_eq!(updated.id, first.id);
        assert_eq!(updated.name, "New");
        assert_eq!(updated.color, "#ffffff");
        assert_eq!(updated.client_id.as_deref(), Some("client-acme"));
    }

    #[tokio::test]
    async fn delete_project_removes_row() {
        let (_dir, app, _db) = mock_app_with_db().await;
        let state = app.state::<crate::AppState>();
        let made = save_project(
            state.clone(),
            project_input(None, "Doomed", "#abc123", None),
        )
        .await
        .unwrap();
        delete_project(state.clone(), made.id.clone())
            .await
            .unwrap();
        let after = list_projects(state).await.unwrap();
        assert!(after.iter().all(|p| p.id != made.id));
    }

    // ---------------- task CRUD ----------------

    fn task_input(id: Option<&str>, project_id: &str, name: &str) -> TaskInput {
        TaskInput {
            id: id.map(|s| s.into()),
            project_id: project_id.into(),
            name: name.into(),
            archived: false,
        }
    }

    #[tokio::test]
    async fn list_tasks_is_empty_on_fresh_db() {
        let (_dir, app, _db) = mock_app_with_db().await;
        let state = app.state::<crate::AppState>();
        let tasks = list_tasks(state, None).await.unwrap();
        assert!(tasks.is_empty());
    }

    #[tokio::test]
    async fn save_task_inserts_and_list_tasks_filters_by_project() {
        let (_dir, app, _db) = mock_app_with_db().await;
        let state = app.state::<crate::AppState>();
        let _t1 = save_task(state.clone(), task_input(None, "cairn", "Rules engine"))
            .await
            .unwrap();
        let _t2 = save_task(state.clone(), task_input(None, "cairn", "Reports UI"))
            .await
            .unwrap();
        let _t3 = save_task(state.clone(), task_input(None, "site", "Blog post"))
            .await
            .unwrap();

        let all = list_tasks(state.clone(), None).await.unwrap();
        assert_eq!(all.len(), 3);
        let just_cairn = list_tasks(state.clone(), Some("cairn".into()))
            .await
            .unwrap();
        assert_eq!(just_cairn.len(), 2);
        assert!(just_cairn.iter().all(|t| t.project_id == "cairn"));
        let just_site = list_tasks(state, Some("site".into())).await.unwrap();
        assert_eq!(just_site.len(), 1);
        assert_eq!(just_site[0].name, "Blog post");
    }

    #[tokio::test]
    async fn save_task_updates_existing_row() {
        let (_dir, app, _db) = mock_app_with_db().await;
        let state = app.state::<crate::AppState>();
        let made = save_task(state.clone(), task_input(None, "cairn", "Old name"))
            .await
            .unwrap();
        let updated = save_task(
            state.clone(),
            task_input(Some(&made.id), "cairn", "New name"),
        )
        .await
        .unwrap();
        assert_eq!(updated.id, made.id);
        assert_eq!(updated.name, "New name");
    }

    #[tokio::test]
    async fn delete_task_removes_row() {
        let (_dir, app, _db) = mock_app_with_db().await;
        let state = app.state::<crate::AppState>();
        let made = save_task(state.clone(), task_input(None, "cairn", "Doomed"))
            .await
            .unwrap();
        delete_task(state.clone(), made.id.clone()).await.unwrap();
        let after = list_tasks(state, None).await.unwrap();
        assert!(after.iter().all(|t| t.id != made.id));
    }

    // ---------------- rules CRUD ----------------

    fn rule_body() -> serde_json::Value {
        serde_json::json!({
            "when": [],
            "then": { "project": "cairn", "tags": [], "tagsFromCalendar": false }
        })
    }

    fn rule_input(id: Option<&str>, name: &str) -> RuleInput {
        RuleInput {
            id: id.map(|s| s.into()),
            name: name.into(),
            enabled: true,
            priority: 10,
            body: rule_body(),
        }
    }

    #[tokio::test]
    async fn save_rule_inserts_when_id_missing() {
        let (_dir, app, _db) = mock_app_with_db().await;
        let state = app.state::<crate::AppState>();
        let saved = save_rule(state.clone(), rule_input(None, "First rule"))
            .await
            .unwrap();
        assert_eq!(saved.name, "First rule");
        assert!(saved.enabled);
        assert_eq!(saved.priority, 10);
        // Body round-trips JSON.
        assert_eq!(saved.body, rule_body());
        let after = list_rules(state).await.unwrap();
        assert!(after.iter().any(|r| r.id == saved.id));
    }

    #[tokio::test]
    async fn save_rule_updates_existing_row() {
        let (_dir, app, _db) = mock_app_with_db().await;
        let state = app.state::<crate::AppState>();
        let made = save_rule(state.clone(), rule_input(None, "Original"))
            .await
            .unwrap();
        let mut renamed = rule_input(Some(&made.id), "Renamed");
        renamed.enabled = false;
        renamed.priority = 99;
        let updated = save_rule(state.clone(), renamed).await.unwrap();
        assert_eq!(updated.id, made.id);
        assert_eq!(updated.name, "Renamed");
        assert!(!updated.enabled);
        assert_eq!(updated.priority, 99);
    }

    #[tokio::test]
    async fn delete_rule_removes_row() {
        let (_dir, app, _db) = mock_app_with_db().await;
        let state = app.state::<crate::AppState>();
        let made = save_rule(state.clone(), rule_input(None, "Doomed"))
            .await
            .unwrap();
        delete_rule(state.clone(), made.id.clone()).await.unwrap();
        let after = list_rules(state).await.unwrap();
        assert!(after.iter().all(|r| r.id != made.id));
    }

    #[tokio::test]
    async fn save_rule_rejects_name_over_max_length() {
        // PR #65 security review: a compromised webview or held-down
        // keypress could otherwise submit a multi-MB name, which the
        // matcher walks on every snapshot tick.
        let (_dir, app, _db) = mock_app_with_db().await;
        let state = app.state::<crate::AppState>();
        let long_name = "a".repeat(super::MAX_RULE_NAME_LEN + 1);
        let err = save_rule(state, rule_input(None, &long_name))
            .await
            .unwrap_err();
        assert!(
            err.contains("name too long"),
            "expected size-limit error, got {err}",
        );
    }

    #[tokio::test]
    async fn save_rule_rejects_body_over_max_bytes() {
        // Sibling guard: cap the serialized body so a pathological
        // 100k-element `when` array can't get stored.
        let (_dir, app, _db) = mock_app_with_db().await;
        let state = app.state::<crate::AppState>();
        let huge_value = "x".repeat(super::MAX_RULE_BODY_BYTES + 1);
        let body = serde_json::json!({
            "when": [{"signal": "ide.folder", "op": "contains", "value": huge_value}],
            "then": { "project": "p", "tags": [], "tagsFromCalendar": false }
        });
        let input = RuleInput {
            id: None,
            name: "fits-but-body-doesnt".into(),
            enabled: true,
            priority: 0,
            body,
        };
        let err = save_rule(state, input).await.unwrap_err();
        assert!(
            err.contains("body too large"),
            "expected body-size error, got {err}",
        );
    }

    #[tokio::test]
    async fn save_rule_accepts_inputs_at_the_max_boundary() {
        // Exactly-at-limit must succeed; off-by-one rejection would
        // surprise users who hit the maxLength attribute on the
        // frontend input.
        let (_dir, app, _db) = mock_app_with_db().await;
        let state = app.state::<crate::AppState>();
        let at_limit = "n".repeat(super::MAX_RULE_NAME_LEN);
        let saved = save_rule(state, rule_input(None, &at_limit)).await.unwrap();
        assert_eq!(saved.name.chars().count(), super::MAX_RULE_NAME_LEN);
    }

    #[tokio::test]
    async fn save_rule_refreshes_rules_cache() {
        // Pin issue #55: the fanout reads from `AppState.rules_cache`
        // instead of querying the DB on every snapshot publish. The
        // cache must be invalidated after every `save_rule` write
        // or the fanout would evaluate snapshots against a stale
        // rule set.
        //
        // Asserts the *engine shape*: the cache holds parsed
        // `when` / `then` (not raw JSON), so the fanout can call
        // `outcome_for_full` against it without re-parsing.
        let (_dir, app, _db) = mock_app_with_db().await;
        let state = app.state::<crate::AppState>();
        assert!(
            state.rules_cache.read().unwrap().is_empty(),
            "fresh app starts with an empty rules cache",
        );
        let body = serde_json::json!({
            "when": [{"signal": "app.name", "op": "equals", "value": "Cached"}],
            "then": { "project": "cached-project", "tags": [], "tagsFromCalendar": false }
        });
        let saved = save_rule(
            state.clone(),
            RuleInput {
                id: None,
                name: "Cached".into(),
                enabled: true,
                priority: 10,
                body,
            },
        )
        .await
        .unwrap();
        let cache = state.rules_cache.read().unwrap();
        assert_eq!(cache.len(), 1, "cache should contain the just-saved rule");
        let cached = &cache[0];
        assert_eq!(cached.id, saved.id);
        assert_eq!(cached.name, "Cached");
        // Engine-shape assertions: the body was projected through
        // `project_rules`, not stored as raw JSON. A bug here would
        // mean the fanout's `outcome_for_full` runs against an empty
        // ruleset even though the cache claims to hold one.
        assert_eq!(cached.when.len(), 1, "parsed `when` from body");
        assert!(
            matches!(
                &cached.when[0],
                crate::rules::Condition::AppName { value, .. } if value == "Cached"
            ),
            "first condition projects through to AppName",
        );
        assert_eq!(
            cached.then.project.as_deref(),
            Some("cached-project"),
            "parsed `then.project` from body",
        );
    }

    #[tokio::test]
    async fn save_rule_update_refreshes_rules_cache() {
        // The save path's `ON CONFLICT(id) DO UPDATE` covers both
        // insert and update. The cache must reflect the *new* body
        // on the update path too — without the reload, the fanout
        // would keep matching against the previous body.
        let (_dir, app, _db) = mock_app_with_db().await;
        let state = app.state::<crate::AppState>();
        let body_v1 = serde_json::json!({
            "when": [{"signal": "app.name", "op": "equals", "value": "Original"}],
            "then": { "project": "p1", "tags": [], "tagsFromCalendar": false }
        });
        let made = save_rule(
            state.clone(),
            RuleInput {
                id: None,
                name: "R".into(),
                enabled: true,
                priority: 10,
                body: body_v1,
            },
        )
        .await
        .unwrap();
        let body_v2 = serde_json::json!({
            "when": [{"signal": "app.name", "op": "equals", "value": "Renamed"}],
            "then": { "project": "p2", "tags": [], "tagsFromCalendar": false }
        });
        save_rule(
            state.clone(),
            RuleInput {
                id: Some(made.id.clone()),
                name: "R".into(),
                enabled: true,
                priority: 10,
                body: body_v2,
            },
        )
        .await
        .unwrap();
        let cache = state.rules_cache.read().unwrap();
        assert_eq!(cache.len(), 1);
        assert!(
            matches!(
                &cache[0].when[0],
                crate::rules::Condition::AppName { value, .. } if value == "Renamed"
            ),
            "cache must reflect the updated body, not the original",
        );
        assert_eq!(cache[0].then.project.as_deref(), Some("p2"));
    }

    #[tokio::test]
    async fn delete_rule_refreshes_rules_cache() {
        // Sibling to save_rule_refreshes_rules_cache. Without the
        // post-delete reload the fanout would keep matching against
        // a rule the user just removed.
        let (_dir, app, _db) = mock_app_with_db().await;
        let state = app.state::<crate::AppState>();
        let made = save_rule(state.clone(), rule_input(None, "ToDelete"))
            .await
            .unwrap();
        assert_eq!(state.rules_cache.read().unwrap().len(), 1);
        delete_rule(state.clone(), made.id.clone()).await.unwrap();
        assert!(
            state.rules_cache.read().unwrap().is_empty(),
            "cache should reflect the delete on next read",
        );
    }

    // ---------------- reorder_rules (#15) ----------------

    async fn seed_three_rules(
        state: tauri::State<'_, crate::AppState>,
    ) -> (String, String, String) {
        let a = save_rule(state.clone(), rule_input(None, "A"))
            .await
            .unwrap();
        let b = save_rule(state.clone(), rule_input(None, "B"))
            .await
            .unwrap();
        let c = save_rule(state.clone(), rule_input(None, "C"))
            .await
            .unwrap();
        (a.id, b.id, c.id)
    }

    #[tokio::test]
    async fn reorder_rules_writes_dense_unique_priorities() {
        let (_dir, app, _db) = mock_app_with_db().await;
        let state = app.state::<crate::AppState>();
        let (a, b, c) = seed_three_rules(state.clone()).await;
        // Reverse the order: C, B, A.
        reorder_rules(state.clone(), vec![c.clone(), b.clone(), a.clone()])
            .await
            .unwrap();
        // list_rules orders by priority ASC, so the first element is
        // the new top (priority 10).
        let listed = list_rules(state).await.unwrap();
        let names: Vec<&str> = listed.iter().map(|r| r.name.as_str()).collect();
        assert_eq!(names, vec!["C", "B", "A"]);
        let priorities: Vec<i64> = listed.iter().map(|r| r.priority).collect();
        assert_eq!(priorities, vec![10, 20, 30]);
    }

    #[tokio::test]
    async fn reorder_rules_refreshes_rules_cache() {
        // The fanout reads from `rules_cache`; after a reorder, the
        // cache must reflect the new priority ordering on the very
        // next snapshot tick.
        let (_dir, app, _db) = mock_app_with_db().await;
        let state = app.state::<crate::AppState>();
        let (a, b, _c) = seed_three_rules(state.clone()).await;
        reorder_rules(
            state.clone(),
            vec![b.clone(), a.clone(), {
                // grab id of c by re-listing
                list_rules(state.clone())
                    .await
                    .unwrap()
                    .into_iter()
                    .find(|r| r.name == "C")
                    .unwrap()
                    .id
            }],
        )
        .await
        .unwrap();
        let cache = state.rules_cache.read().unwrap();
        let names: Vec<&str> = cache.iter().map(|r| r.name.as_str()).collect();
        assert_eq!(names, vec!["B", "A", "C"]);
    }

    #[tokio::test]
    async fn reorder_rules_rejects_partial_id_list() {
        let (_dir, app, _db) = mock_app_with_db().await;
        let state = app.state::<crate::AppState>();
        let (a, b, _c) = seed_three_rules(state.clone()).await;
        // Two ids for a three-rule DB → reject. A silent drop would
        // make rule c un-orderable from the UI.
        let err = reorder_rules(state, vec![a, b]).await.unwrap_err();
        assert!(
            err.contains("length"),
            "expected length-mismatch error, got: {err}"
        );
    }

    #[tokio::test]
    async fn reorder_rules_rejects_duplicate_ids() {
        let (_dir, app, _db) = mock_app_with_db().await;
        let state = app.state::<crate::AppState>();
        let (a, b, _c) = seed_three_rules(state.clone()).await;
        // Duplicate `a` in the list → reject. Tolerating duplicates
        // would assign two priorities to one rule.
        let err = reorder_rules(state, vec![a.clone(), b, a])
            .await
            .unwrap_err();
        assert!(
            err.contains("duplicate"),
            "expected duplicate-id error, got: {err}"
        );
    }

    #[tokio::test]
    async fn reorder_rules_rejects_unknown_id() {
        let (_dir, app, _db) = mock_app_with_db().await;
        let state = app.state::<crate::AppState>();
        let (a, b, c) = seed_three_rules(state.clone()).await;
        let err = reorder_rules(state, vec![a, b, c, "ghost-id".into()])
            .await
            .unwrap_err();
        assert!(
            err.contains("length") || err.contains("unknown"),
            "expected unknown-id error, got: {err}"
        );
    }

    #[tokio::test]
    async fn reorder_rules_rejects_unknown_id_with_matching_length() {
        // Same total count as the DB (so the length check passes)
        // but one of the ids has been substituted for a ghost id —
        // this is the *per-id* membership check, not the length
        // check. Without an explicit test of this path the
        // "unknown id" error string is never reached.
        let (_dir, app, _db) = mock_app_with_db().await;
        let state = app.state::<crate::AppState>();
        let (a, b, _c) = seed_three_rules(state.clone()).await;
        let err = reorder_rules(state, vec![a, b, "ghost-id".into()])
            .await
            .unwrap_err();
        assert!(
            err.contains("unknown"),
            "expected unknown-id error, got: {err}"
        );
    }

    #[tokio::test]
    async fn reorder_rules_accepts_empty_list_on_empty_db() {
        let (_dir, app, _db) = mock_app_with_db().await;
        let state = app.state::<crate::AppState>();
        // No rules in DB → empty reorder is a no-op, not an error.
        reorder_rules(state, vec![]).await.unwrap();
    }

    #[tokio::test]
    async fn reorder_rules_rejects_oversized_input() {
        let (_dir, app, _db) = mock_app_with_db().await;
        let state = app.state::<crate::AppState>();
        let ids: Vec<String> = (0..MAX_REORDER_RULES + 1)
            .map(|i| format!("ghost-{i}"))
            .collect();
        let err = reorder_rules(state, ids).await.unwrap_err();
        assert!(
            err.contains("too many"),
            "expected too-many-ids error, got: {err}"
        );
    }

    #[tokio::test]
    async fn reorder_rules_rejects_overlong_id() {
        // Security-review suggestion: cap each id's length so a
        // forged caller can't OOM us with 10k × MB-sized strings
        // before the dedup HashSet allocates. Real ids are 36-char
        // UUIDs; the cap is 128.
        let (_dir, app, _db) = mock_app_with_db().await;
        let state = app.state::<crate::AppState>();
        let big_id = "a".repeat(MAX_RULE_ID_LEN + 1);
        let err = reorder_rules(state, vec![big_id]).await.unwrap_err();
        assert!(
            err.contains("too long"),
            "expected id-too-long error, got: {err}"
        );
    }

    #[tokio::test]
    async fn reorder_rules_priorities_stay_dense_across_many_moves() {
        // Invariant test per #15 acceptance criterion: "all priorities
        // unique and dense." Seed 20 rules, run 50 deterministic
        // pseudo-random reorders, and after EACH assert the priority
        // sequence is exactly [10, 20, …, 200] AND the id-set is
        // unchanged. Catches off-by-one in the priority math + any
        // silent drop/duplicate the validation forgot.
        let (_dir, app, _db) = mock_app_with_db().await;
        let state = app.state::<crate::AppState>();
        let mut ids = Vec::with_capacity(20);
        for i in 0..20 {
            let r = save_rule(state.clone(), rule_input(None, &format!("R{i}")))
                .await
                .unwrap();
            ids.push(r.id);
        }
        let initial_id_set: std::collections::HashSet<String> = ids.iter().cloned().collect();

        // Cheap deterministic PRNG so the test is reproducible.
        let mut rng_state: u64 = 0x9e3779b97f4a7c15;
        let mut rand = || {
            rng_state = rng_state.wrapping_mul(6364136223846793005).wrapping_add(1);
            rng_state
        };

        for _ in 0..50 {
            // Fisher-Yates one swap (shuffle in place).
            let i = (rand() as usize) % ids.len();
            let j = (rand() as usize) % ids.len();
            ids.swap(i, j);
            reorder_rules(state.clone(), ids.clone()).await.unwrap();
            let listed = list_rules(state.clone()).await.unwrap();
            // Priorities must be exactly 10..=200, stepped by 10.
            let priorities: Vec<i64> = listed.iter().map(|r| r.priority).collect();
            let expected: Vec<i64> = (1..=20).map(|n| n * 10).collect();
            assert_eq!(
                priorities, expected,
                "priorities must be dense+unique after every reorder",
            );
            // ID set must be conserved — no leak, no drop.
            let listed_ids: std::collections::HashSet<String> =
                listed.iter().map(|r| r.id.clone()).collect();
            assert_eq!(
                listed_ids, initial_id_set,
                "the set of ids must be conserved across reorders",
            );
            // The DB's listed order (by priority asc) must match
            // the order we sent in — proves the priorities ARE
            // assigned in the caller's order.
            let listed_order: Vec<String> = listed.iter().map(|r| r.id.clone()).collect();
            assert_eq!(
                listed_order, ids,
                "DB ordering must match the supplied id sequence",
            );
        }
    }

    // ---------------- exclusions CRUD ----------------

    fn exclusion_input(kind: &str, value: &str) -> ExclusionInput {
        ExclusionInput {
            kind: kind.into(),
            value: value.into(),
        }
    }

    #[tokio::test]
    async fn list_exclusions_is_empty_on_fresh_db() {
        let (_dir, app, _db) = mock_app_with_db().await;
        let state = app.state::<crate::AppState>();
        let exclusions = list_exclusions(state).await.unwrap();
        assert!(exclusions.is_empty());
    }

    #[tokio::test]
    async fn save_exclusion_inserts_for_each_valid_kind() {
        let (_dir, app, _db) = mock_app_with_db().await;
        let state = app.state::<crate::AppState>();
        for (kind, value) in [
            ("app", "Slack"),
            ("domain", "facebook.com"),
            ("window", "Private"),
        ] {
            let saved = save_exclusion(state.clone(), exclusion_input(kind, value))
                .await
                .unwrap();
            assert_eq!(saved.kind, kind);
            assert_eq!(saved.value, value);
            assert!(!saved.id.is_empty());
        }
        let after = list_exclusions(state).await.unwrap();
        assert_eq!(after.len(), 3);
    }

    #[tokio::test]
    async fn save_exclusion_rejects_empty_value() {
        let (_dir, app, _db) = mock_app_with_db().await;
        let state = app.state::<crate::AppState>();
        let err = save_exclusion(state, exclusion_input("app", "   "))
            .await
            .unwrap_err();
        assert!(err.contains("empty"), "unexpected error: {err}");
    }

    #[tokio::test]
    async fn save_exclusion_rejects_unknown_kind() {
        let (_dir, app, _db) = mock_app_with_db().await;
        let state = app.state::<crate::AppState>();
        let err = save_exclusion(state, exclusion_input("garbage", "x"))
            .await
            .unwrap_err();
        assert!(err.contains("garbage"), "unexpected error: {err}");
    }

    #[tokio::test]
    async fn delete_exclusion_removes_row() {
        let (_dir, app, _db) = mock_app_with_db().await;
        let state = app.state::<crate::AppState>();
        let made = save_exclusion(state.clone(), exclusion_input("app", "Mail"))
            .await
            .unwrap();
        delete_exclusion(state.clone(), made.id.clone())
            .await
            .unwrap();
        let after = list_exclusions(state).await.unwrap();
        assert!(after.is_empty());
    }

    // ---------------- entry update / delete ----------------

    #[tokio::test]
    async fn update_entry_modifies_individual_fields() {
        let (_dir, app, _db) = mock_app_with_db().await;
        let state = app.state::<crate::AppState>();

        let entry = start_entry(state.clone(), start_input(Some("cairn"), "Initial desc"))
            .await
            .unwrap();
        let task = save_task(state.clone(), task_input(None, "cairn", "Bugs"))
            .await
            .unwrap();

        // Patch description + task.
        let patched = update_entry(
            state.clone(),
            UpdateEntryInput {
                id: entry.id.clone(),
                project_id: None,
                task_id: Some(Some(task.id.clone())),
                description: Some("Updated desc".into()),
                started_at: None,
                ended_at: None,
            },
        )
        .await
        .unwrap();
        assert_eq!(patched.description, "Updated desc");
        assert_eq!(patched.task_id.as_deref(), Some(task.id.as_str()));
        assert_eq!(patched.project_id.as_deref(), Some("cairn"));
    }

    #[tokio::test]
    async fn update_entry_changing_project_clears_task() {
        let (_dir, app, _db) = mock_app_with_db().await;
        let state = app.state::<crate::AppState>();

        let entry = start_entry(state.clone(), start_input(Some("cairn"), "x"))
            .await
            .unwrap();
        let task = save_task(state.clone(), task_input(None, "cairn", "Refactor"))
            .await
            .unwrap();
        // Attach task.
        update_entry(
            state.clone(),
            UpdateEntryInput {
                id: entry.id.clone(),
                project_id: None,
                task_id: Some(Some(task.id.clone())),
                description: None,
                started_at: None,
                ended_at: None,
            },
        )
        .await
        .unwrap();

        // Change project — task must reset to None.
        let after = update_entry(
            state.clone(),
            UpdateEntryInput {
                id: entry.id.clone(),
                project_id: Some(Some("site".into())),
                task_id: None,
                description: None,
                started_at: None,
                ended_at: None,
            },
        )
        .await
        .unwrap();
        assert_eq!(after.project_id.as_deref(), Some("site"));
        assert!(after.task_id.is_none(), "changing project must clear task");
    }

    #[tokio::test]
    async fn update_entry_can_set_started_and_ended() {
        let (_dir, app, _db) = mock_app_with_db().await;
        let state = app.state::<crate::AppState>();

        let entry = start_entry(state.clone(), start_input(Some("cairn"), "x"))
            .await
            .unwrap();
        let started_at = "2026-05-23T08:00:00+00:00".to_string();
        let ended_at = "2026-05-23T09:30:00+00:00".to_string();
        let patched = update_entry(
            state.clone(),
            UpdateEntryInput {
                id: entry.id.clone(),
                project_id: None,
                task_id: None,
                description: None,
                started_at: Some(started_at.clone()),
                ended_at: Some(Some(ended_at.clone())),
            },
        )
        .await
        .unwrap();
        assert_eq!(patched.started_at.to_rfc3339(), started_at);
        assert_eq!(patched.ended_at.map(|t| t.to_rfc3339()), Some(ended_at));
    }

    #[tokio::test]
    async fn delete_entry_removes_row() {
        let (_dir, app, _db) = mock_app_with_db().await;
        let state = app.state::<crate::AppState>();
        let entry = start_entry(state.clone(), start_input(None, "doomed"))
            .await
            .unwrap();
        delete_entry(state.clone(), entry.id.clone()).await.unwrap();
        let today = list_today(state).await.unwrap();
        assert!(today.iter().all(|e| e.id != entry.id));
    }

    // ---------------- create_entry (#21) ----------------

    fn create_input_closed(
        project: Option<&str>,
        description: &str,
        started: &str,
        ended: &str,
    ) -> CreateEntryInput {
        CreateEntryInput {
            project_id: project.map(Into::into),
            task_id: None,
            description: description.into(),
            started_at: started.into(),
            ended_at: Some(ended.into()),
            source: None,
        }
    }

    #[tokio::test]
    async fn create_entry_persists_a_closed_historical_row() {
        let (_dir, app, _db) = mock_app_with_db().await;
        let state = app.state::<crate::AppState>();
        let entry = create_entry(
            state.clone(),
            create_input_closed(
                Some("cairn"),
                "Backfill",
                "2026-05-23T08:00:00+00:00",
                "2026-05-23T09:30:00+00:00",
            ),
        )
        .await
        .unwrap();
        assert_eq!(entry.description, "Backfill");
        assert_eq!(entry.project_id.as_deref(), Some("cairn"));
        assert!(entry.ended_at.is_some());
        assert_eq!(entry.source, "manual");

        // Closed manual entry must NOT stop a running timer.
        let running = current_running(state).await.unwrap();
        assert!(running.is_none(), "closed create must not affect running");
    }

    #[tokio::test]
    async fn create_entry_open_ended_replaces_running_timer() {
        let (_dir, app, _db) = mock_app_with_db().await;
        let state = app.state::<crate::AppState>();
        let prior = start_entry(state.clone(), start_input(Some("cairn"), "prior"))
            .await
            .unwrap();

        let started = (Utc::now() - Duration::minutes(5)).to_rfc3339();
        let open = create_entry(
            state.clone(),
            CreateEntryInput {
                project_id: Some("acme".into()),
                task_id: None,
                description: "Backfill open".into(),
                started_at: started,
                ended_at: None,
                source: Some("manual".into()),
            },
        )
        .await
        .unwrap();
        assert!(open.ended_at.is_none());

        let running = current_running(state.clone()).await.unwrap().unwrap();
        assert_eq!(running.id, open.id);

        let today = list_today(state).await.unwrap();
        let prior_after = today.iter().find(|e| e.id == prior.id).unwrap();
        assert!(prior_after.ended_at.is_some());
    }

    #[tokio::test]
    async fn create_entry_rejects_inverted_range() {
        let (_dir, app, _db) = mock_app_with_db().await;
        let state = app.state::<crate::AppState>();
        let err = create_entry(
            state,
            create_input_closed(
                None,
                "x",
                "2026-05-23T10:00:00+00:00",
                "2026-05-23T09:00:00+00:00",
            ),
        )
        .await
        .unwrap_err();
        assert!(err.contains("ended_at"));
    }

    #[tokio::test]
    async fn create_entry_rejects_equal_range() {
        let (_dir, app, _db) = mock_app_with_db().await;
        let state = app.state::<crate::AppState>();
        let err = create_entry(
            state,
            create_input_closed(
                None,
                "x",
                "2026-05-23T10:00:00+00:00",
                "2026-05-23T10:00:00+00:00",
            ),
        )
        .await
        .unwrap_err();
        assert!(err.contains("ended_at"));
    }

    #[tokio::test]
    async fn create_entry_rejects_malformed_timestamp() {
        let (_dir, app, _db) = mock_app_with_db().await;
        let state = app.state::<crate::AppState>();
        let err = create_entry(
            state,
            CreateEntryInput {
                project_id: None,
                task_id: None,
                description: "x".into(),
                started_at: "not-a-timestamp".into(),
                ended_at: None,
                source: None,
            },
        )
        .await
        .unwrap_err();
        assert!(err.to_lowercase().contains("started_at"));
    }

    // ---------------- list_week aggregation ----------------

    #[tokio::test]
    async fn list_week_returns_seven_days_starting_on_monday() {
        let (_dir, app, _db) = mock_app_with_db().await;
        let state = app.state::<crate::AppState>();
        let week = list_week(state).await.unwrap();
        assert_eq!(week.len(), 7);
        assert_eq!(week[0].day, "Mon");
        assert_eq!(week[6].day, "Sun");
        // One of the days is today.
        assert_eq!(week.iter().filter(|d| d.today).count(), 1);
        // Saturday + Sunday flagged weekend.
        assert!(week[5].weekend);
        assert!(week[6].weekend);
        // Nothing in the DB → all zero hours.
        assert!(week.iter().all(|d| d.hours == 0.0));
    }

    #[tokio::test]
    async fn list_week_counts_open_entry_against_now() {
        let (_dir, app, _db) = mock_app_with_db().await;
        let state = app.state::<crate::AppState>();
        // Open entry started 1h ago, no ended_at — list_week must
        // close it against "now" and count ~1h somewhere in the
        // week.
        //
        // The bucket it lands on depends on local timezone: when
        // this test runs in the first hour after local midnight,
        // "1h ago" is yesterday locally. The contract we actually
        // need to pin is that an open entry IS surfaced — without
        // that the snapshot drops the running-timer signal in the
        // weekly view. Pin the total instead of `today.hours` to
        // keep the test deterministic across timezones.
        let id = uuid::Uuid::new_v4().to_string();
        let started = (Utc::now() - Duration::minutes(60)).to_rfc3339();
        sqlx::query(
            r#"
            INSERT INTO entries
                (id, project_id, task_id, description, started_at, ended_at,
                 source, rule_id, created_at, updated_at)
            VALUES (?1, ?2, NULL, '', ?3, NULL, 'manual', NULL, ?3, ?3)
            "#,
        )
        .bind(&id)
        .bind("cairn")
        .bind(&started)
        .execute(&app.state::<crate::AppState>().db.pool)
        .await
        .unwrap();

        let week = list_week(state).await.unwrap();
        let total: f64 = week.iter().map(|d| d.hours).sum();
        assert!(
            (0.9..=1.1).contains(&total),
            "open entry should contribute ~1h across the week; got {total}",
        );
    }

    #[tokio::test]
    async fn list_week_includes_entry_crossing_midnight() {
        let (_dir, app, _db) = mock_app_with_db().await;
        let state = app.state::<crate::AppState>();
        // Put a closed entry firmly inside this week: starts 2h after
        // Monday-local-midnight, ends 1h later. Should land on Monday's
        // bucket regardless of system tz.
        let monday_local = monday_of(Local::now().date_naive());
        let start_utc = local_midnight_utc(monday_local) + Duration::hours(2);
        let end_utc = start_utc + Duration::hours(1);
        let id = uuid::Uuid::new_v4().to_string();
        sqlx::query(
            r#"
            INSERT INTO entries
                (id, project_id, task_id, description, started_at, ended_at,
                 source, rule_id, created_at, updated_at)
            VALUES (?1, 'cairn', NULL, '', ?2, ?3, 'manual', NULL, ?2, ?2)
            "#,
        )
        .bind(&id)
        .bind(start_utc.to_rfc3339())
        .bind(end_utc.to_rfc3339())
        .execute(&app.state::<crate::AppState>().db.pool)
        .await
        .unwrap();

        let week = list_week(state).await.unwrap();
        let monday = week.iter().find(|d| d.day == "Mon").unwrap();
        assert!(monday.hours >= 0.99 && monday.hours <= 1.01);
        assert_eq!(monday.segments.len(), 1);
        assert_eq!(monday.segments[0].0, "cairn");
    }

    // ---------------- pure helpers ----------------

    #[test]
    fn monday_of_returns_same_date_when_input_is_monday() {
        let mon = NaiveDate::from_ymd_opt(2026, 5, 18).unwrap(); // Mon
        assert_eq!(monday_of(mon), mon);
    }

    #[test]
    fn monday_of_walks_back_from_sunday() {
        let sun = NaiveDate::from_ymd_opt(2026, 5, 24).unwrap(); // Sun
        let mon = NaiveDate::from_ymd_opt(2026, 5, 18).unwrap();
        assert_eq!(monday_of(sun), mon);
    }

    #[test]
    fn monday_of_walks_back_from_wednesday() {
        let wed = NaiveDate::from_ymd_opt(2026, 5, 20).unwrap();
        let mon = NaiveDate::from_ymd_opt(2026, 5, 18).unwrap();
        assert_eq!(monday_of(wed), mon);
    }

    #[test]
    fn local_midnight_utc_returns_a_value_on_a_normal_day() {
        let d = NaiveDate::from_ymd_opt(2026, 5, 23).unwrap();
        let utc = local_midnight_utc(d);
        // The result must be the same calendar date in local time.
        let local = utc.with_timezone(&Local);
        assert_eq!(local.date_naive(), d);
        assert_eq!(
            local.time(),
            chrono::NaiveTime::from_hms_opt(0, 0, 0).unwrap()
        );
    }

    #[test]
    fn round2_truncates_to_two_decimals() {
        assert_eq!(round2(1.005), 1.0); // banker's rounding via f64 — half-even
        assert_eq!(round2(1.234), 1.23);
        assert_eq!(round2(1.235999), 1.24);
        assert_eq!(round2(0.0), 0.0);
    }

    // ---------------- calendar IPC ----------------

    #[tokio::test]
    async fn list_calendar_sources_is_empty_on_fresh_db() {
        let (_dir, app, _db) = mock_app_with_db().await;
        let state = app.state::<crate::AppState>();
        let sources = list_calendar_sources(state).await.unwrap();
        assert!(sources.is_empty());
    }

    #[tokio::test]
    async fn add_calendar_source_rejects_empty_label() {
        let (_dir, app, _db) = mock_app_with_db().await;
        let state = app.state::<crate::AppState>();
        let err = add_calendar_source(
            state,
            AddCalendarInput {
                kind: CalendarKind::File,
                label: "   ".into(),
                raw: "/tmp/cal.ics".into(),
            },
        )
        .await
        .unwrap_err();
        assert_eq!(err, "label cannot be empty");
    }

    #[tokio::test]
    async fn add_calendar_source_rejects_empty_raw() {
        let (_dir, app, _db) = mock_app_with_db().await;
        let state = app.state::<crate::AppState>();
        let err = add_calendar_source(
            state,
            AddCalendarInput {
                kind: CalendarKind::File,
                label: "Work".into(),
                raw: "   ".into(),
            },
        )
        .await
        .unwrap_err();
        assert_eq!(err, "URL or path cannot be empty");
    }

    #[tokio::test]
    async fn add_calendar_source_file_kind_persists_to_store() {
        let (_dir, app, _db) = mock_app_with_db().await;
        let state = app.state::<crate::AppState>();
        // Use a non-existent path: registry kicks off an initial sync
        // which will fail to read the file, but the source row must
        // still be persisted (sync errors are recorded, not fatal).
        let added = add_calendar_source(
            state.clone(),
            AddCalendarInput {
                kind: CalendarKind::File,
                label: "  Local ICS  ".into(),
                raw: "/tmp/does-not-exist.ics".into(),
            },
        )
        .await
        .unwrap();
        assert_eq!(added.label, "Local ICS", "label is trimmed");
        assert_eq!(added.location, "/tmp/does-not-exist.ics");
        assert!(matches!(added.kind, CalendarKind::File));
        assert!(added.enabled);

        let after = list_calendar_sources(state).await.unwrap();
        assert_eq!(after.len(), 1);
        assert_eq!(after[0].id, added.id);
    }

    #[tokio::test]
    async fn add_calendar_source_url_kind_redacts_location() {
        let (_dir, app, _db) = mock_app_with_db().await;
        let state = app.state::<crate::AppState>();
        // Use a deliberately invalid host so the post-add sync fails
        // fast without making a network call to a real server.
        let raw = "https://example.invalid/calendar/ical/SECRET-TOKEN/basic.ics";
        let added = add_calendar_source(
            state.clone(),
            AddCalendarInput {
                kind: CalendarKind::Url,
                label: "Work".into(),
                raw: raw.into(),
            },
        )
        .await
        .unwrap();
        assert!(matches!(added.kind, CalendarKind::Url));
        // The stored location is the redacted form — host without path.
        assert!(!added.location.contains("SECRET-TOKEN"));
        assert!(added.location.contains("example.invalid"));
        // Clean up the keychain entry the registry created so other
        // test runs aren't polluted.
        let _ = remove_calendar_source(state, added.id).await;
    }

    #[tokio::test]
    async fn update_calendar_source_round_trips_fields() {
        let (_dir, app, _db) = mock_app_with_db().await;
        let state = app.state::<crate::AppState>();
        let added = add_calendar_source(
            state.clone(),
            AddCalendarInput {
                kind: CalendarKind::File,
                label: "Old".into(),
                raw: "/tmp/cal.ics".into(),
            },
        )
        .await
        .unwrap();
        let updated = update_calendar_source(
            state.clone(),
            UpdateCalendarInput {
                id: added.id.clone(),
                label: Some("Renamed".into()),
                poll_seconds: Some(120),
                enabled: Some(false),
            },
        )
        .await
        .unwrap();
        assert_eq!(updated.label, "Renamed");
        assert_eq!(updated.poll_seconds, 120);
        assert!(!updated.enabled);
    }

    #[tokio::test]
    async fn remove_calendar_source_deletes_row() {
        let (_dir, app, _db) = mock_app_with_db().await;
        let state = app.state::<crate::AppState>();
        let added = add_calendar_source(
            state.clone(),
            AddCalendarInput {
                kind: CalendarKind::File,
                label: "Doomed".into(),
                raw: "/tmp/x.ics".into(),
            },
        )
        .await
        .unwrap();
        remove_calendar_source(state.clone(), added.id.clone())
            .await
            .unwrap();
        let after = list_calendar_sources(state).await.unwrap();
        assert!(after.is_empty());
    }

    #[tokio::test]
    async fn refresh_calendar_source_fails_for_unknown_id() {
        let (_dir, app, _db) = mock_app_with_db().await;
        let state = app.state::<crate::AppState>();
        let err = refresh_calendar_source(state, "does-not-exist".into())
            .await
            .unwrap_err();
        assert!(err.contains("does-not-exist"), "unexpected error: {err}");
    }

    #[tokio::test]
    async fn current_calendar_events_is_empty_on_fresh_db() {
        let (_dir, app, _db) = mock_app_with_db().await;
        let state = app.state::<crate::AppState>();
        let events = current_calendar_events(state).await.unwrap();
        assert!(events.is_empty());
    }

    #[tokio::test]
    async fn upcoming_calendar_events_is_empty_on_fresh_db() {
        let (_dir, app, _db) = mock_app_with_db().await;
        let state = app.state::<crate::AppState>();
        let events = upcoming_calendar_events(state, Some(3)).await.unwrap();
        assert!(events.is_empty());
    }

    #[tokio::test]
    async fn upcoming_calendar_events_defaults_limit_when_none() {
        let (_dir, app, _db) = mock_app_with_db().await;
        let state = app.state::<crate::AppState>();
        // No events seeded — we just exercise the None-limit branch.
        let events = upcoming_calendar_events(state, None).await.unwrap();
        assert!(events.is_empty());
    }

    #[tokio::test]
    async fn calendar_sync_status_lists_added_sources() {
        let (_dir, app, _db) = mock_app_with_db().await;
        let state = app.state::<crate::AppState>();
        let added = add_calendar_source(
            state.clone(),
            AddCalendarInput {
                kind: CalendarKind::File,
                label: "Plan".into(),
                raw: "/tmp/plan.ics".into(),
            },
        )
        .await
        .unwrap();
        let statuses = calendar_sync_status(state).await.unwrap();
        assert_eq!(statuses.len(), 1);
        assert_eq!(statuses[0].source_id, added.id);
        // The initial sync against a non-existent file will have run;
        // either way event_count is 0 (no parsed events buffered).
        assert_eq!(statuses[0].event_count, 0);
    }

    #[tokio::test]
    async fn current_snapshot_returns_empty_calendar_on_fresh_db() {
        let (_dir, app, _db) = mock_app_with_db().await;
        let state = app.state::<crate::AppState>();
        let snap = current_snapshot(state).await.unwrap();
        assert!(snap.calendar.is_empty());
        assert!(snap.browser_domain.is_none());
        assert!(snap.git_branch.is_none());
        assert!(snap.ide_folder.is_none());
    }

    // ---------------- get_git_watcher_status / browser_extension_status (#34) ----------------

    #[tokio::test]
    async fn get_git_watcher_status_returns_boot_snapshot() {
        let (_dir, app, _db) = mock_app_with_db().await;
        let state = app.state::<crate::AppState>();
        let status = get_git_watcher_status(state).unwrap();
        // mock_app_with_db boots with empty roots — see test_support.rs.
        assert_eq!(status.watched_count, 0);
        assert!(status.discovery_roots.is_empty());
    }

    #[test]
    fn normalize_roots_trims_drops_blanks_and_dedupes() {
        let out = normalize_roots(&[
            "  ~/code  ".into(),
            "".into(),
            "   ".into(),
            "~/code".into(),
            "/srv/git".into(),
        ]);
        assert_eq!(out, vec!["~/code".to_string(), "/srv/git".to_string()]);
    }

    #[test]
    fn validate_roots_accepts_ordinary_paths_and_empty() {
        assert!(validate_roots(&[]).is_ok());
        assert!(validate_roots(&["~/code".into(), "/srv/git".into()]).is_ok());
    }

    #[test]
    fn validate_roots_rejects_filesystem_root() {
        assert!(validate_roots(&["/".into()]).is_err());
    }

    #[test]
    fn validate_roots_rejects_bare_home() {
        // Only meaningful when a home dir resolves in the test env.
        if dirs::home_dir().is_some() {
            assert!(validate_roots(&["~".into()]).is_err());
        }
    }

    #[test]
    fn validate_roots_rejects_too_many() {
        let many: Vec<String> = (0..MAX_DISCOVERY_ROOTS + 1)
            .map(|i| format!("/p/{i}"))
            .collect();
        assert!(validate_roots(&many).is_err());
    }

    #[tokio::test]
    async fn get_git_discovery_roots_falls_back_to_defaults_when_unset() {
        let (_dir, app, _db) = mock_app_with_db().await;
        let configured = {
            let state = app.state::<crate::AppState>();
            get_git_discovery_roots(state).await.unwrap()
        };
        // With no override persisted, the command returns the built-in
        // defaults in display form — which equals display_roots of
        // default_discovery_roots (possibly empty on a CI box with no
        // conventional dev dirs, but never an error).
        let expected = crate::signals::git_watcher::display_roots(
            &crate::signals::git_watcher::default_discovery_roots(),
        );
        assert_eq!(configured, expected);
    }

    #[tokio::test]
    async fn set_git_discovery_roots_rejects_filesystem_root_without_persisting() {
        let (_dir, app, db) = mock_app_with_db().await;
        let result = {
            let state = app.state::<crate::AppState>();
            set_git_discovery_roots(state, vec!["/".into()]).await
        };
        assert!(result.is_err());
        // Nothing persisted (validation runs before any write).
        assert!(load_discovery_roots(&db.pool).await.is_empty());
    }

    #[tokio::test]
    async fn discovery_roots_default_to_empty_then_roundtrip() {
        let (_dir, _app, db) = mock_app_with_db().await;
        // Unset → empty (caller treats as "use defaults").
        assert!(load_discovery_roots(&db.pool).await.is_empty());

        persist_discovery_roots(&db.pool, &["~/work".into(), "/opt/x".into()])
            .await
            .unwrap();
        let loaded = load_discovery_roots(&db.pool).await;
        assert_eq!(loaded, vec!["~/work".to_string(), "/opt/x".to_string()]);
    }

    #[tokio::test]
    async fn set_git_discovery_roots_persists_discovers_and_updates_status() {
        let (_dir, app, db) = mock_app_with_db().await;
        let tmp = tempfile::tempdir().unwrap();
        let repo = tmp.path().join("proj");
        std::fs::create_dir_all(repo.join(".git")).unwrap();
        std::fs::write(repo.join(".git").join("HEAD"), "ref: refs/heads/main\n").unwrap();
        let root = tmp.path().to_string_lossy().to_string();

        let status = {
            let state = app.state::<crate::AppState>();
            set_git_discovery_roots(state, vec![root.clone(), "  ".into(), root.clone()])
                .await
                .unwrap()
        };
        assert_eq!(status.watched_count, 1);
        assert_eq!(status.discovery_roots, vec![root.clone()]);

        // Persisted, deduped, blanks dropped.
        assert_eq!(load_discovery_roots(&db.pool).await, vec![root.clone()]);

        // The cached status the UI reads now reflects the new roots.
        let got = {
            let state = app.state::<crate::AppState>();
            get_git_watcher_status(state).unwrap()
        };
        assert_eq!(got.watched_count, 1);
        assert_eq!(got.discovery_roots, vec![root]);
    }

    #[tokio::test]
    async fn set_git_discovery_roots_empty_clears_override() {
        let (_dir, app, db) = mock_app_with_db().await;
        persist_discovery_roots(&db.pool, &["/seeded".into()])
            .await
            .unwrap();
        {
            let state = app.state::<crate::AppState>();
            set_git_discovery_roots(state, vec!["   ".into(), "".into()])
                .await
                .unwrap();
        }
        // Override cleared → load returns empty (defaults apply).
        assert!(load_discovery_roots(&db.pool).await.is_empty());
    }

    #[tokio::test]
    async fn browser_extension_status_is_disconnected_until_a_heartbeat_arrives() {
        let (_dir, app, _db) = mock_app_with_db().await;
        let state = app.state::<crate::AppState>();
        let status = browser_extension_status(state).unwrap();
        assert!(!status.connected);
        assert!(status.last_seen.is_none());
        assert!(status.browser_label.is_none());
    }

    #[tokio::test]
    async fn browser_extension_status_reflects_a_recorded_heartbeat() {
        let (_dir, app, _db) = mock_app_with_db().await;
        app.state::<crate::AppState>()
            .browser_extension
            .record_heartbeat(Some("Safari".into()), Utc::now());
        let state = app.state::<crate::AppState>();
        let status = browser_extension_status(state).unwrap();
        assert!(status.connected);
        assert_eq!(status.browser_label.as_deref(), Some("Safari"));
        assert!(status.last_seen.is_some());
    }

    // ---------------- signal_capture_* (#23) ----------------

    #[tokio::test]
    async fn signal_capture_status_starts_inactive_on_a_fresh_app() {
        let (_dir, app, _db) = mock_app_with_db().await;
        let state = app.state::<crate::AppState>();
        let st = signal_capture_status(state).await.unwrap();
        assert!(!st.active);
        assert!(st.path.is_none());
        assert_eq!(st.bytes_written, 0);
    }

    #[tokio::test]
    async fn start_then_stop_signal_capture_round_trip_deletes_the_file() {
        let (_dir, app, _db) = mock_app_with_db().await;
        let state = app.state::<crate::AppState>();
        let path = start_signal_capture(app.state::<crate::AppState>())
            .await
            .unwrap();
        let st = signal_capture_status(app.state::<crate::AppState>())
            .await
            .unwrap();
        assert!(st.active);
        assert_eq!(st.path.as_deref(), Some(path.as_str()));
        assert!(
            std::path::Path::new(&path).exists(),
            "ndjson file must exist while capture is on"
        );

        stop_signal_capture(state).await.unwrap();

        let st = signal_capture_status(app.state::<crate::AppState>())
            .await
            .unwrap();
        assert!(!st.active);
        assert!(
            !std::path::Path::new(&path).exists(),
            "stop must delete the ndjson file"
        );
    }

    #[tokio::test]
    async fn double_start_signal_capture_returns_an_error() {
        let (_dir, app, _db) = mock_app_with_db().await;
        let _path = start_signal_capture(app.state::<crate::AppState>())
            .await
            .unwrap();
        let err = start_signal_capture(app.state::<crate::AppState>())
            .await
            .unwrap_err();
        assert!(err.contains("already running"));
        stop_signal_capture(app.state::<crate::AppState>())
            .await
            .unwrap();
    }

    // ---------------- dry_run_rules (#13) ----------------

    fn dry_run_snapshot(
        ide: Option<&str>,
        branch: Option<&str>,
        title: Option<&str>,
    ) -> crate::rules::SignalSnapshot {
        crate::rules::SignalSnapshot {
            ide_folder: ide.map(str::to_owned),
            git_branch: branch.map(str::to_owned),
            window_title: title.map(str::to_owned),
            app_name: None,
            browser_domain: None,
            calendar: vec![],
        }
    }

    fn dry_run_rule_body(signal: &str, op: &str, value: &str, project: &str) -> serde_json::Value {
        serde_json::json!({
            "when": [{ "signal": signal, "op": op, "value": value }],
            "then": { "project": project, "tags": [], "tagsFromCalendar": false }
        })
    }

    #[tokio::test]
    async fn dry_run_returns_none_when_no_rules_match() {
        let (_dir, app, _db) = mock_app_with_db().await;
        let state = app.state::<crate::AppState>();
        // No rules in DB → no match regardless of snapshot.
        let result = dry_run_rules(state, dry_run_snapshot(Some("~/code/cairn"), None, None))
            .await
            .unwrap();
        assert!(result.is_none());
    }

    #[tokio::test]
    async fn dry_run_returns_first_priority_match() {
        let (_dir, app, _db) = mock_app_with_db().await;
        let state = app.state::<crate::AppState>();
        // Two rules: cairn-folder (priority 10) and any-folder (priority 20).
        let mut r1 = rule_input(None, "Cairn dev");
        r1.priority = 10;
        r1.body = dry_run_rule_body("ide.folder", "contains", "cairn", "cairn");
        let _ = save_rule(state.clone(), r1).await.unwrap();
        let mut r2 = rule_input(None, "Any folder fallback");
        r2.priority = 20;
        r2.body = dry_run_rule_body("ide.folder", "contains", "code", "misc");
        let _ = save_rule(state.clone(), r2).await.unwrap();

        let m = dry_run_rules(state, dry_run_snapshot(Some("~/code/cairn"), None, None))
            .await
            .unwrap()
            .expect("a rule should match");
        // Priority 10 wins over priority 20 even though both rules' bodies
        // contain "cairn"/"code" patterns the snapshot satisfies.
        assert_eq!(m.rule_name, "Cairn dev");
        assert_eq!(m.project.as_deref(), Some("cairn"));
    }

    #[tokio::test]
    async fn dry_run_matches_git_branch_condition() {
        let (_dir, app, _db) = mock_app_with_db().await;
        let state = app.state::<crate::AppState>();
        let mut r = rule_input(None, "Feature branch work");
        r.body = dry_run_rule_body("git.branch", "starts-with", "feat/", "cairn");
        let _ = save_rule(state.clone(), r).await.unwrap();

        let m = dry_run_rules(state, dry_run_snapshot(None, Some("feat/rules-ui"), None))
            .await
            .unwrap()
            .expect("branch starting with feat/ should match");
        assert_eq!(m.rule_name, "Feature branch work");
    }

    #[tokio::test]
    async fn dry_run_priority_decides_when_both_rules_match() {
        // Stricter variant of the earlier priority test: BOTH rules
        // explicitly match the snapshot (same signal, same value), so
        // the only thing left to decide the outcome is `priority` —
        // not "rule 1 happened to match first." This pins the
        // priority-asc semantics the live engine guarantees.
        let (_dir, app, _db) = mock_app_with_db().await;
        let state = app.state::<crate::AppState>();
        let mut high = rule_input(None, "High priority");
        high.priority = 5;
        high.body = dry_run_rule_body("ide.folder", "contains", "cairn", "alpha");
        let _ = save_rule(state.clone(), high).await.unwrap();
        let mut low = rule_input(None, "Low priority");
        low.priority = 20;
        low.body = dry_run_rule_body("ide.folder", "contains", "cairn", "beta");
        let _ = save_rule(state.clone(), low).await.unwrap();

        let m = dry_run_rules(state, dry_run_snapshot(Some("~/code/cairn"), None, None))
            .await
            .unwrap()
            .expect("both match; lower-priority value wins");
        assert_eq!(m.rule_name, "High priority");
        assert_eq!(m.project.as_deref(), Some("alpha"));
    }

    #[tokio::test]
    async fn dry_run_skips_disabled_rules() {
        let (_dir, app, _db) = mock_app_with_db().await;
        let state = app.state::<crate::AppState>();
        let mut r = rule_input(None, "Cairn dev");
        r.enabled = false;
        r.body = dry_run_rule_body("ide.folder", "contains", "cairn", "cairn");
        let _ = save_rule(state.clone(), r).await.unwrap();

        let result = dry_run_rules(state, dry_run_snapshot(Some("~/code/cairn"), None, None))
            .await
            .unwrap();
        // A disabled rule must not contribute a match — same contract
        // as the live engine path.
        assert!(result.is_none());
    }

    #[tokio::test]
    async fn dry_run_rejects_overlong_field() {
        let (_dir, app, _db) = mock_app_with_db().await;
        let state = app.state::<crate::AppState>();
        // 2 KB+1 chars: just over the bench input cap. Real user
        // inputs are bounded by the frontend `maxLength`; this is
        // the backend gate against a forged invocation.
        let too_long = "a".repeat(MAX_DRY_RUN_FIELD_LEN + 1);
        let err = dry_run_rules(state, dry_run_snapshot(Some(&too_long), None, None))
            .await
            .unwrap_err();
        assert!(
            err.contains("ideFolder"),
            "error should name the offending field, got: {err}"
        );
    }

    #[tokio::test]
    async fn dry_run_accepts_field_at_the_max_boundary() {
        let (_dir, app, _db) = mock_app_with_db().await;
        let state = app.state::<crate::AppState>();
        // Exactly at the cap — must not trigger the validation error.
        let at_limit = "x".repeat(MAX_DRY_RUN_FIELD_LEN);
        let ok = dry_run_rules(state, dry_run_snapshot(Some(&at_limit), None, None)).await;
        assert!(ok.is_ok(), "boundary value should pass validation: {ok:?}");
    }

    #[tokio::test]
    async fn dry_run_recovers_from_poisoned_rules_cache() {
        // The IPC's RwLock recovery branch only fires when another
        // thread has panicked while holding the write lock. Force
        // that condition deterministically: spawn a thread, take
        // the write lock, panic. The thread's join handle returns
        // Err and the lock is now poisoned. dry_run_rules must still
        // answer correctly (with whatever was in the cache before
        // the panic).
        let (_dir, app, _db) = mock_app_with_db().await;
        let state = app.state::<crate::AppState>();
        let mut r = rule_input(None, "Cairn dev");
        r.body = dry_run_rule_body("ide.folder", "contains", "cairn", "cairn");
        let _ = save_rule(state.clone(), r).await.unwrap();

        let cache = state.rules_cache.clone();
        let handle = std::thread::spawn(move || {
            let _g = cache.write().unwrap();
            panic!("intentional poison for test");
        });
        let _ = handle.join();
        assert!(
            state.rules_cache.read().is_err(),
            "lock must be poisoned for this test to be meaningful",
        );

        let m = dry_run_rules(state, dry_run_snapshot(Some("~/code/cairn"), None, None))
            .await
            .unwrap()
            .expect("rule should match even after lock poison");
        assert_eq!(m.rule_name, "Cairn dev");
    }

    #[tokio::test]
    async fn active_calendar_event_from_active_event_preserves_fields() {
        // Construct the conversion through `From` so the field-by-field
        // shape stays pinned. The IPC handler wraps `ActiveEvent`s the
        // same way.
        let active = ActiveEvent {
            source_id: "src-1".into(),
            source_label: "Work".into(),
            event: crate::signals::calendar::parser::ParsedEvent {
                uid: "u@x".into(),
                summary: "Stand-up".into(),
                start: Utc::now(),
                end: Utc::now() + Duration::minutes(30),
                all_day: false,
                attendees: vec!["a@x".into()],
            },
        };
        let wire: ActiveCalendarEvent = active.clone().into();
        assert_eq!(wire.source_id, active.source_id);
        assert_eq!(wire.source_label, active.source_label);
        assert_eq!(wire.uid, active.event.uid);
        assert_eq!(wire.summary, active.event.summary);
        assert_eq!(wire.all_day, active.event.all_day);
        assert_eq!(wire.attendees, active.event.attendees);
    }
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

/// Next `limit` calendar events strictly after now, across every
/// enabled source, sorted by start time (#20). The Today view's
/// "Up next" list consumes this. `limit` is clamped to 1..=10 to keep
/// the response bounded even if a misbehaving caller asks for more.
#[tauri::command]
pub async fn upcoming_calendar_events(
    state: State<'_, AppState>,
    limit: Option<usize>,
) -> Result<Vec<ActiveCalendarEvent>, String> {
    let n = limit.unwrap_or(3).clamp(1, 10);
    let events = state.calendar.upcoming_events_at(Utc::now(), n).await;
    Ok(events.into_iter().map(Into::into).collect())
}

#[tauri::command]
pub async fn calendar_sync_status(state: State<'_, AppState>) -> Result<Vec<SyncStatus>, String> {
    Ok(state.calendar.sync_status().await)
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SnoozeRuleInput {
    pub rule_id: String,
    /// Snooze duration in seconds. Validated to be `>= 1` and
    /// `<= 7 days` so a malformed payload can't silence rules
    /// effectively forever.
    pub duration_seconds: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SnoozeAllInput {
    pub duration_seconds: i64,
}

/// Per-rule snooze. The matcher will skip this rule until the
/// duration elapses (or `unsnooze_all` is called). Re-snoozing the
/// same rule with a longer duration extends; a shorter duration
/// is ignored (later wins).
#[tauri::command]
pub async fn snooze_rule(state: State<'_, AppState>, input: SnoozeRuleInput) -> Result<(), String> {
    let dur = validate_snooze_duration(input.duration_seconds)?;
    let mut guard = state.snoozer.lock().unwrap_or_else(|p| {
        // Recover from poisoning by taking the inner — the IPC
        // writer's job is to update state, not propagate the
        // panic of a previous critical section.
        log::warn!("snoozer lock was poisoned, recovering");
        p.into_inner()
    });
    guard.snooze_rule(&input.rule_id, dur, Utc::now());
    Ok(())
}

/// Global "snooze everything" — silences every rule for the
/// duration. Same later-wins semantics as `snooze_rule`.
#[tauri::command]
pub async fn snooze_all(state: State<'_, AppState>, input: SnoozeAllInput) -> Result<(), String> {
    let dur = validate_snooze_duration(input.duration_seconds)?;
    let mut guard = state.snoozer.lock().unwrap_or_else(|p| {
        // Recover from poisoning by taking the inner — the IPC
        // writer's job is to update state, not propagate the
        // panic of a previous critical section.
        log::warn!("snoozer lock was poisoned, recovering");
        p.into_inner()
    });
    guard.snooze_all(dur, Utc::now());
    Ok(())
}

/// Clear every snooze. Used by the "un-snooze everything"
/// affordance in Settings.
#[tauri::command]
pub async fn unsnooze_all(state: State<'_, AppState>) -> Result<(), String> {
    let mut guard = state.snoozer.lock().unwrap_or_else(|p| {
        // Recover from poisoning by taking the inner — the IPC
        // writer's job is to update state, not propagate the
        // panic of a previous critical section.
        log::warn!("snoozer lock was poisoned, recovering");
        p.into_inner()
    });
    guard.unsnooze_all();
    Ok(())
}

/// Snapshot the un-expired snooze map. The Rules view uses this
/// to render "snoozed until …" badges on rule rows.
#[tauri::command]
pub async fn list_snoozes(
    state: State<'_, AppState>,
) -> Result<crate::rules::SnoozeSnapshot, String> {
    let guard = state.snoozer.lock().unwrap_or_else(|p| {
        log::warn!("snoozer lock was poisoned, recovering");
        p.into_inner()
    });
    Ok(guard.snapshot(Utc::now()))
}

fn validate_snooze_duration(seconds: i64) -> Result<chrono::Duration, String> {
    // The lower bound is `1` (not the spec floor of 300s = 5 min)
    // so tests and programmatic clients can use short windows; the
    // production UI defaults to 5 min via the frontend constant
    // `DEFAULT_SNOOZE_SECONDS`. The upper bound is an arbitrary
    // hardening cap to reject obviously-malformed payloads — the
    // real lifetime guarantee is "snoozes don't persist across app
    // launches" (the Snoozer state is in-memory only).
    const MAX_SNOOZE_SECS: i64 = 7 * 24 * 3600;
    if seconds < 1 {
        return Err("duration_seconds must be >= 1".into());
    }
    if seconds > MAX_SNOOZE_SECS {
        return Err(format!(
            "duration_seconds must be <= {MAX_SNOOZE_SECS} (7 days)"
        ));
    }
    Ok(chrono::Duration::seconds(seconds))
}

#[tauri::command]
pub async fn current_snapshot(
    state: State<'_, AppState>,
) -> Result<crate::rules::SignalSnapshot, String> {
    // Prefer the stream's live cache (O(1), matches what the rules
    // engine just evaluated and is already exclusion-filtered). On
    // cold start — before the driver has published its first
    // snapshot — fall back to a synchronous `snapshot::build` which
    // also applies exclusions internally so a popover opened in
    // the first ~1.5s never sees an excluded app's title.
    if let Some(snap) = state.stream.current() {
        Ok(snap)
    } else {
        Ok(crate::signals::snapshot::build(&state.calendar, &state.exclusions, Utc::now()).await)
    }
}

/// Settings → Integrations card status. Returns the watcher's
/// discovery roots (tilde-form for display) and the current count of
/// `.git/HEAD` files the watcher is subscribed to. The snapshot is
/// captured at boot — see `AppState::git_watcher_status` for the
/// rationale. The watcher itself doesn't mutate roots after launch
/// today (M1), so the field is plain data rather than locked behind
/// an interior mutability primitive.
#[tauri::command]
pub fn get_git_watcher_status(state: State<'_, AppState>) -> Result<GitWatcherStatus, String> {
    Ok(state
        .git_watcher_status
        .lock()
        .map_err(|_| "git watcher status lock poisoned".to_string())?
        .clone())
}

/// Read the user's configured git discovery roots (issue #7). Returns
/// the persisted tilde-form roots, or the built-in defaults (in
/// tilde-form) when the user hasn't configured any — so the editor
/// always shows what the watcher is actually using.
#[tauri::command]
pub async fn get_git_discovery_roots(state: State<'_, AppState>) -> Result<Vec<String>, String> {
    let configured = load_discovery_roots(&state.db.pool).await;
    if configured.is_empty() {
        Ok(crate::signals::git_watcher::display_roots(
            &crate::signals::git_watcher::default_discovery_roots(),
        ))
    } else {
        Ok(configured)
    }
}

/// Persist a new set of git discovery roots and re-arm the watcher
/// over them (issue #7). Blank entries are dropped and duplicates
/// collapsed (order preserved). An empty list clears the override, so
/// the watcher falls back to the built-in defaults. The live watcher
/// task is aborted and respawned against the freshly-discovered repos,
/// and the cached status is rewritten so Settings → Integrations
/// reflects the new roots immediately. Returns the updated status.
///
/// Caveat: the snapshot stream's repo-path list (used by
/// `derive_ide_folder`'s longest-prefix fallback) is fixed at boot, so
/// IDE-folder→repo resolution for *newly added* roots only takes full
/// effect after the next launch. Branch detection for the new repos
/// works immediately via the respawned watcher.
#[tauri::command]
pub async fn set_git_discovery_roots(
    state: State<'_, AppState>,
    roots: Vec<String>,
) -> Result<GitWatcherStatus, String> {
    // Serialize the whole discover → respawn → persist sequence so two
    // overlapping calls can't interleave and leak an un-abortable
    // watcher (same pattern as rules_mutator / exclusions_mutator).
    let _guard = state.git_roots_mutator.lock().await;

    let cleaned = normalize_roots(&roots);
    validate_roots(&cleaned)?;

    let expanded = if cleaned.is_empty() {
        crate::signals::git_watcher::default_discovery_roots()
    } else {
        crate::signals::git_watcher::expand_roots(&cleaned)
    };
    // Discovery is a synchronous recursive filesystem walk — run it on
    // the blocking pool so a deep/slow root can't stall the async
    // runtime worker (and with it, unrelated IPC).
    let walk_roots = expanded.clone();
    let repos = tauri::async_runtime::spawn_blocking(move || {
        crate::signals::git_watcher::discover_repos(&walk_roots)
    })
    .await
    .map_err(|e| format!("discovery task failed: {e}"))?;
    let status = crate::signals::git_watcher::build_status(&expanded, &repos);

    // Abort the running watcher and respawn over the new repo set.
    {
        let mut handle_guard = state
            .git_watcher_handle
            .lock()
            .map_err(|_| "git watcher handle lock poisoned".to_string())?;
        if let Some(handle) = handle_guard.take() {
            handle.abort();
        }
        let handle =
            crate::signals::git_watcher::spawn_watcher_task(state.stream.event_sender(), repos);
        *handle_guard = Some(handle);
    }
    *state
        .git_watcher_status
        .lock()
        .map_err(|_| "git watcher status lock poisoned".to_string())? = status.clone();

    // Persist LAST: the live session is already re-armed, so a DB write
    // failure leaves the running watcher correct (it reverts to the old
    // roots only on the next launch) rather than the DB getting ahead of
    // the live state.
    persist_discovery_roots(&state.db.pool, &cleaned).await?;

    Ok(status)
}

/// Maximum number of discovery roots a user may configure — a guard
/// against a pathological config (or crafted import) that would make
/// the watcher register an unbounded number of OS subscriptions.
pub(crate) const MAX_DISCOVERY_ROOTS: usize = 64;

/// Reject pathological roots before they reach the filesystem walk:
/// too many entries, or a root that expands to the filesystem root or
/// the bare home directory (either would walk a huge slice of the disk
/// to `MAX_DISCOVERY_DEPTH` and register a flood of watches).
pub(crate) fn validate_roots(cleaned: &[String]) -> Result<(), String> {
    if cleaned.len() > MAX_DISCOVERY_ROOTS {
        return Err(format!(
            "Too many discovery roots ({}); the maximum is {MAX_DISCOVERY_ROOTS}.",
            cleaned.len()
        ));
    }
    let home = dirs::home_dir();
    for raw in cleaned {
        let expanded = crate::signals::git_watcher::expand_root(raw);
        if expanded.parent().is_none() {
            return Err(format!(
                "\u{201c}{raw}\u{201d} resolves to the filesystem root \u{2014} pick a project folder instead."
            ));
        }
        if let Some(home) = home.as_deref() {
            if expanded == home {
                return Err(format!(
                    "\u{201c}{raw}\u{201d} is your entire home folder \u{2014} pick a project subfolder instead."
                ));
            }
        }
    }
    Ok(())
}

/// Trim, drop blanks, and de-duplicate user-entered roots, preserving
/// first-seen order. Pure helper so the cleanup is unit-testable
/// independent of the DB.
pub(crate) fn normalize_roots(roots: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for raw in roots {
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            continue;
        }
        let owned = trimmed.to_string();
        if !out.contains(&owned) {
            out.push(owned);
        }
    }
    out
}

/// Read the persisted discovery-roots JSON from `app_state`. Returns
/// an empty vec when unset or unparseable (the caller treats empty as
/// "use defaults").
pub(crate) async fn load_discovery_roots(pool: &sqlx::SqlitePool) -> Vec<String> {
    let raw: Option<String> =
        sqlx::query_scalar("SELECT git_discovery_roots FROM app_state WHERE singleton = 1")
            .fetch_optional(pool)
            .await
            .ok()
            .flatten();
    match raw {
        None => Vec::new(),
        Some(s) => match serde_json::from_str::<Vec<String>>(&s) {
            Ok(roots) => roots,
            Err(e) => {
                // Corrupt / hand-edited value: degrade to defaults but
                // make the corruption diagnosable rather than silent.
                log::warn!("git_watcher: ignoring unparseable git_discovery_roots ({e})");
                Vec::new()
            }
        },
    }
}

/// Write the discovery-roots override to `app_state` as a JSON array.
/// An empty slice persists `[]`, which `load_discovery_roots` reads
/// back as "no override" → defaults.
pub(crate) async fn persist_discovery_roots(
    pool: &sqlx::SqlitePool,
    roots: &[String],
) -> Result<(), String> {
    let json = serde_json::to_string(roots).map_err(err)?;
    sqlx::query("UPDATE app_state SET git_discovery_roots = ?1 WHERE singleton = 1")
        .bind(json)
        .execute(pool)
        .await
        .map_err(err)?;
    Ok(())
}

/// Settings → Integrations card status for the browser extension.
/// Today this returns `{connected: false, lastSeen: null}` because the
/// browser collector lands in M7 — see `signals::browser_extension`.
/// The frontend renders whatever this IPC returns; once M7 wires the
/// extension's heartbeat into `BrowserExtensionState::record_heartbeat`,
/// the same IPC starts returning live values without any UI changes.
#[tauri::command]
pub fn browser_extension_status(
    state: State<'_, AppState>,
) -> Result<BrowserExtensionStatus, String> {
    Ok(state.browser_extension.snapshot(Utc::now()))
}

/// Start the debug "Capture raw signals" mode (see `docs/PRIVACY.md`
/// §"Debug Capture raw signals"). Returns the absolute path of the
/// `debug-signals.ndjson` file that the writer task appends to. The
/// writer subscribes to the same `SnapshotStream` the matcher
/// consumes, so the on-disk log faithfully reflects every snapshot
/// the rules engine sees.
///
/// The toggle is never persisted: a fresh launch always starts off,
/// and `signals::capture::cleanup_stale` removes a leftover file
/// before this command can be called again.
#[tauri::command]
pub async fn start_signal_capture(state: State<'_, AppState>) -> Result<String, String> {
    let rx = state.stream.subscribe();
    state.capture.start_with_receiver(&state.data_dir, rx).await
}

/// Stop the debug capture writer. Flushes the file, closes the
/// handle, and **deletes** the ndjson file — the file is the
/// capture, so leaving it on disk would defeat the contract that
/// capture-off ⇒ no debug data on disk.
#[tauri::command]
pub async fn stop_signal_capture(state: State<'_, AppState>) -> Result<(), String> {
    state.capture.stop().await
}

/// Footer-banner status. Returns `{active: false, path: null,
/// bytes_written: 0}` whenever capture is off so the UI can render
/// the banner unconditionally from this one source.
#[tauri::command]
pub async fn signal_capture_status(
    state: State<'_, AppState>,
) -> Result<crate::signals::capture::CaptureStatus, String> {
    Ok(state.capture.status().await)
}

// ----------------------------------------------------------------------
// First-run onboarding (issue #31).
//
// The `app_state` table is a single-row marker: `completed_at IS NULL`
// means the popover must mount the onboarding overlay instead of the
// main view. The flow is also re-runnable from Settings — that maps to
// `reset_onboarding`, which nulls the column and lets the next render
// re-mount the overlay.
// ----------------------------------------------------------------------

/// Snapshot of the single-row `app_state` marker. The frontend mirrors
/// this via `useOnboarding` and renders the onboarding overlay when
/// `completed_at` is `None`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OnboardingState {
    /// RFC 3339 timestamp at which the user completed (or skipped) the
    /// flow. `None` ⇒ first-run / re-run-requested ⇒ show onboarding.
    pub completed_at: Option<String>,
}

async fn read_onboarding_state(state: &State<'_, AppState>) -> Result<OnboardingState, String> {
    let row = sqlx::query("SELECT completed_at FROM app_state WHERE singleton = 1")
        .fetch_optional(&state.db.pool)
        .await
        .map_err(err)?;
    let completed_at = row.and_then(|r| r.get::<Option<String>, _>("completed_at"));
    Ok(OnboardingState { completed_at })
}

/// Read the onboarding marker. Returns `{completedAt: null}` on a
/// fresh DB (the migration seeded the row but with a NULL column).
#[tauri::command]
pub async fn get_onboarding_state(state: State<'_, AppState>) -> Result<OnboardingState, String> {
    read_onboarding_state(&state).await
}

/// Mark onboarding as complete — sets `completed_at` to the current
/// UTC instant. Idempotent: completing twice in a row leaves the first
/// timestamp in place so we don't churn `updated_at`-style audit data.
#[tauri::command]
pub async fn complete_onboarding(state: State<'_, AppState>) -> Result<OnboardingState, String> {
    let now = Utc::now().to_rfc3339();
    sqlx::query(
        "UPDATE app_state SET completed_at = COALESCE(completed_at, ?1) WHERE singleton = 1",
    )
    .bind(&now)
    .execute(&state.db.pool)
    .await
    .map_err(err)?;
    read_onboarding_state(&state).await
}

/// Re-arm the onboarding flow. Called from Settings → "Run onboarding
/// again". Nulls `completed_at` so the next render of the popover
/// mounts the overlay again.
#[tauri::command]
pub async fn reset_onboarding(state: State<'_, AppState>) -> Result<OnboardingState, String> {
    sqlx::query("UPDATE app_state SET completed_at = NULL WHERE singleton = 1")
        .execute(&state.db.pool)
        .await
        .map_err(err)?;
    read_onboarding_state(&state).await
}

#[cfg(test)]
#[cfg(not(target_os = "windows"))]
mod onboarding_tests {
    use super::*;
    use crate::test_support::mock_app_with_db;
    use tauri::Manager;

    #[tokio::test]
    async fn fresh_db_reports_onboarding_incomplete() {
        let (_dir, app, _db) = mock_app_with_db().await;
        let state = app.state::<crate::AppState>();
        let s = get_onboarding_state(state).await.unwrap();
        assert!(
            s.completed_at.is_none(),
            "fresh db should mark onboarding as incomplete"
        );
    }

    #[tokio::test]
    async fn complete_onboarding_records_timestamp() {
        let (_dir, app, _db) = mock_app_with_db().await;
        let state = app.state::<crate::AppState>();
        let after = complete_onboarding(state.clone()).await.unwrap();
        let ts = after.completed_at.expect("timestamp set after completion");
        assert!(parse_ts(&ts).is_ok(), "completed_at must be RFC 3339");
        let echoed = get_onboarding_state(state).await.unwrap();
        assert_eq!(
            echoed.completed_at.as_deref(),
            Some(ts.as_str()),
            "get must read what complete wrote"
        );
    }

    #[tokio::test]
    async fn complete_onboarding_is_idempotent() {
        let (_dir, app, _db) = mock_app_with_db().await;
        let state = app.state::<crate::AppState>();
        let first = complete_onboarding(state.clone()).await.unwrap();
        // A second call must not overwrite the original timestamp —
        // the UI may double-fire the completion event on fast taps,
        // and re-stamping would drift the "first completed" audit.
        let second = complete_onboarding(state.clone()).await.unwrap();
        assert_eq!(first.completed_at, second.completed_at);
    }

    #[tokio::test]
    async fn reset_onboarding_clears_completion() {
        let (_dir, app, _db) = mock_app_with_db().await;
        let state = app.state::<crate::AppState>();
        complete_onboarding(state.clone()).await.unwrap();
        let reset = reset_onboarding(state.clone()).await.unwrap();
        assert!(reset.completed_at.is_none());
        let echoed = get_onboarding_state(state).await.unwrap();
        assert!(echoed.completed_at.is_none());
    }

    #[tokio::test]
    async fn singleton_invariant_holds_across_resets() {
        // The schema constrains the table to exactly one row via the
        // CHECK on the constant PK. A complete → reset → complete
        // cycle must still see exactly one row at the end.
        let (_dir, app, _db) = mock_app_with_db().await;
        let state = app.state::<crate::AppState>();
        complete_onboarding(state.clone()).await.unwrap();
        reset_onboarding(state.clone()).await.unwrap();
        complete_onboarding(state.clone()).await.unwrap();
        let count: i64 = sqlx::query("SELECT COUNT(*) AS n FROM app_state")
            .fetch_one(&state.db.pool)
            .await
            .unwrap()
            .get("n");
        assert_eq!(count, 1, "app_state must remain a single-row table");
    }
}
