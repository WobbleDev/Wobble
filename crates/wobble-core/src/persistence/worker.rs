//! Persistence of the worker record: the one `INSERT INTO workers` statement, and the
//! insert of a new worker together with its attribute values and its agitation and
//! language assignments.

use rusqlite::{params, Connection};

use crate::agitation_persistence::save_worker_agitations;
use crate::attribute_migration::WorkerAttributeDefinition;
use crate::attribute_persistence::insert_worker_attribute_values;
use crate::error::Result;
use crate::language_persistence::save_worker_languages;
use crate::schema::Worksite;
use crate::service::WorkerUpdate;

/// The one column list of a `workers` insert, in the order of its seven placeholders.
const INSERT_WORKER: &str =
    "INSERT INTO workers (id, worksite_id, name, email, phone, assessment, notes) \
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)";

/// `insertWorkerRecordWithAttributes`: the worker row, then its attribute values, then
/// its agitation and language assignments. The callers hold the transaction, and the
/// values arrive checked: the request decode has proved their shape, and the service has
/// refused unknown agitation and language ids.
pub(crate) fn insert_worker_record_with_attributes(
    conn: &Connection,
    worksite: &Worksite,
    id: &str,
    worker: &WorkerUpdate,
    attributes: &[WorkerAttributeDefinition],
) -> Result<()> {
    conn.execute(
        INSERT_WORKER,
        params![
            id,
            worksite.id,
            worker.name,
            worker.email,
            worker.phone,
            worker.assessment,
            serde_json::to_string(&worker.notes)?,
        ],
    )?;

    insert_worker_attribute_values(conn, id, &worker.attributes, attributes)?;
    save_worker_agitations(conn, worksite, id, &worker.agitations)?;
    save_worker_languages(conn, worksite, id, &worker.languages)?;

    Ok(())
}

/// Test fixture: a bare Unassessed worker row with no phone, notes, or children, through
/// the same insert statement.
#[cfg(test)]
pub(crate) fn insert_bare_worker(
    conn: &Connection,
    worksite_id: &str,
    id: &str,
    name: &str,
    email: &str,
) {
    conn.execute(
        INSERT_WORKER,
        params![id, worksite_id, name, email, "", "Unassessed", "[]"],
    )
    .expect("a bare worker row");
}
