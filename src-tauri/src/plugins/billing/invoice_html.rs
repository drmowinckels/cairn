//! Render a stored invoice (#1) to a self-contained, printable HTML
//! document — no external resources, so it works offline and the user's
//! browser/OS turns it into a PDF via Print. All user text is escaped.

use super::business::BusinessDetails;
use super::invoices::Invoice;

/// Escape the five HTML-significant characters so user text (client name,
/// notes, line descriptions) can never break out of the document.
fn escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}

/// Escape user text and turn its newlines into `<br>` for display. The escape
/// runs first, so the inserted `<br>` is never itself escaped.
fn escape_multiline(s: &str) -> String {
    escape(s).replace('\n', "<br>")
}

/// The issuer's lines for the invoice "From" block — each field rendered only
/// when set, so a partly-filled profile stays tidy. Empty string when the
/// whole profile is empty (the caller then omits the block entirely).
///
/// Assumes fields are already trimmed — `business::set_business` trims on the
/// way in, so the only production source (`get_business`) is always trimmed; a
/// whitespace-only field here would otherwise render a blank-looking line.
fn issuer_lines(b: &BusinessDetails) -> String {
    let mut s = String::new();
    if !b.name.is_empty() {
        s += &format!("<p class=\"pname\">{}</p>", escape(&b.name));
    }
    if !b.address.is_empty() {
        s += &format!("<p>{}</p>", escape_multiline(&b.address));
    }
    if !b.email.is_empty() {
        s += &format!("<p>{}</p>", escape(&b.email));
    }
    if !b.tax_id.is_empty() {
        s += &format!("<p>Tax ID: {}</p>", escape(&b.tax_id));
    }
    s
}

/// `<currency> <major>.<minor>` — e.g. `USD 150.00`. Assumes a 2-decimal
/// currency, which covers the common case; zero-decimal currencies are a
/// later concern. Invoice amounts are always non-negative (durations times
/// non-negative rates), so the formatting doesn't handle a sign.
fn money(cents: i64, currency: &str) -> String {
    format!("{} {}.{:02}", currency, cents / 100, cents % 100)
}

fn hours(seconds: i64) -> String {
    format!("{:.1}", seconds as f64 / 3600.0)
}

const STYLE: &str = "\
:root{color-scheme:light}\
body{font:14px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;color:#1a1a1a;max-width:46rem;margin:2rem auto;padding:0 1.5rem}\
.head{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:2px solid #1a1a1a;padding-bottom:.75rem}\
h1{font-size:1.6rem;margin:0}\
h2{font-size:.8rem;text-transform:uppercase;letter-spacing:.06em;color:#666;margin:1.5rem 0 .25rem}\
.meta{text-align:right;color:#555;font-size:.85rem}\
.parties{display:flex;justify-content:space-between;gap:2rem;margin-top:1.25rem}\
.parties h2{margin-top:0}\
.from p,.to p{margin:0}\
.pname{font-weight:600;font-size:1.05rem}\
table{width:100%;border-collapse:collapse;margin-top:1.5rem;font-size:.9rem}\
th,td{padding:.5rem .25rem;border-bottom:1px solid #e2e2e2;text-align:left}\
th{font-size:.75rem;text-transform:uppercase;letter-spacing:.04em;color:#666}\
.num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}\
.totals{margin:1rem 0 0;margin-left:auto;width:16rem}\
.totals>div{display:flex;justify-content:space-between;padding:.15rem 0}\
.totals dt,.totals dd{margin:0}\
.totals dd{font-variant-numeric:tabular-nums}\
.grand{font-weight:700;border-top:1px solid #1a1a1a;margin-top:.25rem;padding-top:.35rem}\
.notes{margin-top:2rem;white-space:pre-wrap}\
.muted{color:#777;font-size:.85rem}";

/// Build the printable HTML document for an invoice. `business` is the issuer
/// shown in the "From" block; an empty profile omits that block.
pub fn render_html(inv: &Invoice, business: &BusinessDetails) -> String {
    let rows: String = inv
        .lines
        .iter()
        .map(|l| {
            format!(
                "<tr><td>{}</td><td class=\"num\">{}</td><td class=\"num\">{}</td></tr>",
                escape(&l.description),
                hours(l.seconds),
                money(l.amount_cents, &inv.currency),
            )
        })
        .collect();

    // Notes are stored as `None` when blank (the create form maps "" → null),
    // so a plain match covers both cases.
    let notes = match &inv.notes {
        Some(n) => format!("<p class=\"notes\">{}</p>", escape(n)),
        None => String::new(),
    };
    let unrated = if inv.unrated_seconds > 0 {
        format!(
            "<p class=\"muted\">{} h of billable time in this period had no rate \
             and isn't included on this invoice.</p>",
            hours(inv.unrated_seconds)
        )
    } else {
        String::new()
    };

    // The issuer "From" block appears only when business details are set.
    let from_block = if business.is_empty() {
        String::new()
    } else {
        format!(
            "<section class=\"from\"><h2>From</h2>{}</section>",
            issuer_lines(business)
        )
    };

    format!(
        "<!doctype html>\n<html lang=\"en\"><head><meta charset=\"utf-8\">\
<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">\
<title>Invoice {number}</title><style>{style}</style></head><body>\
<header class=\"head\"><h1>Invoice {number}</h1>\
<div class=\"meta\">Issued {issued}<br>Period {from} – {to}</div></header>\
<div class=\"parties\">{from_block}\
<section class=\"to\"><h2>Billed to</h2><p class=\"pname\">{client}</p></section></div>\
<table><thead><tr><th>Description</th><th class=\"num\">Hours</th>\
<th class=\"num\">Amount</th></tr></thead><tbody>{rows}</tbody></table>\
<dl class=\"totals\"><div><dt>Subtotal</dt><dd>{subtotal}</dd></div>\
<div><dt>Tax ({tax_pct}%)</dt><dd>{tax}</dd></div>\
<div class=\"grand\"><dt>Total</dt><dd>{total}</dd></div></dl>\
{notes}{unrated}</body></html>",
        number = escape(&inv.number),
        style = STYLE,
        issued = escape(&inv.issue_date),
        from = escape(&inv.from_date),
        to = escape(&inv.to_date),
        client = escape(&inv.client_name),
        from_block = from_block,
        rows = rows,
        subtotal = money(inv.subtotal_cents, &inv.currency),
        tax = money(inv.tax_cents, &inv.currency),
        tax_pct = inv.tax_rate_bps as f64 / 100.0,
        total = money(inv.total_cents, &inv.currency),
        notes = notes,
        unrated = unrated,
    )
}

#[cfg(test)]
mod tests {
    use super::super::business::BusinessDetails;
    use super::super::invoices::{Invoice, InvoiceLine};
    use super::*;

    fn business() -> BusinessDetails {
        BusinessDetails {
            name: "Björk & Co".into(),
            address: "1 <b>Main</b> St\nOslo".into(),
            email: "hi@bjork.no".into(),
            tax_id: "NO 999".into(),
        }
    }

    fn invoice() -> Invoice {
        Invoice {
            id: "i1".into(),
            number: "INV-0007".into(),
            client_id: "c1".into(),
            client_name: "Acme & Co".into(),
            currency: "USD".into(),
            issue_date: "2026-07-15".into(),
            from_date: "2026-07-01".into(),
            to_date: "2026-08-01".into(),
            tax_rate_bps: 2500,
            subtotal_cents: 15000,
            tax_cents: 3750,
            total_cents: 18750,
            unrated_seconds: 1800,
            status: "draft".into(),
            notes: Some("Thanks <3".into()),
            created_at: "x".into(),
            lines: vec![InvoiceLine {
                id: "l1".into(),
                description: "Website <redesign>".into(),
                seconds: 5400,
                amount_cents: 15000,
                sort: 0,
            }],
        }
    }

    #[test]
    fn money_and_hours_format() {
        assert_eq!(money(18750, "USD"), "USD 187.50");
        assert_eq!(money(0, "EUR"), "EUR 0.00");
        assert_eq!(hours(5400), "1.5");
    }

    #[test]
    fn renders_the_invoice_fields() {
        let html = render_html(&invoice(), &business());
        assert!(html.starts_with("<!doctype html>"));
        assert!(html.contains("Invoice INV-0007"));
        assert!(html.contains("Period 2026-07-01 – 2026-08-01"));
        assert!(html.contains("USD 187.50")); // total
        assert!(html.contains("Tax (25%)"));
        assert!(html.contains("1.5")); // line hours
        assert!(html.contains("0.5 h of billable time")); // unrated note
    }

    #[test]
    fn renders_the_issuer_block_with_each_set_field() {
        let html = render_html(&invoice(), &business());
        assert!(html.contains("<section class=\"from\"><h2>From</h2>"));
        assert!(html.contains("Björk &amp; Co"));
        // Address newlines become <br>, and its markup is escaped.
        assert!(html.contains("1 &lt;b&gt;Main&lt;/b&gt; St<br>Oslo"));
        assert!(html.contains("hi@bjork.no"));
        assert!(html.contains("Tax ID: NO 999"));
    }

    #[test]
    fn omits_the_issuer_block_when_details_are_empty() {
        let html = render_html(&invoice(), &BusinessDetails::default());
        assert!(!html.contains("class=\"from\""));
        assert!(!html.contains("<h2>From</h2>"));
        // A partly-filled profile shows only the fields that are set.
        let partial = BusinessDetails {
            name: "Solo".into(),
            ..Default::default()
        };
        let html = render_html(&invoice(), &partial);
        assert!(html.contains("class=\"from\""));
        assert!(html.contains("Solo"));
        assert!(!html.contains("Tax ID:"));
    }

    #[test]
    fn escapes_all_user_text() {
        let html = render_html(&invoice(), &business());
        // Client, notes, and line description are escaped — no raw angle brackets.
        assert!(html.contains("Acme &amp; Co"));
        assert!(html.contains("Website &lt;redesign&gt;"));
        assert!(html.contains("Thanks &lt;3"));
        assert!(!html.contains("<redesign>"));
        assert!(!html.contains("Acme & Co"));
    }

    #[test]
    fn omits_notes_and_unrated_when_absent() {
        let mut inv = invoice();
        inv.notes = None;
        inv.unrated_seconds = 0;
        let html = render_html(&inv, &business());
        assert!(!html.contains("class=\"notes\""));
        assert!(!html.contains("had no rate"));
    }
}
