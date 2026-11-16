//! The v21 legacy conversion: one retained, data-only migration that moves the bounded legacy
//! Worker questions to Work Assignment scope and expands each Worker's independent answers into
//! assignment tuples (spec.md "Versioned development and beta migration").
//!
//! The conversion runs inside the caller's migration transaction. A committed answer that cannot
//! be read fails the transaction so nothing is silently lost; a stored Worker draft that cannot be
//! read is left byte-for-byte untouched, because drafts are best-effort recovery data.

use std::collections::{BTreeMap, HashMap, HashSet};

use rusqlite::{params, Connection};
use serde_json::{Map, Value};

use crate::error::{Error, Result};
use crate::id::random_id;
use crate::worker_draft_persistence::WorkerDraftInput;

/// The bounded migration list from the spec, compared after trim + lowercase. No diacritic
/// folding and no token/suffix matching: "Ubicacion" and "Store A" are not answers here.
const LEGACY_ATTRIBUTE_NAMES: &[&str] = &[
    "department",
    "departments",
    "departamento",
    "departamentos",
    "role",
    "roles",
    "job",
    "jobs",
    "puesto",
    "puestos",
    "shift",
    "shifts",
    "turno",
    "turnos",
    "location",
    "locations",
    "ubicación",
    "ubicaciones",
    "store",
    "stores",
    "tienda",
    "tiendas",
];

/// One answer tuple: Attribute id -> answer id. A map is the identity of the fact, so two
/// tuples are duplicates exactly when their pairs match.
type Tuple = BTreeMap<String, String>;

/// A legacy Attribute that the conversion moves to assignment scope.
struct EligibleAttribute {
    id: String,
    /// The stored kind, which decides how the legacy value is read. The definition itself is
    /// rewritten to category.
    kind: String,
    /// The definition's answer ids, in their stored order.
    answers: Vec<String>,
}

/// Converts every Worksite's eligible legacy questions and their stored answers. Runs inside
/// the migration's transaction: any error rolls the whole version back.
pub(crate) fn convert_legacy_work_assignments(conn: &Connection) -> Result<()> {
    let worksite_ids: Vec<String> = {
        let mut statement = conn.prepare("SELECT id FROM worksites ORDER BY rowid")?;
        let rows = statement.query_map([], |row| row.get::<_, String>(0))?;
        rows.collect::<rusqlite::Result<Vec<_>>>()?
    };

    for worksite_id in worksite_ids {
        convert_worksite(conn, &worksite_id)?;
    }
    Ok(())
}

/// One Worksite: convert the eligible definitions, then every Worker's committed answers, then
/// the Worksite's stored Worker drafts.
fn convert_worksite(conn: &Connection, worksite_id: &str) -> Result<()> {
    let eligible = eligible_attributes(conn, worksite_id)?;
    if eligible.is_empty() {
        return Ok(());
    }

    for attribute in &eligible {
        // Scope and kind move; id, name, position and options stay exactly as stored. An
        // Assignment holds one answer, so the stored tag kind becomes a category.
        conn.execute(
            "UPDATE worker_attributes SET scope = 'workAssignment', kind = 'category', inference_eligible = 0 WHERE id = ?1",
            [&attribute.id],
        )?;
    }

    let worker_ids: Vec<String> = {
        let mut statement =
            conn.prepare("SELECT id FROM workers WHERE worksite_id = ?1 ORDER BY rowid")?;
        let rows = statement.query_map([worksite_id], |row| row.get::<_, String>(0))?;
        rows.collect::<rusqlite::Result<Vec<_>>>()?
    };

    for worker_id in &worker_ids {
        convert_worker(conn, worker_id, &eligible)?;
    }

    convert_worker_drafts(conn, worksite_id, &eligible)
}

/// Reads the Worksite's Attribute rows and keeps those the spec makes eligible: still
/// Worker-scoped, still inference-eligible, named in the bounded list, and not already referenced
/// by a saved assignment.
fn eligible_attributes(conn: &Connection, worksite_id: &str) -> Result<Vec<EligibleAttribute>> {
    let mut statement = conn.prepare(
        "SELECT id, name, kind, scope, inference_eligible, options FROM worker_attributes WHERE worksite_id = ?1 ORDER BY position, rowid",
    )?;
    let mut rows = statement.query([worksite_id])?;
    let mut eligible = Vec::new();
    while let Some(row) = rows.next()? {
        let id: String = row.get(0)?;
        let name: String = row.get(1)?;
        let kind: String = row.get(2)?;
        let scope: String = row.get(3)?;
        let inference_eligible: i64 = row.get(4)?;
        let options: String = row.get(5)?;

        if scope != "worker" || inference_eligible == 0 || !is_legacy_name(&name) {
            continue;
        }
        // A definition an assignment already uses is not an independent Worker answer. Leaving
        // it alone avoids inventing a second fact.
        let already_used: bool = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM work_assignment_answers WHERE attribute_id = ?1)",
            [&id],
            |row| row.get(0),
        )?;
        if already_used {
            continue;
        }

        let stored: Value = serde_json::from_str(&options).map_err(|_| {
            Error::Message(format!("Invalid options JSON for worker attribute {id}."))
        })?;
        let answers = crate::attribute_migration::answers_from_json(&stored).ok_or_else(|| {
            Error::Message(format!("Invalid options JSON for worker attribute {id}."))
        })?;

        eligible.push(EligibleAttribute {
            id,
            kind,
            answers: answers.into_iter().map(|answer| answer.id).collect(),
        });
    }
    Ok(eligible)
}

/// Whether a stored Attribute name is on the bounded migration list: trim, lowercase, exact.
fn is_legacy_name(name: &str) -> bool {
    LEGACY_ATTRIBUTE_NAMES.contains(&name.trim().to_lowercase().as_str())
}

/// Converts one Worker's committed independent answers: append generated tuples after the saved
/// assignments, then delete only the values that moved into them.
fn convert_worker(
    conn: &Connection,
    worker_id: &str,
    eligible: &[EligibleAttribute],
) -> Result<()> {
    let selections = read_stored_selections(conn, worker_id, eligible)?;
    let generated = generate_tuples(&selections);
    if !generated.is_empty() {
        let mut saved = saved_tuples(conn, worker_id)?;
        let mut position: i64 = conn.query_row(
            "SELECT COALESCE(MAX(position) + 1, 0) FROM work_assignments WHERE worker_id = ?1",
            [worker_id],
            |row| row.get(0),
        )?;
        for tuple in generated {
            if saved.contains(&tuple) {
                continue;
            }
            insert_assignment(conn, worker_id, position, &tuple)?;
            saved.push(tuple);
            position += 1;
        }
    }

    for attribute in eligible {
        conn.execute(
            "DELETE FROM worker_attribute_values WHERE worker_id = ?1 AND attribute_id = ?2",
            params![worker_id, attribute.id],
        )?;
    }
    Ok(())
}

/// The Worker's stored selections for the converted Attributes, in Attribute order.
fn read_stored_selections(
    conn: &Connection,
    worker_id: &str,
    eligible: &[EligibleAttribute],
) -> Result<Vec<(String, Vec<String>)>> {
    let mut statement = conn
        .prepare("SELECT attribute_id, value FROM worker_attribute_values WHERE worker_id = ?1")?;
    let mut rows = statement.query([worker_id])?;
    let mut stored: HashMap<String, Value> = HashMap::new();
    while let Some(row) = rows.next()? {
        stored.insert(
            row.get(0)?,
            serde_json::from_str(&row.get::<_, String>(1)?)?,
        );
    }

    eligible
        .iter()
        .map(|attribute| {
            let selected = selected_answers(stored.get(&attribute.id), attribute, worker_id)?;
            Ok((attribute.id.clone(), selected))
        })
        .collect()
}

/// One stored value as selected answer ids. Missing and null mean no answer; an empty category
/// string and empty tag array mean none. Answer ids must belong to the definition; an id of ""
/// inside a tag is ignored, and repeated ids are kept once in first-seen order.
fn selected_answers(
    value: Option<&Value>,
    attribute: &EligibleAttribute,
    worker_id: &str,
) -> Result<Vec<String>> {
    let invalid = || {
        Error::Message(format!(
            "Invalid legacy answer stored for worker {worker_id}, attribute {}.",
            attribute.id
        ))
    };
    let selected = match (attribute.kind.as_str(), value) {
        (_, None | Some(Value::Null)) => Vec::new(),
        ("category", Some(Value::String(answer))) => {
            if answer.is_empty() {
                Vec::new()
            } else if attribute.answers.contains(answer) {
                vec![answer.clone()]
            } else {
                return Err(invalid());
            }
        }
        ("tag", Some(Value::Array(items))) => {
            let mut seen = HashSet::new();
            let mut selected = Vec::new();
            for item in items {
                let answer = item.as_str().ok_or_else(invalid)?;
                if answer.is_empty() {
                    continue;
                }
                if !attribute.answers.iter().any(|known| known == answer) {
                    return Err(invalid());
                }
                if seen.insert(answer.to_owned()) {
                    selected.push(answer.to_owned());
                }
            }
            selected
        }
        _ => return Err(invalid()),
    };
    Ok(selected)
}

/// The tuple rule from the spec. Singletons form the common base; with no multi-answer
/// Attribute the non-empty base is one tuple. One multi-answer Attribute expands to one tuple
/// per selected answer of it; several produce separate partial assignments that vary one
/// Attribute at a time. Generated duplicates are consolidated, keeping the first.
fn generate_tuples(selections: &[(String, Vec<String>)]) -> Vec<Tuple> {
    let mut base = Tuple::new();
    let mut multi: Vec<(&str, &[String])> = Vec::new();
    for (attribute_id, answers) in selections {
        match answers.as_slice() {
            [] => {}
            [only] => {
                base.insert(attribute_id.clone(), only.clone());
            }
            several => multi.push((attribute_id, several)),
        }
    }

    let mut tuples: Vec<Tuple> = Vec::new();
    let mut push = |tuple: Tuple| {
        if !tuple.is_empty() && !tuples.contains(&tuple) {
            tuples.push(tuple);
        }
    };
    match multi.as_slice() {
        [] => push(base),
        [(attribute_id, answers)] => {
            for answer in *answers {
                let mut tuple = base.clone();
                tuple.insert((*attribute_id).to_owned(), answer.clone());
                push(tuple);
            }
        }
        several => {
            for (attribute_id, answers) in several {
                for answer in *answers {
                    let mut tuple = base.clone();
                    tuple.insert((*attribute_id).to_owned(), answer.clone());
                    push(tuple);
                }
            }
        }
    }
    tuples
}

/// Every saved answer tuple of one Worker, in saved position order.
fn saved_tuples(conn: &Connection, worker_id: &str) -> Result<Vec<Tuple>> {
    let assignment_ids: Vec<String> = {
        let mut statement = conn.prepare(
            "SELECT id FROM work_assignments WHERE worker_id = ?1 ORDER BY position, rowid",
        )?;
        let rows = statement.query_map([worker_id], |row| row.get::<_, String>(0))?;
        rows.collect::<rusqlite::Result<Vec<_>>>()?
    };
    let mut tuples = Vec::with_capacity(assignment_ids.len());
    for assignment_id in assignment_ids {
        let mut statement = conn.prepare(
            "SELECT attribute_id, answer_id FROM work_assignment_answers WHERE assignment_id = ?1",
        )?;
        let mut rows = statement.query([&assignment_id])?;
        let mut tuple = Tuple::new();
        while let Some(row) = rows.next()? {
            tuple.insert(row.get(0)?, row.get(1)?);
        }
        tuples.push(tuple);
    }
    Ok(tuples)
}

/// Writes one generated assignment and its linked answers.
fn insert_assignment(
    conn: &Connection,
    worker_id: &str,
    position: i64,
    tuple: &Tuple,
) -> Result<()> {
    let assignment_id = random_id();
    conn.execute(
        "INSERT INTO work_assignments (id, worker_id, position) VALUES (?1, ?2, ?3)",
        params![assignment_id, worker_id, position],
    )?;
    for (attribute_id, answer_id) in tuple {
        conn.execute(
            "INSERT INTO work_assignment_answers (assignment_id, attribute_id, answer_id) VALUES (?1, ?2, ?3)",
            params![assignment_id, attribute_id, answer_id],
        )?;
    }
    Ok(())
}

/// What one stored Worker draft turns into: the payload with the converted Attribute ids
/// removed, and the tuples that had no matching saved assignment.
struct DraftConversion {
    payload: Value,
    stripped: bool,
    tuples: Vec<Tuple>,
}

/// Converts the Worksite's stored Worker drafts, including the not-yet-created Worker's draft
/// under the 'new' sentinel. A draft that does not decode or holds an invalid converted value is
/// left exactly as stored.
fn convert_worker_drafts(
    conn: &Connection,
    worksite_id: &str,
    eligible: &[EligibleAttribute],
) -> Result<()> {
    let drafts: Vec<(String, String, String)> = {
        let mut statement = conn.prepare(
            "SELECT worker_id, payload, updated_at FROM worker_drafts WHERE worksite_id = ?1 ORDER BY rowid",
        )?;
        let rows = statement.query_map([worksite_id], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?))
        })?;
        rows.collect::<rusqlite::Result<Vec<_>>>()?
    };

    for (worker_id, raw, updated_at) in drafts {
        let Some(conversion) = plan_draft_conversion(&raw, eligible) else {
            continue;
        };

        let saved = if crate::worker_draft_persistence::NEW_WORKER_DRAFT_ID == worker_id {
            Vec::new()
        } else {
            saved_tuples(conn, &worker_id)?
        };
        for tuple in conversion.tuples {
            if saved.contains(&tuple) {
                continue;
            }
            insert_draft(conn, worksite_id, &worker_id, &updated_at, &tuple)?;
        }

        if conversion.stripped {
            conn.execute(
                "UPDATE worker_drafts SET payload = ?1 WHERE worksite_id = ?2 AND worker_id = ?3",
                params![
                    serde_json::to_string(&conversion.payload)?,
                    worksite_id,
                    worker_id
                ],
            )?;
        }
    }
    Ok(())
}

/// Reads one stored draft and computes its converted payload and pending tuples. None leaves
/// the draft untouched: a payload that does not decode, an Attribute map that is not an object,
/// or a converted value that is not a valid legacy answer.
fn plan_draft_conversion(raw: &str, eligible: &[EligibleAttribute]) -> Option<DraftConversion> {
    let input: WorkerDraftInput = serde_json::from_str(raw).ok()?;
    let mut payload: Value = serde_json::from_str(raw).ok()?;

    let update = draft_selections(&input.update.attributes, eligible, "worker draft")?;
    let mut tuples = generate_tuples(&update);
    if let Some(base) = &input.base {
        let base_selections = draft_selections(&base.attributes, eligible, "worker draft base")?;
        for tuple in generate_tuples(&base_selections) {
            if !tuples.contains(&tuple) {
                tuples.push(tuple);
            }
        }
    }

    let mut stripped = false;
    for part in ["update", "base"] {
        let Some(attributes) = payload
            .get_mut(part)
            .and_then(|part| part.get_mut("attributes"))
            .and_then(Value::as_object_mut)
        else {
            continue;
        };
        for attribute in eligible {
            if attributes.remove(&attribute.id).is_some() {
                stripped = true;
            }
        }
    }

    Some(DraftConversion {
        payload,
        stripped,
        tuples,
    })
}

/// The draft's Attribute map as selections in converted-Attribute order. A missing key is no
/// answer; a value the legacy definition cannot hold makes the whole draft untouched.
fn draft_selections(
    attributes: &Value,
    eligible: &[EligibleAttribute],
    owner: &str,
) -> Option<Vec<(String, Vec<String>)>> {
    let attributes: &Map<String, Value> = attributes.as_object()?;
    eligible
        .iter()
        .map(|attribute| {
            selected_answers(attributes.get(&attribute.id), attribute, owner)
                .ok()
                .map(|selected| (attribute.id.clone(), selected))
        })
        .collect()
}

/// Stores one pending assignment draft. Its identity is a new stable creation id, its base is
/// empty (the draft adds an assignment), and it keeps the Worker draft's timestamp exactly.
fn insert_draft(
    conn: &Connection,
    worksite_id: &str,
    worker_id: &str,
    updated_at: &str,
    tuple: &Tuple,
) -> Result<()> {
    let answers: Map<String, Value> = tuple
        .iter()
        .map(|(attribute_id, answer_id)| (attribute_id.clone(), Value::String(answer_id.clone())))
        .collect();
    let payload = serde_json::json!({ "base": {}, "answers": Value::Object(answers) });
    conn.execute(
        "INSERT INTO work_assignment_drafts (worksite_id, worker_id, assignment_id, payload, updated_at) VALUES (?1, ?2, ?3, ?4, ?5)",
        params![
            worksite_id,
            worker_id,
            random_id(),
            serde_json::to_string(&payload)?,
            updated_at
        ],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn selections(values: &[(&str, &[&str])]) -> Vec<(String, Vec<String>)> {
        values
            .iter()
            .map(|(attribute, answers)| {
                (
                    (*attribute).to_owned(),
                    answers.iter().map(|answer| (*answer).to_owned()).collect(),
                )
            })
            .collect()
    }

    fn tuple(pairs: &[(&str, &str)]) -> Tuple {
        pairs
            .iter()
            .map(|(attribute, answer)| ((*attribute).to_owned(), (*answer).to_owned()))
            .collect()
    }

    #[test]
    fn reads_one_stored_shape_and_refuses_the_other() {
        let category = EligibleAttribute {
            id: "dept".to_owned(),
            kind: "category".to_owned(),
            answers: vec!["sales".to_owned(), "marketing".to_owned()],
        };
        assert_eq!(
            selected_answers(Some(&json!("sales")), &category, "w1").unwrap(),
            ["sales"]
        );
        assert!(selected_answers(Some(&json!(["sales"])), &category, "w1").is_err());
        assert!(selected_answers(Some(&json!("missing")), &category, "w1").is_err());

        let tag = EligibleAttribute {
            id: "shift".to_owned(),
            kind: "tag".to_owned(),
            answers: vec!["days".to_owned(), "nights".to_owned()],
        };
        assert_eq!(
            selected_answers(Some(&json!(["days", "days", "", "nights"])), &tag, "w1").unwrap(),
            ["days", "nights"],
            "empty entries are ignored and repeated ids keep their first position"
        );
        assert!(selected_answers(Some(&json!("days")), &tag, "w1").is_err());
        assert!(selected_answers(Some(&json!([1])), &tag, "w1").is_err());
    }

    #[test]
    fn recognizes_only_the_bounded_trimmed_names() {
        for name in [
            "Department",
            " departments ",
            "UBICACIÓN",
            "Tiendas",
            "Puestos",
        ] {
            assert!(is_legacy_name(name), "{name}");
        }
        for name in [
            "Ubicacion",
            "Store A",
            "Position",
            "Team",
            "Department Lead",
        ] {
            assert!(!is_legacy_name(name), "{name}");
        }
    }

    #[test]
    fn builds_one_base_tuple_when_no_attribute_holds_several_answers() {
        let tuples = generate_tuples(&selections(&[
            ("dept", &["sales"]),
            ("role", &["cashier"]),
            ("shift", &["days"]),
            ("empty", &[]),
        ]));
        assert_eq!(
            tuples,
            vec![tuple(&[
                ("dept", "sales"),
                ("role", "cashier"),
                ("shift", "days")
            ])]
        );
        assert!(generate_tuples(&selections(&[("empty", &[])])).is_empty());
    }

    #[test]
    fn expands_one_multi_answer_attribute_and_several_as_separate_partials() {
        assert_eq!(
            generate_tuples(&selections(&[
                ("dept", &["sales"]),
                ("shift", &["days", "nights"]),
            ])),
            vec![
                tuple(&[("dept", "sales"), ("shift", "days")]),
                tuple(&[("dept", "sales"), ("shift", "nights")]),
            ]
        );

        let tuples = generate_tuples(&selections(&[
            ("dept", &["sales"]),
            ("role", &["cashier"]),
            ("location", &["store-a", "store-b"]),
            ("job", &["cashier-job", "stocker-job"]),
        ]));
        assert_eq!(
            tuples,
            vec![
                tuple(&[
                    ("dept", "sales"),
                    ("role", "cashier"),
                    ("location", "store-a")
                ]),
                tuple(&[
                    ("dept", "sales"),
                    ("role", "cashier"),
                    ("location", "store-b")
                ]),
                tuple(&[
                    ("dept", "sales"),
                    ("role", "cashier"),
                    ("job", "cashier-job")
                ]),
                tuple(&[
                    ("dept", "sales"),
                    ("role", "cashier"),
                    ("job", "stocker-job")
                ]),
            ],
            "no store+job pairs and no product"
        );
        assert!(
            !tuples.iter().any(|tuple| tuple.len() == 4),
            "no tuple combines both multi-answer attributes"
        );
    }

    #[test]
    fn consolidates_exact_duplicate_tuples_and_skips_empty_ones() {
        let tuples = generate_tuples(&selections(&[
            ("dept", &["sales", "sales"]),
            ("role", &["cashier"]),
        ]));
        assert_eq!(
            tuples,
            vec![tuple(&[("dept", "sales"), ("role", "cashier")])],
            "the repeated answer is one multi-answer selection; its tuple is consolidated"
        );
    }
}
