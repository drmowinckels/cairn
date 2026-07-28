//! Pro invoice issuer details (#1): the sender's own business identity —
//! name, address, contact, tax id — printed as the "From" block on generated
//! invoices. A single row (one business per install), plugin-owned. Every
//! field is optional free text; an all-empty profile renders no block.

use serde::{Deserialize, Serialize};
use sqlx::{Row, SqlitePool};

use super::err;

/// The issuer's business details, shown as the invoice "From" block.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BusinessDetails {
    pub name: String,
    pub address: String,
    pub email: String,
    pub tax_id: String,
}

impl BusinessDetails {
    /// True when nothing is filled in — the invoice then omits the block.
    pub fn is_empty(&self) -> bool {
        self.name.is_empty()
            && self.address.is_empty()
            && self.email.is_empty()
            && self.tax_id.is_empty()
    }

    fn trimmed(&self) -> BusinessDetails {
        BusinessDetails {
            name: self.name.trim().to_string(),
            address: self.address.trim().to_string(),
            email: self.email.trim().to_string(),
            tax_id: self.tax_id.trim().to_string(),
        }
    }
}

/// Read the stored business details, or an empty profile when none are set.
pub async fn get_business(pool: &SqlitePool) -> Result<BusinessDetails, String> {
    let row = sqlx::query(
        "SELECT name, address, email, tax_id FROM billing_business WHERE singleton = 1",
    )
    .fetch_optional(pool)
    .await
    .map_err(err)?;
    Ok(match row {
        Some(r) => BusinessDetails {
            name: r.get("name"),
            address: r.get("address"),
            email: r.get("email"),
            tax_id: r.get("tax_id"),
        },
        None => BusinessDetails::default(),
    })
}

/// Upsert the single business-details row, trimming each field. Returns the
/// stored (trimmed) details.
pub async fn set_business(
    pool: &SqlitePool,
    details: &BusinessDetails,
) -> Result<BusinessDetails, String> {
    let d = details.trimmed();
    sqlx::query(
        "INSERT INTO billing_business (singleton, name, address, email, tax_id, updated_at) \
         VALUES (1, ?1, ?2, ?3, ?4, datetime('now')) \
         ON CONFLICT (singleton) DO UPDATE SET \
           name = ?1, address = ?2, email = ?3, tax_id = ?4, updated_at = datetime('now')",
    )
    .bind(&d.name)
    .bind(&d.address)
    .bind(&d.email)
    .bind(&d.tax_id)
    .execute(pool)
    .await
    .map_err(err)?;
    Ok(d)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::test_db;

    #[tokio::test]
    async fn defaults_empty_then_round_trips_and_upserts() {
        let (_dir, db) = test_db().await;

        // Nothing stored yet → an empty profile that omits the block.
        let empty = get_business(&db.pool).await.unwrap();
        assert!(empty.is_empty());

        // Set trims each field and reports the stored form.
        let saved = set_business(
            &db.pool,
            &BusinessDetails {
                name: "  Acme Consulting AS  ".into(),
                address: "123 Main St\nOslo, Norway".into(),
                email: "hi@acme.no".into(),
                tax_id: "NO 123 456 789".into(),
            },
        )
        .await
        .unwrap();
        assert_eq!(saved.name, "Acme Consulting AS");
        assert!(!saved.is_empty());
        assert_eq!(get_business(&db.pool).await.unwrap(), saved);

        // A second set overwrites the single row (not a second insert).
        set_business(
            &db.pool,
            &BusinessDetails {
                name: "New Co".into(),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let got = get_business(&db.pool).await.unwrap();
        assert_eq!(got.name, "New Co");
        assert_eq!(got.email, ""); // cleared by the overwrite
    }
}
