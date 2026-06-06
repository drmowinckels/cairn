//! Filling request templates by **value substitution only**. The literal
//! text of a template is copied verbatim; each `{{var}}` is replaced by a
//! context value, escaped for where it lands — so a value can never inject
//! request *structure* (a path separator, a query delimiter, a JSON
//! break-out). See `docs/PM_CONNECTORS.md`.

use std::collections::BTreeMap;

use anyhow::{anyhow, bail, Result};
use percent_encoding::{utf8_percent_encode, NON_ALPHANUMERIC};

/// The values a request template may reference (`{{project.id}}`,
/// `{{cursor}}`, `{{offset}}`).
#[derive(Default)]
pub(super) struct Context {
    vars: BTreeMap<&'static str, String>,
}

impl Context {
    pub(super) fn new() -> Self {
        Self::default()
    }

    pub(super) fn set(&mut self, key: &'static str, value: impl Into<String>) -> &mut Self {
        self.vars.insert(key, value.into());
        self
    }

    fn get(&self, key: &str) -> Option<&str> {
        self.vars.get(key).map(String::as_str)
    }
}

/// How a substituted value is escaped for its sink.
#[derive(Clone, Copy)]
pub(super) enum Escape {
    /// Percent-encode every non-alphanumeric byte (path segments).
    Url,
    /// JSON-string-escape (GraphQL / JSON bodies).
    Json,
    /// No escaping, but reject control characters (header values, and
    /// query values that a URL serializer will encode afterwards).
    Raw,
}

/// Fill `{{var}}` placeholders in `template` from `ctx`, escaping each
/// substituted value per `escape`. Errors on an unterminated placeholder,
/// an unknown variable, or (for `Raw`) a value containing a control byte.
pub(super) fn fill(template: &str, ctx: &Context, escape: Escape) -> Result<String> {
    let mut out = String::with_capacity(template.len());
    let mut rest = template;
    while let Some(start) = rest.find("{{") {
        out.push_str(&rest[..start]);
        let after = &rest[start + 2..];
        let end = after
            .find("}}")
            .ok_or_else(|| anyhow!("unterminated template placeholder"))?;
        let name = after[..end].trim();
        let value = ctx
            .get(name)
            .ok_or_else(|| anyhow!("unknown template variable {{{{{name}}}}}"))?;
        out.push_str(&escape_value(value, escape)?);
        rest = &after[end + 2..];
    }
    out.push_str(rest);
    Ok(out)
}

fn escape_value(value: &str, escape: Escape) -> Result<String> {
    Ok(match escape {
        Escape::Url => utf8_percent_encode(value, NON_ALPHANUMERIC).to_string(),
        Escape::Json => {
            // `to_string` of a string yields `"\"...escaped...\""`; strip
            // the surrounding quotes to get the value for insertion.
            let quoted = serde_json::to_string(value)?;
            quoted[1..quoted.len() - 1].to_string()
        }
        Escape::Raw => {
            if value.bytes().any(|b| b < 0x20) {
                bail!("template value contains a control character");
            }
            value.to_string()
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ctx() -> Context {
        let mut c = Context::new();
        c.set("project.id", "a b/c").set("cursor", "");
        c
    }

    #[test]
    fn copies_literals_and_substitutes_vars() {
        let out = fill("/boards/{{project.id}}/cards", &ctx(), Escape::Url).unwrap();
        assert_eq!(out, "/boards/a%20b%2Fc/cards", "value is percent-encoded");
    }

    #[test]
    fn empty_value_substitutes_to_nothing() {
        assert_eq!(
            fill("page={{cursor}}", &ctx(), Escape::Raw).unwrap(),
            "page="
        );
    }

    #[test]
    fn json_escape_neutralizes_quotes() {
        let mut c = Context::new();
        c.set("project.id", "a\"b\\c");
        let out = fill("{\"id\":\"{{project.id}}\"}", &c, Escape::Json).unwrap();
        assert_eq!(out, "{\"id\":\"a\\\"b\\\\c\"}");
    }

    #[test]
    fn raw_rejects_control_characters() {
        let mut c = Context::new();
        c.set("project.id", "a\nb");
        assert!(fill("{{project.id}}", &c, Escape::Raw).is_err());
    }

    #[test]
    fn unknown_variable_errors() {
        let err = fill("{{nope}}", &ctx(), Escape::Raw).unwrap_err();
        assert!(err.to_string().contains("nope"));
    }

    #[test]
    fn unterminated_placeholder_errors() {
        assert!(fill("{{project.id", &ctx(), Escape::Raw).is_err());
    }

    #[test]
    fn template_without_placeholders_is_verbatim() {
        assert_eq!(fill("/projects", &ctx(), Escape::Url).unwrap(), "/projects");
    }

    #[test]
    fn a_substituted_value_is_not_re_expanded() {
        // A value that itself contains `{{...}}` must emit it literally, not
        // re-expand (which would also be an "unknown variable" error).
        let mut c = Context::new();
        c.set("cursor", "{{project.id}}");
        assert_eq!(
            fill("x={{cursor}}", &c, Escape::Raw).unwrap(),
            "x={{project.id}}"
        );
    }

    #[test]
    fn json_escape_handles_newlines_and_unicode() {
        let mut c = Context::new();
        c.set("project.id", "a\nb→c");
        assert_eq!(fill("{{project.id}}", &c, Escape::Json).unwrap(), "a\\nb→c");
    }
}
