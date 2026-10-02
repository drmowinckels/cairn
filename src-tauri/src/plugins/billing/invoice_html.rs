//! Render a stored invoice (#1) to a self-contained, printable HTML
//! document — no external resources, so it works offline and the user's
//! browser/OS turns it into a PDF via Print. All user text is escaped.

use super::business::BusinessDetails;
use super::invoices::{ClientSnapshot, Invoice};
use super::money::Money;

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

/// An amount as the client's document shows it: locale-aware, from the
/// amount's own currency (`money_locale`, #330) rather than `Money`'s plain
/// diagnostic `Display`. One function, so all three template presets render
/// amounts identically. The digits and separators are safe by construction, but
/// the currency code is free text in the database and an unlisted one renders
/// verbatim, so this goes through `escape` like every other value that reaches
/// the document.
fn money(m: &Money) -> String {
    escape(&super::money_locale::format(m))
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
    s += &tax_id_line(&b.tax_id);
    s
}

/// The shared "Tax ID" line, so the label and its escaping are written once for
/// both parties; empty when the id is unset.
fn tax_id_line(tax_id: &str) -> String {
    if tax_id.is_empty() {
        String::new()
    } else {
        format!("<p>Tax ID: {}</p>", escape(tax_id))
    }
}

/// The buyer's lines for the "Billed to" block: the client name, then each
/// detail frozen onto the invoice at creation (#331) that was actually set. An
/// invoice issued before those fields existed — or to a client who had none —
/// renders the name alone, exactly as it did before.
///
/// Values are trimmed on the way into the `clients` table (`ipc::save_client`),
/// so an empty check is enough to keep a blank-looking line off the document.
fn client_lines(name: &str, client: &ClientSnapshot) -> String {
    let mut s = format!("<p class=\"pname\">{}</p>", escape(name));
    if !client.address.is_empty() {
        s += &format!("<p>{}</p>", escape_multiline(&client.address));
    }
    s += &tax_id_line(&client.tax_id);
    s
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
                money(&l.amount),
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
<section class=\"to\"><h2>Billed to</h2>{to_lines}</section></div>\
<table><thead><tr><th>Description</th><th class=\"num\">Hours</th>\
<th class=\"num\">Amount ({currency})</th></tr></thead><tbody>{rows}</tbody></table>\
<dl class=\"totals\"><div><dt>Subtotal</dt><dd>{subtotal}</dd></div>\
<div><dt>{tax_label} ({tax_pct}%)</dt><dd>{tax}</dd></div>\
<div class=\"grand\"><dt>Total ({currency})</dt><dd>{total}</dd></div></dl>\
{payment}{notes}{unrated}</body></html>",
        number = escape(&inv.number),
        currency = escape(&inv.total.currency),
        style = BASE,
        template_override = template_override,
        template_key = template_key,
        issued = escape(&inv.issue_date),
        due_line = due_line,
        from = escape(&inv.from_date),
        to = escape(&inv.to_date),
        to_lines = client_lines(&inv.client_name, &inv.client),
        from_block = from_block,
        rows = rows,
        subtotal = money(&inv.subtotal),
        tax = money(&inv.tax),
        tax_label = tax_label,
        tax_pct = inv.tax_rate_bps as f64 / 100.0,
        total = money(&inv.total),
        payment = payment,
        notes = notes,
        unrated = unrated,
    )
}

#[cfg(test)]
mod tests {
    use super::super::business::BusinessDetails;
    use super::super::invoices::{ClientSnapshot, Invoice, InvoiceLine};
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
            invoice_prefix: String::new(),
            invoice_number_padding: 0,
        }
    }

    fn invoice() -> Invoice {
        Invoice {
            id: "i1".into(),
            number: "INV-0007".into(),
            client_id: "c1".into(),
            client_name: "Acme & Co".into(),
            client: ClientSnapshot {
                address: "9 <b>Buyer</b> Rd\nBerlin".into(),
                tax_id: "DE 123".into(),
            },
            issue_date: "2026-07-15".into(),
            from_date: "2026-07-01".into(),
            to_date: "2026-08-01".into(),
            tax_rate_bps: 2500,
            tax_label: String::new(),
            subtotal: Money::new(15000, "USD"),
            tax: Money::new(3750, "USD"),
            total: Money::new(18750, "USD"),
            unrated_seconds: 1800,
            status: "draft".into(),
            notes: Some("Thanks <3".into()),
            created_at: "x".into(),
            lines: vec![InvoiceLine {
                id: "l1".into(),
                description: "Website <redesign>".into(),
                seconds: 5400,
                amount: Money::new(15000, "USD"),
                sort: 0,
            }],
        }
    }

    #[test]
    fn a_tampered_currency_code_cannot_inject_markup() {
        let mut inv = invoice();
        inv.total = Money::new(18750, "<script>");
        let html = render_html(&inv, &business());
        assert!(
            !html.contains("<script>"),
            "raw markup reached the document"
        );
        assert!(html.contains("&lt;SCRIPT&gt;"), "{html}");
    }

    #[test]
    fn hours_renders_one_decimal() {
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
        assert!(html.contains("$187.50")); // total, locale-aware (#330)
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
        // Rendered without buyer details, so the only "Tax ID:" line this
        // could find would be the issuer's.
        let mut no_buyer = invoice();
        no_buyer.client = ClientSnapshot::default();
        let html = render_html(&no_buyer, &partial);
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

    /// An invoice in `currency`, with every figure in it — `invoices.rs`
    /// enforces one currency per invoice (`Money::checked_add` refuses a
    /// mismatch, and `get_invoice` reads every amount with the single stored
    /// code), so a test invoice has to be built the same way or it pins a
    /// document the app cannot produce.
    fn invoice_in(currency: &str, subtotal_minor: i64) -> Invoice {
        let subtotal = Money::new(subtotal_minor, currency);
        // The invoice's own 25% rate, applied with the same arithmetic
        // `invoices.rs` uses, so the figures agree with each other.
        let (tax, total) = subtotal
            .with_tax_bps(2_500)
            .expect("the test figures must fit");
        let mut inv = invoice();
        inv.lines[0].amount = subtotal.clone();
        inv.subtotal = subtotal;
        inv.tax = tax;
        inv.total = total;
        inv
    }

    /// The amount the client reads, not the `USD 187.50` developer form — and
    /// the symbol, grouping and separators of the amount's own currency, not
    /// the machine's (#330).
    #[test]
    fn renders_amounts_in_the_currencys_own_locale() {
        // The total is covered by the preset loop below; these are the two
        // figures it doesn't reach.
        let html = render_html(&invoice(), &business());
        assert!(html.contains("$150.00"), "line amount: {html}");
        assert!(html.contains("$37.50"), "tax");

        // The same invoice in EUR reads the way a eurozone client expects:
        // dot grouping, comma decimal, symbol last.
        let html = render_html(&invoice_in("EUR", 150_000), &business());
        assert!(html.contains("1.875,00\u{a0}\u{20ac}"), "{html}");

        // A yen invoice keeps whole amounts, grouped — no decimals that
        // currency doesn't have.
        let html = render_html(&invoice_in("JPY", 150_000), &business());
        assert!(html.contains("\u{ffe5}187,500"), "{html}");
        assert!(!html.contains("187,500.00"), "a yen amount has no decimals");

        // And a three-decimal currency keeps all three.
        let html = render_html(&invoice_in("BHD", 1_500_000), &business());
        assert!(html.contains("BHD\u{a0}1,875.000"), "{html}");
    }

    /// The group separator is one of the five characters `escape` encodes, so a
    /// Swiss amount round-trips through the escaper rather than being mangled
    /// by it (#321's escaping still wraps every rendered amount).
    #[test]
    fn escapes_a_group_separator_that_is_html_significant() {
        let html = render_html(&invoice_in("CHF", 150_000), &business());
        assert!(html.contains("CHF\u{a0}1&#39;875.00"), "{html}");
        assert!(
            !html.contains("1'875.00"),
            "a raw apostrophe reached the document"
        );
    }

    /// All three presets share one `money()`, so the fix can't reach some looks
    /// and miss others.
    #[test]
    fn every_template_preset_renders_the_same_amounts() {
        for template in ["", "classic", "modern", "minimal"] {
            let mut b = business();
            b.template = template.into();
            let html = render_html(&invoice(), &b);
            assert!(html.contains("$187.50"), "preset {template:?}: {html}");
            assert!(!html.contains("USD 187.50"), "preset {template:?}");
        }
    }

    /// A localized amount can render a bare `$` (CAD, AUD, SGD and MXN all do),
    /// so the document has to say which currency it is somewhere.
    #[test]
    fn states_the_currency_code_once_per_section() {
        let html = render_html(&invoice_in("CAD", 150_000), &business());
        assert!(html.contains("Amount (CAD)"), "{html}");
        assert!(html.contains("Total (CAD)"), "{html}");
    }

    #[test]
    fn renders_the_buyer_block_with_the_frozen_address_and_tax_id() {
        let html = render_html(&invoice(), &business());
        assert!(html.contains("<section class=\"to\"><h2>Billed to</h2>"));
        assert!(html.contains("<p class=\"pname\">Acme &amp; Co</p>"));
        // Address newlines become <br>, and its markup is escaped.
        assert!(html.contains("9 &lt;b&gt;Buyer&lt;/b&gt; Rd<br>Berlin"));
        assert!(html.contains("<p>Tax ID: DE 123</p>"));
    }

    #[test]
    fn the_buyer_block_falls_back_to_the_name_alone() {
        // A client with no address or tax id — and every pre-0037 invoice,
        // whose empty snapshot deserializes to exactly this.
        let mut inv = invoice();
        inv.client = ClientSnapshot::default();
        let html = render_html(&inv, &business());
        assert!(html.contains(
            "<section class=\"to\"><h2>Billed to</h2>\
             <p class=\"pname\">Acme &amp; Co</p></section>"
        ));
        assert!(!html.contains("Berlin"));
        // The issuer's own "Tax ID:" line is still there; the buyer's is not.
        assert!(html.contains("<p>Tax ID: NO 999</p>"));
        assert!(!html.contains("DE 123"));

        // Each field renders independently of the other.
        let mut address_only = invoice();
        address_only.client.tax_id = String::new();
        let html = render_html(&address_only, &business());
        assert!(html.contains("Berlin"));
        assert!(!html.contains("DE 123"));

        let mut tax_only = invoice();
        tax_only.client.address = String::new();
        let html = render_html(&tax_only, &business());
        assert!(!html.contains("Berlin"));
        assert!(html.contains("Tax ID: DE 123"));
    }

    /// One document, both halves: the buyer block (#331) and the localized
    /// amounts with their currency code (#330) have to be present together in
    /// every preset, not each on its own in a separate test.
    #[test]
    fn every_template_preset_renders_the_buyer_details_and_the_localized_amounts() {
        for template in ["", "classic", "modern", "minimal"] {
            let mut b = business();
            b.template = template.into();
            let html = render_html(&invoice(), &b);
            assert!(
                html.contains("9 &lt;b&gt;Buyer&lt;/b&gt; Rd<br>Berlin"),
                "template {template:?} dropped the buyer address"
            );
            assert!(
                html.contains("<p>Tax ID: DE 123</p>"),
                "template {template:?} dropped the buyer tax id"
            );
            assert!(
                html.contains("$187.50") && !html.contains("USD 187.50"),
                "template {template:?} lost the localized total"
            );
            assert!(
                html.contains("Amount (USD)") && html.contains("Total (USD)"),
                "template {template:?} lost the currency code"
            );
        }
    }

    #[test]
    fn a_tampered_buyer_snapshot_cannot_inject_markup() {
        let mut inv = invoice();
        inv.client = ClientSnapshot {
            address: "<script>alert(1)</script>".into(),
            tax_id: "<img onerror=x>".into(),
        };
        let html = render_html(&inv, &business());
        assert!(
            !html.contains("<script>"),
            "raw markup reached the document"
        );
        assert!(!html.contains("<img onerror"));
        assert!(html.contains("&lt;script&gt;alert(1)&lt;/script&gt;"));
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
