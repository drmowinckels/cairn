//! Pro invoice issuer details (#1): the sender's own business identity —
//! name, address, contact, tax id — printed as the "From" block on generated
//! invoices. A single row (one business per install), plugin-owned. Every
//! field is optional free text; an all-empty profile renders no block.

use base64::Engine;
use serde::{Deserialize, Serialize};
use sqlx::{Row, SqlitePool};

use super::err;

/// Cap on the raw logo image so an embedded data URI can't bloat every
/// exported invoice (and the DB). Generous for a logo; a data URI is ~33%
/// larger once base64-encoded.
const MAX_LOGO_BYTES: usize = 512 * 1024;

/// The issuer's business details, shown as the invoice "From" block.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BusinessDetails {
    pub name: String,
    pub address: String,
    pub email: String,
    pub tax_id: String,
    /// A self-contained image data URI (`data:image/png;base64,…`) or empty.
    pub logo: String,
    /// The tax line's label ("VAT", "GST", "Sales Tax", …); empty renders as
    /// "Tax". A tax-line detail, not a "From" field — see `is_empty`.
    pub tax_label: String,
    /// The invoice look: "classic" (default / empty), "modern", or "minimal".
    /// Not a "From" field — excluded from `is_empty`.
    pub template: String,
    /// How the client pays (bank / IBAN / "how to pay me"); shown as its own
    /// "Payment" block. Not a "From" field — excluded from `is_empty`.
    pub payment_details: String,
}

impl BusinessDetails {
    /// True when the "From" block has nothing to show. Excludes `tax_label`,
    /// which only labels the tax line — a tax-label-only profile still omits
    /// the block.
    pub fn is_empty(&self) -> bool {
        self.name.is_empty()
            && self.address.is_empty()
            && self.email.is_empty()
            && self.tax_id.is_empty()
            && self.logo.is_empty()
    }

    fn trimmed(&self) -> BusinessDetails {
        BusinessDetails {
            name: self.name.trim().to_string(),
            address: self.address.trim().to_string(),
            email: self.email.trim().to_string(),
            tax_id: self.tax_id.trim().to_string(),
            // The logo is an opaque data URI — never trimmed or altered.
            logo: self.logo.clone(),
            tax_label: self.tax_label.trim().to_string(),
            template: self.template.trim().to_string(),
            payment_details: self.payment_details.trim().to_string(),
        }
    }
}

/// Reject an unknown template so only a preset the renderer actually supports
/// (or the empty default) can be stored. The allowlist is the renderer's own
/// table — one source of truth, so a name can't be accepted here that would
/// silently render as classic.
fn validate_template(template: &str) -> Result<(), String> {
    if super::invoice_html::known_template(template) {
        Ok(())
    } else {
        Err(format!("unknown invoice template: {template}"))
    }
}

/// Identify a supported raster image by its magic bytes, returning its MIME.
/// SVG is deliberately excluded — it can carry script and this feeds an
/// `<img>` `src` in the exported document.
fn sniff_image_mime(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(&[0x89, b'P', b'N', b'G']) {
        Some("image/png")
    } else if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        Some("image/jpeg")
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        Some("image/gif")
    } else if bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        Some("image/webp")
    } else {
        None
    }
}

/// Validate a stored logo value: empty, or a base64 image data URI whose MIME
/// is a supported raster format, whose payload is valid base64 within the size
/// cap, and whose decoded bytes really are that format (magic-byte check). This
/// guards the value before it is embedded into an invoice's `<img src>`.
fn validate_logo(logo: &str) -> Result<(), String> {
    if logo.is_empty() {
        return Ok(());
    }
    let rest = logo
        .strip_prefix("data:")
        .ok_or("the logo must be an image data URI")?;
    let (mime, b64) = rest
        .split_once(";base64,")
        .ok_or("the logo must be a base64 image data URI")?;
    if !matches!(
        mime,
        "image/png" | "image/jpeg" | "image/gif" | "image/webp"
    ) {
        return Err("the logo must be a PNG, JPEG, GIF, or WebP image".into());
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(b64)
        .map_err(|_| "the logo image data is not valid base64".to_string())?;
    check_logo_size(bytes.len())?;
    if sniff_image_mime(&bytes) != Some(mime) {
        return Err("the logo data doesn't match a supported image format".into());
    }
    Ok(())
}

fn check_logo_size(len: usize) -> Result<(), String> {
    if len > MAX_LOGO_BYTES {
        return Err(format!(
            "the logo is too large ({} KB); keep it under {} KB",
            len / 1024,
            MAX_LOGO_BYTES / 1024
        ));
    }
    Ok(())
}

/// Read an image file the user picked and return it as a self-contained data
/// URI ready to store as the logo. Rejects non-images and oversized files. The
/// read is bounded to one byte past the cap, so a huge (or unbounded, e.g.
/// `/dev/zero`) file is rejected without slurping it all into memory.
pub async fn logo_from_path(path: &str) -> Result<String, String> {
    use tokio::io::AsyncReadExt;
    let file = tokio::fs::File::open(path).await.map_err(err)?;
    let mut bytes = Vec::new();
    file.take(MAX_LOGO_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .await
        .map_err(err)?;
    check_logo_size(bytes.len())?;
    let mime =
        sniff_image_mime(&bytes).ok_or("unsupported image — use a PNG, JPEG, GIF, or WebP file")?;
    // Append the base64 straight onto the prefix — no second copy of the payload.
    let mut uri = format!("data:{mime};base64,");
    base64::engine::general_purpose::STANDARD.encode_string(&bytes, &mut uri);
    Ok(uri)
}

/// Read the stored business details, or an empty profile when none are set.
pub async fn get_business(pool: &SqlitePool) -> Result<BusinessDetails, String> {
    let row = sqlx::query(
        "SELECT name, address, email, tax_id, logo, tax_label, template, payment_details \
           FROM billing_business WHERE singleton = 1",
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
            logo: r.get("logo"),
            tax_label: r.get("tax_label"),
            template: r.get("template"),
            payment_details: r.get("payment_details"),
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
    validate_logo(&d.logo)?;
    validate_template(&d.template)?;
    sqlx::query(
        "INSERT INTO billing_business \
           (singleton, name, address, email, tax_id, logo, tax_label, template, \
            payment_details, updated_at) \
         VALUES (1, ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, datetime('now')) \
         ON CONFLICT (singleton) DO UPDATE SET \
           name = ?1, address = ?2, email = ?3, tax_id = ?4, logo = ?5, \
           tax_label = ?6, template = ?7, payment_details = ?8, \
           updated_at = datetime('now')",
    )
    .bind(&d.name)
    .bind(&d.address)
    .bind(&d.email)
    .bind(&d.tax_id)
    .bind(&d.logo)
    .bind(&d.tax_label)
    .bind(&d.template)
    .bind(&d.payment_details)
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
                logo: PNG_URI.into(),
                tax_label: "  VAT  ".into(),
                template: "modern".into(),
                payment_details: "  Bank: Acme\nIBAN: NO00  ".into(),
            },
        )
        .await
        .unwrap();
        assert_eq!(saved.name, "Acme Consulting AS");
        assert_eq!(saved.logo, PNG_URI); // stored verbatim, not trimmed
        assert_eq!(saved.tax_label, "VAT"); // trimmed
        assert_eq!(saved.template, "modern");
        assert_eq!(saved.payment_details, "Bank: Acme\nIBAN: NO00"); // trimmed
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
        assert_eq!(got.logo, ""); // logo cleared too
    }

    #[test]
    fn is_empty_counts_a_logo_only_profile_as_non_empty() {
        let b = BusinessDetails {
            logo: PNG_URI.into(),
            ..Default::default()
        };
        assert!(!b.is_empty());
        assert!(BusinessDetails::default().is_empty());
        // Tax-label-only and template-only profiles have no "From" block.
        assert!(BusinessDetails {
            tax_label: "VAT".into(),
            ..Default::default()
        }
        .is_empty());
        assert!(BusinessDetails {
            template: "modern".into(),
            ..Default::default()
        }
        .is_empty());
        // Payment details render in their own block, not the "From" block.
        assert!(BusinessDetails {
            payment_details: "IBAN NO00".into(),
            ..Default::default()
        }
        .is_empty());
    }

    #[test]
    fn sniff_recognizes_each_supported_format() {
        assert_eq!(sniff_image_mime(b"\x89PNG\r\n\x1a\n"), Some("image/png"));
        assert_eq!(sniff_image_mime(b"\xFF\xD8\xFFxx"), Some("image/jpeg"));
        assert_eq!(sniff_image_mime(b"GIF89a...."), Some("image/gif"));
        assert_eq!(sniff_image_mime(b"RIFF\0\0\0\0WEBPxx"), Some("image/webp"));
        assert_eq!(sniff_image_mime(b"nope"), None);
        assert_eq!(sniff_image_mime(b""), None);
    }

    #[test]
    fn check_logo_size_enforces_the_cap() {
        assert!(check_logo_size(10).is_ok());
        assert!(check_logo_size(MAX_LOGO_BYTES).is_ok());
        let e = check_logo_size(MAX_LOGO_BYTES + 1).unwrap_err();
        assert!(e.contains("too large"), "{e}");
    }

    #[test]
    fn validate_logo_accepts_a_raster_data_uri_and_rejects_the_rest() {
        assert!(validate_logo("").is_ok()); // empty = no logo
        assert!(validate_logo(PNG_URI).is_ok());

        // Not a data URI, missing base64 marker, unsupported/SVG mime, bad
        // base64, and a MIME that lies about the bytes are all rejected.
        assert!(validate_logo("https://x/logo.png")
            .unwrap_err()
            .contains("data URI"));
        assert!(validate_logo("data:image/png,rawbytes")
            .unwrap_err()
            .contains("base64 image"));
        assert!(validate_logo("data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=")
            .unwrap_err()
            .contains("PNG, JPEG"));
        assert!(validate_logo("data:image/png;base64,!!!not-base64")
            .unwrap_err()
            .contains("not valid base64"));
        // Valid base64 PNG bytes but claiming JPEG → magic-byte mismatch.
        let lying = PNG_URI.replace("image/png", "image/jpeg");
        assert!(validate_logo(&lying).unwrap_err().contains("doesn't match"));

        // A well-formed base64 payload that decodes past the cap is rejected on
        // size (validate_logo's own size check, distinct from the file read).
        let oversized = format!(
            "data:image/png;base64,{}",
            base64::engine::general_purpose::STANDARD.encode(vec![0u8; MAX_LOGO_BYTES + 1])
        );
        assert!(validate_logo(&oversized).unwrap_err().contains("too large"));
    }

    #[tokio::test]
    async fn set_business_rejects_an_invalid_logo() {
        // Validation runs before any DB work, so a rejected logo never lands.
        let (_dir, db) = test_db().await;
        let e = set_business(
            &db.pool,
            &BusinessDetails {
                logo: "data:image/svg+xml;base64,PHN2Zz4=".into(),
                ..Default::default()
            },
        )
        .await
        .unwrap_err();
        assert!(e.contains("PNG, JPEG"), "{e}");
        assert!(get_business(&db.pool).await.unwrap().logo.is_empty());
    }

    #[test]
    fn validate_template_allows_known_presets_and_empty() {
        for t in ["", "classic", "modern", "minimal"] {
            assert!(validate_template(t).is_ok(), "{t}");
        }
        assert!(validate_template("fancy")
            .unwrap_err()
            .contains("unknown invoice template"));
    }

    #[tokio::test]
    async fn set_business_rejects_an_unknown_template() {
        let (_dir, db) = test_db().await;
        let e = set_business(
            &db.pool,
            &BusinessDetails {
                template: "fancy".into(),
                ..Default::default()
            },
        )
        .await
        .unwrap_err();
        assert!(e.contains("unknown invoice template"), "{e}");
        assert!(get_business(&db.pool).await.unwrap().template.is_empty());
    }

    #[tokio::test]
    async fn logo_from_path_encodes_images_and_rejects_the_rest() {
        let dir = tempfile::tempdir().unwrap();
        let png = base64::engine::general_purpose::STANDARD
            .decode(PNG_URI.strip_prefix("data:image/png;base64,").unwrap())
            .unwrap();

        let img = dir.path().join("logo.png");
        tokio::fs::write(&img, &png).await.unwrap();
        let uri = logo_from_path(img.to_str().unwrap()).await.unwrap();
        assert!(uri.starts_with("data:image/png;base64,"));
        assert!(validate_logo(&uri).is_ok());

        // A non-image file is rejected.
        let txt = dir.path().join("notes.txt");
        tokio::fs::write(&txt, b"just text").await.unwrap();
        assert!(logo_from_path(txt.to_str().unwrap())
            .await
            .unwrap_err()
            .contains("unsupported image"));

        // An oversized file is rejected before any encoding.
        let big = dir.path().join("big.png");
        tokio::fs::write(&big, vec![0u8; MAX_LOGO_BYTES + 1])
            .await
            .unwrap();
        assert!(logo_from_path(big.to_str().unwrap())
            .await
            .unwrap_err()
            .contains("too large"));

        // A missing file surfaces the read error.
        assert!(
            logo_from_path(dir.path().join("nope.png").to_str().unwrap())
                .await
                .is_err()
        );
    }

    /// A 1×1 transparent PNG as a data URI — small, valid, real magic bytes.
    const PNG_URI: &str = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
}
