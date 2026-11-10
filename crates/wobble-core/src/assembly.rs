//! Worker read model: the one-query worker projection and validate-on-read decoding of stored columns.

use rusqlite::{params, Connection, Row};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::attribute_migration::WorkerAttributeDefinition;
use crate::attribute_persistence::get_worker_attributes;
use crate::error::{Error, Result};
use crate::schema::Worksite;
use crate::serialization::{is_assessment_option, is_worker_attribute_values, is_worker_notes};
use crate::utils::parse_stored_json;

/// A Worker as the handlers and pages surface it. Every field name is one word, so no
/// serde rename is needed.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
pub struct Worker {
    pub id: String,
    pub name: String,
    pub email: String,
    pub phone: String,
    pub assessment: String,
    /// Object: attribute id → string (category) or array (tag).
    #[cfg_attr(feature = "ts", ts(type = "Record<string, string | Array<string>>"))]
    pub attributes: Value,
    pub agitations: Vec<String>,
    pub languages: Vec<String>,
    pub relationships: Vec<String>,
    /// Array of `{id, text, timestamp[, editedAt]}` notes.
    #[cfg_attr(feature = "ts", ts(as = "Vec<crate::assembly::WorkerNoteTs>"))]
    pub notes: Value,
}

/// TS-only mirror of one worker note, matching `WorkerNote` in
/// `src/lib/domain-vocabulary.ts` (the stored `notes` column stays untyped `Value`,
/// so the field above points here instead of narrowing the runtime type).
#[cfg(feature = "ts")]
#[derive(ts_rs::TS)]
#[ts(export, rename = "WorkerNote")]
#[allow(dead_code)]
pub(crate) struct WorkerNoteTs {
    pub id: String,
    pub text: String,
    pub timestamp: String,
    #[cfg_attr(feature = "ts", ts(optional))]
    #[cfg_attr(feature = "ts", ts(rename = "editedAt"))]
    pub edited_at: Option<String>,
}

/// `workerProjection`: the Worker row plus its Relationships, Agitations, Languages and
/// attribute values, aggregated in SQLite so no join happens in Rust. The SQL is the
/// contract — the UNION ALL relationship arms, the two `COALESCE` defaults, and
/// `json_group_object(..., json(value))` all have to match the TS byte for byte.
const WORKER_PROJECTION: &str = r#"
  workers.*,
  COALESCE((
    SELECT json_group_array(related.related_id)
    FROM (
      SELECT worker_relationships.worker_b_id AS related_id
      FROM worker_relationships
      JOIN workers AS other ON other.id = worker_relationships.worker_b_id
      WHERE worker_relationships.worker_a_id = workers.id
        AND other.worksite_id = workers.worksite_id
      UNION ALL
      SELECT worker_relationships.worker_a_id AS related_id
      FROM worker_relationships
      JOIN workers AS other ON other.id = worker_relationships.worker_a_id
      WHERE worker_relationships.worker_b_id = workers.id
        AND other.worksite_id = workers.worksite_id
    ) AS related
  ), '[]') AS relationships,
  COALESCE((
    SELECT json_group_array(worker_agitations.agitation_id)
    FROM worker_agitations
    JOIN agitations ON agitations.id = worker_agitations.agitation_id
    WHERE worker_agitations.worker_id = workers.id
      AND agitations.worksite_id = workers.worksite_id
  ), '[]') AS agitations,
  COALESCE((
    SELECT json_group_array(worker_languages.language_id)
    FROM worker_languages
    JOIN languages ON languages.id = worker_languages.language_id
    WHERE worker_languages.worker_id = workers.id
      AND languages.worksite_id = workers.worksite_id
  ), '[]') AS languages,
  COALESCE((
    SELECT json_group_object(attribute_values.attribute_id, json(attribute_values.value))
    FROM worker_attribute_values AS attribute_values
    JOIN worker_attributes ON worker_attributes.id = attribute_values.attribute_id
    WHERE attribute_values.worker_id = workers.id
      AND worker_attributes.worksite_id = workers.worksite_id
  ), '{}') AS attributes
"#;

/// `decodeNotes`: the JSON column parses, then passes the notes guard. Two distinct
/// messages, unlike the other decoders.
fn decode_notes(value: &str, worker_id: &str) -> Result<Value> {
    let parsed = parse_stored_json(
        value,
        &format!("Invalid notes JSON for worker {worker_id}."),
    )?;

    if !is_worker_notes(&parsed) {
        return Err(Error::Message(format!(
            "Invalid notes stored for worker {worker_id}."
        )));
    }

    Ok(parsed)
}

/// `decodeAssessment`: the stored text is one of the assessment options.
fn decode_assessment(value: &str, worker_id: &str) -> Result<String> {
    if !is_assessment_option(&Value::String(value.to_owned())) {
        return Err(Error::Message(format!(
            "Invalid assessment stored for worker {worker_id}."
        )));
    }

    Ok(value.to_owned())
}

/// `decodeIdList`: a JSON array of strings, returned sorted. The shape check is
/// array-of-strings only — no uniqueness, no non-empty rule. `Vec::sort()` is the JS
/// `Array.prototype.sort()` for the ASCII ids this app stores.
fn decode_id_list(value: &str, worker_id: &str) -> Result<Vec<String>> {
    let parsed = parse_stored_json(
        value,
        &format!("Invalid stored id list for worker {worker_id}."),
    )?;

    let Some(items) = parsed.as_array() else {
        return Err(Error::Message(format!(
            "Invalid stored id list for worker {worker_id}."
        )));
    };

    let mut ids: Vec<String> = Vec::with_capacity(items.len());
    for item in items {
        match item.as_str() {
            Some(id) => ids.push(id.to_owned()),
            None => {
                return Err(Error::Message(format!(
                    "Invalid stored id list for worker {worker_id}."
                )))
            }
        }
    }

    ids.sort();

    Ok(ids)
}

/// `decodeAttributes`: the JSON object parses and fits the Worksite's whole attribute
/// configuration — every attribute id present, each value inside its kind's vocabulary.
/// Parse and shape share one message.
fn decode_attributes(
    value: &str,
    worker_id: &str,
    attributes: &[WorkerAttributeDefinition],
) -> Result<Value> {
    let parsed = parse_stored_json(
        value,
        &format!("Invalid attribute values stored for worker {worker_id}."),
    )?;

    let definition_values: Vec<Value> = attributes
        .iter()
        .map(serde_json::to_value)
        .collect::<serde_json::Result<Vec<Value>>>()?;

    if !is_worker_attribute_values(&parsed, &definition_values) {
        return Err(Error::Message(format!(
            "Invalid attribute values stored for worker {worker_id}."
        )));
    }

    Ok(parsed)
}

/// `toWorker`: the 11 projected columns decoded into a Worker. Index 1 is
/// `workers.worksite_id`, selected by `workers.*` and deliberately unused.
fn to_worker(row: &Row, attributes: &[WorkerAttributeDefinition]) -> Result<Worker> {
    let id: String = row.get(0)?;
    let name: String = row.get(2)?;
    let email: String = row.get(3)?;
    let phone: String = row.get(4)?;
    let assessment: String = row.get(5)?;
    let notes: String = row.get(6)?;
    let relationships: String = row.get(7)?;
    let agitations: String = row.get(8)?;
    let languages: String = row.get(9)?;
    let stored_attributes: String = row.get(10)?;

    Ok(Worker {
        assessment: decode_assessment(&assessment, &id)?,
        attributes: decode_attributes(&stored_attributes, &id, attributes)?,
        agitations: decode_id_list(&agitations, &id)?,
        languages: decode_id_list(&languages, &id)?,
        relationships: decode_id_list(&relationships, &id)?,
        notes: decode_notes(&notes, &id)?,
        id,
        name,
        email,
        phone,
    })
}

/// `readWorker`: one worker, or nothing. The attribute configuration is read only once
/// a row exists, so a missing worker never trips a corrupt-configuration error. No
/// Worksite reads nothing.
pub fn read_worker(
    conn: &Connection,
    worksite: &Option<Worksite>,
    worker_id: &str,
) -> Result<Option<Worker>> {
    let Some(worksite) = worksite else {
        return Ok(None);
    };

    let mut statement = conn.prepare(&format!(
        "SELECT {WORKER_PROJECTION} FROM workers WHERE workers.id = ?1 AND workers.worksite_id = ?2"
    ))?;
    let mut rows = statement.query(params![worker_id, worksite.id])?;
    let Some(row) = rows.next()? else {
        return Ok(None);
    };

    let attributes = get_worker_attributes(conn, &Some(worksite.clone()))?;

    Ok(Some(to_worker(row, &attributes)?))
}

/// `readWorkers`: every worker of the Worksite in rowid order, decoded against one
/// shared attribute configuration read. No Worksite reads nothing.
pub fn read_workers(conn: &Connection, worksite: &Option<Worksite>) -> Result<Vec<Worker>> {
    let Some(worksite) = worksite else {
        return Ok(Vec::new());
    };

    let attributes = get_worker_attributes(conn, &Some(worksite.clone()))?;
    let mut statement = conn.prepare(&format!(
        "SELECT {WORKER_PROJECTION} FROM workers WHERE workers.worksite_id = ?1 ORDER BY workers.rowid"
    ))?;
    let mut rows = statement.query([&worksite.id])?;

    let mut workers = Vec::new();
    while let Some(row) = rows.next()? {
        workers.push(to_worker(row, &attributes)?);
    }

    Ok(workers)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::worker_persistence::insert_bare_worker;

    use crate::agitation_persistence::create_agitation;
    use crate::db::{open_seeded, Db};
    use crate::id::{counter_id, CounterId};
    use crate::relationship_persistence::replace_relationships;
    use crate::worksite_persistence::resolve_active_worksite;
    use serde_json::json;

    fn seeded() -> (Db, CounterId, Worksite) {
        let ids = CounterId::new();
        let db = open_seeded(":memory:", &ids).unwrap();
        let worksite = resolve_active_worksite(db.conn(), None).unwrap().unwrap();
        (db, ids, worksite)
    }

    /// The spec's `makeWorker`: a worker row plus one attribute value per seeded
    /// attribute, holding that kind's empty value.
    fn add_worker(conn: &Connection, worksite: &Worksite, id: &str, name: &str) {
        insert_bare_worker(conn, &worksite.id, id, name, "test@example.com");

        for attribute in get_worker_attributes(conn, &Some(worksite.clone())).unwrap() {
            let empty = if attribute.kind == "category" {
                json!("")
            } else {
                json!([])
            };
            conn.execute(
                "INSERT INTO worker_attribute_values (worker_id, attribute_id, value) \
                 VALUES (?1, ?2, ?3)",
                params![id, attribute.id, serde_json::to_string(&empty).unwrap()],
            )
            .unwrap();
        }
    }

    fn set_value(conn: &Connection, worker_id: &str, attribute_id: &str, value: &Value) {
        conn.execute(
            "UPDATE worker_attribute_values SET value = ?1 WHERE worker_id = ?2 AND attribute_id = ?3",
            params![serde_json::to_string(value).unwrap(), worker_id, attribute_id],
        )
        .unwrap();
    }

    fn attributes_of(conn: &Connection, worksite: &Worksite) -> Vec<WorkerAttributeDefinition> {
        get_worker_attributes(conn, &Some(worksite.clone())).unwrap()
    }

    fn read_one(db: &Db, worksite: &Worksite, worker_id: &str) -> Worker {
        read_worker(db.conn(), &Some(worksite.clone()), worker_id)
            .unwrap()
            .unwrap()
    }

    #[test]
    fn reads_the_same_worker_through_both_paths() {
        let (db, _ids, worksite) = seeded();
        add_worker(db.conn(), &worksite, "w1", "Rosalind Franklin");

        let bulk = read_workers(db.conn(), &Some(worksite.clone())).unwrap();

        assert_eq!(bulk, [read_one(&db, &worksite, "w1")]);
        assert_eq!(bulk.len(), 1);
    }

    #[test]
    fn reads_a_missing_worker_as_none() {
        let (db, _ids, worksite) = seeded();

        assert_eq!(
            read_worker(db.conn(), &Some(worksite.clone()), "nobody").unwrap(),
            None
        );
    }

    #[test]
    fn reads_nothing_when_there_is_no_active_worksite() {
        let (db, _ids, worksite) = seeded();
        add_worker(db.conn(), &worksite, "w1", "Rosalind Franklin");

        assert_eq!(read_workers(db.conn(), &None).unwrap(), Vec::new());
        assert_eq!(read_worker(db.conn(), &None, "w1").unwrap(), None);
    }

    #[test]
    fn orders_agitations_ascending_by_id_on_both_paths() {
        let (db, ids, worksite) = seeded();
        let first = create_agitation(db.conn(), &worksite, "First", &ids)
            .unwrap()
            .agitation;
        let second = create_agitation(db.conn(), &worksite, "Second", &ids)
            .unwrap()
            .agitation;
        add_worker(db.conn(), &worksite, "w1", "Rosalind Franklin");
        // Linked in the reverse of the id order, so the decode has to sort.
        for id in [&second.id, &first.id] {
            db.conn()
                .execute(
                    "INSERT INTO worker_agitations (worker_id, agitation_id) VALUES (?1, ?2)",
                    params!["w1", id],
                )
                .unwrap();
        }

        let sorted = [counter_id(5), counter_id(6)];
        assert_eq!(first.id, sorted[0]);
        assert_eq!(second.id, sorted[1]);
        assert_eq!(read_one(&db, &worksite, "w1").agitations, sorted);
        assert_eq!(
            read_workers(db.conn(), &Some(worksite.clone())).unwrap()[0].agitations,
            sorted
        );
    }

    #[test]
    fn sorts_relationships_read_from_both_union_branches() {
        let (db, _ids, worksite) = seeded();
        for (id, name) in [("aaa", "A"), ("mmm", "M"), ("zzz", "Z")] {
            add_worker(db.conn(), &worksite, id, name);
        }
        // `mmm` is the a-side of one pair and the b-side of the other.
        for (a, b) in [("mmm", "zzz"), ("aaa", "mmm")] {
            db.conn()
                .execute(
                    "INSERT INTO worker_relationships (worker_a_id, worker_b_id) VALUES (?1, ?2)",
                    params![a, b],
                )
                .unwrap();
        }

        // The projection's own relationship subquery, b-side row first: the raw value
        // is not sorted, so the decoded one below proves the sort runs.
        let raw: String = db
            .conn()
            .query_row(
                "SELECT COALESCE((
                   SELECT json_group_array(related.related_id)
                   FROM (
                     SELECT worker_relationships.worker_b_id AS related_id
                     FROM worker_relationships
                     JOIN workers AS other ON other.id = worker_relationships.worker_b_id
                     WHERE worker_relationships.worker_a_id = 'mmm'
                       AND other.worksite_id = ?1
                     UNION ALL
                     SELECT worker_relationships.worker_a_id AS related_id
                     FROM worker_relationships
                     JOIN workers AS other ON other.id = worker_relationships.worker_a_id
                     WHERE worker_relationships.worker_b_id = 'mmm'
                       AND other.worksite_id = ?1
                   ) AS related
                 ), '[]')",
                [&worksite.id],
                |row| row.get(0),
            )
            .unwrap();

        assert_eq!(raw, r#"["zzz","aaa"]"#);
        assert_eq!(
            read_one(&db, &worksite, "mmm").relationships,
            ["aaa", "zzz"]
        );
    }

    #[test]
    fn decodes_relationships_and_attribute_values() {
        let (db, _ids, worksite) = seeded();
        db.conn()
            .execute(
                "UPDATE worker_attributes SET options = json_array(json_object('id', id || '-one', 'value', 'One'), json_object('id', id || '-two', 'value', 'Two')) WHERE kind IN ('category', 'tag')",
                [],
            )
            .unwrap();
        add_worker(db.conn(), &worksite, "w1", "First");
        add_worker(db.conn(), &worksite, "w2", "Second");
        let attributes = attributes_of(db.conn(), &worksite);
        let category = attributes
            .iter()
            .find(|attribute| attribute.kind == "category")
            .unwrap();
        let tag = attributes
            .iter()
            .find(|attribute| attribute.kind == "tag")
            .unwrap();

        replace_relationships(db.conn(), &worksite, "w1", &["w2".to_owned()]).unwrap();
        set_value(
            db.conn(),
            "w1",
            &category.id,
            &json!(format!("{}-one", category.id)),
        );
        set_value(
            db.conn(),
            "w1",
            &tag.id,
            &json!([format!("{}-one", tag.id)]),
        );

        let worker = read_one(&db, &worksite, "w1");

        assert_eq!(worker.relationships, ["w2"]);
        assert_eq!(
            worker.attributes.get(&category.id),
            Some(&json!(format!("{}-one", category.id)))
        );
        assert_eq!(
            worker.attributes.get(&tag.id),
            Some(&json!([format!("{}-one", tag.id)]))
        );
    }

    #[test]
    fn decodes_assessment_and_notes() {
        let (db, _ids, worksite) = seeded();
        let notes = json!([{
            "id": "n1",
            "text": "Prefers mornings",
            "timestamp": "2026-09-02T10:00:00.000Z"
        }]);
        add_worker(db.conn(), &worksite, "w1", "Assessed");
        db.conn()
            .execute(
                "UPDATE workers SET assessment = 'Supporter', notes = ?1 WHERE id = 'w1'",
                params![serde_json::to_string(&notes).unwrap()],
            )
            .unwrap();

        let worker = read_one(&db, &worksite, "w1");

        assert_eq!(worker.assessment, "Supporter");
        assert_eq!(worker.notes, notes);
        assert_eq!(
            read_workers(db.conn(), &Some(worksite.clone())).unwrap(),
            [worker]
        );
    }

    #[test]
    fn reports_a_stored_attribute_value_outside_the_vocabulary() {
        let (db, _ids, worksite) = seeded();
        add_worker(db.conn(), &worksite, "w1", "Corrupt");
        let category = attributes_of(db.conn(), &worksite)
            .into_iter()
            .find(|attribute| attribute.kind == "category")
            .unwrap();
        set_value(db.conn(), "w1", &category.id, &json!("Not an option"));

        let error = read_worker(db.conn(), &Some(worksite.clone()), "w1").unwrap_err();

        assert!(
            matches!(error, Error::Message(message) if message == "Invalid attribute values stored for worker w1.")
        );
    }

    #[test]
    fn reports_a_worker_missing_one_attribute_value() {
        let (db, _ids, worksite) = seeded();
        add_worker(db.conn(), &worksite, "w1", "Incomplete");
        let tag = attributes_of(db.conn(), &worksite)
            .into_iter()
            .find(|attribute| attribute.kind == "tag")
            .unwrap();
        db.conn()
            .execute(
                "DELETE FROM worker_attribute_values WHERE worker_id = 'w1' AND attribute_id = ?1",
                params![tag.id],
            )
            .unwrap();

        let error = read_worker(db.conn(), &Some(worksite.clone()), "w1").unwrap_err();

        assert!(
            matches!(error, Error::Message(message) if message == "Invalid attribute values stored for worker w1.")
        );
    }

    #[test]
    fn reports_stored_notes_that_fail_the_guard() {
        let (db, _ids, worksite) = seeded();
        add_worker(db.conn(), &worksite, "w1", "Odd notes");
        db.conn()
            .execute("UPDATE workers SET notes = '{}' WHERE id = 'w1'", [])
            .unwrap();

        let error = read_worker(db.conn(), &Some(worksite.clone()), "w1").unwrap_err();

        assert!(
            matches!(error, Error::Message(message) if message == "Invalid notes stored for worker w1.")
        );
    }

    #[test]
    fn reports_a_stored_assessment_outside_the_vocabulary() {
        let (db, _ids, worksite) = seeded();
        add_worker(db.conn(), &worksite, "w1", "Misassessed");
        db.conn()
            .execute("UPDATE workers SET assessment = 'Nope' WHERE id = 'w1'", [])
            .unwrap();

        let error = read_worker(db.conn(), &Some(worksite.clone()), "w1").unwrap_err();

        assert!(
            matches!(error, Error::Message(message) if message == "Invalid assessment stored for worker w1.")
        );
    }

    #[test]
    fn decoders_report_their_own_message_for_a_corrupt_column() {
        // The id-list columns come from `json_group_array`, so their parse and shape
        // failures are unreachable through the projection; the decoders are tested
        // directly instead.
        for corrupt in ["{", "{}", "[1]", r#"[["a"]]"#] {
            let error = decode_id_list(corrupt, "w1").unwrap_err();
            assert!(
                matches!(error, Error::Message(message) if message == "Invalid stored id list for worker w1."),
                "{corrupt} reported the wrong message"
            );
        }
        assert_eq!(
            decode_id_list(r#"["b","a","a"]"#, "w1").unwrap(),
            ["a", "a", "b"]
        );
        assert_eq!(decode_id_list("[]", "w1").unwrap(), Vec::<String>::new());

        let error = decode_notes("{", "w1").unwrap_err();
        assert!(
            matches!(error, Error::Message(message) if message == "Invalid notes JSON for worker w1.")
        );
        assert_eq!(
            decode_notes(
                r#"[{"id":"n1","text":"t","timestamp":"2026-09-02T10:00:00.000Z"}]"#,
                "w1"
            )
            .unwrap(),
            json!([{ "id": "n1", "text": "t", "timestamp": "2026-09-02T10:00:00.000Z" }])
        );

        let error = decode_assessment("Nope", "w1").unwrap_err();
        assert!(
            matches!(error, Error::Message(message) if message == "Invalid assessment stored for worker w1.")
        );
        assert_eq!(decode_assessment("Hostile", "w1").unwrap(), "Hostile");

        let error = decode_attributes("[]", "w1", &[]).unwrap_err();
        assert!(
            matches!(error, Error::Message(message) if message == "Invalid attribute values stored for worker w1.")
        );
    }
}
