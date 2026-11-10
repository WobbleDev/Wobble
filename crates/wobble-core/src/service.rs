//! Worker service: orchestrates worker writes (create, update, patch, delete, notes, and contact import) over the persistence modules.

use rusqlite::{params, Connection, OptionalExtension, Transaction, TransactionBehavior};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::agitation_persistence::{
    assign_agitation, find_unknown_agitation_ids, save_worker_agitations, unassign_agitation,
};
use crate::assembly::{read_worker, read_workers, Worker};
use crate::attribute_migration::WorkerAttributeDefinition;
use crate::attribute_persistence::{
    default_attribute_values, get_worker_attributes, save_worker_attribute_value,
    save_worker_attribute_values,
};
use crate::error::{Error, Result};
use crate::id::IdSource;
use crate::language_persistence::{find_unknown_language_ids, save_worker_languages};
use crate::phone::clean_import_phone;
use crate::relationship_persistence::{
    add_relationship_pair, has_invalid_relationship, relationship_exists, remove_relationship_pair,
    replace_relationships,
};
use crate::schema::Worksite;
use crate::serialization::{is_worker_attribute_values, is_worker_import_contacts};
use crate::worker_draft_persistence::rekey_new_worker_drafts;
use crate::worker_persistence::insert_worker_record_with_attributes;
use crate::worker_request::{
    decode_worker_patch, decode_worker_update, WorkerAgitationAction, WorkerNoteAction,
    WorkerPatch, WorkerPatchDecode, WorkerRelationshipAction, WorkerTextField, WorkerUpdateDecode,
};

/// The editable fields of one worker, as the create and update routes decode them.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
pub struct WorkerUpdate {
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
    /// Array of `{id, text, timestamp}`.
    #[cfg_attr(feature = "ts", ts(as = "Vec<crate::assembly::WorkerNoteTs>"))]
    pub notes: Value,
}

/// One contact of an import batch. Both details are optional in the request.
#[derive(Debug, Clone, PartialEq)]
pub struct WorkerImportContact {
    pub name: String,
    pub email: Option<String>,
    pub phone: Option<String>,
}

/// `WorkerCreateResult`: the created worker, or the reason it was not created.
///
/// The success variants box their `Worker` so that the enums stay small next to their
/// `String` failure variants (clippy::large_enum_variant). The TS shape is unchanged.
#[derive(Debug, Clone, PartialEq)]
pub enum WorkerCreateResult {
    Created { worker: Box<Worker> },
    NoActiveWorksite,
    InvalidRelationships,
    InvalidAgitations { message: String },
    InvalidLanguages { message: String },
}

/// `WorkerUpdateResult`: the updated worker, or the reason it was not updated.
#[derive(Debug, Clone, PartialEq)]
pub enum WorkerUpdateResult {
    Updated { worker: Box<Worker> },
    NotFound,
    InvalidRelationships,
    InvalidAgitations { message: String },
    InvalidLanguages { message: String },
}

/// `WorkerAgitationResult`.
#[derive(Debug, Clone, PartialEq)]
pub enum WorkerAgitationResult {
    Updated { worker: Box<Worker> },
    NotFound,
    InvalidAgitations { message: String },
}

/// `WorkerLanguageResult`.
#[derive(Debug, Clone, PartialEq)]
pub enum WorkerLanguageResult {
    Updated { worker: Box<Worker> },
    NotFound,
    InvalidLanguages { message: String },
}

/// `WorkerRelationshipResult`: the Worker whose pair changed, or the reason it did not.
#[derive(Debug, Clone, PartialEq)]
pub enum WorkerRelationshipResult {
    Updated {
        worker: Box<Worker>,
    },
    NotFound,
    /// The other id is this Worker, or a Worker this Worksite does not have.
    InvalidOtherWorker,
    /// Add only: the pair is already stored, in either order.
    AlreadyRelated,
    /// Remove only: there was no such pair.
    NotRelated,
}

/// `getWorkers`: every worker of the Worksite, through the assembly read.
pub fn get_workers(conn: &Connection, worksite: Option<&Worksite>) -> Result<Vec<Worker>> {
    read_workers(conn, &worksite.cloned())
}

/// `findWorkerById`: service.ts keeps its own prepared statement for this, as the TS
/// does, rather than reaching into relationship-persistence.
fn worker_exists(conn: &Connection, worker_id: &str, worksite_id: &str) -> Result<bool> {
    let exists: Option<i64> = conn
        .query_row(
            "SELECT 1 FROM workers WHERE id = ?1 AND worksite_id = ?2",
            params![worker_id, worksite_id],
            |row| row.get(0),
        )
        .optional()?;

    Ok(exists.is_some())
}

/// `unknownAgitationsMessage`.
fn unknown_agitations_message(ids: &[String]) -> String {
    format!(
        "Worker references unknown agitation(s): {}.",
        ids.join(", ")
    )
}

/// `unknownLanguagesMessage`.
fn unknown_languages_message(ids: &[String]) -> String {
    format!("Worker references unknown language(s): {}.", ids.join(", "))
}

/// `unknownAgitationResult`: the message when any id is unknown, else `None`. The TS
/// returns a tagged failure object; the message is the only thing it carries into the
/// three result enums, so that is what this returns.
fn unknown_agitations(
    conn: &Connection,
    worksite: &Worksite,
    ids: &[String],
) -> Result<Option<String>> {
    let unknown = find_unknown_agitation_ids(conn, worksite, ids)?;
    if unknown.is_empty() {
        return Ok(None);
    }

    Ok(Some(unknown_agitations_message(&unknown)))
}

/// `unknownLanguageResult`: as above, for languages.
fn unknown_languages(
    conn: &Connection,
    worksite: &Worksite,
    ids: &[String],
) -> Result<Option<String>> {
    let unknown = find_unknown_language_ids(conn, worksite, ids)?;
    if unknown.is_empty() {
        return Ok(None);
    }

    Ok(Some(unknown_languages_message(&unknown)))
}

/// `createWorker`: one deferred transaction that mints the id, rejects relationships
/// and unknown assignments before writing anything, then inserts and reads back.
pub fn create_worker(
    conn: &Connection,
    worksite: Option<&Worksite>,
    values: &WorkerUpdate,
    attributes: &[WorkerAttributeDefinition],
    id_source: &impl IdSource,
) -> Result<WorkerCreateResult> {
    let Some(worksite) = worksite else {
        return Ok(WorkerCreateResult::NoActiveWorksite);
    };

    let tx = Transaction::new_unchecked(conn, TransactionBehavior::Deferred)?;

    // The id is minted before the checks, exactly as `randomUUID()` is in the TS.
    let worker_id = id_source.next_id();

    if has_invalid_relationship(&tx, worksite, &worker_id, &values.relationships)? {
        return Ok(WorkerCreateResult::InvalidRelationships);
    }
    if let Some(message) = unknown_agitations(&tx, worksite, &values.agitations)? {
        return Ok(WorkerCreateResult::InvalidAgitations { message });
    }
    if let Some(message) = unknown_languages(&tx, worksite, &values.languages)? {
        return Ok(WorkerCreateResult::InvalidLanguages { message });
    }

    insert_worker_record_with_attributes(&tx, worksite, &worker_id, values, attributes)?;
    replace_relationships(&tx, worksite, &worker_id, &values.relationships)?;
    // A draft started in the New Worker form belongs to this Worker now.
    rekey_new_worker_drafts(&tx, &worksite.id, &worker_id)?;

    let Some(worker) = read_worker(&tx, &Some(worksite.clone()), &worker_id)? else {
        return Err(Error::Message(format!(
            "Created worker \"{worker_id}\" could not be loaded."
        )));
    };

    tx.commit()?;

    Ok(WorkerCreateResult::Created {
        worker: Box::new(worker),
    })
}

/// `updateWorker`: one deferred transaction; the worker must exist, then relationships
/// and assignments are checked before the row and its children are rewritten.
pub fn update_worker(
    conn: &Connection,
    worksite: Option<&Worksite>,
    worker_id: &str,
    values: &WorkerUpdate,
    attributes: &[WorkerAttributeDefinition],
) -> Result<WorkerUpdateResult> {
    let Some(worksite) = worksite else {
        return Ok(WorkerUpdateResult::NotFound);
    };

    let tx = Transaction::new_unchecked(conn, TransactionBehavior::Deferred)?;

    if !worker_exists(&tx, worker_id, &worksite.id)? {
        return Ok(WorkerUpdateResult::NotFound);
    }
    if has_invalid_relationship(&tx, worksite, worker_id, &values.relationships)? {
        return Ok(WorkerUpdateResult::InvalidRelationships);
    }
    if let Some(message) = unknown_agitations(&tx, worksite, &values.agitations)? {
        return Ok(WorkerUpdateResult::InvalidAgitations { message });
    }
    if let Some(message) = unknown_languages(&tx, worksite, &values.languages)? {
        return Ok(WorkerUpdateResult::InvalidLanguages { message });
    }

    tx.execute(
        "UPDATE workers SET name = ?1, email = ?2, phone = ?3, assessment = ?4, notes = ?5 \
         WHERE id = ?6 AND worksite_id = ?7",
        params![
            values.name,
            values.email,
            values.phone,
            values.assessment,
            serde_json::to_string(&values.notes)?,
            worker_id,
            worksite.id,
        ],
    )?;

    save_worker_attribute_values(&tx, worksite, worker_id, &values.attributes, attributes)?;
    save_worker_agitations(&tx, worksite, worker_id, &values.agitations)?;
    save_worker_languages(&tx, worksite, worker_id, &values.languages)?;
    replace_relationships(&tx, worksite, worker_id, &values.relationships)?;

    let Some(worker) = read_worker(&tx, &Some(worksite.clone()), worker_id)? else {
        return Ok(WorkerUpdateResult::NotFound);
    };

    tx.commit()?;

    Ok(WorkerUpdateResult::Updated {
        worker: Box::new(worker),
    })
}

/// `deleteWorker`: true when a row was removed through the cascade.
pub fn delete_worker(
    conn: &Connection,
    worksite: Option<&Worksite>,
    worker_id: &str,
) -> Result<bool> {
    let Some(worksite) = worksite else {
        return Ok(false);
    };

    let removed = conn.execute(
        "DELETE FROM workers WHERE id = ?1 AND worksite_id = ?2",
        params![worker_id, worksite.id],
    )?;

    Ok(removed > 0)
}

/// `updateWorkerAssessment`: the assessment only, or nothing when no row matched.
pub fn update_worker_assessment(
    conn: &Connection,
    worksite: Option<&Worksite>,
    worker_id: &str,
    assessment: &str,
) -> Result<Option<Worker>> {
    let Some(worksite) = worksite else {
        return Ok(None);
    };

    let updated = conn.execute(
        "UPDATE workers SET assessment = ?1 WHERE id = ?2 AND worksite_id = ?3",
        params![assessment, worker_id, worksite.id],
    )?;
    if updated == 0 {
        return Ok(None);
    }

    read_worker(conn, &Some(worksite.clone()), worker_id)
}

/// `updateWorkerField`: one of the Worker's free-text fields, or nothing when no row
/// matched. The row is scoped by Worksite, so an unknown Worker and one of another
/// Worksite are the same answer. The value arrives already trimmed and validated.
pub fn update_worker_field(
    conn: &Connection,
    worksite: Option<&Worksite>,
    worker_id: &str,
    field: WorkerTextField,
    value: &str,
) -> Result<Option<Worker>> {
    let Some(worksite) = worksite else {
        return Ok(None);
    };

    let updated = conn.execute(
        &format!(
            "UPDATE workers SET {} = ?1 WHERE id = ?2 AND worksite_id = ?3",
            field.column()
        ),
        params![value, worker_id, worksite.id],
    )?;
    if updated == 0 {
        return Ok(None);
    }

    read_worker(conn, &Some(worksite.clone()), worker_id)
}

/// `addWorkerNote`: appends one Note to the Worker's stored list. The core mints the
/// Note's id and writes its `timestamp` with SQLite's own clock, so a client can never
/// claim when a conversation was written down.
pub fn add_worker_note(
    conn: &Connection,
    worksite: Option<&Worksite>,
    worker_id: &str,
    text: &str,
    id_source: &impl IdSource,
) -> Result<Option<Worker>> {
    let Some(worksite) = worksite else {
        return Ok(None);
    };
    let Some(worker) = read_worker(conn, &Some(worksite.clone()), worker_id)? else {
        return Ok(None);
    };

    // The same stamp the Worker draft table uses, so every core-written instant
    // has one shape.
    let timestamp: String =
        conn.query_row("SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now')", [], |row| {
            row.get(0)
        })?;

    let mut notes = worker.notes.as_array().cloned().unwrap_or_default();
    notes.push(serde_json::json!({
        "id": id_source.next_id(),
        "text": text,
        "timestamp": timestamp,
    }));

    save_worker_notes(conn, worksite, worker_id, &Value::Array(notes))?;

    read_worker(conn, &Some(worksite.clone()), worker_id)
}

/// `editWorkerNote`: rewrites one Note's text in place. Its `timestamp` (when
/// it was written) never changes. `editedAt` moves to now only when the text
/// actually changed, unless the caller restores an earlier `editedAt` (an Undo), in
/// which case it is put back exactly. A note id that is not there writes nothing.
pub fn edit_worker_note(
    conn: &Connection,
    worksite: Option<&Worksite>,
    worker_id: &str,
    edit: &Value,
) -> Result<Option<Worker>> {
    let Some(worksite) = worksite else {
        return Ok(None);
    };
    let Some(worker) = read_worker(conn, &Some(worksite.clone()), worker_id)? else {
        return Ok(None);
    };
    let note_id = edit.get("id").and_then(Value::as_str).unwrap_or_default();
    let text = edit.get("text").and_then(Value::as_str).unwrap_or_default();

    let mut notes = worker.notes.as_array().cloned().unwrap_or_default();
    let Some(note) = notes
        .iter_mut()
        .find(|note| note.get("id").and_then(Value::as_str) == Some(note_id))
    else {
        return read_worker(conn, &Some(worksite.clone()), worker_id);
    };

    let changed = note.get("text").and_then(Value::as_str) != Some(text);
    let restored = edit.get("editedAt");
    if !changed && restored.is_none() {
        return read_worker(conn, &Some(worksite.clone()), worker_id);
    }

    note["text"] = Value::from(text);
    // A Note written before dates were dropped may still carry one; it goes now.
    if let Some(object) = note.as_object_mut() {
        object.remove("occurredOn");
    }
    match restored {
        Some(Value::Null) => {
            if let Some(object) = note.as_object_mut() {
                object.remove("editedAt");
            }
        }
        Some(stamp) => note["editedAt"] = stamp.clone(),
        None => {
            let now: String =
                conn.query_row("SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now')", [], |row| {
                    row.get(0)
                })?;
            note["editedAt"] = Value::from(now);
        }
    }

    save_worker_notes(conn, worksite, worker_id, &Value::Array(notes))?;

    read_worker(conn, &Some(worksite.clone()), worker_id)
}

/// `deleteWorkerNote`: takes one Note off the Worker's list by id. A note id that is
/// not there writes nothing and still answers the Worker, so an Undo that has already
/// done its work is never reported as a failure.
pub fn delete_worker_note(
    conn: &Connection,
    worksite: Option<&Worksite>,
    worker_id: &str,
    note_id: &str,
) -> Result<Option<Worker>> {
    let Some(worksite) = worksite else {
        return Ok(None);
    };
    let Some(worker) = read_worker(conn, &Some(worksite.clone()), worker_id)? else {
        return Ok(None);
    };

    let notes = worker.notes.as_array().cloned().unwrap_or_default();
    let kept: Vec<Value> = notes
        .into_iter()
        .filter(|note| note.get("id").and_then(Value::as_str) != Some(note_id))
        .collect();

    if kept.len() < worker.notes.as_array().map_or(0, Vec::len) {
        save_worker_notes(conn, worksite, worker_id, &Value::Array(kept))?;
    }

    read_worker(conn, &Some(worksite.clone()), worker_id)
}

/// `restoreWorkerNote`: puts a deleted Note back exactly as it was — the same id,
/// text, `timestamp` and `editedAt` — which is what its Undo sends.
/// The list reads by written time, so putting it back is all the position it needs. A note
/// id that is already there writes nothing, so a second Undo cannot duplicate it.
pub fn restore_worker_note(
    conn: &Connection,
    worksite: Option<&Worksite>,
    worker_id: &str,
    note: &Value,
) -> Result<Option<Worker>> {
    let Some(worksite) = worksite else {
        return Ok(None);
    };
    let Some(worker) = read_worker(conn, &Some(worksite.clone()), worker_id)? else {
        return Ok(None);
    };
    let note_id = note.get("id").and_then(Value::as_str).unwrap_or_default();

    let mut notes = worker.notes.as_array().cloned().unwrap_or_default();
    if notes
        .iter()
        .any(|existing| existing.get("id").and_then(Value::as_str) == Some(note_id))
    {
        return read_worker(conn, &Some(worksite.clone()), worker_id);
    }

    notes.push(note.clone());
    save_worker_notes(conn, worksite, worker_id, &Value::Array(notes))?;

    read_worker(conn, &Some(worksite.clone()), worker_id)
}

/// The Notes column is one JSON array, so a Note change rewrites it whole.
fn save_worker_notes(
    conn: &Connection,
    worksite: &Worksite,
    worker_id: &str,
    notes: &Value,
) -> Result<()> {
    conn.execute(
        "UPDATE workers SET notes = ?1 WHERE id = ?2 AND worksite_id = ?3",
        params![notes.to_string(), worker_id, worksite.id],
    )?;

    Ok(())
}

/// `updateWorkerAgitations`: the worker must exist before its assignment list is even
/// looked at; unknown ids are rejected rather than left to the foreign key.
pub fn update_worker_agitations(
    conn: &Connection,
    worksite: Option<&Worksite>,
    worker_id: &str,
    ids: &[String],
) -> Result<WorkerAgitationResult> {
    let Some(worksite) = worksite else {
        return Ok(WorkerAgitationResult::NotFound);
    };
    if !worker_exists(conn, worker_id, &worksite.id)? {
        return Ok(WorkerAgitationResult::NotFound);
    }

    if let Some(message) = unknown_agitations(conn, worksite, ids)? {
        return Ok(WorkerAgitationResult::InvalidAgitations { message });
    }

    save_worker_agitations(conn, worksite, worker_id, ids)?;

    match read_worker(conn, &Some(worksite.clone()), worker_id)? {
        Some(worker) => Ok(WorkerAgitationResult::Updated {
            worker: Box::new(worker),
        }),
        None => Ok(WorkerAgitationResult::NotFound),
    }
}

/// One Agitation linked to, or unlinked from, one Worker. The Worker has to exist and the
/// Agitation has to belong to this Worksite; either change is idempotent, so an Undo that
/// meets a link already in the state it wants reports success rather than failing.
fn change_worker_agitation(
    conn: &Connection,
    worksite: Option<&Worksite>,
    worker_id: &str,
    agitation_id: &str,
    assign: bool,
) -> Result<WorkerAgitationResult> {
    let Some(worksite) = worksite else {
        return Ok(WorkerAgitationResult::NotFound);
    };
    if !worker_exists(conn, worker_id, &worksite.id)? {
        return Ok(WorkerAgitationResult::NotFound);
    }
    if let Some(message) = unknown_agitations(conn, worksite, &[agitation_id.to_owned()])? {
        return Ok(WorkerAgitationResult::InvalidAgitations { message });
    }

    if assign {
        assign_agitation(conn, worker_id, agitation_id)?;
    } else {
        unassign_agitation(conn, worker_id, agitation_id)?;
    }

    match read_worker(conn, &Some(worksite.clone()), worker_id)? {
        Some(worker) => Ok(WorkerAgitationResult::Updated {
            worker: Box::new(worker),
        }),
        None => Ok(WorkerAgitationResult::NotFound),
    }
}

/// `assignWorkerAgitation`: links one Agitation to the Worker.
pub fn assign_worker_agitation(
    conn: &Connection,
    worksite: Option<&Worksite>,
    worker_id: &str,
    agitation_id: &str,
) -> Result<WorkerAgitationResult> {
    change_worker_agitation(conn, worksite, worker_id, agitation_id, true)
}

/// `unassignWorkerAgitation`: unlinks one Agitation from the Worker only; the shared
/// Agitation and every other Worker's assignment stay.
pub fn unassign_worker_agitation(
    conn: &Connection,
    worksite: Option<&Worksite>,
    worker_id: &str,
    agitation_id: &str,
) -> Result<WorkerAgitationResult> {
    change_worker_agitation(conn, worksite, worker_id, agitation_id, false)
}

/// `updateWorkerLanguages`: as above, for languages.
pub fn update_worker_languages(
    conn: &Connection,
    worksite: Option<&Worksite>,
    worker_id: &str,
    ids: &[String],
) -> Result<WorkerLanguageResult> {
    let Some(worksite) = worksite else {
        return Ok(WorkerLanguageResult::NotFound);
    };
    if !worker_exists(conn, worker_id, &worksite.id)? {
        return Ok(WorkerLanguageResult::NotFound);
    }

    if let Some(message) = unknown_languages(conn, worksite, ids)? {
        return Ok(WorkerLanguageResult::InvalidLanguages { message });
    }

    save_worker_languages(conn, worksite, worker_id, ids)?;

    match read_worker(conn, &Some(worksite.clone()), worker_id)? {
        Some(worker) => Ok(WorkerLanguageResult::Updated {
            worker: Box::new(worker),
        }),
        None => Ok(WorkerLanguageResult::NotFound),
    }
}

/// `addWorkerRelationship`: one normalized pair, symmetric by construction. The other
/// Worker has to be a different Worker of this Worksite, and the pair must be new — a
/// duplicate in either order is refused rather than written twice.
pub fn add_worker_relationship(
    conn: &Connection,
    worksite: Option<&Worksite>,
    worker_id: &str,
    other_worker_id: &str,
) -> Result<WorkerRelationshipResult> {
    let Some(worksite) = worksite else {
        return Ok(WorkerRelationshipResult::NotFound);
    };
    if !worker_exists(conn, worker_id, &worksite.id)? {
        return Ok(WorkerRelationshipResult::NotFound);
    }
    if other_worker_id == worker_id || !worker_exists(conn, other_worker_id, &worksite.id)? {
        return Ok(WorkerRelationshipResult::InvalidOtherWorker);
    }
    if relationship_exists(conn, worker_id, other_worker_id)? {
        return Ok(WorkerRelationshipResult::AlreadyRelated);
    }

    add_relationship_pair(conn, worker_id, other_worker_id)?;

    match read_worker(conn, &Some(worksite.clone()), worker_id)? {
        Some(worker) => Ok(WorkerRelationshipResult::Updated {
            worker: Box::new(worker),
        }),
        None => Ok(WorkerRelationshipResult::NotFound),
    }
}

/// `removeWorkerRelationship`: takes one normalized pair off, whichever way round the two
/// Workers are named. A pair that is not stored is refused, so an Undo cannot report a
/// removal that never happened.
pub fn remove_worker_relationship(
    conn: &Connection,
    worksite: Option<&Worksite>,
    worker_id: &str,
    other_worker_id: &str,
) -> Result<WorkerRelationshipResult> {
    let Some(worksite) = worksite else {
        return Ok(WorkerRelationshipResult::NotFound);
    };
    if !worker_exists(conn, worker_id, &worksite.id)? {
        return Ok(WorkerRelationshipResult::NotFound);
    }
    if other_worker_id == worker_id || !worker_exists(conn, other_worker_id, &worksite.id)? {
        return Ok(WorkerRelationshipResult::InvalidOtherWorker);
    }
    if !remove_relationship_pair(conn, worker_id, other_worker_id)? {
        return Ok(WorkerRelationshipResult::NotRelated);
    }

    match read_worker(conn, &Some(worksite.clone()), worker_id)? {
        Some(worker) => Ok(WorkerRelationshipResult::Updated {
            worker: Box::new(worker),
        }),
        None => Ok(WorkerRelationshipResult::NotFound),
    }
}

/// `updateWorkerAttribute`: one attribute value patched onto the worker's current values,
/// with the *whole* merged object re-validated against the configuration before it is
/// saved. The two throws are unreachable from PATCH, which already validated the value.
pub fn update_worker_attribute(
    conn: &Connection,
    worksite: Option<&Worksite>,
    worker_id: &str,
    attribute_id: &str,
    value: &Value,
) -> Result<Option<Worker>> {
    let Some(worksite) = worksite else {
        return Ok(None);
    };

    let attributes = get_worker_attributes(conn, &Some(worksite.clone()))?;
    if !attributes
        .iter()
        .any(|candidate| candidate.id == attribute_id)
    {
        return Err(Error::Message(format!(
            "Unknown worker attribute \"{attribute_id}\"."
        )));
    }

    let Some(existing) = read_worker(conn, &Some(worksite.clone()), worker_id)? else {
        return Ok(None);
    };

    // `{ ...existing.attributes, [attributeId]: value }` — `decode_attributes` proved the
    // stored value is an object, so a non-object here can only fail the guard below.
    let mut merged = existing.attributes.clone();
    if let Some(fields) = merged.as_object_mut() {
        fields.insert(attribute_id.to_owned(), value.clone());
    }

    let definition_values: Vec<Value> = attributes
        .iter()
        .map(serde_json::to_value)
        .collect::<serde_json::Result<Vec<Value>>>()?;
    if !is_worker_attribute_values(&merged, &definition_values) {
        return Err(Error::Message(format!(
            "Invalid value for worker attribute \"{attribute_id}\"."
        )));
    }

    // `values[attributeId]` after that spread is just `value`.
    save_worker_attribute_value(conn, worksite, worker_id, attribute_id, value)?;

    read_worker(conn, &Some(worksite.clone()), worker_id)
}

/// One accepted CSV row: the source row number the review showed, and the contact.
#[derive(Debug, Clone, PartialEq)]
pub struct ImportRow {
    pub row: u32,
    pub contact: WorkerImportContact,
    /// Answers the review chose for existing Attributes, by Attribute id (an answer id, or
    /// a list of them, as the Attribute stores it). Attributes it does not name stay empty.
    pub attributes: serde_json::Map<String, Value>,
}

/// What an import commit answers.
#[derive(Debug, Clone, PartialEq)]
pub enum ImportOutcome {
    /// Every row was created; the source row number and the created id, in request order.
    Created(Vec<(u32, String)>),
    /// The Attribute definitions changed after the review: nothing was created.
    StaleVocabulary,
    /// The Worksite is gone: nothing was created.
    NoWorksite,
}

/// `importWorkers`: one deferred transaction that inserts a named contact per row, each
/// with empty attributes, relationships and notes.
pub fn import_workers(
    conn: &Connection,
    worksite: &Worksite,
    contacts: &[WorkerImportContact],
    id_source: &impl IdSource,
) -> Result<Vec<String>> {
    let rows: Vec<ImportRow> = contacts
        .iter()
        .enumerate()
        .map(|(index, contact)| ImportRow {
            row: u32::try_from(index + 1).unwrap_or(u32::MAX),
            contact: contact.clone(),
            attributes: serde_json::Map::new(),
        })
        .collect();
    match import_reviewed_rows(conn, worksite, &rows, None, id_source)? {
        ImportOutcome::Created(created) => Ok(created.into_iter().map(|(_, id)| id).collect()),
        ImportOutcome::StaleVocabulary | ImportOutcome::NoWorksite => Err(Error::Message(
            "The Worksite changed during the import.".to_owned(),
        )),
    }
}

/// The accepted rows of a reviewed CSV, created in one deferred transaction. Revalidation
/// points, all inside that transaction: the Worksite row is still there; the Attribute
/// definitions are read live (the new Workers take their empty values from them) and, when
/// the review named the definitions it saw, they must be the same set; every name is
/// non-blank. Any refusal rolls everything back, so a stale review never creates.
pub fn import_reviewed_rows(
    conn: &Connection,
    worksite: &Worksite,
    rows: &[ImportRow],
    reviewed_attribute_ids: Option<&[String]>,
    id_source: &impl IdSource,
) -> Result<ImportOutcome> {
    let tx = Transaction::new_unchecked(conn, TransactionBehavior::Deferred)?;

    let live: Option<String> = tx
        .query_row(
            "SELECT id FROM worksites WHERE id = ?1",
            rusqlite::params![worksite.id],
            |row| row.get(0),
        )
        .optional()?;
    if live.is_none() {
        return Ok(ImportOutcome::NoWorksite);
    }

    let attributes = get_worker_attributes(&tx, &Some(worksite.clone()))?;
    if let Some(reviewed) = reviewed_attribute_ids {
        let mut seen: Vec<&str> = reviewed.iter().map(String::as_str).collect();
        let mut current: Vec<&str> = attributes.iter().map(|a| a.id.as_str()).collect();
        seen.sort_unstable();
        current.sort_unstable();
        if seen != current {
            return Ok(ImportOutcome::StaleVocabulary);
        }
    }
    let empty_values = default_attribute_values(&attributes);

    // Each row's chosen answers are decoded against the live definitions, here, before
    // anything is written: an Attribute or answer that is gone, or answers the select modes
    // no longer allow together, make the review stale. Import never creates vocabulary.
    let definitions = attribute_definition_values(&attributes)?;
    let mut values_by_row: Vec<Value> = Vec::with_capacity(rows.len());
    for import_row in rows {
        let mut values = empty_values.clone();
        if let Some(fields) = values.as_object_mut() {
            for (attribute_id, value) in &import_row.attributes {
                if !fields.contains_key(attribute_id) {
                    return Ok(ImportOutcome::StaleVocabulary);
                }
                fields.insert(attribute_id.clone(), value.clone());
            }
        }
        if !import_row.attributes.is_empty() && !is_worker_attribute_values(&values, &definitions) {
            return Ok(ImportOutcome::StaleVocabulary);
        }
        values_by_row.push(values);
    }

    let mut created = Vec::new();
    for (ImportRow { row, contact, .. }, values) in rows.iter().zip(values_by_row) {
        let name = contact.name.trim();
        if name.is_empty() {
            return Err(Error::Message(
                "Imported workers must have a name.".to_owned(),
            ));
        }

        let id = id_source.next_id();
        insert_worker_record_with_attributes(
            &tx,
            worksite,
            &id,
            &WorkerUpdate {
                name: name.to_owned(),
                email: contact
                    .email
                    .as_deref()
                    .unwrap_or_default()
                    .trim()
                    .to_owned(),
                // Every non-digit is stripped, a clean number is stored formatted and
                // anything else as empty, so what the import preview promises is what the
                // row holds.
                phone: clean_import_phone(contact.phone.as_deref().unwrap_or_default())
                    .unwrap_or_default(),
                assessment: "Unassessed".to_owned(),
                attributes: values,
                agitations: Vec::new(),
                languages: Vec::new(),
                relationships: Vec::new(),
                notes: Value::Array(Vec::new()),
            },
            &attributes,
        )?;
        created.push((*row, id));
    }

    tx.commit()?;

    Ok(ImportOutcome::Created(created))
}

/// The message a Worker body with no usable name answers.
const CONTACT_NAME_REQUIRED_MESSAGE: &str = "Contact name is required.";
/// The message an import batch that is not a list of named contacts answers.
const INVALID_IMPORT_MESSAGE: &str =
    "Import must include at least one contact, and every contact must have a name.";

/// What a request-shaped service call did: it refused the body before any write, or it
/// ran and produced `T`. A refusal is the `invalid_worker` 400 of the Worker routes.
#[derive(Debug, Clone, PartialEq)]
pub enum PayloadOutcome<T> {
    Invalid { message: String },
    Done(T),
}

/// The typed definitions as the decoders take them: as `Value`s.
fn attribute_definition_values(attributes: &[WorkerAttributeDefinition]) -> Result<Vec<Value>> {
    Ok(attributes
        .iter()
        .map(serde_json::to_value)
        .collect::<serde_json::Result<Vec<Value>>>()?)
}

/// New Worker, which names a Worker and nothing else: creates an Unassessed Worker whose
/// every Attribute answer is empty. The caller has already refused a blank name.
pub fn create_named_worker(
    conn: &Connection,
    worksite: &Worksite,
    name: &str,
    id_source: &impl IdSource,
) -> Result<WorkerCreateResult> {
    let worksite = Some(worksite.clone());
    let attributes = get_worker_attributes(conn, &worksite)?;

    let mut attributes_value = serde_json::Map::new();
    for attribute in &attributes {
        let empty = if attribute.kind == "tag" {
            json!([])
        } else {
            json!("")
        };
        attributes_value.insert(attribute.id.clone(), empty);
    }

    let update = WorkerUpdate {
        name: name.to_owned(),
        email: String::new(),
        phone: String::new(),
        assessment: "Unassessed".to_owned(),
        attributes: Value::Object(attributes_value),
        agitations: vec![],
        languages: vec![],
        relationships: vec![],
        notes: json!([]),
    };

    create_worker(conn, worksite.as_ref(), &update, &attributes, id_source)
}

/// Creates one Worker from a full request body: decodes it against the Worksite's
/// Attribute definitions, refuses a blank name, then creates.
pub fn create_worker_from_payload(
    conn: &Connection,
    worksite: &Worksite,
    payload: &Value,
    id_source: &impl IdSource,
) -> Result<PayloadOutcome<WorkerCreateResult>> {
    let worksite = Some(worksite.clone());
    let attributes = get_worker_attributes(conn, &worksite)?;
    let definition_values = attribute_definition_values(&attributes)?;

    let update = match decode_worker_update(payload, &definition_values) {
        WorkerUpdateDecode::Ok { update } => update,
        WorkerUpdateDecode::Invalid { message } => {
            return Ok(PayloadOutcome::Invalid { message });
        }
    };
    let update: WorkerUpdate = serde_json::from_value(update)?;

    // The decode trims the name, so a blank one is what is left of a whitespace name.
    if update.name.is_empty() {
        return Ok(PayloadOutcome::Invalid {
            message: CONTACT_NAME_REQUIRED_MESSAGE.to_owned(),
        });
    }

    Ok(PayloadOutcome::Done(create_worker(
        conn,
        worksite.as_ref(),
        &update,
        &attributes,
        id_source,
    )?))
}

/// Imports a contact batch from a request body: a list of named contacts, or
/// `{contacts, attributeIds}` when the review names the Attribute definitions it saw. A
/// contact may carry its source `row` number; without one it is its position. Answers the
/// created ids against those row numbers, in order.
pub fn import_workers_from_payload(
    conn: &Connection,
    worksite: &Worksite,
    payload: &Value,
    id_source: &impl IdSource,
) -> Result<PayloadOutcome<ImportOutcome>> {
    let (contacts_value, reviewed) = match payload {
        Value::Object(body) => {
            let reviewed = match body.get("attributeIds") {
                None => None,
                Some(Value::Array(ids)) if ids.iter().all(Value::is_string) => Some(
                    ids.iter()
                        .filter_map(|id| id.as_str().map(str::to_owned))
                        .collect::<Vec<String>>(),
                ),
                Some(_) => {
                    return Ok(PayloadOutcome::Invalid {
                        message: INVALID_IMPORT_MESSAGE.to_owned(),
                    });
                }
            };
            (body.get("contacts").unwrap_or(&Value::Null), reviewed)
        }
        other => (other, None),
    };

    if !is_worker_import_contacts(contacts_value) {
        return Ok(PayloadOutcome::Invalid {
            message: INVALID_IMPORT_MESSAGE.to_owned(),
        });
    }

    // The guard proved every contact's shape; the fallbacks only keep this total.
    let mut seen_rows = std::collections::HashSet::new();
    let mut rows: Vec<ImportRow> = Vec::new();
    for (index, contact) in contacts_value
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or_default()
        .iter()
        .enumerate()
    {
        let row = match contact.get("row") {
            None | Some(Value::Null) => u32::try_from(index + 1).unwrap_or(u32::MAX),
            Some(value) => match value.as_u64().and_then(|n| u32::try_from(n).ok()) {
                Some(n) if n >= 1 => n,
                _ => {
                    return Ok(PayloadOutcome::Invalid {
                        message: INVALID_IMPORT_MESSAGE.to_owned(),
                    });
                }
            },
        };
        if !seen_rows.insert(row) {
            return Ok(PayloadOutcome::Invalid {
                message: INVALID_IMPORT_MESSAGE.to_owned(),
            });
        }
        let attributes = match contact.get("attributes") {
            None | Some(Value::Null) => serde_json::Map::new(),
            Some(Value::Object(fields)) => fields.clone(),
            Some(_) => {
                return Ok(PayloadOutcome::Invalid {
                    message: INVALID_IMPORT_MESSAGE.to_owned(),
                });
            }
        };
        rows.push(ImportRow {
            row,
            attributes,
            contact: WorkerImportContact {
                name: contact
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_owned(),
                email: contact
                    .get("email")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
                phone: contact
                    .get("phone")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
            },
        });
    }

    Ok(PayloadOutcome::Done(import_reviewed_rows(
        conn,
        worksite,
        &rows,
        reviewed.as_deref(),
        id_source,
    )?))
}

/// Replaces one Worker from a full request body: decodes it against the Worksite's
/// Attribute definitions, then updates.
pub fn update_worker_from_payload(
    conn: &Connection,
    worksite: Option<&Worksite>,
    worker_id: &str,
    payload: &Value,
) -> Result<PayloadOutcome<WorkerUpdateResult>> {
    let attributes = get_worker_attributes(conn, &worksite.cloned())?;
    let definition_values = attribute_definition_values(&attributes)?;

    let update = match decode_worker_update(payload, &definition_values) {
        WorkerUpdateDecode::Ok { update } => update,
        WorkerUpdateDecode::Invalid { message } => {
            return Ok(PayloadOutcome::Invalid { message });
        }
    };
    let update: WorkerUpdate = serde_json::from_value(update)?;

    Ok(PayloadOutcome::Done(update_worker(
        conn,
        worksite,
        worker_id,
        &update,
        &attributes,
    )?))
}

/// What a Worker patch did, whichever field it changed.
#[derive(Debug, Clone, PartialEq)]
pub enum WorkerPatchOutcome {
    Updated {
        worker: Box<Worker>,
    },
    NotFound,
    /// An Agitation or Language id the Worksite does not have.
    InvalidVocabulary {
        message: String,
    },
    /// Relationship patches: the other id is this Worker, or not a Worker of this Worksite.
    InvalidOtherWorker,
    AlreadyRelated,
    NotRelated,
}

impl From<Option<Worker>> for WorkerPatchOutcome {
    fn from(worker: Option<Worker>) -> Self {
        match worker {
            Some(worker) => Self::Updated {
                worker: Box::new(worker),
            },
            None => Self::NotFound,
        }
    }
}

impl From<WorkerAgitationResult> for WorkerPatchOutcome {
    fn from(result: WorkerAgitationResult) -> Self {
        match result {
            WorkerAgitationResult::Updated { worker } => Self::Updated { worker },
            WorkerAgitationResult::NotFound => Self::NotFound,
            WorkerAgitationResult::InvalidAgitations { message } => {
                Self::InvalidVocabulary { message }
            }
        }
    }
}

impl From<WorkerLanguageResult> for WorkerPatchOutcome {
    fn from(result: WorkerLanguageResult) -> Self {
        match result {
            WorkerLanguageResult::Updated { worker } => Self::Updated { worker },
            WorkerLanguageResult::NotFound => Self::NotFound,
            WorkerLanguageResult::InvalidLanguages { message } => {
                Self::InvalidVocabulary { message }
            }
        }
    }
}

impl From<WorkerRelationshipResult> for WorkerPatchOutcome {
    fn from(result: WorkerRelationshipResult) -> Self {
        match result {
            WorkerRelationshipResult::Updated { worker } => Self::Updated { worker },
            WorkerRelationshipResult::NotFound => Self::NotFound,
            WorkerRelationshipResult::InvalidOtherWorker => Self::InvalidOtherWorker,
            WorkerRelationshipResult::AlreadyRelated => Self::AlreadyRelated,
            WorkerRelationshipResult::NotRelated => Self::NotRelated,
        }
    }
}

/// `dispatchWorkerPatch`: decodes a patch body against the Worksite's Attribute
/// definitions and applies the one change it names.
pub fn patch_worker_from_payload(
    conn: &Connection,
    worksite: Option<&Worksite>,
    worker_id: &str,
    payload: &Value,
    id_source: &impl IdSource,
) -> Result<PayloadOutcome<WorkerPatchOutcome>> {
    let attributes = get_worker_attributes(conn, &worksite.cloned())?;
    let definition_values = attribute_definition_values(&attributes)?;

    let patch = match decode_worker_patch(payload, &definition_values) {
        WorkerPatchDecode::Ok { patch } => patch,
        WorkerPatchDecode::Invalid { message } => {
            return Ok(PayloadOutcome::Invalid { message });
        }
    };

    let outcome: WorkerPatchOutcome = match patch {
        WorkerPatch::Assessment { value } => {
            update_worker_assessment(conn, worksite, worker_id, &value)?.into()
        }
        WorkerPatch::Agitations { value } => {
            update_worker_agitations(conn, worksite, worker_id, &value)?.into()
        }
        WorkerPatch::Agitation { action, value } => match action {
            WorkerAgitationAction::Assign => {
                assign_worker_agitation(conn, worksite, worker_id, &value)?
            }
            WorkerAgitationAction::Unassign => {
                unassign_worker_agitation(conn, worksite, worker_id, &value)?
            }
        }
        .into(),
        WorkerPatch::Languages { value } => {
            update_worker_languages(conn, worksite, worker_id, &value)?.into()
        }
        WorkerPatch::Text { field, value } => {
            update_worker_field(conn, worksite, worker_id, field, &value)?.into()
        }
        WorkerPatch::Note { action, value } => {
            // The decode proved each action's payload carries its own keys.
            match action {
                WorkerNoteAction::Add => add_worker_note(
                    conn,
                    worksite,
                    worker_id,
                    value
                        .get("text")
                        .and_then(Value::as_str)
                        .unwrap_or_default(),
                    id_source,
                )?,
                WorkerNoteAction::Edit => edit_worker_note(conn, worksite, worker_id, &value)?,
                WorkerNoteAction::Delete => delete_worker_note(
                    conn,
                    worksite,
                    worker_id,
                    value.get("id").and_then(Value::as_str).unwrap_or_default(),
                )?,
                WorkerNoteAction::Restore => {
                    restore_worker_note(conn, worksite, worker_id, &value)?
                }
            }
            .into()
        }
        WorkerPatch::Relationship { action, value } => match action {
            WorkerRelationshipAction::Add => {
                add_worker_relationship(conn, worksite, worker_id, &value)?
            }
            WorkerRelationshipAction::Remove => {
                remove_worker_relationship(conn, worksite, worker_id, &value)?
            }
        }
        .into(),
        // The patch decode already proved the attribute exists and the value fits it, so
        // this call's two `Err`s are unreachable here and would answer 500 if they ever were.
        WorkerPatch::Attribute {
            attribute_id,
            value,
        } => update_worker_attribute(conn, worksite, worker_id, &attribute_id, &value)?.into(),
    };

    Ok(PayloadOutcome::Done(outcome))
}

#[cfg(test)]
mod tests {
    use super::*;

    use crate::agitation_persistence::{create_agitation, get_agitations};
    use crate::db::{open_seeded, Db};
    use crate::id::{counter_id, CounterId};
    use crate::language_persistence::{create_language, get_languages};
    use crate::worksite_persistence::resolve_active_worksite;
    use serde_json::json;

    fn seeded() -> (Db, CounterId, Worksite) {
        let ids = CounterId::new();
        let db = open_seeded(":memory:", &ids).unwrap();
        let worksite = resolve_active_worksite(db.conn(), None).unwrap().unwrap();
        (db, ids, worksite)
    }

    fn attributes_of(conn: &Connection, worksite: &Worksite) -> Vec<WorkerAttributeDefinition> {
        get_worker_attributes(conn, &Some(worksite.clone())).unwrap()
    }

    /// The spec's `draft()`: a valid update over the Worksite's own configuration.
    fn draft(attributes: &[WorkerAttributeDefinition]) -> WorkerUpdate {
        WorkerUpdate {
            name: "Test Worker".to_owned(),
            email: "test@example.com".to_owned(),
            phone: String::new(),
            assessment: "Unassessed".to_owned(),
            attributes: default_attribute_values(attributes),
            agitations: Vec::new(),
            languages: Vec::new(),
            relationships: Vec::new(),
            notes: json!([]),
        }
    }

    fn created(result: WorkerCreateResult) -> Worker {
        match result {
            WorkerCreateResult::Created { worker } => *worker,
            other => panic!("expected the worker to be created, got {other:?}"),
        }
    }

    fn updated(result: WorkerUpdateResult) -> Worker {
        match result {
            WorkerUpdateResult::Updated { worker } => *worker,
            other => panic!("expected the worker to be updated, got {other:?}"),
        }
    }

    fn message(failure: WorkerUpdateResult) -> String {
        match failure {
            WorkerUpdateResult::InvalidAgitations { message }
            | WorkerUpdateResult::InvalidLanguages { message } => message,
            other => panic!("expected an invalid-assignment failure, got {other:?}"),
        }
    }

    #[test]
    fn creates_a_worker_and_reads_it_back() {
        let (db, ids, worksite) = seeded();
        let attributes = attributes_of(db.conn(), &worksite);

        let mut values = draft(&attributes);
        values.name = "Rosalind Franklin".to_owned();
        let worker =
            created(create_worker(db.conn(), Some(&worksite), &values, &attributes, &ids).unwrap());

        assert_eq!(worker.name, "Rosalind Franklin");
        assert_eq!(worker.agitations, Vec::<String>::new());
        assert_eq!(worker.notes, json!([]));
        assert_eq!(get_workers(db.conn(), Some(&worksite)).unwrap().len(), 1);
    }

    #[test]
    fn reports_an_unknown_agitation_instead_of_failing_on_the_foreign_key() {
        let (db, ids, worksite) = seeded();
        let attributes = attributes_of(db.conn(), &worksite);

        let mut values = draft(&attributes);
        values.agitations = vec!["nope".to_owned()];
        let result = create_worker(db.conn(), Some(&worksite), &values, &attributes, &ids).unwrap();

        assert_eq!(
            result,
            WorkerCreateResult::InvalidAgitations {
                message: "Worker references unknown agitation(s): nope.".to_owned()
            }
        );
        assert_eq!(get_workers(db.conn(), Some(&worksite)).unwrap(), Vec::new());
    }

    #[test]
    fn reports_an_unknown_language_instead_of_failing_on_the_foreign_key() {
        let (db, ids, worksite) = seeded();
        let attributes = attributes_of(db.conn(), &worksite);

        let mut values = draft(&attributes);
        values.languages = vec!["nope".to_owned()];
        let result = create_worker(db.conn(), Some(&worksite), &values, &attributes, &ids).unwrap();

        assert_eq!(
            result,
            WorkerCreateResult::InvalidLanguages {
                message: "Worker references unknown language(s): nope.".to_owned()
            }
        );
        assert_eq!(get_workers(db.conn(), Some(&worksite)).unwrap(), Vec::new());
    }

    #[test]
    fn reports_a_relationship_that_points_at_nobody() {
        let (db, ids, worksite) = seeded();
        let attributes = attributes_of(db.conn(), &worksite);

        let mut values = draft(&attributes);
        values.relationships = vec!["nope".to_owned()];

        assert_eq!(
            create_worker(db.conn(), Some(&worksite), &values, &attributes, &ids).unwrap(),
            WorkerCreateResult::InvalidRelationships
        );
    }

    #[test]
    fn keeps_notes_that_were_written_against_the_worker() {
        let (db, ids, worksite) = seeded();
        let attributes = attributes_of(db.conn(), &worksite);
        let notes = json!([{
            "id": "n1",
            "text": "Prefers mornings",
            "timestamp": "2026-09-02T10:00:00.000Z"
        }]);

        let mut values = draft(&attributes);
        values.notes = notes.clone();
        let worker =
            created(create_worker(db.conn(), Some(&worksite), &values, &attributes, &ids).unwrap());

        assert_eq!(worker.notes, notes);
    }

    #[test]
    fn create_without_a_worksite_reports_no_active_worksite_and_mints_nothing() {
        let (db, ids, worksite) = seeded();
        let attributes = attributes_of(db.conn(), &worksite);

        assert_eq!(
            create_worker(db.conn(), None, &draft(&attributes), &attributes, &ids).unwrap(),
            WorkerCreateResult::NoActiveWorksite
        );
        assert_eq!(ids.next_id(), counter_id(5));
    }

    #[test]
    fn reports_an_unknown_agitation_without_writing_anything_else() {
        let (db, ids, worksite) = seeded();
        let attributes = attributes_of(db.conn(), &worksite);
        let mut values = draft(&attributes);
        values.name = "Rosalind Franklin".to_owned();
        let worker =
            created(create_worker(db.conn(), Some(&worksite), &values, &attributes, &ids).unwrap());

        let mut rename = draft(&attributes);
        rename.name = "Renamed".to_owned();
        rename.agitations = vec!["nope".to_owned()];

        assert_eq!(
            message(
                update_worker(db.conn(), Some(&worksite), &worker.id, &rename, &attributes)
                    .unwrap()
            ),
            "Worker references unknown agitation(s): nope."
        );
        assert_eq!(
            get_workers(db.conn(), Some(&worksite)).unwrap()[0].name,
            "Rosalind Franklin"
        );
    }

    #[test]
    fn reports_an_unknown_language_without_writing_anything_else() {
        let (db, ids, worksite) = seeded();
        let attributes = attributes_of(db.conn(), &worksite);
        let mut values = draft(&attributes);
        values.name = "Rosalind Franklin".to_owned();
        let worker =
            created(create_worker(db.conn(), Some(&worksite), &values, &attributes, &ids).unwrap());

        let mut rename = draft(&attributes);
        rename.name = "Renamed".to_owned();
        rename.languages = vec!["nope".to_owned()];

        assert_eq!(
            message(
                update_worker(db.conn(), Some(&worksite), &worker.id, &rename, &attributes)
                    .unwrap()
            ),
            "Worker references unknown language(s): nope."
        );
        assert_eq!(
            get_workers(db.conn(), Some(&worksite)).unwrap()[0].name,
            "Rosalind Franklin"
        );
    }

    #[test]
    fn reports_an_unknown_worker() {
        let (db, _ids, worksite) = seeded();
        let attributes = attributes_of(db.conn(), &worksite);

        assert_eq!(
            update_worker(
                db.conn(),
                Some(&worksite),
                "nobody",
                &draft(&attributes),
                &attributes
            )
            .unwrap(),
            WorkerUpdateResult::NotFound
        );
        assert_eq!(
            update_worker(db.conn(), None, "nobody", &draft(&attributes), &attributes).unwrap(),
            WorkerUpdateResult::NotFound
        );
    }

    #[test]
    fn updates_a_worker_and_reads_it_back() {
        let (db, ids, worksite) = seeded();
        let attributes = attributes_of(db.conn(), &worksite);
        let worker = created(
            create_worker(
                db.conn(),
                Some(&worksite),
                &draft(&attributes),
                &attributes,
                &ids,
            )
            .unwrap(),
        );

        let mut values = draft(&attributes);
        values.name = "Renamed".to_owned();
        values.assessment = "Leader".to_owned();
        values.notes =
            json!([{ "id": "n1", "text": "t", "timestamp": "2026-09-02T10:00:00.000Z" }]);

        let updated_worker = updated(
            update_worker(db.conn(), Some(&worksite), &worker.id, &values, &attributes).unwrap(),
        );

        assert_eq!(updated_worker.name, "Renamed");
        assert_eq!(updated_worker.assessment, "Leader");
        assert_eq!(updated_worker.notes, values.notes);
        assert_eq!(
            get_workers(db.conn(), Some(&worksite)).unwrap(),
            [updated_worker]
        );
    }

    #[test]
    fn assigns_a_shared_agitation_to_a_worker() {
        let (db, ids, worksite) = seeded();
        let attributes = attributes_of(db.conn(), &worksite);
        let worker = created(
            create_worker(
                db.conn(),
                Some(&worksite),
                &draft(&attributes),
                &attributes,
                &ids,
            )
            .unwrap(),
        );
        let agitation = create_agitation(db.conn(), &worksite, "Unpaid overtime", &ids)
            .unwrap()
            .agitation;

        let result = update_worker_agitations(
            db.conn(),
            Some(&worksite),
            &worker.id,
            std::slice::from_ref(&agitation.id),
        )
        .unwrap();

        match result {
            WorkerAgitationResult::Updated { worker } => {
                assert_eq!(worker.agitations, [agitation.id]);
            }
            other => panic!("expected the worker to be updated, got {other:?}"),
        }
    }

    #[test]
    fn lets_one_agitation_be_shared_by_two_workers() {
        let (db, ids, worksite) = seeded();
        let attributes = attributes_of(db.conn(), &worksite);
        let mut first = draft(&attributes);
        first.name = "First".to_owned();
        let mut second = draft(&attributes);
        second.name = "Second".to_owned();
        let first =
            created(create_worker(db.conn(), Some(&worksite), &first, &attributes, &ids).unwrap());
        let second =
            created(create_worker(db.conn(), Some(&worksite), &second, &attributes, &ids).unwrap());
        let agitation = create_agitation(db.conn(), &worksite, "Unpaid overtime", &ids)
            .unwrap()
            .agitation;

        for id in [&first.id, &second.id] {
            update_worker_agitations(
                db.conn(),
                Some(&worksite),
                id,
                std::slice::from_ref(&agitation.id),
            )
            .unwrap();
        }

        let workers = get_workers(db.conn(), Some(&worksite)).unwrap();
        assert!(workers
            .iter()
            .all(|worker| worker.agitations.contains(&agitation.id)));
        assert_eq!(
            get_agitations(db.conn(), &Some(worksite.clone()))
                .unwrap()
                .len(),
            1
        );
    }

    #[test]
    fn reports_an_unknown_worker_before_it_looks_at_the_agitations() {
        let (db, _ids, worksite) = seeded();

        assert_eq!(
            update_worker_agitations(db.conn(), Some(&worksite), "nobody", &["nope".to_owned()])
                .unwrap(),
            WorkerAgitationResult::NotFound
        );
        assert_eq!(
            update_worker_agitations(db.conn(), None, "nobody", &["nope".to_owned()]).unwrap(),
            WorkerAgitationResult::NotFound
        );
    }

    #[test]
    fn reports_an_unknown_agitation_for_a_worker_that_exists() {
        let (db, ids, worksite) = seeded();
        let attributes = attributes_of(db.conn(), &worksite);
        let worker = created(
            create_worker(
                db.conn(),
                Some(&worksite),
                &draft(&attributes),
                &attributes,
                &ids,
            )
            .unwrap(),
        );

        assert_eq!(
            update_worker_agitations(db.conn(), Some(&worksite), &worker.id, &["nope".to_owned()])
                .unwrap(),
            WorkerAgitationResult::InvalidAgitations {
                message: "Worker references unknown agitation(s): nope.".to_owned()
            }
        );
    }

    #[test]
    fn clears_agitation_assignments_when_handed_an_empty_list() {
        let (db, ids, worksite) = seeded();
        let attributes = attributes_of(db.conn(), &worksite);
        let worker = created(
            create_worker(
                db.conn(),
                Some(&worksite),
                &draft(&attributes),
                &attributes,
                &ids,
            )
            .unwrap(),
        );
        let agitation = create_agitation(db.conn(), &worksite, "Unpaid overtime", &ids)
            .unwrap()
            .agitation;
        update_worker_agitations(db.conn(), Some(&worksite), &worker.id, &[agitation.id]).unwrap();

        match update_worker_agitations(db.conn(), Some(&worksite), &worker.id, &[]).unwrap() {
            WorkerAgitationResult::Updated { worker } => {
                assert_eq!(worker.agitations, Vec::<String>::new());
            }
            other => panic!("expected the worker to be updated, got {other:?}"),
        }
    }

    #[test]
    fn assigns_a_shared_language_to_a_worker() {
        let (db, ids, worksite) = seeded();
        let attributes = attributes_of(db.conn(), &worksite);
        let worker = created(
            create_worker(
                db.conn(),
                Some(&worksite),
                &draft(&attributes),
                &attributes,
                &ids,
            )
            .unwrap(),
        );
        let language = create_language(db.conn(), &worksite, "Spanish", &ids)
            .unwrap()
            .language;

        match update_worker_languages(
            db.conn(),
            Some(&worksite),
            &worker.id,
            std::slice::from_ref(&language.id),
        )
        .unwrap()
        {
            WorkerLanguageResult::Updated { worker } => {
                assert_eq!(worker.languages, [language.id]);
            }
            other => panic!("expected the worker to be updated, got {other:?}"),
        }
    }

    #[test]
    fn lets_one_language_be_shared_by_two_workers() {
        let (db, ids, worksite) = seeded();
        let attributes = attributes_of(db.conn(), &worksite);
        let mut first = draft(&attributes);
        first.name = "First".to_owned();
        let mut second = draft(&attributes);
        second.name = "Second".to_owned();
        let first =
            created(create_worker(db.conn(), Some(&worksite), &first, &attributes, &ids).unwrap());
        let second =
            created(create_worker(db.conn(), Some(&worksite), &second, &attributes, &ids).unwrap());
        let language = create_language(db.conn(), &worksite, "Spanish", &ids)
            .unwrap()
            .language;

        for id in [&first.id, &second.id] {
            update_worker_languages(
                db.conn(),
                Some(&worksite),
                id,
                std::slice::from_ref(&language.id),
            )
            .unwrap();
        }

        let workers = get_workers(db.conn(), Some(&worksite)).unwrap();
        assert!(workers
            .iter()
            .all(|worker| worker.languages.contains(&language.id)));
        assert_eq!(
            get_languages(db.conn(), &Some(worksite.clone()))
                .unwrap()
                .len(),
            1
        );
    }

    #[test]
    fn reports_an_unknown_worker_before_it_looks_at_the_languages() {
        let (db, _ids, worksite) = seeded();

        assert_eq!(
            update_worker_languages(db.conn(), Some(&worksite), "nobody", &["nope".to_owned()])
                .unwrap(),
            WorkerLanguageResult::NotFound
        );
    }

    #[test]
    fn reports_an_unknown_language_for_a_worker_that_exists() {
        let (db, ids, worksite) = seeded();
        let attributes = attributes_of(db.conn(), &worksite);
        let worker = created(
            create_worker(
                db.conn(),
                Some(&worksite),
                &draft(&attributes),
                &attributes,
                &ids,
            )
            .unwrap(),
        );

        assert_eq!(
            update_worker_languages(db.conn(), Some(&worksite), &worker.id, &["nope".to_owned()])
                .unwrap(),
            WorkerLanguageResult::InvalidLanguages {
                message: "Worker references unknown language(s): nope.".to_owned()
            }
        );
    }

    #[test]
    fn clears_language_assignments_when_handed_an_empty_list() {
        let (db, ids, worksite) = seeded();
        let attributes = attributes_of(db.conn(), &worksite);
        let worker = created(
            create_worker(
                db.conn(),
                Some(&worksite),
                &draft(&attributes),
                &attributes,
                &ids,
            )
            .unwrap(),
        );
        let language = create_language(db.conn(), &worksite, "Spanish", &ids)
            .unwrap()
            .language;
        update_worker_languages(db.conn(), Some(&worksite), &worker.id, &[language.id]).unwrap();

        match update_worker_languages(db.conn(), Some(&worksite), &worker.id, &[]).unwrap() {
            WorkerLanguageResult::Updated { worker } => {
                assert_eq!(worker.languages, Vec::<String>::new());
            }
            other => panic!("expected the worker to be updated, got {other:?}"),
        }
    }

    #[test]
    fn takes_the_workers_own_notes_and_assignments_with_it() {
        let (db, ids, worksite) = seeded();
        let attributes = attributes_of(db.conn(), &worksite);
        let mut doomed_draft = draft(&attributes);
        doomed_draft.name = "Doomed".to_owned();
        let mut survivor_draft = draft(&attributes);
        survivor_draft.name = "Survivor".to_owned();
        let doomed = created(
            create_worker(db.conn(), Some(&worksite), &doomed_draft, &attributes, &ids).unwrap(),
        );
        let survivor = created(
            create_worker(
                db.conn(),
                Some(&worksite),
                &survivor_draft,
                &attributes,
                &ids,
            )
            .unwrap(),
        );
        let agitation = create_agitation(db.conn(), &worksite, "Unpaid overtime", &ids)
            .unwrap()
            .agitation;
        for id in [&doomed.id, &survivor.id] {
            update_worker_agitations(
                db.conn(),
                Some(&worksite),
                id,
                std::slice::from_ref(&agitation.id),
            )
            .unwrap();
        }

        assert!(delete_worker(db.conn(), Some(&worksite), &doomed.id).unwrap());

        let remaining = get_workers(db.conn(), Some(&worksite)).unwrap();
        assert_eq!(
            remaining
                .iter()
                .map(|worker| worker.name.as_str())
                .collect::<Vec<_>>(),
            ["Survivor"]
        );
        assert_eq!(remaining[0].agitations, [agitation.id]);
        assert_eq!(
            get_agitations(db.conn(), &Some(worksite.clone()))
                .unwrap()
                .len(),
            1
        );
        assert!(!delete_worker(db.conn(), Some(&worksite), &doomed.id).unwrap());
        assert!(!delete_worker(db.conn(), None, &survivor.id).unwrap());
    }

    #[test]
    fn updates_the_assessment_or_reports_nothing_for_an_unknown_worker() {
        let (db, ids, worksite) = seeded();
        let attributes = attributes_of(db.conn(), &worksite);
        let worker = created(
            create_worker(
                db.conn(),
                Some(&worksite),
                &draft(&attributes),
                &attributes,
                &ids,
            )
            .unwrap(),
        );

        let updated = update_worker_assessment(db.conn(), Some(&worksite), &worker.id, "Supporter")
            .unwrap()
            .unwrap();
        assert_eq!(updated.assessment, "Supporter");

        assert_eq!(
            update_worker_assessment(db.conn(), Some(&worksite), "nobody", "Supporter").unwrap(),
            None
        );
        assert_eq!(
            update_worker_assessment(db.conn(), None, &worker.id, "Supporter").unwrap(),
            None
        );
    }

    #[test]
    fn merges_one_attribute_value_and_revalidates_the_whole_object() {
        let (db, ids, worksite) = seeded();
        db.conn()
            .execute(
                "UPDATE worker_attributes SET options = json_array(json_object('id', id || '-one', 'value', 'One'), json_object('id', id || '-two', 'value', 'Two')) WHERE kind IN ('category', 'tag')",
                [],
            )
            .unwrap();
        let attributes = attributes_of(db.conn(), &worksite);
        let category = attributes
            .iter()
            .find(|attribute| attribute.kind == "category")
            .unwrap()
            .clone();
        let tag = attributes
            .iter()
            .find(|attribute| attribute.kind == "tag")
            .unwrap()
            .clone();
        let worker = created(
            create_worker(
                db.conn(),
                Some(&worksite),
                &draft(&attributes),
                &attributes,
                &ids,
            )
            .unwrap(),
        );

        let worker = update_worker_attribute(
            db.conn(),
            Some(&worksite),
            &worker.id,
            &category.id,
            &json!(category.options[1].id),
        )
        .unwrap()
        .unwrap();
        assert_eq!(
            worker.attributes.get(&category.id),
            Some(&json!(category.options[1].id))
        );
        // The tag value the patch did not mention survived the merge.
        assert_eq!(worker.attributes.get(&tag.id), Some(&json!([])));

        let worker = update_worker_attribute(
            db.conn(),
            Some(&worksite),
            &worker.id,
            &tag.id,
            &json!([tag.options[0].id]),
        )
        .unwrap()
        .unwrap();
        assert_eq!(
            worker.attributes.get(&tag.id),
            Some(&json!([tag.options[0].id]))
        );

        assert_eq!(
            update_worker_attribute(
                db.conn(),
                Some(&worksite),
                &worker.id,
                &category.id,
                &json!("Nope")
            )
            .unwrap_err()
            .to_string(),
            format!("Invalid value for worker attribute \"{}\".", category.id)
        );
        assert_eq!(
            update_worker_attribute(db.conn(), Some(&worksite), &worker.id, "ghost", &json!("x"))
                .unwrap_err()
                .to_string(),
            "Unknown worker attribute \"ghost\"."
        );
        assert_eq!(
            update_worker_attribute(db.conn(), None, &worker.id, &category.id, &json!("x"))
                .unwrap(),
            None
        );
    }

    #[test]
    fn imports_contacts_with_empty_assignments_and_trimmed_details() {
        let (db, ids, worksite) = seeded();

        let imported = import_workers(
            db.conn(),
            &worksite,
            &[
                WorkerImportContact {
                    name: "  Ada Lovelace  ".to_owned(),
                    email: Some("  ada@example.test ".to_owned()),
                    phone: Some("  555-010-0100  ".to_owned()),
                },
                WorkerImportContact {
                    name: "Grace Hopper".to_owned(),
                    email: None,
                    phone: None,
                },
            ],
            &ids,
        )
        .unwrap();

        assert_eq!(imported, [counter_id(5), counter_id(6)]);

        let workers = get_workers(db.conn(), Some(&worksite)).unwrap();
        assert_eq!(workers[0].name, "Ada Lovelace");
        assert_eq!(workers[0].email, "ada@example.test");
        assert_eq!(workers[0].phone, "(555) 010-0100");
        assert_eq!(workers[1].email, "");
        assert_eq!(workers[1].phone, "");
        assert_eq!(workers[0].assessment, "Unassessed");
        assert_eq!(workers[0].notes, json!([]));
        assert_eq!(
            workers[0].attributes,
            Value::Object(serde_json::Map::from_iter([
                (counter_id(2), json!("")),
                (counter_id(3), json!("")),
                (counter_id(4), json!([])),
            ]))
        );
    }

    #[test]
    fn import_rejects_a_blank_name_and_rolls_the_batch_back() {
        let (db, ids, worksite) = seeded();

        let error = import_workers(
            db.conn(),
            &worksite,
            &[
                WorkerImportContact {
                    name: "Ada Lovelace".to_owned(),
                    email: None,
                    phone: None,
                },
                WorkerImportContact {
                    name: "   ".to_owned(),
                    email: None,
                    phone: None,
                },
            ],
            &ids,
        )
        .unwrap_err();

        assert!(
            matches!(error, Error::Message(message) if message == "Imported workers must have a name.")
        );
        assert_eq!(get_workers(db.conn(), Some(&worksite)).unwrap(), Vec::new());
    }

    fn row(row: u32, name: &str) -> ImportRow {
        ImportRow {
            row,
            attributes: serde_json::Map::new(),
            contact: WorkerImportContact {
                name: name.to_owned(),
                email: None,
                phone: None,
            },
        }
    }

    #[test]
    fn a_reviewed_import_answers_each_source_row_with_its_created_id_in_order() {
        let (db, ids, worksite) = seeded();
        let attribute_ids: Vec<String> = attributes_of(db.conn(), &worksite)
            .into_iter()
            .map(|a| a.id)
            .collect();

        let outcome = import_reviewed_rows(
            db.conn(),
            &worksite,
            &[row(2, "Ada Lovelace"), row(5, "Grace Hopper")],
            Some(&attribute_ids),
            &ids,
        )
        .unwrap();

        let ImportOutcome::Created(created) = outcome else {
            panic!("expected Created");
        };
        assert_eq!(created.iter().map(|(r, _)| *r).collect::<Vec<_>>(), [2, 5]);
        let workers = get_workers(db.conn(), Some(&worksite)).unwrap();
        for (row_number, id) in &created {
            let name = if *row_number == 2 {
                "Ada Lovelace"
            } else {
                "Grace Hopper"
            };
            assert_eq!(workers.iter().find(|w| &w.id == id).unwrap().name, name);
        }
    }

    #[test]
    fn an_import_reviewed_against_changed_attributes_creates_nothing() {
        let (db, ids, worksite) = seeded();

        let outcome = import_reviewed_rows(
            db.conn(),
            &worksite,
            &[row(2, "Ada Lovelace")],
            Some(&["gone-attribute".to_owned()]),
            &ids,
        )
        .unwrap();

        assert_eq!(outcome, ImportOutcome::StaleVocabulary);
        assert_eq!(get_workers(db.conn(), Some(&worksite)).unwrap(), Vec::new());
    }

    fn row_with(row: u32, name: &str, attributes: Value) -> ImportRow {
        let mut import = self::row(row, name);
        import.attributes = attributes.as_object().cloned().unwrap_or_default();
        import
    }

    /// The first Attribute with an answer, and that answer's id.
    fn category_and_answer(conn: &Connection, worksite: &Worksite) -> (String, String) {
        conn.execute(
            "UPDATE worker_attributes SET options = json_array(json_object('id', id || '-one', 'value', 'One'), json_object('id', id || '-two', 'value', 'Two')) WHERE kind IN ('category', 'tag')",
            [],
        )
        .unwrap();
        let attribute = attributes_of(conn, worksite)
            .into_iter()
            .find(|a| !a.options.is_empty())
            .expect("a seeded Attribute with answers");
        (attribute.id.clone(), attribute.options[0].id.clone())
    }

    /// The answer as its Attribute stores it: a list for a tag.
    fn stored(
        conn: &Connection,
        worksite: &Worksite,
        attribute_id: &str,
        answer_id: &str,
    ) -> Value {
        let attribute = attributes_of(conn, worksite)
            .into_iter()
            .find(|a| a.id == attribute_id)
            .unwrap();
        if attribute.kind == "tag" {
            json!([answer_id])
        } else {
            json!(answer_id)
        }
    }

    #[test]
    fn an_import_stores_the_chosen_answers_of_existing_attributes() {
        let (db, ids, worksite) = seeded();
        let (attribute_id, answer_id) = category_and_answer(db.conn(), &worksite);

        let outcome = import_reviewed_rows(
            db.conn(),
            &worksite,
            &[
                row_with(
                    2,
                    "Ada Lovelace",
                    json!({ attribute_id.clone(): answer_id.clone() }),
                ),
                row(3, "Grace Hopper"),
            ],
            None,
            &ids,
        )
        .unwrap();

        let ImportOutcome::Created(created) = outcome else {
            panic!("expected Created");
        };
        let workers = get_workers(db.conn(), Some(&worksite)).unwrap();
        let ada = workers.iter().find(|w| w.id == created[0].1).unwrap();
        let grace = workers.iter().find(|w| w.id == created[1].1).unwrap();
        assert_eq!(
            ada.attributes[&attribute_id],
            stored(db.conn(), &worksite, &attribute_id, &answer_id)
        );
        assert_ne!(
            grace.attributes[&attribute_id],
            ada.attributes[&attribute_id]
        );
    }

    #[test]
    fn an_answer_that_is_not_in_the_live_definition_creates_nothing() {
        let (db, ids, worksite) = seeded();
        let (attribute_id, _) = category_and_answer(db.conn(), &worksite);

        let outcome = import_reviewed_rows(
            db.conn(),
            &worksite,
            &[
                row(2, "Ada Lovelace"),
                row_with(
                    3,
                    "Grace Hopper",
                    json!({ attribute_id.clone(): "answer-that-is-gone" }),
                ),
            ],
            None,
            &ids,
        )
        .unwrap();

        assert_eq!(outcome, ImportOutcome::StaleVocabulary);
        assert_eq!(get_workers(db.conn(), Some(&worksite)).unwrap(), Vec::new());
    }

    #[test]
    fn an_attribute_that_is_gone_creates_nothing() {
        let (db, ids, worksite) = seeded();

        let outcome = import_reviewed_rows(
            db.conn(),
            &worksite,
            &[row_with(
                2,
                "Ada Lovelace",
                json!({ "gone-attribute": "x" }),
            )],
            None,
            &ids,
        )
        .unwrap();

        assert_eq!(outcome, ImportOutcome::StaleVocabulary);
        assert_eq!(get_workers(db.conn(), Some(&worksite)).unwrap(), Vec::new());
    }

    #[test]
    fn a_payload_row_with_attributes_that_are_not_an_object_is_refused() {
        let (db, ids, worksite) = seeded();

        let outcome = import_workers_from_payload(
            db.conn(),
            &worksite,
            &json!([{"name": "Ada Lovelace", "row": 2, "attributes": ["x"]}]),
            &ids,
        )
        .unwrap();

        assert!(matches!(outcome, PayloadOutcome::Invalid { .. }));
        assert_eq!(get_workers(db.conn(), Some(&worksite)).unwrap(), Vec::new());
    }

    #[test]
    fn an_import_into_a_deleted_worksite_creates_nothing() {
        let (db, ids, worksite) = seeded();
        db.conn()
            .execute("DELETE FROM worksites WHERE id = ?1", params![worksite.id])
            .unwrap();

        let outcome =
            import_reviewed_rows(db.conn(), &worksite, &[row(2, "Ada Lovelace")], None, &ids)
                .unwrap();

        assert_eq!(outcome, ImportOutcome::NoWorksite);
    }

    #[test]
    fn a_payload_with_a_duplicate_source_row_is_refused() {
        let (db, ids, worksite) = seeded();

        let outcome = import_workers_from_payload(
            db.conn(),
            &worksite,
            &json!([{"name": "Ada Lovelace", "row": 2}, {"name": "Grace Hopper", "row": 2}]),
            &ids,
        )
        .unwrap();

        assert!(matches!(outcome, PayloadOutcome::Invalid { .. }));
        assert_eq!(get_workers(db.conn(), Some(&worksite)).unwrap(), Vec::new());
    }
}
