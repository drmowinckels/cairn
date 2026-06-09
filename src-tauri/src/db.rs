use std::path::Path;

use chrono::Utc;
use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use sqlx::{Row, SqlitePool};

#[derive(Clone)]
pub struct Db {
    pub pool: SqlitePool,
}

impl Db {
    pub async fn open(path: &Path) -> anyhow::Result<Self> {
        let opts = SqliteConnectOptions::new()
            .filename(path)
            .create_if_missing(true)
            .foreign_keys(true);

        let pool = SqlitePoolOptions::new()
            .max_connections(4)
            .connect_with(opts)
            .await?;

        sqlx::migrate!("./migrations").run(&pool).await?;
        seed_if_empty(&pool).await?;

        Ok(Db { pool })
    }
}

pub(crate) async fn seed_if_empty(pool: &SqlitePool) -> anyhow::Result<()> {
    let count: i64 = sqlx::query("SELECT COUNT(*) AS n FROM projects")
        .fetch_one(pool)
        .await?
        .get("n");
    if count > 0 {
        return Ok(());
    }

    let now = Utc::now().to_rfc3339();
    let client_seeds = [
        ("client-acme", "ACME Co."),
        ("client-internal", "Internal"),
        ("client-os", "Open source"),
    ];
    let project_seeds: [(&str, &str, Option<&str>, &str); 5] = [
        ("acme", "acme-web", Some("client-acme"), "#81b29a"),
        ("cairn", "Cairn", Some("client-os"), "#f2cc8f"),
        ("site", "Personal site", None, "#e07a5f"),
        ("ops", "Operations", Some("client-internal"), "#9a9bb0"),
        ("mtg", "Meetings", None, "#c8b8e0"),
    ];

    let mut tx = pool.begin().await?;
    for (id, name) in client_seeds {
        sqlx::query(
            r#"
            INSERT INTO clients (id, name, archived, created_at, updated_at)
            VALUES (?1, ?2, 0, ?3, ?3)
            "#,
        )
        .bind(id)
        .bind(name)
        .bind(&now)
        .execute(&mut *tx)
        .await?;
    }
    for (id, name, client_id, color) in project_seeds {
        sqlx::query(
            r#"
            INSERT INTO projects (id, name, client_id, color, archived, created_at, updated_at)
            VALUES (?1, ?2, ?3, ?4, 0, ?5, ?5)
            "#,
        )
        .bind(id)
        .bind(name)
        .bind(client_id)
        .bind(color)
        .bind(&now)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;
    log::info!(
        "db: seeded {} default clients and {} default projects",
        client_seeds.len(),
        project_seeds.len()
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::test_db;

    #[tokio::test]
    async fn open_runs_migrations_and_seeds_default_projects() {
        let (_dir, db) = test_db().await;
        let count: i64 = sqlx::query("SELECT COUNT(*) AS n FROM projects")
            .fetch_one(&db.pool)
            .await
            .unwrap()
            .get("n");
        assert!(count > 0, "default seed should insert projects");
    }

    #[tokio::test]
    async fn migration_0012_preserves_entry_task_links() {
        use sqlx::sqlite::SqliteConnectOptions;
        use sqlx::SqlitePool;

        let dir = crate::test_support::temp_dir();
        let path = dir.path().join("m.sqlite");
        // Foreign keys ON, exactly as production opens the pool — this is what
        // makes `DROP TABLE tasks` cascade into `entries.task_id`.
        let opts = SqliteConnectOptions::new()
            .filename(&path)
            .create_if_missing(true)
            .foreign_keys(true);
        let pool = SqlitePool::connect_with(opts).await.unwrap();

        // The pre-0012 shape: a local task an entry is attributed to, with the
        // same ON DELETE actions production declares.
        for ddl in [
            "CREATE TABLE projects (id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL)",
            "CREATE TABLE tasks (id TEXT PRIMARY KEY NOT NULL, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, name TEXT NOT NULL, archived INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(project_id, name))",
            "CREATE TABLE entries (id TEXT PRIMARY KEY NOT NULL, task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL)",
            "INSERT INTO projects VALUES ('p', 'P')",
            "INSERT INTO tasks (id, project_id, name, created_at, updated_at) VALUES ('t', 'p', 'Task', 'x', 'x')",
            "INSERT INTO entries VALUES ('e', 't')",
        ] {
            sqlx::query(ddl).execute(&pool).await.unwrap();
        }

        // Apply exactly the migration that ships.
        let migration = include_str!("../migrations/0012_remote_tasks.sql");
        sqlx::raw_sql(migration).execute(&pool).await.unwrap();

        let task_id: Option<String> = sqlx::query("SELECT task_id FROM entries WHERE id = 'e'")
            .fetch_one(&pool)
            .await
            .unwrap()
            .get("task_id");
        assert_eq!(
            task_id.as_deref(),
            Some("t"),
            "0012 must preserve the entry→task link across the table rebuild"
        );

        // The rebuilt table has the remote columns and a nullable project_id.
        sqlx::query("INSERT INTO tasks (id, project_id, name, connector_id, remote_id, archived, created_at, updated_at) VALUES ('r', NULL, 'Task', 'gh', '9', 0, 'x', 'x')")
            .execute(&pool)
            .await
            .expect("a remote task with a NULL project and a duplicate name must be accepted");
    }

    #[tokio::test]
    async fn open_seeds_default_clients() {
        let (_dir, db) = test_db().await;
        let count: i64 = sqlx::query("SELECT COUNT(*) AS n FROM clients")
            .fetch_one(&db.pool)
            .await
            .unwrap()
            .get("n");
        assert!(count > 0, "default seed should insert clients");
    }

    #[tokio::test]
    async fn reopening_existing_db_does_not_reseed() {
        let dir = crate::test_support::temp_dir();
        let path = dir.path().join("cairn.sqlite");
        {
            let db = Db::open(&path).await.unwrap();
            let count: i64 = sqlx::query("SELECT COUNT(*) AS n FROM projects")
                .fetch_one(&db.pool)
                .await
                .unwrap()
                .get("n");
            assert!(count > 0);
        }
        // Reopen — seed must be skipped (idempotent).
        let db2 = Db::open(&path).await.unwrap();
        let count2: i64 = sqlx::query("SELECT COUNT(*) AS n FROM projects")
            .fetch_one(&db2.pool)
            .await
            .unwrap()
            .get("n");
        assert_eq!(count2, 5, "five seeded projects, no re-seed");
    }

    #[tokio::test]
    async fn schema_includes_all_tables() {
        let (_dir, db) = test_db().await;
        // After migration 0002 the legacy `tags` / `entry_tags` tables
        // are dropped in favor of a project-scoped tasks table — verify
        // the post-migration shape.
        for table in [
            "projects",
            "entries",
            "rules",
            "exclusions",
            "clients",
            "tasks",
            "calendar_sources",
            "app_state",
            "connector_cache",
            "connector_state",
        ] {
            let row = sqlx::query("SELECT name FROM sqlite_master WHERE type='table' AND name=?1")
                .bind(table)
                .fetch_optional(&db.pool)
                .await
                .unwrap();
            assert!(row.is_some(), "migrations must create table `{table}`");
        }
        for dropped in ["tags", "entry_tags"] {
            let row = sqlx::query("SELECT name FROM sqlite_master WHERE type='table' AND name=?1")
                .bind(dropped)
                .fetch_optional(&db.pool)
                .await
                .unwrap();
            assert!(
                row.is_none(),
                "migration 0002 must drop legacy `{dropped}` table"
            );
        }
    }
}
