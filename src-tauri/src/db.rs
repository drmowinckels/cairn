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

async fn seed_if_empty(pool: &SqlitePool) -> anyhow::Result<()> {
    let count: i64 = sqlx::query("SELECT COUNT(*) AS n FROM projects")
        .fetch_one(pool)
        .await?
        .get("n");
    if count > 0 {
        return Ok(());
    }

    let now = Utc::now().to_rfc3339();
    let seeds = [
        ("acme", "acme-web", Some("ACME Co."), "#81b29a"),
        ("cairn", "Cairn", Some("Open source"), "#f2cc8f"),
        ("site", "Personal site", None, "#e07a5f"),
        ("ops", "Operations", Some("Internal"), "#9a9bb0"),
        ("mtg", "Meetings", None, "#c8b8e0"),
    ];

    let mut tx = pool.begin().await?;
    for (id, name, client, color) in seeds {
        sqlx::query(
            r#"
            INSERT INTO projects (id, name, client, color, archived, created_at, updated_at)
            VALUES (?1, ?2, ?3, ?4, 0, ?5, ?5)
            "#,
        )
        .bind(id)
        .bind(name)
        .bind(client)
        .bind(color)
        .bind(&now)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;
    log::info!("db: seeded {} default projects", seeds.len());
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
    async fn schema_includes_entries_tags_rules_exclusions() {
        let (_dir, db) = test_db().await;
        for table in ["entries", "tags", "entry_tags", "rules", "exclusions"] {
            let row = sqlx::query("SELECT name FROM sqlite_master WHERE type='table' AND name=?1")
                .bind(table)
                .fetch_optional(&db.pool)
                .await
                .unwrap();
            assert!(row.is_some(), "migrations must create table `{table}`");
        }
    }
}
