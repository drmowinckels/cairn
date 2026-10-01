//! An amount and the currency that tells you what it means (#321).
//!
//! Billing money used to travel as a bare `i64` next to a separate
//! `currency: String`, paired by convention. That is the exact shape of the
//! bug #320 fixed: a `*_cents` integer whose "cents" implicitly meant ÷100
//! until a currency came along where it didn't. Convention cost one round of
//! rework; the guard against a second is a type.
//!
//! So [`Money`] carries both halves, and everything that needs the scale —
//! formatting, hourly billing, tax — is a method on it rather than something
//! each call site must remember to look up in [`super::currency`]. Two
//! amounts in different currencies cannot be added: [`Money::checked_add`]
//! returns an error, and there is no infallible `+`.

use std::fmt;

use serde::{Deserialize, Serialize};

use super::currency;

/// An integer amount in the minor units of its own currency — 150000 "JPY" is
/// ¥150,000, 150000 "USD" is $1,500.00, and the type is what keeps those
/// apart. The currency is always a canonical (trimmed, upper-cased) ISO 4217
/// code: [`Money::new`] enforces it and deserializing goes through `new`, so a
/// payload from the webview can't produce a value that breaks the invariant.
/// Validating that the code is a *known* one is the caller's job (see
/// `rates::set_rate`); an unknown code falls back to the commonest scale rather
/// than failing.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", from = "MoneyWire")]
pub struct Money {
    pub minor_units: i64,
    pub currency: String,
}

/// The wire shape `Money` deserializes through, so an incoming currency code is
/// canonicalized by [`Money::new`] instead of landing in the struct verbatim.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct MoneyWire {
    minor_units: i64,
    currency: String,
}

impl From<MoneyWire> for Money {
    fn from(w: MoneyWire) -> Self {
        Money::new(w.minor_units, &w.currency)
    }
}

/// Why two amounts couldn't be combined.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum MoneyError {
    /// There is no exchange rate in Cairn and there never will be: an amount in
    /// one currency and an amount in another are not addable quantities, so
    /// this is an error rather than a silently wrong number.
    #[error("an amount in {left} can't be combined with one in {right}")]
    CurrencyMismatch { left: String, right: String },
    /// The result doesn't fit in a signed 64-bit count of minor units. Only a
    /// nonsensical rate or tax rate can get here, but wrapping would turn a
    /// huge total into a plausible-looking negative one, which is worse than
    /// refusing it.
    #[error("the amount is too large to represent in {currency}")]
    Overflow { currency: String },
}

impl Money {
    /// An amount in `currency`'s minor units. The code is canonicalized, so
    /// `" jpy "` and `"JPY"` produce equal values.
    pub fn new(minor_units: i64, currency: &str) -> Self {
        Self {
            minor_units,
            currency: currency.trim().to_ascii_uppercase(),
        }
    }

    /// The same amount with a different figure, in the same currency.
    fn with_minor_units(&self, minor_units: i64) -> Money {
        Money {
            minor_units,
            currency: self.currency.clone(),
        }
    }

    fn overflow(&self) -> MoneyError {
        MoneyError::Overflow {
            currency: self.currency.clone(),
        }
    }

    /// This amount plus `other` — the only way to add two `Money` values, and
    /// checked in both senses the name implies: the currencies must match, and
    /// the sum must fit.
    pub fn checked_add(&self, other: &Money) -> Result<Money, MoneyError> {
        if self.currency != other.currency {
            return Err(MoneyError::CurrencyMismatch {
                left: self.currency.clone(),
                right: other.currency.clone(),
            });
        }
        self.minor_units
            .checked_add(other.minor_units)
            .map(|n| self.with_minor_units(n))
            .ok_or_else(|| self.overflow())
    }

    /// Bill this amount as an hourly rate over a span: amount × seconds ÷
    /// 3600, in the same currency. The rate's currency travels with the
    /// result, so a priced line can't lose track of what it's priced in.
    pub fn bill_hourly(&self, seconds: i64) -> Result<Money, MoneyError> {
        self.scaled_by(i128::from(seconds), 3_600)
    }

    /// `bps` basis points of this amount as a tax line, and the gross it
    /// produces — returned together because they share a currency by
    /// construction, which is what lets the total be built without a
    /// currency mismatch that could never happen.
    pub fn with_tax_bps(&self, bps: i64) -> Result<(Money, Money), MoneyError> {
        let tax = self.scaled_by(i128::from(bps), 10_000)?;
        let total = self.checked_add(&tax)?;
        Ok((tax, total))
    }

    /// This amount × `factor` ÷ `denom`, rounded to a whole minor unit half
    /// away from zero — the shape both hourly billing and tax take.
    ///
    /// Exact `i128` rather than `f64`: this is the chokepoint every priced
    /// amount in the app goes through, and a float can't hold a whole minor
    /// unit above 2^53. A result that wouldn't fit in `i64` is refused, not
    /// clamped, so no operation on `Money` can quietly invent a figure.
    fn scaled_by(&self, factor: i128, denom: i128) -> Result<Money, MoneyError> {
        let scaled = i128::from(self.minor_units) * factor;
        // Double both sides and bias by `denom` — half of the doubled divisor —
        // so truncation lands on the nearer unit, ties away from zero.
        let rounded = if scaled < 0 {
            (scaled * 2 - denom) / (denom * 2)
        } else {
            (scaled * 2 + denom) / (denom * 2)
        };
        i64::try_from(rounded)
            .map(|n| self.with_minor_units(n))
            .map_err(|_| self.overflow())
    }
}

/// `<code> <amount>` with the currency's own number of decimals — `JPY
/// 150000`, `USD 1500.00`, `KWD 15.505`. The sign is carried once, in front
/// of the whole number: splitting a negative amount with `/` and `%` would
/// print it twice (`USD -15.-50`), since both truncate toward zero.
impl fmt::Display for Money {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let exp = currency::exponent(&self.currency);
        if exp == 0 {
            return write!(f, "{} {}", self.currency, self.minor_units);
        }
        let per_major = 10_u64.pow(exp);
        // Unsigned so `i64::MIN` can be split without overflowing on negation.
        let abs = self.minor_units.unsigned_abs();
        write!(
            f,
            "{} {}{}.{:0width$}",
            self.currency,
            if self.minor_units < 0 { "-" } else { "" },
            abs / per_major,
            abs % per_major,
            width = exp as usize,
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn new_canonicalizes_the_currency_code() {
        assert_eq!(Money::new(1, " jpy "), Money::new(1, "JPY"));
        assert_eq!(Money::new(1, "jpy").currency, "JPY");
    }

    #[test]
    fn checked_add_sums_one_currency() {
        let a = Money::new(1_500, "USD");
        let b = Money::new(250, "USD");
        assert_eq!(a.checked_add(&b).unwrap(), Money::new(1_750, "USD"));
        assert_eq!(Money::new(0, "USD").checked_add(&a).unwrap(), a);
    }

    #[test]
    fn checked_add_refuses_two_currencies() {
        let err = Money::new(100, "USD")
            .checked_add(&Money::new(100, "EUR"))
            .expect_err("mixing currencies must not silently produce a number");
        assert_eq!(
            err,
            MoneyError::CurrencyMismatch {
                left: "USD".into(),
                right: "EUR".into(),
            }
        );
        assert_eq!(
            err.to_string(),
            "an amount in USD can't be combined with one in EUR"
        );
    }

    /// Wrapping would turn a vast total into a plausible-looking negative one,
    /// which an invoice would then print as fact.
    #[test]
    fn checked_add_refuses_a_sum_that_doesnt_fit() {
        let err = Money::new(i64::MAX, "USD")
            .checked_add(&Money::new(1, "USD"))
            .expect_err("an overflowing sum must not wrap");
        assert_eq!(
            err,
            MoneyError::Overflow {
                currency: "USD".into()
            }
        );
        assert_eq!(
            err.to_string(),
            "the amount is too large to represent in USD"
        );
        // And in the other direction.
        assert!(Money::new(i64::MIN, "USD")
            .checked_add(&Money::new(-1, "USD"))
            .is_err());
    }

    #[test]
    fn bill_hourly_prices_a_span_and_keeps_the_currency() {
        // $150/hr for 90 min = $225.00; 20 min at $30/hr = $10.00.
        assert_eq!(
            Money::new(15_000, "USD").bill_hourly(90 * 60).unwrap(),
            Money::new(22_500, "USD")
        );
        assert_eq!(
            Money::new(3_000, "USD").bill_hourly(20 * 60).unwrap(),
            Money::new(1_000, "USD")
        );
        // The currency rides along rather than being re-attached downstream.
        assert_eq!(
            Money::new(15_000, "JPY")
                .bill_hourly(3600)
                .unwrap()
                .currency,
            "JPY"
        );
    }

    #[test]
    fn bill_hourly_rounds_to_the_nearest_minor_unit() {
        // 1 second of a ¥1/hr rate is far below a whole yen: rounds to 0.
        assert_eq!(Money::new(1, "JPY").bill_hourly(1).unwrap().minor_units, 0);
        // 1801 seconds of $1.00/hr is 50.03 cents → 50.
        assert_eq!(
            Money::new(100, "USD")
                .bill_hourly(1801)
                .unwrap()
                .minor_units,
            50
        );
        // A zero-length span bills nothing.
        assert_eq!(
            Money::new(15_000, "USD")
                .bill_hourly(0)
                .unwrap()
                .minor_units,
            0
        );
    }

    /// The amount a float would get wrong: above 2^53 an `f64` can't hold a
    /// whole minor unit, so an exact rate would bill a few units off.
    #[test]
    fn bill_hourly_is_exact_beyond_the_float_precision_cliff() {
        let minor = (1_i64 << 53) + 1;
        assert_eq!(
            Money::new(minor, "USD").bill_hourly(3600).unwrap(),
            Money::new(minor, "USD"),
            "one hour of a rate bills exactly the rate",
        );
    }

    #[test]
    fn bill_hourly_rounds_ties_away_from_zero() {
        // 1800 s of a 1-unit hourly rate is exactly half a minor unit.
        assert_eq!(
            Money::new(1, "USD").bill_hourly(1800).unwrap().minor_units,
            1
        );
        assert_eq!(
            Money::new(-1, "USD").bill_hourly(1800).unwrap().minor_units,
            -1
        );
    }

    /// Only a nonsensical rate reaches this. Refusing it rather than clamping
    /// is what keeps a saturated figure from being persisted as fact when it is
    /// the invoice's only line and no later add would notice.
    #[test]
    fn bill_hourly_refuses_an_amount_that_doesnt_fit() {
        assert_eq!(
            Money::new(i64::MAX, "USD").bill_hourly(3600 * 1000),
            Err(MoneyError::Overflow {
                currency: "USD".into()
            }),
        );
        assert!(Money::new(i64::MIN, "USD")
            .bill_hourly(3600 * 1000)
            .is_err());
    }

    #[test]
    fn with_tax_bps_returns_the_tax_and_the_gross() {
        let (tax, total) = Money::new(10_000, "USD").with_tax_bps(2_500).unwrap();
        assert_eq!(tax, Money::new(2_500, "USD")); // 25% of $100
        assert_eq!(total, Money::new(12_500, "USD"));

        let (tax, total) = Money::new(10_000, "USD").with_tax_bps(0).unwrap();
        assert_eq!(tax.minor_units, 0);
        assert_eq!(total, Money::new(10_000, "USD"));
    }

    /// `tax_rate_bps` has no upper bound at the DB or the form, so an absurd
    /// one must surface as a refused invoice rather than a wrapped total that
    /// renders as a believable negative figure.
    #[test]
    fn with_tax_bps_refuses_a_tax_or_gross_that_doesnt_fit() {
        // The tax itself overflows.
        assert_eq!(
            Money::new(15_000, "USD").with_tax_bps(i64::MAX),
            Err(MoneyError::Overflow {
                currency: "USD".into()
            }),
        );
        // The tax fits but the gross doesn't.
        assert_eq!(
            Money::new(i64::MAX, "USD").with_tax_bps(10_000),
            Err(MoneyError::Overflow {
                currency: "USD".into()
            }),
        );
    }

    #[test]
    fn with_tax_bps_rounds_half_away_from_zero() {
        // 0.5 of a minor unit rounds up, so the gross stays subtotal + tax.
        let (tax, total) = Money::new(1, "USD").with_tax_bps(5_000).unwrap();
        assert_eq!(tax.minor_units, 1);
        assert_eq!(total.minor_units, 2);
        let (tax, total) = Money::new(-1, "USD").with_tax_bps(5_000).unwrap();
        assert_eq!(tax.minor_units, -1);
        assert_eq!(total.minor_units, -2);
    }

    #[test]
    fn display_uses_the_currencys_own_decimals() {
        assert_eq!(Money::new(150_000, "USD").to_string(), "USD 1500.00");
        assert_eq!(Money::new(5, "USD").to_string(), "USD 0.05");
        // The bug this module's scale table exists for: a yen amount is whole.
        assert_eq!(Money::new(150_000, "JPY").to_string(), "JPY 150000");
        assert_eq!(Money::new(0, "JPY").to_string(), "JPY 0");
        // And a dinar keeps all three of its digits.
        assert_eq!(Money::new(15_505, "KWD").to_string(), "KWD 15.505");
        assert_eq!(Money::new(5, "KWD").to_string(), "KWD 0.005");
    }

    #[test]
    fn display_pads_the_minor_part() {
        assert_eq!(Money::new(1_000, "USD").to_string(), "USD 10.00");
        assert_eq!(Money::new(1_005, "USD").to_string(), "USD 10.05");
        assert_eq!(Money::new(10_050, "KWD").to_string(), "KWD 10.050");
        assert_eq!(Money::new(10_005, "KWD").to_string(), "KWD 10.005");
    }

    #[test]
    fn display_trims_the_code_and_survives_an_unknown_one() {
        assert_eq!(Money::new(150, " usd ").to_string(), "USD 1.50");
        // An unknown code shows through at the commonest scale.
        assert_eq!(Money::new(150, "ZZZ").to_string(), "ZZZ 1.50");
    }

    /// Nothing in Cairn produces a negative amount today — there are no credit
    /// notes or discounts — but the formatter is where a sign has to be
    /// impossible to print twice, so it is pinned at every scale.
    #[test]
    fn display_carries_a_negative_sign_once() {
        assert_eq!(Money::new(-1_550, "USD").to_string(), "USD -15.50");
        assert_eq!(Money::new(-5, "USD").to_string(), "USD -0.05");
        assert_eq!(Money::new(-15_505, "BHD").to_string(), "BHD -15.505");
        assert_eq!(Money::new(-150_000, "JPY").to_string(), "JPY -150000");
    }

    #[test]
    fn display_survives_the_extreme_amounts() {
        assert_eq!(
            Money::new(i64::MIN, "USD").to_string(),
            "USD -92233720368547758.08"
        );
        assert_eq!(
            Money::new(i64::MAX, "USD").to_string(),
            "USD 92233720368547758.07"
        );
    }

    #[test]
    fn serializes_to_the_camel_case_the_frontend_mirrors() {
        let json = serde_json::to_string(&Money::new(15_000, "USD")).unwrap();
        assert_eq!(json, r#"{"minorUnits":15000,"currency":"USD"}"#);
        let back: Money = serde_json::from_str(&json).unwrap();
        assert_eq!(back, Money::new(15_000, "USD"));
    }

    /// The webview is the one untrusted producer of a `Money`, so the
    /// canonical-code invariant has to hold on the way in — not just when the
    /// constructor happens to be used.
    #[test]
    fn deserializing_canonicalizes_the_currency_code() {
        let wire = r#"{"minorUnits":150,"currency":" usd "}"#;
        let m: Money = serde_json::from_str(wire).unwrap();
        assert_eq!(m, Money::new(150, "USD"));
        // Which is what keeps a round trip from reading as two currencies.
        assert!(m.checked_add(&Money::new(1, "USD")).is_ok());
    }
}
