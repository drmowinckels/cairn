//! Locale-aware rendering of a [`Money`] for the exported invoice (#330).
//!
//! The app formats amounts with `Intl.NumberFormat` (`src/lib/money.ts`), so
//! in-app figures read as `$1,500.00` or `1 500,00 kr`. The exported document
//! renders Rust-side, and [`Money`]'s `Display` — the plain `USD 1500.00`
//! form — is a developer/diagnostic rendering: no symbol, no grouping, no
//! locale, on the one artefact that leaves the machine and reaches a paying
//! customer's client. This module is the client-facing rendering.
//!
//! ## Why a second formatter, and what stops it drifting
//!
//! There is no `Intl` in the Rust process, so a locale-aware amount means
//! either driving the whole document from the webview or carrying the
//! conventions here. Carrying them here is the smaller change, and the drift
//! it risks — two money formatters disagreeing, the bug class #320 and #321
//! each cost a round of rework — is held shut the way the currency scale
//! tables already are (`scripts/currency-tables.test.mjs`): by a test.
//!
//! [`money_locale_fixture.json`](money_locale_fixture.json) holds, per
//! currency, what `Intl.NumberFormat` produces for a battery of amounts.
//! `tests::matches_the_pinned_intl_output` asserts this module reproduces it;
//! `scripts/invoice-money-drift.test.mjs` asserts the fixture is still what a
//! live `Intl` produces, and that every row of [`PATTERNS`] is pinned by it.
//! Either side moving turns a build red.
//!
//! ## Whose locale
//!
//! **The amount's own currency picks the conventions** — a EUR amount is
//! rendered the way a eurozone reader expects (`1.500,00 €`), not the way the
//! machine that generated the document happens to be configured. The reader is
//! the client, and the currency is the only reader-side signal an invoice
//! actually carries: Cairn stores no client locale, and the issuer's machine
//! locale is precisely the wrong answer (an `en-US` laptop invoicing a German
//! client in EUR). Each currency maps to its home locale's conventions; where a
//! currency has no single home, the tie is broken in [`PATTERNS`] and recorded
//! in the fixture (EUR follows `de-DE`, the largest eurozone economy and the
//! commonest eurozone convention).
//!
//! A currency with no row renders as today's code-prefixed form with grouping
//! added (`BHD 1,500.000`) — which is also exactly what `Intl` does in `en-US`
//! for a currency it has no symbol for, so the fallback is pinned too. Rows are
//! deliberately restricted to locales that render in Latin digits with no bidi
//! controls: the document is `lang="en"` and LTR, so a currency whose home
//! locale would mix in Arabic-Indic digits or invisible direction marks takes
//! the Latin fallback instead (ILS is listed with its `en-US` conventions for
//! this reason).
//!
//! The number of decimals is **not** taken from the locale: it is the ISO 4217
//! minor-unit exponent from [`super::currency`], the authority on what a stored
//! integer means. CLDR disagrees with ISO for a few currencies (it renders HUF
//! with no decimals), and the stored scale has to win — so the fixture asks
//! `Intl` for the same number of digits Cairn stores.
//!
//! Because a localized amount can render a bare `$` (CAD, AUD, SGD, MXN… all
//! do, in their own locales), the document states the ISO code once — see
//! `invoice_html`. The symbol is for reading; the code is what makes the
//! document unambiguous.

use super::currency;
use super::money::Money;

/// How digits left of the decimal separator are grouped.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Grouping {
    /// Threes all the way: `1,234,567`.
    Western,
    /// Three, then twos — the Indian system: `12,34,567`.
    Indic,
}

/// One currency's rendering conventions, as `Intl` produces them in the locale
/// the fixture records for it. `prefix`/`suffix` carry their own spacing (a
/// no-break space where the locale puts one), so placement needs no separate
/// rule: an amount is `prefix` + digits + `suffix`.
struct Pattern {
    prefix: &'static str,
    suffix: &'static str,
    group: &'static str,
    decimal: &'static str,
    grouping: Grouping,
    /// Fewest integer digits that get a group separator at all. 4 nearly
    /// everywhere; 5 where CLDR sets `minimumGroupingDigits=2`, which renders
    /// four digits unbroken (`1500,00 zł`).
    group_from: usize,
}

/// Every currency whose own conventions Cairn renders, keyed by canonical ISO
/// code. Generated from `Intl` and pinned against it by the drift test — not
/// hand-written, and not to be hand-edited without regenerating the fixture.
#[rustfmt::skip]
const PATTERNS: [(&str, Pattern); 41] = [
    ("USD", Pattern { prefix: "$", suffix: "", group: ",", decimal: ".", grouping: Grouping::Western, group_from: 4 }),
    ("EUR", Pattern { prefix: "", suffix: "\u{a0}\u{20ac}", group: ".", decimal: ",", grouping: Grouping::Western, group_from: 4 }),
    ("GBP", Pattern { prefix: "\u{a3}", suffix: "", group: ",", decimal: ".", grouping: Grouping::Western, group_from: 4 }),
    ("NOK", Pattern { prefix: "", suffix: "\u{a0}kr", group: "\u{a0}", decimal: ",", grouping: Grouping::Western, group_from: 4 }),
    ("SEK", Pattern { prefix: "", suffix: "\u{a0}kr", group: "\u{a0}", decimal: ",", grouping: Grouping::Western, group_from: 4 }),
    ("DKK", Pattern { prefix: "", suffix: "\u{a0}kr.", group: ".", decimal: ",", grouping: Grouping::Western, group_from: 4 }),
    ("CHF", Pattern { prefix: "CHF\u{a0}", suffix: "", group: "'", decimal: ".", grouping: Grouping::Western, group_from: 4 }),
    ("ISK", Pattern { prefix: "", suffix: "\u{a0}kr.", group: ".", decimal: ".", grouping: Grouping::Western, group_from: 4 }),
    ("PLN", Pattern { prefix: "", suffix: "\u{a0}z\u{142}", group: "\u{a0}", decimal: ",", grouping: Grouping::Western, group_from: 5 }),
    ("CZK", Pattern { prefix: "", suffix: "\u{a0}K\u{10d}", group: "\u{a0}", decimal: ",", grouping: Grouping::Western, group_from: 4 }),
    ("HUF", Pattern { prefix: "", suffix: "\u{a0}Ft", group: "\u{a0}", decimal: ",", grouping: Grouping::Western, group_from: 5 }),
    ("RON", Pattern { prefix: "", suffix: "\u{a0}RON", group: ".", decimal: ",", grouping: Grouping::Western, group_from: 4 }),
    ("UAH", Pattern { prefix: "", suffix: "\u{a0}\u{20b4}", group: "\u{a0}", decimal: ",", grouping: Grouping::Western, group_from: 4 }),
    ("TRY", Pattern { prefix: "\u{20ba}", suffix: "", group: ".", decimal: ",", grouping: Grouping::Western, group_from: 4 }),
    ("RUB", Pattern { prefix: "", suffix: "\u{a0}\u{20bd}", group: "\u{a0}", decimal: ",", grouping: Grouping::Western, group_from: 4 }),
    ("ILS", Pattern { prefix: "\u{20aa}", suffix: "", group: ",", decimal: ".", grouping: Grouping::Western, group_from: 4 }),
    ("JPY", Pattern { prefix: "\u{ffe5}", suffix: "", group: ",", decimal: ".", grouping: Grouping::Western, group_from: 4 }),
    ("CNY", Pattern { prefix: "\u{a5}", suffix: "", group: ",", decimal: ".", grouping: Grouping::Western, group_from: 4 }),
    ("TWD", Pattern { prefix: "$", suffix: "", group: ",", decimal: ".", grouping: Grouping::Western, group_from: 4 }),
    ("KRW", Pattern { prefix: "\u{20a9}", suffix: "", group: ",", decimal: ".", grouping: Grouping::Western, group_from: 4 }),
    ("HKD", Pattern { prefix: "HK$", suffix: "", group: ",", decimal: ".", grouping: Grouping::Western, group_from: 4 }),
    ("SGD", Pattern { prefix: "$", suffix: "", group: ",", decimal: ".", grouping: Grouping::Western, group_from: 4 }),
    ("THB", Pattern { prefix: "\u{e3f}", suffix: "", group: ",", decimal: ".", grouping: Grouping::Western, group_from: 4 }),
    ("VND", Pattern { prefix: "", suffix: "\u{a0}\u{20ab}", group: ".", decimal: ".", grouping: Grouping::Western, group_from: 4 }),
    ("IDR", Pattern { prefix: "Rp\u{a0}", suffix: "", group: ".", decimal: ",", grouping: Grouping::Western, group_from: 4 }),
    ("MYR", Pattern { prefix: "RM\u{a0}", suffix: "", group: ",", decimal: ".", grouping: Grouping::Western, group_from: 4 }),
    ("PHP", Pattern { prefix: "\u{20b1}", suffix: "", group: ",", decimal: ".", grouping: Grouping::Western, group_from: 4 }),
    ("INR", Pattern { prefix: "\u{20b9}", suffix: "", group: ",", decimal: ".", grouping: Grouping::Indic, group_from: 4 }),
    ("AUD", Pattern { prefix: "$", suffix: "", group: ",", decimal: ".", grouping: Grouping::Western, group_from: 4 }),
    ("NZD", Pattern { prefix: "$", suffix: "", group: ",", decimal: ".", grouping: Grouping::Western, group_from: 4 }),
    ("CAD", Pattern { prefix: "$", suffix: "", group: ",", decimal: ".", grouping: Grouping::Western, group_from: 4 }),
    ("MXN", Pattern { prefix: "$", suffix: "", group: ",", decimal: ".", grouping: Grouping::Western, group_from: 4 }),
    ("BRL", Pattern { prefix: "R$\u{a0}", suffix: "", group: ".", decimal: ",", grouping: Grouping::Western, group_from: 4 }),
    ("ARS", Pattern { prefix: "$\u{a0}", suffix: "", group: ".", decimal: ",", grouping: Grouping::Western, group_from: 4 }),
    ("CLP", Pattern { prefix: "$", suffix: "", group: ".", decimal: ".", grouping: Grouping::Western, group_from: 4 }),
    ("COP", Pattern { prefix: "$\u{a0}", suffix: "", group: ".", decimal: ",", grouping: Grouping::Western, group_from: 4 }),
    ("ZAR", Pattern { prefix: "R\u{a0}", suffix: "", group: "\u{a0}", decimal: ",", grouping: Grouping::Western, group_from: 4 }),
    ("NGN", Pattern { prefix: "\u{20a6}", suffix: "", group: ",", decimal: ".", grouping: Grouping::Western, group_from: 4 }),
    ("KES", Pattern { prefix: "Ksh\u{a0}", suffix: "", group: ",", decimal: ".", grouping: Grouping::Western, group_from: 4 }),
    ("XOF", Pattern { prefix: "", suffix: "\u{a0}F\u{202f}CFA", group: "\u{202f}", decimal: ".", grouping: Grouping::Western, group_from: 4 }),
    ("XAF", Pattern { prefix: "", suffix: "\u{a0}FCFA", group: "\u{202f}", decimal: ".", grouping: Grouping::Western, group_from: 4 }),
];

/// The conventions an unlisted currency takes: `en-US` number formatting, with
/// the ISO code standing in for the symbol it has none of.
const FALLBACK: Pattern = Pattern {
    prefix: "",
    suffix: "",
    group: ",",
    decimal: ".",
    grouping: Grouping::Western,
    group_from: 4,
};

/// `currency`'s own conventions, or `None` for one Cairn has no row for. The
/// code is matched as stored — [`Money`] canonicalizes it on construction.
fn pattern_for(currency: &str) -> Option<&'static Pattern> {
    PATTERNS
        .iter()
        .find(|(code, _)| *code == currency)
        .map(|(_, pattern)| pattern)
}

/// Insert `pattern`'s group separator into a run of ASCII digits. Grouping runs
/// right to left, so only the leading group is short.
fn group_digits(digits: &str, pattern: &Pattern) -> String {
    if digits.len() < pattern.group_from {
        return digits.to_string();
    }
    let mut groups: Vec<&str> = Vec::new();
    let mut end = digits.len();
    let mut size = 3;
    while end > 0 {
        let start = end.saturating_sub(size);
        groups.push(&digits[start..end]);
        end = start;
        if pattern.grouping == Grouping::Indic {
            size = 2;
        }
    }
    groups.reverse();
    groups.join(pattern.group)
}

/// The amount as the client's invoice shows it: the currency's symbol and
/// separators, grouped digits, and the currency's own number of decimals —
/// `$1,500.00`, `1 500,00 kr`, `￥150,000`, `BHD 1,500.000`.
///
/// A negative amount carries its sign once, in front of the whole rendering
/// (the `-15.-50` bug #321 fixed in `Display`). Nothing in Cairn produces one
/// today, so the sign deliberately does not chase each locale's own placement
/// of it; it is simply unambiguous.
pub fn format(amount: &Money) -> String {
    let exponent = currency::exponent(&amount.currency);
    let listed = pattern_for(&amount.currency);
    let pattern = listed.unwrap_or(&FALLBACK);

    // Unsigned so `i64::MIN` can be split without overflowing on negation.
    let absolute = amount.minor_units.unsigned_abs();
    let per_major = 10_u64.pow(exponent);

    let mut out = String::new();
    if amount.minor_units < 0 {
        out.push('-');
    }
    match listed {
        Some(_) => out.push_str(pattern.prefix),
        // No symbol to show, so the code leads instead — `Intl`'s own fallback.
        None => {
            out.push_str(&amount.currency);
            out.push('\u{a0}');
        }
    }
    out.push_str(&group_digits(&(absolute / per_major).to_string(), pattern));
    if exponent > 0 {
        out.push_str(pattern.decimal);
        out.push_str(&format!(
            "{:0width$}",
            absolute % per_major,
            width = exponent as usize
        ));
    }
    out.push_str(pattern.suffix);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The pinned `Intl` output this module is checked against. The companion
    /// `scripts/invoice-money-drift.test.mjs` checks the fixture itself is
    /// still what a live `Intl` produces.
    const FIXTURE: &str = include_str!("money_locale_fixture.json");

    #[derive(serde::Deserialize)]
    struct Fixture {
        currencies: Vec<FixtureCurrency>,
    }

    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct FixtureCurrency {
        currency: String,
        locale: String,
        amounts: Vec<FixtureAmount>,
    }

    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct FixtureAmount {
        minor_units: i64,
        formatted: String,
    }

    /// Collapse the space variants ICU moves between (no-break, narrow
    /// no-break, thin) to a plain space. Which of them a locale uses as a group
    /// separator is typographic churn that shifts between ICU releases; the
    /// symbol, the separators, the grouping and the decimals are what this
    /// module has to get right, and they stay compared exactly.
    fn normalize(s: &str) -> String {
        s.chars()
            .map(|c| match c {
                '\u{a0}' | '\u{202f}' | '\u{2009}' | '\u{2007}' => ' ',
                other => other,
            })
            .collect()
    }

    fn fixture() -> Fixture {
        serde_json::from_str(FIXTURE).expect("the pinned Intl fixture must parse")
    }

    /// The whole point of the module: every row renders exactly what `Intl`
    /// does in the locale the fixture names for it.
    #[test]
    fn matches_the_pinned_intl_output() {
        let fixture = fixture();
        assert!(
            fixture.currencies.len() > PATTERNS.len(),
            "the fixture must pin every pattern plus the unlisted fallback",
        );
        for currency in &fixture.currencies {
            for amount in &currency.amounts {
                let money = Money::new(amount.minor_units, &currency.currency);
                assert_eq!(
                    normalize(&format(&money)),
                    normalize(&amount.formatted),
                    "{} ({}) at {} minor units",
                    currency.currency,
                    currency.locale,
                    amount.minor_units,
                );
            }
        }
    }

    #[test]
    fn renders_the_symbol_grouping_and_separators_of_the_currency() {
        // A prefix symbol with no space, and a suffix one with a no-break space.
        assert_eq!(format(&Money::new(150_000, "USD")), "$1,500.00");
        assert_eq!(format(&Money::new(150_000, "EUR")), "1.500,00\u{a0}€");
        assert_eq!(format(&Money::new(150_000, "NOK")), "1\u{a0}500,00\u{a0}kr");
        // The code is canonicalized on the way in, so a sloppy one still hits
        // its row rather than the fallback.
        assert_eq!(format(&Money::new(150_000, " usd ")), "$1,500.00");
    }

    #[test]
    fn keeps_the_currencys_own_number_of_decimals() {
        // 0-decimal: a yen amount is whole, and still grouped.
        assert_eq!(format(&Money::new(150_000, "JPY")), "￥150,000");
        assert_eq!(format(&Money::new(0, "JPY")), "￥0");
        // 3-decimal: all three digits survive, padded.
        assert_eq!(format(&Money::new(1_500_000, "BHD")), "BHD\u{a0}1,500.000");
        assert_eq!(format(&Money::new(5, "BHD")), "BHD\u{a0}0.005");
        // 2-decimal padding.
        assert_eq!(format(&Money::new(5, "USD")), "$0.05");
        assert_eq!(format(&Money::new(100_005, "USD")), "$1,000.05");
    }

    #[test]
    fn groups_indian_amounts_two_at_a_time() {
        assert_eq!(format(&Money::new(15_000_000, "INR")), "₹1,50,000.00");
        assert_eq!(format(&Money::new(123_456_789, "INR")), "₹12,34,567.89");
        // Below the first group boundary nothing is inserted.
        assert_eq!(format(&Money::new(99_900, "INR")), "₹999.00");
    }

    #[test]
    fn leaves_four_digits_unbroken_where_the_locale_does() {
        // pl-PL groups only from five digits up (minimumGroupingDigits=2).
        assert_eq!(format(&Money::new(150_000, "PLN")), "1500,00\u{a0}zł");
        assert_eq!(
            format(&Money::new(1_500_000, "PLN")),
            "15\u{a0}000,00\u{a0}zł"
        );
        // Where the locale doesn't say so, four digits are grouped.
        assert_eq!(format(&Money::new(150_000, "CZK")), "1\u{a0}500,00\u{a0}Kč");
    }

    #[test]
    fn falls_back_to_the_code_for_an_unlisted_currency() {
        // The form that ships today, with grouping added.
        assert_eq!(format(&Money::new(150_000, "AED")), "AED\u{a0}1,500.00");
        // An unknown code shows through at the commonest scale rather than
        // failing — same contract as `currency::exponent`.
        assert_eq!(format(&Money::new(150_000, "ZZZ")), "ZZZ\u{a0}1,500.00");
    }

    /// The #321 invariant: one sign, in front, at every scale — never the
    /// `-15.-50` a `/` and `%` split would print.
    #[test]
    fn carries_a_negative_sign_once() {
        assert_eq!(format(&Money::new(-1_550, "USD")), "-$15.50");
        assert_eq!(format(&Money::new(-5, "USD")), "-$0.05");
        assert_eq!(format(&Money::new(-150_000, "JPY")), "-￥150,000");
        assert_eq!(format(&Money::new(-15_505, "BHD")), "-BHD\u{a0}15.505");
        assert_eq!(format(&Money::new(-150_000, "EUR")), "-1.500,00\u{a0}€");
    }

    /// `i64::MIN` has no positive counterpart, so the sign has to come off the
    /// unsigned magnitude rather than from negating the value.
    #[test]
    fn survives_the_extreme_amounts() {
        assert_eq!(
            format(&Money::new(i64::MIN, "USD")),
            "-$92,233,720,368,547,758.08"
        );
        assert_eq!(
            format(&Money::new(i64::MAX, "USD")),
            "$92,233,720,368,547,758.07"
        );
    }

    #[test]
    fn pattern_for_matches_only_a_listed_code() {
        assert!(pattern_for("USD").is_some());
        assert!(pattern_for("ZZZ").is_none());
        // The table is matched on the canonical form only — `Money` guarantees
        // it, so a lower-case code reaching here would be a bug upstream.
        assert!(pattern_for("usd").is_none());
    }

    #[test]
    fn the_table_holds_no_duplicate_currency() {
        let mut codes: Vec<&str> = PATTERNS.iter().map(|(code, _)| *code).collect();
        codes.sort_unstable();
        let total = codes.len();
        codes.dedup();
        assert_eq!(codes.len(), total, "a currency is listed twice");
    }
}
