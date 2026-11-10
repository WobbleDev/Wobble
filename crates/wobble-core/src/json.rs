//! Canonical JSON — the D6 normalizer (scenario-runner.ts::normalize).

use serde_json::Value;
use std::collections::BTreeMap;

/// Sorts object keys recursively and pins schema_migrations.applied_at to "$t",
/// exactly as the TypeScript normalizer does. Arrays keep their order.
pub fn normalize(value: &mut Value) {
    normalize_keyed(value, "");
}

fn normalize_keyed(value: &mut Value, key: &str) {
    match value {
        Value::Array(items) => {
            for item in items.iter_mut() {
                normalize_keyed(item, "");
            }
        }
        Value::Object(map) => {
            let mut sorted = BTreeMap::new();
            for (name, child) in map.iter_mut() {
                normalize_keyed(child, name);
                sorted.insert(name.clone(), child.take());
            }
            *map = sorted.into_iter().collect();
        }
        _ => {
            if key == "applied_at" {
                *value = Value::String("$t".to_owned());
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn sorts_object_keys_recursively() {
        let mut value = json!({ "z": 1, "a": { "y": 2, "b": 3 } });
        normalize(&mut value);
        assert_eq!(value, json!({ "a": { "b": 3, "y": 2 }, "z": 1 }));
    }

    #[test]
    fn leaves_array_order_alone() {
        let mut value = json!([{ "b": 1, "a": 2 }]);
        normalize(&mut value);
        assert_eq!(value, json!([{ "a": 2, "b": 1 }]));
    }

    #[test]
    fn pins_applied_at() {
        let mut value = json!({ "applied_at": "2026-01-01", "name": "x" });
        normalize(&mut value);
        assert_eq!(value, json!({ "applied_at": "$t", "name": "x" }));
    }
}
