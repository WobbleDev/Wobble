//! Worker request decoding: turns update and patch JSON bodies into typed, validated changes.

use serde_json::Value;

use crate::phone::{normalize_phone, phone_for_whole_record_update};
use crate::serialization::{
    is_agitation_ids, is_assessment_option, is_language_ids, is_note_timestamp,
    is_worker_attribute_value, is_worker_email, is_worker_update,
};

/// `invalidWorkerUpdateMessage`: shared by the create and update routes.
const INVALID_WORKER_UPDATE_MESSAGE: &str = "Request must contain valid editable worker fields.";

/// `WorkerUpdateDecodeResult`: a validated update, or the one shared message.
#[derive(Debug, PartialEq)]
pub enum WorkerUpdateDecode {
    /// The update, with name, email, and phone trim-normalized.
    Ok { update: Value },
    /// The payload was not a valid worker update.
    Invalid { message: String },
}

pub use crate::serialization::WorkerTextField;

/// Which Note change a `field: "notes"` patch asks for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WorkerNoteAction {
    Add,
    Edit,
    Delete,
    /// Puts a deleted Note back exactly as it was, which is what its Undo sends.
    Restore,
}

impl WorkerNoteAction {
    /// The action a patch names, or `None` for anything else.
    pub fn from_action(action: &str) -> Option<Self> {
        match action {
            "add" => Some(WorkerNoteAction::Add),
            "edit" => Some(WorkerNoteAction::Edit),
            "delete" => Some(WorkerNoteAction::Delete),
            "restore" => Some(WorkerNoteAction::Restore),
            _ => None,
        }
    }
}

/// Which Relationship change a `field: "relationships"` patch asks for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WorkerRelationshipAction {
    Add,
    Remove,
}

impl WorkerRelationshipAction {
    /// The action a patch names, or `None` for anything else.
    pub fn from_action(action: &str) -> Option<Self> {
        match action {
            "add" => Some(WorkerRelationshipAction::Add),
            "remove" => Some(WorkerRelationshipAction::Remove),
            _ => None,
        }
    }
}

/// Which Agitation change a `field: "agitations"` patch with an `action` asks for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WorkerAgitationAction {
    Assign,
    Unassign,
}

impl WorkerAgitationAction {
    /// The action a patch names, or `None` for anything else.
    pub fn from_action(action: &str) -> Option<Self> {
        match action {
            "assign" => Some(WorkerAgitationAction::Assign),
            "unassign" => Some(WorkerAgitationAction::Unassign),
            _ => None,
        }
    }
}

/// `WorkerPatch`: the one shape `dispatchWorkerPatch` expects.
#[derive(Debug, PartialEq)]
pub enum WorkerPatch {
    Assessment {
        value: String,
    },
    Agitations {
        value: Vec<String>,
    },
    /// One Agitation assigned or unassigned: its id, already proved a non-empty string.
    Agitation {
        action: WorkerAgitationAction,
        value: String,
    },
    Languages {
        value: Vec<String>,
    },
    Attribute {
        attribute_id: String,
        value: Value,
    },
    /// One free-text field, already trimmed and validated.
    Text {
        field: WorkerTextField,
        value: String,
    },
    /// One Note change, with the action's own normalized payload: `{text}`
    /// for Add, `{id}` for Delete, and the whole Note for Restore.
    Note {
        action: WorkerNoteAction,
        value: Value,
    },
    /// One Relationship change: the other Worker's id, already proved a non-empty
    /// string. The core normalizes the pair, so both directions name the same row.
    Relationship {
        action: WorkerRelationshipAction,
        value: String,
    },
}

/// `WorkerPatchDecodeResult`.
#[derive(Debug, PartialEq)]
pub enum WorkerPatchDecode {
    Ok { patch: WorkerPatch },
    Invalid { message: String },
}

/// `decodeWorkerUpdate`: validates an untrusted update against the Worksite's
/// Attribute definitions, then trims the free-text fields.
pub fn decode_worker_update(value: &Value, attributes: &[Value]) -> WorkerUpdateDecode {
    if !is_worker_update(value, attributes) {
        return WorkerUpdateDecode::Invalid {
            message: INVALID_WORKER_UPDATE_MESSAGE.to_owned(),
        };
    }

    let mut update = value.clone();
    if let Some(fields) = update.as_object_mut() {
        // The guard above proved each of these is a string. Phone additionally keeps a
        // clean number in its stored shape; anything else stays trimmed, because a
        // Worker whose stored Phone predates the format must remain editable.
        for field in WorkerTextField::ALL {
            let key = field.key();
            let text = fields.get(key).and_then(Value::as_str).unwrap_or_default();
            let normalized = match field {
                WorkerTextField::Phone => phone_for_whole_record_update(text),
                _ => text.trim().to_owned(),
            };
            fields.insert(key.to_owned(), Value::String(normalized));
        }
    }

    WorkerUpdateDecode::Ok { update }
}

/// `hasOnlyKeys`: every key of the payload is allowed. A non-object (an array,
/// which the patch decoder accepts at the top) has no keys, so it passes.
fn has_only_keys(payload: &Value, allowed: &[&str]) -> bool {
    match payload {
        Value::Object(fields) => fields.keys().all(|key| allowed.contains(&key.as_str())),
        _ => true,
    }
}

/// The strings of a validated id list (non-empty strings, unique).
fn id_list(value: &Value) -> Vec<String> {
    value
        .as_array()
        .map(|ids| {
            ids.iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default()
}

/// Every rejection of a free-text field patch that is not about the value itself.
const INVALID_TEXT_FIELD_MESSAGE: &str = "Request must include a field and value.";

/// The refusal of a Phone value the strict field patch cannot store.
const INVALID_PHONE_MESSAGE: &str = "Worker phone must be a 10-digit US or Canada number.";

/// `decodeWorkerTextPatch`: one of the Worker's free-text fields, trimmed and, for
/// Name, Email and Phone, validated. Email may be emptied; a Name may not be, and a
/// Phone is empty or a complete number stored formatted.
///
/// `action: "restore"` on Phone accepts the value without validating or reformatting
/// it (the patch trims it like every text field): Undo sends the previous stored value
/// back through this same patch, and that value may predate the format.
fn decode_worker_text_patch(value: &Value) -> WorkerPatchDecode {
    let invalid = || WorkerPatchDecode::Invalid {
        message: INVALID_TEXT_FIELD_MESSAGE.to_owned(),
    };

    if !has_only_keys(value, &["field", "value", "action"]) {
        return invalid();
    }

    let Some(field) = value
        .get("field")
        .and_then(Value::as_str)
        .and_then(WorkerTextField::from_field)
    else {
        return invalid();
    };
    let Some(text) = value.get("value").and_then(Value::as_str) else {
        return invalid();
    };

    let text = text.trim();

    if value.get("action").is_some() {
        let restoring = value.get("action").and_then(Value::as_str) == Some("restore")
            && field == WorkerTextField::Phone;
        if !restoring {
            return invalid();
        }
        return WorkerPatchDecode::Ok {
            patch: WorkerPatch::Text {
                field,
                value: text.to_owned(),
            },
        };
    }

    match field {
        WorkerTextField::Name if text.is_empty() => WorkerPatchDecode::Invalid {
            message: "Worker name cannot be empty.".to_owned(),
        },
        WorkerTextField::Email if !is_worker_email(text) => WorkerPatchDecode::Invalid {
            message: "Worker email must look like an email address.".to_owned(),
        },
        WorkerTextField::Phone => match normalize_phone(text) {
            Some(value) => WorkerPatchDecode::Ok {
                patch: WorkerPatch::Text { field, value },
            },
            None => WorkerPatchDecode::Invalid {
                message: INVALID_PHONE_MESSAGE.to_owned(),
            },
        },
        _ => WorkerPatchDecode::Ok {
            patch: WorkerPatch::Text {
                field,
                value: text.to_owned(),
            },
        },
    }
}

/// Every rejection of a Note patch that is not about its text.
const INVALID_NOTE_PATCH_MESSAGE: &str = "Request must include a valid note change.";

/// `decodeWorkerNotePatch`: one Note change. Add takes `{text}` and
/// trims the text; Delete takes `{id}`; Restore takes a whole Note, whose id and
/// `timestamp` it puts back as they were. The core mints the Note's id, its
/// `timestamp` and, on an edit, its `editedAt`.
fn decode_worker_note_patch(payload: &Value) -> WorkerPatchDecode {
    let invalid = || WorkerPatchDecode::Invalid {
        message: INVALID_NOTE_PATCH_MESSAGE.to_owned(),
    };

    if !has_only_keys(payload, &["field", "action", "value"]) {
        return invalid();
    }

    let Some(action) = payload
        .get("action")
        .and_then(Value::as_str)
        .and_then(WorkerNoteAction::from_action)
    else {
        return invalid();
    };
    let Some(value) = payload.get("value").and_then(Value::as_object) else {
        return invalid();
    };

    match action {
        WorkerNoteAction::Add => {
            if value.keys().any(|key| !matches!(key.as_str(), "text")) {
                return invalid();
            }

            let Some(text) = value.get("text").and_then(Value::as_str) else {
                return invalid();
            };
            let text = text.trim();
            if text.is_empty() {
                return WorkerPatchDecode::Invalid {
                    message: "A note needs text.".to_owned(),
                };
            }

            WorkerPatchDecode::Ok {
                patch: WorkerPatch::Note {
                    action,
                    value: serde_json::json!({ "text": text }),
                },
            }
        }
        WorkerNoteAction::Edit => {
            if value
                .keys()
                .any(|key| !matches!(key.as_str(), "id" | "text" | "editedAt"))
            {
                return invalid();
            }

            let Some(id) = value
                .get("id")
                .and_then(Value::as_str)
                .filter(|id| !id.is_empty())
            else {
                return invalid();
            };
            let Some(text) = value.get("text").and_then(Value::as_str) else {
                return invalid();
            };
            let text = text.trim();
            if text.is_empty() {
                return WorkerPatchDecode::Invalid {
                    message: "A note needs text.".to_owned(),
                };
            }

            let mut decoded = serde_json::json!({ "id": id, "text": text });
            // `editedAt` is sent only by an Undo, which puts back the Note's earlier
            // edit time exactly (or `null` for a Note never edited before).
            if let Some(edited_at) = value.get("editedAt") {
                match edited_at {
                    Value::Null => {}
                    Value::String(stamp) if is_note_timestamp(stamp) => {}
                    _ => return invalid(),
                }
                decoded["editedAt"] = edited_at.clone();
            }

            WorkerPatchDecode::Ok {
                patch: WorkerPatch::Note {
                    action,
                    value: decoded,
                },
            }
        }
        WorkerNoteAction::Delete => {
            if value.keys().any(|key| key.as_str() != "id") {
                return invalid();
            }

            let Some(id) = value.get("id").and_then(Value::as_str) else {
                return invalid();
            };
            if id.is_empty() {
                return invalid();
            }

            WorkerPatchDecode::Ok {
                patch: WorkerPatch::Note {
                    action,
                    value: serde_json::json!({ "id": id }),
                },
            }
        }
        WorkerNoteAction::Restore => {
            if value
                .keys()
                .any(|key| !matches!(key.as_str(), "id" | "text" | "timestamp" | "editedAt"))
            {
                return invalid();
            }

            let Some(id) = value
                .get("id")
                .and_then(Value::as_str)
                .filter(|id| !id.is_empty())
            else {
                return invalid();
            };
            let Some(text) = value.get("text").and_then(Value::as_str) else {
                return invalid();
            };
            let text = text.trim();
            if text.is_empty() {
                return WorkerPatchDecode::Invalid {
                    message: "A note needs text.".to_owned(),
                };
            }
            let Some(timestamp) = value
                .get("timestamp")
                .and_then(Value::as_str)
                .filter(|stamp| is_note_timestamp(stamp))
            else {
                return invalid();
            };

            // The note is put back exactly as it was, so its written time is the
            // one the client held and its edit time comes back untouched (or
            // stays absent for a Note that was never edited).
            let mut decoded = serde_json::json!({
                "id": id,
                "text": text,
                "timestamp": timestamp,
            });
            if let Some(edited_at) = value.get("editedAt") {
                match edited_at {
                    Value::Null => {}
                    Value::String(stamp) if is_note_timestamp(stamp) => {
                        decoded["editedAt"] = edited_at.clone();
                    }
                    _ => return invalid(),
                }
            }

            WorkerPatchDecode::Ok {
                patch: WorkerPatch::Note {
                    action,
                    value: decoded,
                },
            }
        }
    }
}

/// Every rejection of a Relationship patch that is not about its pair.
const INVALID_RELATIONSHIP_PATCH_MESSAGE: &str =
    "Request must include a valid relationship change.";

/// `decodeWorkerRelationshipPatch`: one Relationship change, either direction. The
/// payload is the other Worker's id; whether that Worker exists, is not this one and
/// is not already related is the service's business, judged against the Worksite.
fn decode_worker_relationship_patch(payload: &Value) -> WorkerPatchDecode {
    let invalid = || WorkerPatchDecode::Invalid {
        message: INVALID_RELATIONSHIP_PATCH_MESSAGE.to_owned(),
    };

    if !has_only_keys(payload, &["field", "action", "value"]) {
        return invalid();
    }

    let Some(action) = payload
        .get("action")
        .and_then(Value::as_str)
        .and_then(WorkerRelationshipAction::from_action)
    else {
        return invalid();
    };
    let Some(value) = payload.get("value").and_then(Value::as_object) else {
        return invalid();
    };
    if value.keys().any(|key| key.as_str() != "id") {
        return invalid();
    }
    let Some(id) = value
        .get("id")
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())
    else {
        return invalid();
    };

    WorkerPatchDecode::Ok {
        patch: WorkerPatch::Relationship {
            action,
            value: id.to_owned(),
        },
    }
}

/// `decodeWorkerAgitationPatch`: one Agitation assigned or unassigned, as
/// `{ field, action, value: { id } }`. Whether that Agitation belongs to this Worksite is
/// the service's business.
fn decode_worker_agitation_patch(payload: &Value) -> WorkerPatchDecode {
    let invalid = || WorkerPatchDecode::Invalid {
        message: "Request must include a valid agitation change.".to_owned(),
    };

    if !has_only_keys(payload, &["field", "action", "value"]) {
        return invalid();
    }

    let Some(action) = payload
        .get("action")
        .and_then(Value::as_str)
        .and_then(WorkerAgitationAction::from_action)
    else {
        return invalid();
    };
    let Some(value) = payload.get("value").and_then(Value::as_object) else {
        return invalid();
    };
    if value.keys().any(|key| key.as_str() != "id") {
        return invalid();
    }
    let Some(id) = value
        .get("id")
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())
    else {
        return invalid();
    };

    WorkerPatchDecode::Ok {
        patch: WorkerPatch::Agitation {
            action,
            value: id.to_owned(),
        },
    }
}

/// `decodeWorkerPatch`: routes an untrusted patch to its kind, keeping each
/// kind's rejection message byte-identical to the route it replaced.
pub fn decode_worker_patch(value: &Value, attributes: &[Value]) -> WorkerPatchDecode {
    if !value.is_object() && !value.is_array() {
        return WorkerPatchDecode::Invalid {
            message: "Request must include a patch object.".to_owned(),
        };
    }

    match value.get("field").and_then(Value::as_str) {
        Some(field) if WorkerTextField::from_field(field).is_some() => {
            decode_worker_text_patch(value)
        }
        Some("notes") => decode_worker_note_patch(value),
        Some("relationships") => decode_worker_relationship_patch(value),
        Some("assessment") => {
            if !has_only_keys(value, &["field", "value"]) {
                return WorkerPatchDecode::Invalid {
                    message: "Assessment patch must contain only the field and value.".to_owned(),
                };
            }

            match value.get("value") {
                Some(assessment) if is_assessment_option(assessment) => WorkerPatchDecode::Ok {
                    patch: WorkerPatch::Assessment {
                        value: assessment.as_str().unwrap_or_default().to_owned(),
                    },
                },
                _ => WorkerPatchDecode::Invalid {
                    message: "Invalid assessment value.".to_owned(),
                },
            }
        }
        Some("agitations") if value.get("action").is_some() => decode_worker_agitation_patch(value),
        Some("agitations") => {
            let valid = value.get("value").is_some_and(is_agitation_ids);
            if !has_only_keys(value, &["field", "value"]) || !valid {
                return WorkerPatchDecode::Invalid {
                    message: "Invalid agitations value.".to_owned(),
                };
            }

            WorkerPatchDecode::Ok {
                patch: WorkerPatch::Agitations {
                    value: value.get("value").map(id_list).unwrap_or_default(),
                },
            }
        }
        Some("languages") => {
            let valid = value.get("value").is_some_and(is_language_ids);
            if !has_only_keys(value, &["field", "value"]) || !valid {
                return WorkerPatchDecode::Invalid {
                    message: "Invalid languages value.".to_owned(),
                };
            }

            WorkerPatchDecode::Ok {
                patch: WorkerPatch::Languages {
                    value: value.get("value").map(id_list).unwrap_or_default(),
                },
            }
        }
        _ => {
            if !has_only_keys(value, &["attributeId", "value"]) {
                return WorkerPatchDecode::Invalid {
                    message: "Request must include an attribute ID and value.".to_owned(),
                };
            }

            let Some(attribute_id) = value.get("attributeId").and_then(Value::as_str) else {
                return WorkerPatchDecode::Invalid {
                    message: "Request must include an attribute ID and value.".to_owned(),
                };
            };
            let Some(attribute_value) = value.get("value") else {
                return WorkerPatchDecode::Invalid {
                    message: "Request must include an attribute ID and value.".to_owned(),
                };
            };

            let attribute = attributes.iter().find(|candidate| {
                candidate.get("id").and_then(Value::as_str) == Some(attribute_id)
            });
            match attribute {
                Some(attribute) if is_worker_attribute_value(attribute_value, attribute) => {
                    WorkerPatchDecode::Ok {
                        patch: WorkerPatch::Attribute {
                            attribute_id: attribute_id.to_owned(),
                            value: attribute_value.clone(),
                        },
                    }
                }
                _ => WorkerPatchDecode::Invalid {
                    message: format!("Invalid value for worker attribute \"{attribute_id}\"."),
                },
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn department() -> Value {
        json!({
            "id": "a1",
            "name": "Department",
            "kind": "category",
            "options": [{"id": "d-foh", "value": "Front of House"}, {"id": "d-boh", "value": "Back of House"}]
        })
    }

    fn shifts() -> Value {
        json!({
            "id": "a2",
            "name": "Shifts",
            "kind": "tag",
            "options": [{"id": "s-dinner", "value": "Dinner"}, {"id": "s-brunch", "value": "Brunch"}]
        })
    }

    fn attributes() -> Vec<Value> {
        vec![department(), shifts()]
    }

    fn valid_update() -> Value {
        json!({
            "name": "  Lise Meitner  ",
            "email": "  lise.meitner@example.test ",
            "phone": "  ",
            "assessment": "Supporter",
            "attributes": { "a1": "d-foh", "a2": ["s-dinner"] },
            "agitations": ["g1"],
            "languages": [],
            "relationships": ["w02"],
            "notes": []
        })
    }

    /// The TS `{ ...validUpdate, key: value }` spread.
    fn with(update: &Value, key: &str, value: Value) -> Value {
        let mut spread = update.clone();
        spread[key] = value;
        spread
    }

    #[test]
    fn decode_worker_update_returns_the_update_with_its_free_text_fields_trimmed() {
        assert_eq!(
            decode_worker_update(&valid_update(), &attributes()),
            WorkerUpdateDecode::Ok {
                update: json!({
                    "name": "Lise Meitner",
                    "email": "lise.meitner@example.test",
                    "phone": "",
                    "assessment": "Supporter",
                    "attributes": { "a1": "d-foh", "a2": ["s-dinner"] },
                    "agitations": ["g1"],
                    "languages": [],
                    "relationships": ["w02"],
                    "notes": []
                })
            }
        );
    }

    #[test]
    fn decode_worker_update_rejects_a_payload_whose_shape_does_not_match_an_update() {
        let expected = WorkerUpdateDecode::Invalid {
            message: "Request must contain valid editable worker fields.".to_owned(),
        };

        assert_eq!(
            decode_worker_update(&with(&valid_update(), "name", json!(42)), &attributes()),
            expected
        );
        assert_eq!(
            decode_worker_update(
                &with(&valid_update(), "unexpected", json!(true)),
                &attributes()
            ),
            expected
        );
    }

    #[test]
    fn decode_worker_update_rejects_an_attribute_value_outside_the_worksite_vocabulary() {
        assert_eq!(
            decode_worker_update(
                &with(
                    &valid_update(),
                    "attributes",
                    json!({ "a1": "d-nope", "a2": ["s-dinner"] })
                ),
                &attributes()
            ),
            WorkerUpdateDecode::Invalid {
                message: "Request must contain valid editable worker fields.".to_owned(),
            }
        );
    }

    #[test]
    fn decode_worker_patch_accepts_an_assessment_patch_with_only_the_field_and_value() {
        assert_eq!(
            decode_worker_patch(
                &json!({ "field": "assessment", "value": "Supporter" }),
                &attributes()
            ),
            WorkerPatchDecode::Ok {
                patch: WorkerPatch::Assessment {
                    value: "Supporter".to_owned()
                }
            }
        );
    }

    #[test]
    fn decode_worker_patch_rejects_an_assessment_patch_with_extra_keys_or_an_unknown_value() {
        assert_eq!(
            decode_worker_patch(
                &json!({ "field": "assessment", "value": "Supporter", "extra": true }),
                &attributes()
            ),
            WorkerPatchDecode::Invalid {
                message: "Assessment patch must contain only the field and value.".to_owned()
            }
        );
        assert_eq!(
            decode_worker_patch(
                &json!({ "field": "assessment", "value": "supporter" }),
                &attributes()
            ),
            WorkerPatchDecode::Invalid {
                message: "Invalid assessment value.".to_owned()
            }
        );
    }

    #[test]
    fn decode_worker_patch_reports_a_missing_assessment_value_after_the_key_check() {
        assert_eq!(
            decode_worker_patch(&json!({ "field": "assessment" }), &attributes()),
            WorkerPatchDecode::Invalid {
                message: "Invalid assessment value.".to_owned()
            }
        );
    }

    #[test]
    fn decode_worker_patch_accepts_an_agitations_patch_and_rejects_a_malformed_one() {
        assert_eq!(
            decode_worker_patch(
                &json!({ "field": "agitations", "value": ["g1"] }),
                &attributes()
            ),
            WorkerPatchDecode::Ok {
                patch: WorkerPatch::Agitations {
                    value: vec!["g1".to_owned()]
                }
            }
        );

        let expected = WorkerPatchDecode::Invalid {
            message: "Invalid agitations value.".to_owned(),
        };
        assert_eq!(
            decode_worker_patch(
                &json!({ "field": "agitations", "value": "g1" }),
                &attributes()
            ),
            expected
        );
        assert_eq!(
            decode_worker_patch(
                &json!({ "field": "agitations", "value": ["g1", "g1"] }),
                &attributes()
            ),
            expected
        );
    }

    #[test]
    fn decode_worker_patch_accepts_an_agitation_change_and_rejects_a_malformed_one() {
        for (action, expected) in [
            ("assign", WorkerAgitationAction::Assign),
            ("unassign", WorkerAgitationAction::Unassign),
        ] {
            assert_eq!(
                decode_worker_patch(
                    &json!({ "field": "agitations", "action": action, "value": { "id": "g1" } }),
                    &attributes()
                ),
                WorkerPatchDecode::Ok {
                    patch: WorkerPatch::Agitation {
                        action: expected,
                        value: "g1".to_owned()
                    }
                },
                "{action}"
            );
        }

        let invalid = WorkerPatchDecode::Invalid {
            message: "Request must include a valid agitation change.".to_owned(),
        };
        for payload in [
            json!({ "field": "agitations", "action": "remove", "value": { "id": "g1" } }),
            json!({ "field": "agitations", "action": "assign", "value": {} }),
            json!({ "field": "agitations", "action": "assign", "value": { "id": "" } }),
            json!({ "field": "agitations", "action": "assign", "value": { "id": 7 } }),
            json!({ "field": "agitations", "action": "assign", "value": { "id": "g1", "text": "x" } }),
            json!({ "field": "agitations", "action": "assign", "value": "g1" }),
            json!({ "field": "agitations", "action": "assign", "value": { "id": "g1" }, "extra": 1 }),
        ] {
            assert_eq!(
                decode_worker_patch(&payload, &attributes()),
                invalid,
                "{payload}"
            );
        }
    }

    #[test]
    fn decode_worker_patch_accepts_a_languages_patch_and_rejects_a_malformed_one() {
        assert_eq!(
            decode_worker_patch(
                &json!({ "field": "languages", "value": ["la1"] }),
                &attributes()
            ),
            WorkerPatchDecode::Ok {
                patch: WorkerPatch::Languages {
                    value: vec!["la1".to_owned()]
                }
            }
        );

        let expected = WorkerPatchDecode::Invalid {
            message: "Invalid languages value.".to_owned(),
        };
        assert_eq!(
            decode_worker_patch(
                &json!({ "field": "languages", "value": "la1" }),
                &attributes()
            ),
            expected
        );
        assert_eq!(
            decode_worker_patch(
                &json!({ "field": "languages", "value": ["la1", "la1"] }),
                &attributes()
            ),
            expected
        );
    }

    #[test]
    fn decode_worker_patch_accepts_a_text_field_patch_with_its_value_trimmed() {
        for (field, value, expected) in [
            ("name", "  Ada Lovelace  ", "Ada Lovelace"),
            ("email", " ada@example.test ", "ada@example.test"),
            ("phone", "  (555) 010-0100  ", "(555) 010-0100"),
        ] {
            assert_eq!(
                decode_worker_patch(&json!({ "field": field, "value": value }), &attributes()),
                WorkerPatchDecode::Ok {
                    patch: WorkerPatch::Text {
                        field: WorkerTextField::from_field(field).unwrap(),
                        value: expected.to_owned()
                    }
                },
                "{field}"
            );
        }

        // An empty Email clears the field.
        assert_eq!(
            decode_worker_patch(&json!({ "field": "email", "value": "   " }), &attributes()),
            WorkerPatchDecode::Ok {
                patch: WorkerPatch::Text {
                    field: WorkerTextField::Email,
                    value: String::new()
                }
            }
        );
    }

    #[test]
    fn decode_worker_patch_rejects_an_empty_name_and_a_malformed_email() {
        assert_eq!(
            decode_worker_patch(&json!({ "field": "name", "value": "   " }), &attributes()),
            WorkerPatchDecode::Invalid {
                message: "Worker name cannot be empty.".to_owned()
            }
        );

        for email in [
            "ada",
            "ada@",
            "@example.test",
            "ada@example",
            "ada @example.test",
        ] {
            assert_eq!(
                decode_worker_patch(&json!({ "field": "email", "value": email }), &attributes()),
                WorkerPatchDecode::Invalid {
                    message: "Worker email must look like an email address.".to_owned()
                },
                "{email}"
            );
        }
    }

    #[test]
    fn decode_worker_patch_rejects_a_text_field_patch_with_extra_keys_or_a_non_string_value() {
        let expected = WorkerPatchDecode::Invalid {
            message: "Request must include a field and value.".to_owned(),
        };

        assert_eq!(
            decode_worker_patch(
                &json!({ "field": "email", "value": "a@b.test", "extra": true }),
                &attributes()
            ),
            expected
        );
        assert_eq!(
            decode_worker_patch(&json!({ "field": "email", "value": 42 }), &attributes()),
            expected
        );
        assert_eq!(
            decode_worker_patch(&json!({ "field": "email" }), &attributes()),
            expected
        );
    }

    #[test]
    fn decode_worker_patch_accepts_a_note_add_with_its_text_trimmed() {
        assert_eq!(
            decode_worker_patch(
                &json!({
                    "field": "notes",
                    "action": "add",
                    "value": { "text": "  Called back  " }
                }),
                &attributes()
            ),
            WorkerPatchDecode::Ok {
                patch: WorkerPatch::Note {
                    action: WorkerNoteAction::Add,
                    value: json!({ "text": "Called back" })
                }
            }
        );
    }

    #[test]
    fn decode_worker_patch_accepts_a_note_edit_and_its_undo() {
        assert_eq!(
            decode_worker_patch(
                &json!({ "field": "notes", "action": "edit", "value": { "id": "n1", "text": " Fixed " } }),
                &attributes()
            ),
            WorkerPatchDecode::Ok {
                patch: WorkerPatch::Note {
                    action: WorkerNoteAction::Edit,
                    value: json!({ "id": "n1", "text": "Fixed" })
                }
            }
        );
        assert_eq!(
            decode_worker_patch(
                &json!({ "field": "notes", "action": "edit", "value": { "id": "n1", "text": "x", "editedAt": null } }),
                &attributes()
            ),
            WorkerPatchDecode::Ok {
                patch: WorkerPatch::Note {
                    action: WorkerNoteAction::Edit,
                    value: json!({ "id": "n1", "text": "x", "editedAt": null })
                }
            }
        );
        for bad in [
            json!({ "id": "", "text": "x" }),
            json!({ "id": "n1", "text": "x", "editedAt": "yesterday" }),
            json!({ "id": "n1", "text": "x", "timestamp": "2026-10-07T00:00:00Z" }),
        ] {
            assert!(matches!(
                decode_worker_patch(
                    &json!({ "field": "notes", "action": "edit", "value": bad }),
                    &attributes()
                ),
                WorkerPatchDecode::Invalid { .. }
            ));
        }
        assert_eq!(
            decode_worker_patch(
                &json!({ "field": "notes", "action": "edit", "value": { "id": "n1", "text": "  " } }),
                &attributes()
            ),
            WorkerPatchDecode::Invalid {
                message: "A note needs text.".to_owned()
            }
        );
    }

    #[test]
    fn decode_worker_patch_accepts_a_note_delete_and_rejects_an_empty_id() {
        assert_eq!(
            decode_worker_patch(
                &json!({ "field": "notes", "action": "delete", "value": { "id": "n1" } }),
                &attributes()
            ),
            WorkerPatchDecode::Ok {
                patch: WorkerPatch::Note {
                    action: WorkerNoteAction::Delete,
                    value: json!({ "id": "n1" })
                }
            }
        );
        assert_eq!(
            decode_worker_patch(
                &json!({ "field": "notes", "action": "delete", "value": { "id": "" } }),
                &attributes()
            ),
            WorkerPatchDecode::Invalid {
                message: "Request must include a valid note change.".to_owned()
            }
        );
    }

    #[test]
    fn decode_worker_patch_accepts_a_note_restore_with_its_written_time() {
        assert_eq!(
            decode_worker_patch(
                &json!({
                    "field": "notes",
                    "action": "restore",
                    "value": {
                        "id": "n1",
                        "text": "  Back  ",
                        "timestamp": "2026-10-07T09:15:00.000Z",
                        "editedAt": "2026-10-08T09:15:00.000Z"
                    }
                }),
                &attributes()
            ),
            WorkerPatchDecode::Ok {
                patch: WorkerPatch::Note {
                    action: WorkerNoteAction::Restore,
                    value: json!({
                        "id": "n1",
                        "text": "Back",
                        "timestamp": "2026-10-07T09:15:00.000Z",
                        "editedAt": "2026-10-08T09:15:00.000Z"
                    })
                }
            }
        );

        // A Note that was never edited comes back without an edit time, not a null one.
        assert_eq!(
            decode_worker_patch(
                &json!({
                    "field": "notes",
                    "action": "restore",
                    "value": {
                        "id": "n1",
                        "text": "Back",
                        "timestamp": "2026-10-07T09:15:00.000Z",
                        "editedAt": null
                    }
                }),
                &attributes()
            ),
            WorkerPatchDecode::Ok {
                patch: WorkerPatch::Note {
                    action: WorkerNoteAction::Restore,
                    value: json!({
                        "id": "n1",
                        "text": "Back",
                        "timestamp": "2026-10-07T09:15:00.000Z"
                    })
                }
            }
        );
    }

    #[test]
    fn decode_worker_patch_refuses_a_note_restore_it_cannot_trust() {
        let invalid = WorkerPatchDecode::Invalid {
            message: "Request must include a valid note change.".to_owned(),
        };
        let note = |value: Value| json!({ "field": "notes", "action": "restore", "value": value });

        for value in [
            // No id, an empty id.
            json!({ "text": "Back", "timestamp": "2026-10-07T09:15:00.000Z" }),
            json!({ "id": "", "text": "Back", "timestamp": "2026-10-07T09:15:00.000Z" }),
            // A written time that is not an instant.
            json!({ "id": "n1", "text": "Back", "timestamp": "yesterday" }),
            json!({ "id": "n1", "text": "Back" }),
            // An edit time that is neither absent nor an instant.
            json!({ "id": "n1", "text": "Back", "timestamp": "2026-10-07T09:15:00.000Z", "editedAt": 3 }),
            // A key the action does not take.
            json!({ "id": "n1", "text": "Back", "timestamp": "2026-10-07T09:15:00.000Z", "author": "Ada" }),
        ] {
            assert_eq!(
                decode_worker_patch(&note(value.clone()), &attributes()),
                invalid,
                "{value}"
            );
        }

        // Text and date keep the action's own refusals.
        assert_eq!(
            decode_worker_patch(
                &note(json!({ "id": "n1", "text": "  ", "timestamp": "2026-10-07T09:15:00.000Z" })),
                &attributes()
            ),
            WorkerPatchDecode::Invalid {
                message: "A note needs text.".to_owned()
            }
        );
    }

    #[test]
    fn decode_worker_patch_rejects_a_note_patch_that_is_not_one() {
        let expected = WorkerPatchDecode::Invalid {
            message: "Request must include a valid note change.".to_owned(),
        };

        for payload in [
            // An action nobody knows yet.
            json!({ "field": "notes", "action": "rename", "value": { "id": "n1" } }),
            // Extra keys at the patch's own level.
            json!({ "field": "notes", "action": "add", "value": { "text": "x" }, "extra": true }),
            // A key the action does not take.
            json!({ "field": "notes", "action": "delete", "value": { "id": "n1", "text": "x" } }),
            // A value that is not an object.
            json!({ "field": "notes", "action": "add", "value": "x" }),
        ] {
            assert_eq!(
                decode_worker_patch(&payload, &attributes()),
                expected,
                "{payload}"
            );
        }

        // Text and date are the action's own refusals, not the shape's.
        assert_eq!(
            decode_worker_patch(
                &json!({ "field": "notes", "action": "add", "value": { "text": "  " } }),
                &attributes()
            ),
            WorkerPatchDecode::Invalid {
                message: "A note needs text.".to_owned()
            }
        );
    }

    #[test]
    fn decode_worker_patch_accepts_an_attribute_patch_inside_the_worksite_vocabulary() {
        assert_eq!(
            decode_worker_patch(
                &json!({ "attributeId": "a1", "value": "d-foh" }),
                &attributes()
            ),
            WorkerPatchDecode::Ok {
                patch: WorkerPatch::Attribute {
                    attribute_id: "a1".to_owned(),
                    value: json!("d-foh")
                }
            }
        );
        assert_eq!(
            decode_worker_patch(
                &json!({ "attributeId": "a2", "value": ["s-dinner"] }),
                &attributes()
            ),
            WorkerPatchDecode::Ok {
                patch: WorkerPatch::Attribute {
                    attribute_id: "a2".to_owned(),
                    value: json!(["s-dinner"])
                }
            }
        );
    }

    #[test]
    fn decode_worker_patch_accepts_a_relationship_change_and_rejects_a_malformed_one() {
        for (action, expected) in [
            ("add", WorkerRelationshipAction::Add),
            ("remove", WorkerRelationshipAction::Remove),
        ] {
            assert_eq!(
                decode_worker_patch(
                    &json!({ "field": "relationships", "action": action, "value": { "id": "w2" } }),
                    &attributes()
                ),
                WorkerPatchDecode::Ok {
                    patch: WorkerPatch::Relationship {
                        action: expected,
                        value: "w2".to_owned()
                    }
                },
                "{action}"
            );
        }

        let invalid = WorkerPatchDecode::Invalid {
            message: "Request must include a valid relationship change.".to_owned(),
        };
        for payload in [
            // An action nobody knows.
            json!({ "field": "relationships", "action": "relate", "value": { "id": "w2" } }),
            // No action at all.
            json!({ "field": "relationships", "value": { "id": "w2" } }),
            // An id that is missing or empty.
            json!({ "field": "relationships", "action": "add", "value": {} }),
            json!({ "field": "relationships", "action": "add", "value": { "id": "" } }),
            json!({ "field": "relationships", "action": "add", "value": { "id": 7 } }),
            // A key the change does not take, at either level.
            json!({ "field": "relationships", "action": "add", "value": { "id": "w2", "name": "Grace" } }),
            json!({ "field": "relationships", "action": "add", "value": { "id": "w2" }, "extra": true }),
            // A value that is not an object.
            json!({ "field": "relationships", "action": "add", "value": "w2" }),
        ] {
            assert_eq!(
                decode_worker_patch(&payload, &attributes()),
                invalid,
                "{payload}"
            );
        }
    }

    #[test]
    fn decode_worker_patch_rejects_an_unknown_attribute_or_an_out_of_vocabulary_value() {
        assert_eq!(
            decode_worker_patch(
                &json!({ "attributeId": "missing", "value": "x" }),
                &attributes()
            ),
            WorkerPatchDecode::Invalid {
                message: "Invalid value for worker attribute \"missing\".".to_owned()
            }
        );
        assert_eq!(
            decode_worker_patch(
                &json!({ "attributeId": "a1", "value": "d-nope" }),
                &attributes()
            ),
            WorkerPatchDecode::Invalid {
                message: "Invalid value for worker attribute \"a1\".".to_owned()
            }
        );
    }

    #[test]
    fn decode_worker_patch_rejects_a_payload_that_is_not_an_attribute_patch_or_a_patch_object() {
        assert_eq!(
            decode_worker_patch(&json!({ "value": "x" }), &attributes()),
            WorkerPatchDecode::Invalid {
                message: "Request must include an attribute ID and value.".to_owned()
            }
        );
        assert_eq!(
            decode_worker_patch(&Value::Null, &attributes()),
            WorkerPatchDecode::Invalid {
                message: "Request must include a patch object.".to_owned()
            }
        );
    }

    #[test]
    fn decode_worker_patch_falls_through_arrays_to_the_attribute_branch() {
        // JS `typeof [] === 'object'`, so an array passes the top check and then
        // fails on the missing attributeId, not on the patch-object check.
        assert_eq!(
            decode_worker_patch(&json!([]), &attributes()),
            WorkerPatchDecode::Invalid {
                message: "Request must include an attribute ID and value.".to_owned()
            }
        );
        assert_eq!(
            decode_worker_patch(&json!(["x"]), &attributes()),
            WorkerPatchDecode::Invalid {
                message: "Request must include an attribute ID and value.".to_owned()
            }
        );
    }

    #[test]
    fn decode_worker_patch_falls_through_a_non_string_field_to_the_attribute_branch() {
        assert_eq!(
            decode_worker_patch(&json!({ "field": 42 }), &attributes()),
            WorkerPatchDecode::Invalid {
                message: "Request must include an attribute ID and value.".to_owned()
            }
        );
    }
}
