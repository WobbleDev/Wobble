//! The core's Worker drafts (ADR-0023): at most one per (Worksite, worker id), where the
//! sentinel worker id holds the not-yet-created Worker's draft. The payload is stored as
//! JSON and read back as untrusted, so a corrupt row is refused rather than believed.

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use crate::error::{Error, Result};
use crate::service::WorkerUpdate;

/// The worker id the New Worker form's draft is stored under.
pub const NEW_WORKER_DRAFT_ID: &str = "new";

/// The note composer's un-added state, carried so a half-written note survives too.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(
    feature = "ts",
    derive(ts_rs::TS),
    ts(export, rename = "PendingNoteDraft")
)]
pub struct PendingNote {
    pub text: String,
}

/// What a client sends to store a draft; the core stamps `updated_at`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
pub struct WorkerDraftInput {
    pub update: WorkerUpdate,
    pub pending_note: PendingNote,
    /// The record the draft was based on, so a changed record can be flagged.
    pub base: Option<WorkerUpdate>,
}

/// One stored draft.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
pub struct WorkerDraft {
    pub update: WorkerUpdate,
    pub pending_note: PendingNote,
    pub base: Option<WorkerUpdate>,
    pub updated_at: String,
}

/// Reads the draft for one (Worksite, worker id), validating the stored JSON as untrusted.
pub fn get_worker_draft(
    conn: &Connection,
    worksite_id: &str,
    worker_id: &str,
) -> Result<Option<WorkerDraft>> {
    let stored: Option<(String, String)> = conn
        .query_row(
            "SELECT payload, updated_at FROM worker_drafts WHERE worksite_id = ?1 AND worker_id = ?2",
            params![worksite_id, worker_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;

    let Some((payload, updated_at)) = stored else {
        return Ok(None);
    };

    let input: WorkerDraftInput = serde_json::from_str(&payload)
        .map_err(|_| Error::Message(format!("Invalid Worker draft stored for {worker_id}.")))?;

    Ok(Some(WorkerDraft {
        update: input.update,
        pending_note: input.pending_note,
        base: input.base,
        updated_at,
    }))
}

/// Writes (or replaces) one draft and reads it back.
pub fn save_worker_draft(
    conn: &Connection,
    worksite_id: &str,
    worker_id: &str,
    input: &WorkerDraftInput,
) -> Result<WorkerDraft> {
    let payload = serde_json::to_string(input)?;
    conn.execute(
        "INSERT INTO worker_drafts (worksite_id, worker_id, payload, updated_at) \
         VALUES (?1, ?2, ?3, strftime('%Y-%m-%dT%H:%M:%fZ','now')) \
         ON CONFLICT (worksite_id, worker_id) DO UPDATE SET \
           payload = excluded.payload, updated_at = excluded.updated_at",
        params![worksite_id, worker_id, payload],
    )?;

    get_worker_draft(conn, worksite_id, worker_id)?
        .ok_or_else(|| Error::Message("Worker draft vanished after write.".to_owned()))
}

/// Moves the not-yet-created Worker's stored personal draft onto the Worker just created. The
/// draft keeps its payload and timestamp. A contact import never calls this, so a batch cannot
/// claim the New Worker form's draft.
pub(crate) fn rekey_new_worker_drafts(
    conn: &Connection,
    worksite_id: &str,
    worker_id: &str,
) -> Result<()> {
    conn.execute(
        "UPDATE worker_drafts SET worker_id = ?1 WHERE worksite_id = ?2 AND worker_id = ?3",
        params![worker_id, worksite_id, NEW_WORKER_DRAFT_ID],
    )?;
    Ok(())
}

/// Deletes one draft; returns whether one was there.
pub fn delete_worker_draft(conn: &Connection, worksite_id: &str, worker_id: &str) -> Result<bool> {
    let removed = conn.execute(
        "DELETE FROM worker_drafts WHERE worksite_id = ?1 AND worker_id = ?2",
        params![worksite_id, worker_id],
    )?;
    Ok(removed > 0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::open_seeded;
    use crate::id::CounterId;
    use crate::worker_persistence::insert_bare_worker;
    use serde_json::json;

    fn update(name: &str) -> WorkerUpdate {
        WorkerUpdate {
            name: name.to_owned(),
            email: String::new(),
            phone: String::new(),
            assessment: "Unassessed".to_owned(),
            attributes: json!({}),
            agitations: Vec::new(),
            languages: Vec::new(),
            relationships: Vec::new(),
            notes: json!([]),
        }
    }

    fn input(name: &str) -> WorkerDraftInput {
        WorkerDraftInput {
            update: update(name),
            pending_note: PendingNote {
                text: "half a note".to_owned(),
            },
            base: None,
        }
    }

    fn seeded() -> crate::db::Db {
        open_seeded(":memory:", &CounterId::new()).unwrap()
    }

    fn worksite_id(conn: &Connection) -> String {
        conn.query_row("SELECT id FROM worksites LIMIT 1", [], |row| row.get(0))
            .unwrap()
    }

    #[test]
    fn round_trips_a_draft_and_deletes_it() {
        let db = seeded();
        let conn = db.conn();
        let worksite = worksite_id(conn);

        assert!(get_worker_draft(conn, &worksite, NEW_WORKER_DRAFT_ID)
            .unwrap()
            .is_none());

        let saved = save_worker_draft(conn, &worksite, NEW_WORKER_DRAFT_ID, &input("Ada")).unwrap();
        assert!(!saved.updated_at.is_empty());

        let read = get_worker_draft(conn, &worksite, NEW_WORKER_DRAFT_ID)
            .unwrap()
            .unwrap();
        assert_eq!(read.update.name, "Ada");
        assert_eq!(read.pending_note.text, "half a note");

        assert!(delete_worker_draft(conn, &worksite, NEW_WORKER_DRAFT_ID).unwrap());
        assert!(get_worker_draft(conn, &worksite, NEW_WORKER_DRAFT_ID)
            .unwrap()
            .is_none());
        assert!(!delete_worker_draft(conn, &worksite, NEW_WORKER_DRAFT_ID).unwrap());
    }

    #[test]
    fn cascades_a_draft_with_its_worker_and_with_its_worksite() {
        let db = seeded();
        let conn = db.conn();
        let worksite = worksite_id(conn);
        insert_bare_worker(conn, &worksite, "w1", "Ada", "");

        save_worker_draft(conn, &worksite, "w1", &input("Ada")).unwrap();
        conn.execute("DELETE FROM workers WHERE id = 'w1'", [])
            .unwrap();
        assert!(get_worker_draft(conn, &worksite, "w1").unwrap().is_none());

        save_worker_draft(conn, &worksite, NEW_WORKER_DRAFT_ID, &input("New")).unwrap();
        conn.execute("DELETE FROM worksites WHERE id = ?1", params![worksite])
            .unwrap();
        assert!(get_worker_draft(conn, &worksite, NEW_WORKER_DRAFT_ID)
            .unwrap()
            .is_none());
    }

    #[test]
    fn refuses_a_stored_payload_that_does_not_decode() {
        let db = seeded();
        let conn = db.conn();
        let worksite = worksite_id(conn);
        conn.execute(
            "INSERT INTO worker_drafts (worksite_id, worker_id, payload, updated_at) \
             VALUES (?1, 'w1', '{}', '2026-10-12T00:00:00.000Z')",
            params![worksite],
        )
        .unwrap();

        let error = get_worker_draft(conn, &worksite, "w1").unwrap_err();
        assert!(
            error
                .to_string()
                .contains("Invalid Worker draft stored for w1."),
            "{error}"
        );
    }
}
