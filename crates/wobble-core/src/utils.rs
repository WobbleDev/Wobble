//! Shared JSON helpers: record checks, uniqueness checks, and parsing stored JSON with a caller-supplied error message.

use std::collections::HashSet;
use std::hash::Hash;

use serde_json::Value;

use crate::error::{Error, Result};

/// `isRecord`: plain objects only — arrays and null are not records.
pub fn is_record(value: &Value) -> bool {
    matches!(value, Value::Object(_))
}

/// `hasUniqueValues`: strict identity, so any duplicate makes the list non-unique.
pub fn has_unique_values<T: Eq + Hash>(values: &[T]) -> bool {
    let mut seen = HashSet::with_capacity(values.len());
    values.iter().all(|value| seen.insert(value))
}

/// `parseStoredJson`: parses a stored JSON column, blaming the caller's message.
/// The TS `{ cause }` is never observable in an HTTP response, so it is dropped.
pub fn parse_stored_json(value: &str, error_message: &str) -> Result<Value> {
    serde_json::from_str(value).map_err(|_| Error::Message(error_message.to_owned()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn has_unique_values_reports_duplicates_by_strict_identity() {
        assert!(has_unique_values(&["a", "b"]));
        assert!(!has_unique_values(&["a", "a"]));
        assert!(has_unique_values::<&str>(&[]));
    }

    #[test]
    fn is_record_accepts_plain_objects_only() {
        assert!(is_record(&json!({})));
        assert!(!is_record(&json!([])));
        assert!(!is_record(&Value::Null));
        assert!(!is_record(&json!("w01")));
    }

    #[test]
    fn parse_stored_json_parses_valid_json() {
        assert_eq!(
            parse_stored_json("{\"a\":1}", "Invalid JSON.").unwrap(),
            json!({ "a": 1 })
        );
    }

    #[test]
    fn parse_stored_json_throws_the_callers_message_and_drops_the_cause() {
        let error = parse_stored_json("{", "Invalid notes JSON.").unwrap_err();

        assert!(matches!(error, Error::Message(message) if message == "Invalid notes JSON."));
    }
}
