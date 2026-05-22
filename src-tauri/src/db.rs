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
        ("acme",  "acme-web",      Some("ACME Co."),    "#81b29a"),
        ("cairn", "Cairn",         Some("Open source"), "#f2cc8f"),
        ("site",  "Personal site", None,                "#e07a5f"),
        ("ops",   "Operations",    Some("Internal"),    "#9a9bb0"),
        ("mtg",   "Meetings",      None,                "#c8b8e0"),
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
