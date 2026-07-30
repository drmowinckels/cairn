//! Render a stored invoice (#1) to a self-contained, printable HTML
//! document — no external resources, so it works offline and the user's
//! browser/OS turns it into a PDF via Print. All user text is escaped.

use super::business::BusinessDetails;
use super::invoices::Invoice;

/// Escape the five HTML-significant characters so user text (client name,
/// notes, line descriptions) can never break out of the document. Single pass
/// with one allocation — matters for the logo data URI, which is large and
/// never actually contains any of these characters.
fn escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            _ => out.push(c),
        }
    }
    out
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

/// The invoice due date: `issue_date` plus the issuer's `payment_terms_days`,
/// formatted `YYYY-MM-DD`. `None` when terms are ≤ 0, the issue date doesn't
/// parse, or the result is out of range — so no due line is shown. Uses the
/// checked `try_days`/`checked_add_signed` throughout: an absurd `terms_days`
/// (only reachable by a direct IPC call, past the clamped input) yields `None`
/// rather than panicking `Duration::days`.
fn due_date(issue_date: &str, terms_days: i64) -> Option<String> {
    if terms_days <= 0 {
        return None;
    }
    let issued = chrono::NaiveDate::parse_from_str(issue_date, "%Y-%m-%d").ok()?;
    let delta = chrono::Duration::try_days(terms_days)?;
    let due = issued.checked_add_signed(delta)?;
    Some(due.format("%Y-%m-%d").to_string())
}

/// The shared invoice layout — the "classic" look on its own. A template
/// preset appends a small override sheet (below) that wins over these rules.
const BASE: &str = "\
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
.from .logo{display:block;max-height:56px;max-width:200px;margin-bottom:.4rem}\
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
.payment{margin-top:1.5rem}\
.payment p{margin:.1rem 0}\
.muted{color:#777;font-size:.85rem}";

/// "modern" — an indigo accent, bolder headings, a tinted table header.
const MODERN_OVERRIDE: &str = "\
body{color:#111827}\
.head{border-bottom:3px solid #4338ca}\
h1{color:#4338ca;font-weight:800;letter-spacing:-.02em}\
h2{color:#4338ca}\
th{background:#eef2ff;color:#4338ca;border-bottom:none}\
td{border-bottom:1px solid #eef2ff}\
.grand{border-top:2px solid #4338ca;color:#4338ca}";

/// "minimal" — monochrome, hairline rules, lighter weight, more whitespace.
const MINIMAL_OVERRIDE: &str = "\
body{color:#374151;max-width:44rem}\
.head{border-bottom:1px solid #e5e7eb;padding-bottom:1.25rem}\
h1{font-weight:400;font-size:1.5rem;letter-spacing:.01em}\
h2{color:#9ca3af;letter-spacing:.12em}\
table{margin-top:2rem}\
th{color:#9ca3af;border-bottom:1px solid #f3f4f6}\
td{border-bottom:none;padding:.55rem .25rem}\
.grand{border-top:1px solid #d1d5db}";

/// Each preset with its override sheet — the single source of which templates
/// exist. "classic" is the base sheet alone (no override entry).
const TEMPLATE_OVERRIDES: [(&str, &str); 2] =
    [("modern", MODERN_OVERRIDE), ("minimal", MINIMAL_OVERRIDE)];

/// True for a storable template: the empty default, "classic", or a preset
/// with an override sheet. `business::set_business` validates against this, so
/// a name the renderer would silently fall back on can never be stored.
pub fn known_template(template: &str) -> bool {
    matches!(template, "" | "classic") || TEMPLATE_OVERRIDES.iter().any(|(n, _)| *n == template)
}

/// Resolve the template name to its `(key, override-sheet)`. Empty, "classic",
/// or any unknown value falls back to the classic base (no override).
fn template_style(template: &str) -> (&'static str, &'static str) {
    TEMPLATE_OVERRIDES
        .iter()
        .find(|(name, _)| *name == template)
        .copied()
        .unwrap_or(("classic", ""))
}

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
        // The logo is a validated raster data URI (business::set_business), so
        // its base64 payload can't break out of the attribute; escaped anyway.
        let logo = if business.logo.is_empty() {
            String::new()
        } else {
            format!(
                "<img class=\"logo\" alt=\"\" src=\"{}\">",
                escape(&business.logo)
            )
        };
        format!(
            "<section class=\"from\"><h2>From</h2>{}{}</section>",
            logo,
            issuer_lines(business)
        )
    };

    // The tax line's label comes from the issuer's tax regime; "Tax" by
    // default. `set_business` trims it, so `get_business` never yields a
    // whitespace-only label that would slip past this empty check.
    let tax_label = if business.tax_label.is_empty() {
        "Tax".to_string()
    } else {
        escape(&business.tax_label)
    };

    // A "Payment" block (how the client pays) when the issuer set instructions.
    let payment = if business.payment_details.is_empty() {
        String::new()
    } else {
        format!(
            "<section class=\"payment\"><h2>Payment</h2><p>{}</p></section>",
            escape_multiline(&business.payment_details)
        )
    };

    // The due date (issue date + the issuer's terms) sits in the header meta.
    let due_line = match due_date(&inv.issue_date, business.payment_terms_days) {
        Some(d) => format!("Due {}<br>", escape(&d)),
        None => String::new(),
    };

    // The template preset selects an override sheet appended after the base.
    // `template_key` (a fixed allowlist value) tags the body as a decorative
    // marker — the styling comes from the override, not a `[data-template]`
    // selector.
    let (template_key, template_override) = template_style(&business.template);

    format!(
        "<!doctype html>\n<html lang=\"en\"><head><meta charset=\"utf-8\">\
<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">\
<title>Invoice {number}</title><style>{style}{template_override}</style></head>\
<body data-template=\"{template_key}\">\
<header class=\"head\"><h1>Invoice {number}</h1>\
<div class=\"meta\">Issued {issued}<br>{due_line}Period {from} – {to}</div></header>\
<div class=\"parties\">{from_block}\
<section class=\"to\"><h2>Billed to</h2><p class=\"pname\">{client}</p></section></div>\
<table><thead><tr><th>Description</th><th class=\"num\">Hours</th>\
<th class=\"num\">Amount</th></tr></thead><tbody>{rows}</tbody></table>\
<dl class=\"totals\"><div><dt>Subtotal</dt><dd>{subtotal}</dd></div>\
<div><dt>{tax_label} ({tax_pct}%)</dt><dd>{tax}</dd></div>\
<div class=\"grand\"><dt>Total</dt><dd>{total}</dd></div></dl>\
{payment}{notes}{unrated}</body></html>",
        number = escape(&inv.number),
        style = BASE,
        template_override = template_override,
        template_key = template_key,
        issued = escape(&inv.issue_date),
        due_line = due_line,
        from = escape(&inv.from_date),
        to = escape(&inv.to_date),
        client = escape(&inv.client_name),
        from_block = from_block,
        rows = rows,
        subtotal = money(inv.subtotal_cents, &inv.currency),
        tax = money(inv.tax_cents, &inv.currency),
        tax_label = tax_label,
        tax_pct = inv.tax_rate_bps as f64 / 100.0,
        total = money(inv.total_cents, &inv.currency),
        payment = payment,
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
            logo: "data:image/png;base64,AAAA".into(),
            tax_label: String::new(), // default "Tax" label
            template: String::new(),  // default "classic" look
            payment_details: "Bank <Acme>\nIBAN NO00".into(),
            payment_terms_days: 0, // no due date by default
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
    fn escape_encodes_all_five_characters() {
        assert_eq!(escape("a&b<c>d\"e'f"), "a&amp;b&lt;c&gt;d&quot;e&#39;f");
    }

    #[test]
    fn due_date_is_issue_plus_terms() {
        assert_eq!(due_date("2026-07-15", 14).as_deref(), Some("2026-07-29"));
        assert_eq!(due_date("2026-07-15", 0), None); // no terms
        assert_eq!(due_date("2026-07-15", -3), None); // negative
        assert_eq!(due_date("not-a-date", 14), None); // unparseable
        assert_eq!(due_date("2026-07-15", i64::MAX), None); // no panic on absurd terms
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
    fn uses_the_configured_tax_label_escaped() {
        let mut b = business();
        b.tax_label = "GST & VAT".into();
        let html = render_html(&invoice(), &b);
        assert!(html.contains("GST &amp; VAT (25%)"));
        assert!(!html.contains(">Tax (25%)")); // the default is not used
    }

    #[test]
    fn renders_the_payment_block_when_set_and_omits_it_otherwise() {
        let html = render_html(&invoice(), &business());
        assert!(html.contains("<section class=\"payment\"><h2>Payment</h2>"));
        // Escaped, with newlines turned into <br>.
        assert!(html.contains("Bank &lt;Acme&gt;<br>IBAN NO00"));

        let mut b = business();
        b.payment_details = String::new();
        assert!(!render_html(&invoice(), &b).contains("class=\"payment\""));
    }

    #[test]
    fn renders_the_due_date_from_terms() {
        let mut b = business();
        b.payment_terms_days = 14; // issue 2026-07-15 + 14 = 2026-07-29
        assert!(render_html(&invoice(), &b).contains("Due 2026-07-29<br>"));
        // No terms → no due line.
        assert!(!render_html(&invoice(), &business()).contains("Due 2026"));
    }

    #[test]
    fn payment_block_is_independent_of_the_from_block() {
        // Payment details but nothing else: the "From" block is omitted, yet the
        // "Payment" block still renders (it isn't gated on `is_empty`).
        let b = BusinessDetails {
            payment_details: "IBAN NO00".into(),
            ..Default::default()
        };
        assert!(b.is_empty());
        let html = render_html(&invoice(), &b);
        assert!(!html.contains("<h2>From</h2>"));
        assert!(html.contains("<section class=\"payment\">"));
        assert!(html.contains("IBAN NO00"));
    }

    #[test]
    fn selects_the_template_preset_stylesheet() {
        let render = |template: &str| {
            let mut b = business();
            b.template = template.into();
            render_html(&invoice(), &b)
        };

        // Empty and explicit "classic" → base sheet, no accent, tagged classic.
        for c in [render(""), render("classic")] {
            assert!(c.contains("<body data-template=\"classic\">"));
            assert!(!c.contains("#4338ca"));
        }

        // Modern → indigo accent override + tag.
        let modern = render("modern");
        assert!(modern.contains("<body data-template=\"modern\">"));
        assert!(modern.contains("#4338ca"));

        // Minimal → hairline/monochrome override + tag.
        let minimal = render("minimal");
        assert!(minimal.contains("<body data-template=\"minimal\">"));
        assert!(minimal.contains("#9ca3af"));

        // An unknown value (blocked on store) still falls back to classic.
        assert!(render("bogus").contains("<body data-template=\"classic\">"));
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
        // The logo is embedded as an <img> ahead of the issuer lines.
        assert!(html.contains("<img class=\"logo\" alt=\"\" src=\"data:image/png;base64,AAAA\">"));
    }

    #[test]
    fn omits_the_issuer_block_when_details_are_empty() {
        let html = render_html(&invoice(), &BusinessDetails::default());
        assert!(!html.contains("class=\"from\""));
        assert!(!html.contains("<h2>From</h2>"));
        // A partly-filled profile shows only the fields that are set, and no
        // <img> when there's no logo.
        let partial = BusinessDetails {
            name: "Solo".into(),
            ..Default::default()
        };
        let html = render_html(&invoice(), &partial);
        assert!(html.contains("class=\"from\""));
        assert!(html.contains("Solo"));
        assert!(!html.contains("Tax ID:"));
        assert!(!html.contains("class=\"logo\""));
    }

    #[test]
    fn renders_a_logo_only_profile() {
        let logo_only = BusinessDetails {
            logo: "data:image/png;base64,AAAA".into(),
            ..Default::default()
        };
        let html = render_html(&invoice(), &logo_only);
        assert!(html.contains("class=\"from\""));
        assert!(html.contains("<img class=\"logo\""));
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
