//! Reading values out of a JSON response by **dotted path**. See
//! `docs/PM_CONNECTORS.md`. Object keys only (`a.b.c`) — enough for every
//! REST and GraphQL list response, and small enough to audit.

use serde_json::Value;

/// Walk a JSON value by a dotted path. `""` returns the value itself;
/// otherwise each segment indexes an object key. `None` if any segment is
/// missing or a non-object is traversed.
pub(super) fn dotted<'a>(value: &'a Value, path: &str) -> Option<&'a Value> {
    if path.is_empty() {
        return Some(value);
    }
    let mut current = value;
    for key in path.split('.') {
        current = current.get(key)?;
    }
    Some(current)
}

/// The array of items at `path`. Errors if the path is missing or doesn't
/// point at an array.
pub(super) fn items<'a>(body: &'a Value, path: &str) -> anyhow::Result<&'a Vec<Value>> {
    match dotted(body, path) {
        Some(Value::Array(array)) => Ok(array),
        Some(_) => anyhow::bail!("response items at {path:?} is not an array"),
        None => anyhow::bail!("response items path {path:?} not found"),
    }
}

/// A scalar rendered as a string: strings as-is, numbers/bools via their
/// JSON form. Objects, arrays, and null yield `None`.
pub(super) fn as_string(value: &Value) -> Option<String> {
    match value {
        Value::String(s) => Some(s.clone()),
        Value::Number(n) => Some(n.to_string()),
        Value::Bool(b) => Some(b.to_string()),
        _ => None,
    }
}

/// Truthiness for a `done` field: a bool as-is, a non-zero number, or a
/// non-empty string that isn't `"false"`. Missing / null / object / array
/// is false.
pub(super) fn truthy(value: Option<&Value>) -> bool {
    match value {
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().is_some_and(|f| f != 0.0),
        Some(Value::String(s)) => !s.is_empty() && !s.eq_ignore_ascii_case("false"),
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn dotted_walks_object_keys() {
        let v = json!({ "a": { "b": { "c": 42 } } });
        assert_eq!(dotted(&v, "a.b.c"), Some(&json!(42)));
        assert_eq!(dotted(&v, ""), Some(&v));
        assert_eq!(dotted(&v, "a.x"), None);
        assert_eq!(dotted(&v, "a.b.c.d"), None, "can't index into a scalar");
    }

    #[test]
    fn items_requires_an_array() {
        let v = json!({ "data": { "nodes": [1, 2, 3] } });
        assert_eq!(items(&v, "data.nodes").unwrap().len(), 3);
        assert_eq!(items(&json!([1, 2]), "").unwrap().len(), 2);
        assert!(items(&v, "data.missing").is_err());
        assert!(items(&v, "data").is_err(), "object is not an array");
    }

    #[test]
    fn as_string_renders_scalars_only() {
        assert_eq!(as_string(&json!("x")), Some("x".to_string()));
        assert_eq!(as_string(&json!(7)), Some("7".to_string()));
        assert_eq!(as_string(&json!(true)), Some("true".to_string()));
        assert_eq!(as_string(&json!(null)), None);
        assert_eq!(as_string(&json!({})), None);
        assert_eq!(as_string(&json!([1])), None);
    }

    #[test]
    fn truthy_covers_each_shape() {
        assert!(truthy(Some(&json!(true))));
        assert!(!truthy(Some(&json!(false))));
        assert!(truthy(Some(&json!(1))));
        assert!(!truthy(Some(&json!(0))));
        assert!(truthy(Some(&json!("done"))));
        assert!(!truthy(Some(&json!("false"))));
        assert!(!truthy(Some(&json!(""))));
        assert!(!truthy(Some(&json!(null))));
        assert!(!truthy(None));
        assert!(!truthy(Some(&json!({}))));
    }
}
