//! The v22 legacy conversion: saved Work Assignment answers become ordinary Worker Attribute
//! values, and the assignment-shaped schema is removed.
//!
//! The conversion runs inside the caller's migration transaction. Every committed answer is
//! validated against its Attribute's configured answers first, so a source that cannot be
//! converted fails and rolls the whole version back instead of dropping information. Assignment
//! drafts are deliberately ignored: they survive only in the verified pre-upgrade backup.
//! Ordinary Worker drafts are preserved and receive the migrated values in both their update
//! and their saved base.

use std::collections::{HashMap, HashSet};

use rusqlite::{params, Connection, OptionalExtension};
use serde_json::Value;

use crate::attribute_migration::{answers_from_json, empty_attribute_value, StoredAnswer};
use crate::error::{Error, Result};
use crate::worker_draft_persistence::{WorkerDraftInput, NEW_WORKER_DRAFT_ID};

/// One former assignment-scoped Attribute and every Worker's committed answer ids, in the
/// Attribute's configured value order.
struct FlattenedAttribute {
    id: String,
    answers: Vec<StoredAnswer>,
    /// Worker id -> distinct committed answer ids, configured order.
    selected: HashMap<String, Vec<String>>,
    /// The Worksite-wide cardinality: Multi-Select when any Worker holds several answers.
    kind: &'static str,
}

impl FlattenedAttribute {
    fn value_for(&self, worker_id: &str) -> Value {
        match self.selected.get(worker_id) {
            None => empty_attribute_value(self.kind),
            Some(ids) if self.kind == "category" => {
                Value::String(ids.first().cloned().unwrap_or_default())
            }
            Some(ids) => Value::Array(ids.iter().cloned().map(Value::String).collect()),
        }
    }
}

/// Converts every Worksite, then removes the obsolete assignment tables and Attribute scope
/// columns. Runs inside the migration's transaction: any error rolls the whole version back.
pub(crate) fn flatten_work_assignments(conn: &Connection) -> Result<()> {
    validate_committed_assignments(conn)?;

    let worksite_ids: Vec<String> = {
        let mut statement = conn.prepare("SELECT id FROM worksites ORDER BY rowid")?;
        let rows = statement.query_map([], |row| row.get::<_, String>(0))?;
        rows.collect::<rusqlite::Result<Vec<_>>>()?
    };
    for worksite_id in worksite_ids {
        flatten_worksite(conn, &worksite_id)?;
    }

    remove_obsolete_schema(conn)
}

/// Every stored assignment answer must belong to a saved assignment whose Worker exists, and
/// to a formerly assignment-scoped Attribute of that Worker's Worksite. A dangling answer is
/// corrupt committed data, not an empty answer.
fn validate_committed_assignments(conn: &Connection) -> Result<()> {
    let dangling: Option<(String, String)> = conn
        .query_row(
            "SELECT answers.assignment_id, answers.attribute_id \
             FROM work_assignment_answers AS answers \
             LEFT JOIN work_assignments AS assignments ON assignments.id = answers.assignment_id \
             LEFT JOIN workers ON workers.id = assignments.worker_id \
             LEFT JOIN worker_attributes AS attributes ON attributes.id = answers.attribute_id \
               AND attributes.worksite_id = workers.worksite_id \
               AND attributes.scope = 'workAssignment' \
             WHERE assignments.id IS NULL OR workers.id IS NULL OR attributes.id IS NULL \
             LIMIT 1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    if let Some((assignment_id, attribute_id)) = dangling {
        return Err(Error::Message(format!(
            "Invalid Work Assignment answer stored for assignment {assignment_id}, attribute {attribute_id}."
        )));
    }
    Ok(())
}

/// One Worksite: flatten its former assignment Attributes, write every Worker's value, then
/// normalize the Worksite's ordinary Worker drafts against the migrated values.
fn flatten_worksite(conn: &Connection, worksite_id: &str) -> Result<()> {
    let attributes = read_assignment_attributes(conn, worksite_id)?;
    if attributes.is_empty() {
        return Ok(());
    }

    let worker_ids = read_worker_ids(conn, worksite_id)?;
    let mut flattened = read_committed_answers(conn, worksite_id, attributes)?;

    for attribute in &mut flattened {
        if attribute.selected.values().any(|ids| ids.len() > 1) {
            attribute.kind = "tag";
        } else {
            attribute.kind = "category";
        }
    }

    for attribute in &flattened {
        conn.execute(
            "UPDATE worker_attributes SET kind = ?1 WHERE id = ?2",
            params![attribute.kind, attribute.id],
        )?;
        for worker_id in &worker_ids {
            conn.execute(
                "INSERT INTO worker_attribute_values (worker_id, attribute_id, value) \
                 VALUES (?1, ?2, ?3) \
                 ON CONFLICT (worker_id, attribute_id) DO UPDATE SET value = excluded.value",
                params![
                    worker_id,
                    attribute.id,
                    serde_json::to_string(&attribute.value_for(worker_id))?
                ],
            )?;
        }
    }

    normalize_worker_drafts(conn, worksite_id, &worker_ids, &flattened)
}

/// The Worksite's former assignment-scoped Attributes, in configured column order.
fn read_assignment_attributes(
    conn: &Connection,
    worksite_id: &str,
) -> Result<Vec<FlattenedAttribute>> {
    let mut statement = conn.prepare(
        "SELECT id, options FROM worker_attributes \
         WHERE worksite_id = ?1 AND scope = 'workAssignment' ORDER BY position, rowid",
    )?;
    let mut rows = statement.query([worksite_id])?;
    let mut attributes = Vec::new();
    while let Some(row) = rows.next()? {
        let id: String = row.get(0)?;
        let raw: String = row.get(1)?;
        let options: Value = serde_json::from_str(&raw).map_err(|_| {
            Error::Message(format!("Invalid options JSON for worker attribute {id}."))
        })?;
        let answers = answers_from_json(&options).ok_or_else(|| {
            Error::Message(format!("Invalid options JSON for worker attribute {id}."))
        })?;
        attributes.push(FlattenedAttribute {
            id,
            answers,
            selected: HashMap::new(),
            kind: "category",
        });
    }
    Ok(attributes)
}

fn read_worker_ids(conn: &Connection, worksite_id: &str) -> Result<Vec<String>> {
    let mut statement =
        conn.prepare("SELECT id FROM workers WHERE worksite_id = ?1 ORDER BY rowid")?;
    let rows = statement.query_map([worksite_id], |row| row.get::<_, String>(0))?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

/// Reads every committed assignment answer of the Worksite and groups the distinct answer ids
/// by Worker and Attribute, ordered by the Attribute's configured value order.
fn read_committed_answers(
    conn: &Connection,
    worksite_id: &str,
    mut attributes: Vec<FlattenedAttribute>,
) -> Result<Vec<FlattenedAttribute>> {
    let mut committed: HashMap<String, HashMap<String, HashSet<String>>> = HashMap::new();
    {
        let mut statement = conn.prepare(
            "SELECT assignments.worker_id, answers.attribute_id, answers.answer_id \
             FROM work_assignments AS assignments \
             JOIN workers ON workers.id = assignments.worker_id \
             JOIN work_assignment_answers AS answers ON answers.assignment_id = assignments.id \
             WHERE workers.worksite_id = ?1 \
             ORDER BY assignments.worker_id, assignments.position, assignments.rowid, \
                      answers.attribute_id",
        )?;
        let mut rows = statement.query([worksite_id])?;
        while let Some(row) = rows.next()? {
            let worker_id: String = row.get(0)?;
            let attribute_id: String = row.get(1)?;
            let answer_id: String = row.get(2)?;
            let attribute = attributes
                .iter()
                .find(|attribute| attribute.id == attribute_id)
                .ok_or_else(|| {
                    Error::Message(format!(
                        "Invalid Work Assignment answer stored for unknown attribute {attribute_id}."
                    ))
                })?;
            if !attribute
                .answers
                .iter()
                .any(|answer| answer.id == answer_id)
            {
                return Err(Error::Message(format!(
                    "Invalid Work Assignment answer stored for worker {worker_id}, attribute {attribute_id}: {answer_id} is not configured."
                )));
            }
            committed
                .entry(attribute_id)
                .or_default()
                .entry(worker_id)
                .or_default()
                .insert(answer_id);
        }
    }

    for attribute in &mut attributes {
        let selected = committed.remove(&attribute.id).unwrap_or_default();
        let mut ordered = HashMap::new();
        for (worker_id, ids) in selected {
            // The configured order decides, not the order the assignments were saved in.
            let answer_ids = attribute
                .answers
                .iter()
                .filter(|answer| ids.contains(&answer.id))
                .map(|answer| answer.id.clone())
                .collect();
            ordered.insert(worker_id, answer_ids);
        }
        attribute.selected = ordered;
    }
    Ok(attributes)
}

/// Rewrites every ordinary Worker draft: the newly flattened Attribute takes the Worker's
/// migrated saved value in both the update and the base, so an older draft snapshot cannot
/// clear it. A malformed payload is left byte-for-byte untouched.
fn normalize_worker_drafts(
    conn: &Connection,
    worksite_id: &str,
    worker_ids: &[String],
    flattened: &[FlattenedAttribute],
) -> Result<()> {
    let drafts: Vec<(String, String)> = {
        let mut statement =
            conn.prepare("SELECT worker_id, payload FROM worker_drafts WHERE worksite_id = ?1")?;
        let rows = statement.query_map([worksite_id], |row| Ok((row.get(0)?, row.get(1)?)))?;
        rows.collect::<rusqlite::Result<Vec<_>>>()?
    };

    for (worker_id, raw) in drafts {
        let Some(payload) = normalized_payload(&raw, &worker_id, worker_ids, flattened) else {
            continue;
        };
        let encoded = serde_json::to_string(&payload)?;
        if encoded == raw {
            continue;
        }
        conn.execute(
            "UPDATE worker_drafts SET payload = ?1 WHERE worksite_id = ?2 AND worker_id = ?3",
            params![encoded, worksite_id, worker_id],
        )?;
    }
    Ok(())
}

/// The normalized draft payload, or `None` when the stored payload is malformed and must stay
/// exactly as it is. The migrated value replaces whatever snapshot the draft held for the
/// flattened Attribute.
fn normalized_payload(
    raw: &str,
    worker_id: &str,
    worker_ids: &[String],
    flattened: &[FlattenedAttribute],
) -> Option<Value> {
    serde_json::from_str::<WorkerDraftInput>(raw).ok()?;
    let mut payload: Value = serde_json::from_str(raw).ok()?;

    let update = payload
        .get_mut("update")?
        .get_mut("attributes")?
        .as_object_mut()?;
    // The New Worker draft has no saved value, and a draft whose Worker no longer exists gets
    // the same safe empty values.
    let new_worker =
        worker_id == NEW_WORKER_DRAFT_ID || !worker_ids.iter().any(|id| id == worker_id);
    for attribute in flattened {
        let value = if new_worker {
            empty_attribute_value(attribute.kind)
        } else {
            attribute.value_for(worker_id)
        };
        update.insert(attribute.id.clone(), value);
    }

    if let Some(base) = payload.get_mut("base") {
        if !base.is_null() {
            let base = base.get_mut("attributes")?.as_object_mut()?;
            for attribute in flattened {
                let value = if new_worker {
                    empty_attribute_value(attribute.kind)
                } else {
                    attribute.value_for(worker_id)
                };
                base.insert(attribute.id.clone(), value);
            }
        }
    }

    Some(payload)
}

/// Drops the assignment tables and their triggers, and the obsolete Attribute metadata columns.
/// The bundled SQLite supports `ALTER TABLE … DROP COLUMN`; the resulting table columns equal a
/// fresh bootstrap's.
fn remove_obsolete_schema(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "DROP TRIGGER IF EXISTS work_assignment_drafts_cascade_worker;
         DROP TRIGGER IF EXISTS work_assignment_drafts_cascade_assignment;
         DROP TABLE IF EXISTS work_assignment_drafts;
         DROP TABLE IF EXISTS work_assignment_answers;
         DROP TABLE IF EXISTS work_assignments;
         ALTER TABLE worker_attributes DROP COLUMN inference_eligible;
         ALTER TABLE worker_attributes DROP COLUMN scope;",
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// The final value shape for one Attribute kind and selection set.
    fn value(kind: &str, ids: &[&str]) -> Value {
        if kind == "category" {
            Value::String(ids.first().map_or(String::new(), |id| (*id).to_owned()))
        } else {
            Value::Array(
                ids.iter()
                    .map(|id| Value::String((*id).to_owned()))
                    .collect(),
            )
        }
    }

    #[test]
    fn ordered_distinct_selections_keep_configured_order() {
        let selected: Vec<String> = ["north", "north-downtown", "south-downtown"]
            .iter()
            .map(|id| (*id).to_owned())
            .collect();
        let mut selected_by_worker = HashMap::new();
        selected_by_worker.insert("w".to_owned(), selected);
        let attribute = FlattenedAttribute {
            id: "area".to_owned(),
            answers: Vec::new(),
            selected: selected_by_worker,
            kind: "tag",
        };
        assert_eq!(
            attribute.value_for("w"),
            value("tag", &["north", "north-downtown", "south-downtown"])
        );
        assert_eq!(attribute.value_for("absent"), Value::Array(Vec::new()));
    }

    /// A Worker draft payload shaped like the current form's.
    fn draft(worker_id: &str, update: Value, base: Option<Value>) -> (String, String) {
        let update = json!({
            "name": "One",
            "email": "",
            "phone": "",
            "assessment": "Unassessed",
            "attributes": update,
            "agitations": [],
            "languages": [],
            "relationships": [],
            "notes": [],
        });
        let payload = json!({
            "update": update,
            "pendingNote": { "text": "" },
            "base": base.map(|base| json!({
                "name": "One",
                "email": "",
                "phone": "",
                "assessment": "Unassessed",
                "attributes": base,
                "agitations": [],
                "languages": [],
                "relationships": [],
                "notes": [],
            })),
        });
        (
            worker_id.to_owned(),
            serde_json::to_string(&payload).unwrap(),
        )
    }

    #[test]
    fn normalizes_update_and_base_but_leaves_malformed_payloads_alone() {
        let flattened = vec![FlattenedAttribute {
            id: "store".to_owned(),
            answers: Vec::new(),
            selected: HashMap::from([(
                "w".to_owned(),
                vec!["store-a".to_owned(), "store-b".to_owned()],
            )]),
            kind: "tag",
        }];
        let (_, raw) = draft("w", json!({ "store": "stale" }), Some(json!({})));
        let payload = normalized_payload(&raw, "w", &["w".to_owned()], &flattened).unwrap();
        assert_eq!(
            payload["update"]["attributes"],
            json!({ "store": ["store-a", "store-b"] })
        );
        assert_eq!(
            payload["base"]["attributes"],
            json!({ "store": ["store-a", "store-b"] })
        );

        assert_eq!(
            normalized_payload("{}", "w", &["w".to_owned()], &flattened),
            None
        );
        let malformed = r#"{"update":{"attributes":[]}}"#;
        assert_eq!(
            normalized_payload(malformed, "w", &["w".to_owned()], &flattened),
            None
        );
    }

    #[test]
    fn new_worker_drafts_get_the_final_empty_values() {
        let flattened = vec![FlattenedAttribute {
            id: "store".to_owned(),
            answers: Vec::new(),
            selected: HashMap::new(),
            kind: "tag",
        }];
        let (_, raw) = draft(NEW_WORKER_DRAFT_ID, json!({ "store": ["ghost"] }), None);
        let payload =
            normalized_payload(&raw, NEW_WORKER_DRAFT_ID, &["w".to_owned()], &flattened).unwrap();
        assert_eq!(payload["update"]["attributes"]["store"], json!([]));
    }
}
