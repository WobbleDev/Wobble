//! Worksite Agitations: list, create, replace, and assign them to workers.
//!
//! ADR-0015 keeps this deliberately parallel to language_persistence.rs: two tables,
//! two modules, no shared code.

use std::collections::HashSet;

use rusqlite::{params, Connection, OptionalExtension, Transaction, TransactionBehavior};
use serde::Serialize;

use crate::error::{Error, Result};
use crate::id::IdSource;
use crate::schema::Worksite;

/// An Agitation as the handlers surface it.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
pub struct Agitation {
    pub id: String,
    pub text: String,
}

/// `AgitationCreateResult`: whether a row was inserted, plus the agitation either way.
#[derive(Debug, Clone, PartialEq)]
pub struct AgitationCreateResult {
    pub created: bool,
    pub agitation: Agitation,
}

/// `getAgitations`: the Worksite's agitations, case-insensitively ordered by text.
/// No Worksite reads nothing.
pub fn get_agitations(conn: &Connection, worksite: &Option<Worksite>) -> Result<Vec<Agitation>> {
    let Some(worksite) = worksite else {
        return Ok(Vec::new());
    };

    let mut statement = conn.prepare(
        "SELECT id, text FROM agitations WHERE worksite_id = ?1 ORDER BY text COLLATE NOCASE",
    )?;
    let agitations = statement
        .query_map([&worksite.id], |row| {
            Ok(Agitation {
                id: row.get(0)?,
                text: row.get(1)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<Agitation>>>()?;

    Ok(agitations)
}

/// `findAgitationByText`: the `text` column is `COLLATE NOCASE`, so this compares
/// case-insensitively without a `COLLATE` of its own — that is what makes create
/// idempotent.
fn find_agitation_by_text(
    conn: &Connection,
    worksite: &Worksite,
    text: &str,
) -> Result<Option<Agitation>> {
    let agitation = conn
        .query_row(
            "SELECT id, text FROM agitations WHERE worksite_id = ?1 AND text = ?2",
            params![worksite.id, text],
            |row| {
                Ok(Agitation {
                    id: row.get(0)?,
                    text: row.get(1)?,
                })
            },
        )
        .optional()?;

    Ok(agitation)
}

/// `findUnknownAgitationIds`: the subset of the given ids this Worksite does not have.
pub fn find_unknown_agitation_ids(
    conn: &Connection,
    worksite: &Worksite,
    ids: &[String],
) -> Result<Vec<String>> {
    let mut statement =
        conn.prepare("SELECT 1 FROM agitations WHERE id = ?1 AND worksite_id = ?2")?;

    let mut unknown = Vec::new();
    for id in ids {
        let exists: Option<i64> = statement
            .query_row(params![id, worksite.id], |row| row.get(0))
            .optional()?;
        if exists.is_none() {
            unknown.push(id.clone());
        }
    }

    Ok(unknown)
}

/// `saveWorkerAgitations`: the worker's assignments go, then each id is inserted through
/// the same-Worksite `EXISTS` guards. The callers hold the transaction.
pub fn save_worker_agitations(
    conn: &Connection,
    worksite: &Worksite,
    worker_id: &str,
    ids: &[String],
) -> Result<()> {
    conn.execute(
        "DELETE FROM worker_agitations \
         WHERE worker_id = ?1 \
           AND worker_id IN (SELECT id FROM workers WHERE worksite_id = ?2) \
           AND agitation_id IN (SELECT id FROM agitations WHERE worksite_id = ?3)",
        params![worker_id, worksite.id, worksite.id],
    )?;

    let mut insert = conn.prepare(
        "INSERT INTO worker_agitations (worker_id, agitation_id) \
         SELECT ?1, ?2 \
         WHERE EXISTS (SELECT 1 FROM workers WHERE id = ?3 AND worksite_id = ?4) \
           AND EXISTS (SELECT 1 FROM agitations WHERE id = ?5 AND worksite_id = ?6)",
    )?;
    for id in ids {
        insert.execute(params![
            worker_id,
            id,
            worker_id,
            worksite.id,
            id,
            worksite.id
        ])?;
    }

    Ok(())
}

/// Links one Agitation to one Worker, answering whether the link was new. The primary key
/// makes a repeat insert a no-op rather than a second row. The caller has already proved
/// both ids belong to the Worksite.
pub fn assign_agitation(conn: &Connection, worker_id: &str, agitation_id: &str) -> Result<bool> {
    let inserted = conn.execute(
        "INSERT OR IGNORE INTO worker_agitations (worker_id, agitation_id) VALUES (?1, ?2)",
        params![worker_id, agitation_id],
    )?;

    Ok(inserted > 0)
}

/// Unlinks one Agitation from one Worker only: the shared Agitation and every other
/// Worker's assignment stay (ADR-0004). Answers whether the link was there.
pub fn unassign_agitation(conn: &Connection, worker_id: &str, agitation_id: &str) -> Result<bool> {
    let removed = conn.execute(
        "DELETE FROM worker_agitations WHERE worker_id = ?1 AND agitation_id = ?2",
        params![worker_id, agitation_id],
    )?;

    Ok(removed > 0)
}

/// `createAgitation`: an already-listed text wins and keeps its stored spelling,
/// otherwise a new row is minted. One deferred transaction; no trim here — the route
/// trims.
pub fn create_agitation(
    conn: &Connection,
    worksite: &Worksite,
    text: &str,
    id_source: &impl IdSource,
) -> Result<AgitationCreateResult> {
    let tx = Transaction::new_unchecked(conn, TransactionBehavior::Deferred)?;

    let result = match find_agitation_by_text(&tx, worksite, text)? {
        Some(agitation) => AgitationCreateResult {
            created: false,
            agitation,
        },
        None => {
            let agitation = Agitation {
                id: id_source.next_id(),
                text: text.to_owned(),
            };
            tx.execute(
                "INSERT INTO agitations (id, worksite_id, text) VALUES (?1, ?2, ?3)",
                params![agitation.id, worksite.id, agitation.text],
            )?;

            AgitationCreateResult {
                created: true,
                agitation,
            }
        }
    };

    tx.commit()?;

    Ok(result)
}

/// One Agitation removed from the list by a merge: its assignments move to the kept
/// survivor, and the folded row is deleted.
#[derive(Debug, Clone, PartialEq)]
pub struct AgitationMerge {
    pub folded_id: String,
    pub survivor_id: String,
}

/// A proposed kept Agitation that another Worksite owns is not this Worksite's to save.
/// The read-only preview refuses it through the same helper and the same message.
pub fn reject_foreign_agitation_ids(
    conn: &Connection,
    worksite: &Worksite,
    agitations: &[Agitation],
) -> Result<()> {
    let mut find_owner = conn.prepare("SELECT worksite_id FROM agitations WHERE id = ?1")?;
    for agitation in agitations {
        let owner: Option<String> = find_owner
            .query_row([&agitation.id], |row| row.get(0))
            .optional()?;
        if let Some(owner) = owner {
            if owner != worksite.id {
                return Err(Error::Message(format!(
                    "Agitation \"{}\" belongs to another Worksite.",
                    agitation.id
                )));
            }
        }
    }

    Ok(())
}

/// Every merge a replacement proposes, checked against the stored ids and the list's kept
/// ids exactly as the Save checks them. The read-only preview calls this too, so it never
/// reports an effect for a Save that would fail.
pub fn validate_agitation_merges(
    stored_ids: &[String],
    kept_ids: &HashSet<&str>,
    merges: &[AgitationMerge],
) -> Result<()> {
    let stored: HashSet<&str> = stored_ids.iter().map(String::as_str).collect();
    for merge in merges {
        if merge.folded_id == merge.survivor_id
            || kept_ids.contains(merge.folded_id.as_str())
            || !stored.contains(merge.folded_id.as_str())
        {
            return Err(Error::Message(format!(
                "Agitation \"{}\" cannot be merged into \"{}\".",
                merge.folded_id, merge.survivor_id
            )));
        }
        if !kept_ids.contains(merge.survivor_id.as_str())
            || !stored.contains(merge.survivor_id.as_str())
        {
            return Err(Error::Message(format!(
                "Merge survivor \"{}\" is not a kept Agitation of this Worksite.",
                merge.survivor_id
            )));
        }
    }

    Ok(())
}

/// `replaceAgitations`: ids left out are deleted, kept rows are parked on throwaway
/// text and then rewritten, unknown ids are inserted — all in one deferred
/// transaction, so a text swap never trips `UNIQUE (worksite_id, text)`.
pub fn replace_agitations(
    conn: &Connection,
    worksite: &Worksite,
    agitations: &[Agitation],
    id_source: &impl IdSource,
) -> Result<Vec<Agitation>> {
    replace_agitations_with_merges(conn, worksite, agitations, &[], id_source)
}

/// `replaceAgitations` with merges: as above, plus each merge remaps the folded
/// Agitation's assignments to its survivor (a Worker holding both holds the survivor
/// once), then deletes the folded row. Survivors keep their id and position; every
/// check runs before the first write, and the one transaction rolls back on any error.
pub fn replace_agitations_with_merges(
    conn: &Connection,
    worksite: &Worksite,
    agitations: &[Agitation],
    merges: &[AgitationMerge],
    id_source: &impl IdSource,
) -> Result<Vec<Agitation>> {
    let tx = Transaction::new_unchecked(conn, TransactionBehavior::Deferred)?;

    // Unlike the attribute replace, this check lives *inside* the transaction, as the
    // TS `db.transaction` callback does. The read-only preview calls the same helper.
    reject_foreign_agitation_ids(&tx, worksite, agitations)?;

    let stored_ids = {
        let mut statement = tx.prepare("SELECT id FROM agitations WHERE worksite_id = ?1")?;
        let ids = statement
            .query_map([&worksite.id], |row| row.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<String>>>()?;
        ids
    };
    let kept_ids: HashSet<&str> = agitations
        .iter()
        .map(|agitation| agitation.id.as_str())
        .collect();
    validate_agitation_merges(&stored_ids, &kept_ids, merges)?;

    {
        let mut remap_shared = tx.prepare(
            "DELETE FROM worker_agitations WHERE agitation_id = ?1 \
               AND worker_id IN (SELECT worker_id FROM worker_agitations WHERE agitation_id = ?2)",
        )?;
        let mut remap =
            tx.prepare("UPDATE worker_agitations SET agitation_id = ?2 WHERE agitation_id = ?1")?;
        let mut fold = tx.prepare("DELETE FROM agitations WHERE id = ?1 AND worksite_id = ?2")?;
        for merge in merges {
            remap_shared.execute(params![merge.folded_id, merge.survivor_id])?;
            remap.execute(params![merge.folded_id, merge.survivor_id])?;
            fold.execute(params![merge.folded_id, worksite.id])?;
        }
    }

    {
        let mut delete = tx.prepare("DELETE FROM agitations WHERE id = ?1 AND worksite_id = ?2")?;
        for stored_id in &stored_ids {
            if !kept_ids.contains(stored_id.as_str()) {
                delete.execute(params![stored_id, worksite.id])?;
            }
        }
    }

    {
        let mut park =
            tx.prepare("UPDATE agitations SET text = ?1 WHERE id = ?2 AND worksite_id = ?3")?;
        for agitation in agitations {
            if stored_ids.contains(&agitation.id) {
                // `__updating_${randomUUID()}`: the parking text is thrown away by the
                // rewrite below, but the id is still minted so the counter the recorder
                // stubbed stays in lock-step with this port.
                park.execute(params![
                    format!("__updating_{}", id_source.next_id()),
                    agitation.id,
                    worksite.id
                ])?;
            }
        }
    }

    {
        let mut rename =
            tx.prepare("UPDATE agitations SET text = ?1 WHERE id = ?2 AND worksite_id = ?3")?;
        let mut insert =
            tx.prepare("INSERT INTO agitations (id, worksite_id, text) VALUES (?1, ?2, ?3)")?;
        for agitation in agitations {
            if stored_ids.contains(&agitation.id) {
                rename.execute(params![agitation.text, agitation.id, worksite.id])?;
            } else {
                insert.execute(params![agitation.id, worksite.id, agitation.text])?;
            }
        }
    }

    tx.commit()?;

    get_agitations(conn, &Some(worksite.clone()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::worker_persistence::insert_bare_worker;

    use crate::db::{open_seeded, Db};
    use crate::id::{counter_id, CounterId};
    use crate::worksite_persistence::resolve_active_worksite;

    const WORKER: &str = "w01";

    fn seeded() -> (Db, CounterId, Worksite) {
        let ids = CounterId::new();
        let db = open_seeded(":memory:", &ids).unwrap();
        let worksite = resolve_active_worksite(db.conn(), None).unwrap().unwrap();
        insert_bare_worker(db.conn(), &worksite.id, WORKER, "Test Worker", "");
        (db, ids, worksite)
    }

    fn agitation(id: &str, text: &str) -> Agitation {
        Agitation {
            id: id.to_owned(),
            text: text.to_owned(),
        }
    }

    fn texts(agitations: &[Agitation]) -> Vec<&str> {
        agitations
            .iter()
            .map(|agitation| agitation.text.as_str())
            .collect()
    }

    fn assigned_agitation_ids(conn: &Connection) -> Vec<String> {
        let mut statement = conn
            .prepare("SELECT agitation_id FROM worker_agitations WHERE worker_id = ?1")
            .unwrap();
        statement
            .query_map([WORKER], |row| row.get::<_, String>(0))
            .unwrap()
            .collect::<rusqlite::Result<Vec<String>>>()
            .unwrap()
    }

    #[test]
    fn unassign_removes_only_this_workers_link() {
        let (db, ids, worksite) = seeded();
        insert_bare_worker(db.conn(), &worksite.id, "w02", "Other Worker", "");
        let pay = create_agitation(db.conn(), &worksite, "Pay", &ids)
            .unwrap()
            .agitation;
        assert!(assign_agitation(db.conn(), WORKER, &pay.id).unwrap());
        assert!(assign_agitation(db.conn(), "w02", &pay.id).unwrap());

        assert!(unassign_agitation(db.conn(), WORKER, &pay.id).unwrap());

        assert_eq!(assigned_agitation_ids(db.conn()), Vec::<String>::new());
        let other: i64 = db
            .conn()
            .query_row(
                "SELECT COUNT(*) FROM worker_agitations WHERE worker_id = 'w02'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(other, 1);
        // The shared Agitation is still the Worksite's.
        assert_eq!(
            get_agitations(db.conn(), &Some(worksite.clone())).unwrap(),
            std::slice::from_ref(&pay)
        );
        // A second unassign has nothing left to take.
        assert!(!unassign_agitation(db.conn(), WORKER, &pay.id).unwrap());
    }

    #[test]
    fn assign_is_a_no_op_for_a_link_that_is_already_there() {
        let (db, ids, worksite) = seeded();
        let pay = create_agitation(db.conn(), &worksite, "Pay", &ids)
            .unwrap()
            .agitation;

        assert!(assign_agitation(db.conn(), WORKER, &pay.id).unwrap());
        assert!(!assign_agitation(db.conn(), WORKER, &pay.id).unwrap());
        assert_eq!(assigned_agitation_ids(db.conn()), [pay.id]);
    }

    #[test]
    fn get_agitations_reads_nothing_without_a_worksite() {
        let (db, _ids, worksite) = seeded();
        create_agitation(db.conn(), &worksite, "Pay", &CounterId::new()).unwrap();

        assert_eq!(get_agitations(db.conn(), &None).unwrap(), Vec::new());
    }

    #[test]
    fn creates_an_agitation_and_reports_it_as_created() {
        let (db, ids, worksite) = seeded();

        let result = create_agitation(db.conn(), &worksite, "Unpaid overtime", &ids).unwrap();

        assert!(result.created);
        assert_eq!(result.agitation.text, "Unpaid overtime");
        assert_eq!(result.agitation.id, counter_id(5));
        assert_eq!(
            get_agitations(db.conn(), &Some(worksite.clone())).unwrap(),
            [result.agitation]
        );
    }

    #[test]
    fn returns_the_existing_agitation_when_the_worksite_already_lists_the_text() {
        let (db, ids, worksite) = seeded();
        let first = create_agitation(db.conn(), &worksite, "Unpaid overtime", &ids).unwrap();

        let second = create_agitation(db.conn(), &worksite, "unpaid OVERTIME", &ids).unwrap();

        assert!(!second.created);
        assert_eq!(second.agitation.id, first.agitation.id);
        // The stored spelling wins: the match did not overwrite it.
        assert_eq!(second.agitation.text, "Unpaid overtime");
        assert_eq!(
            get_agitations(db.conn(), &Some(worksite.clone()))
                .unwrap()
                .len(),
            1
        );
        // A matched create mints no id.
        assert_eq!(ids.next_id(), counter_id(6));
    }

    #[test]
    fn creates_ids_the_worksite_does_not_have_yet() {
        let (db, _ids, worksite) = seeded();

        let saved = replace_agitations(
            db.conn(),
            &worksite,
            &[
                agitation("client-generated-1", "Unpaid overtime"),
                agitation("client-generated-2", "Broken rota"),
            ],
            &CounterId::new(),
        )
        .unwrap();

        assert_eq!(texts(&saved), ["Broken rota", "Unpaid overtime"]);
        assert_eq!(
            get_agitations(db.conn(), &Some(worksite.clone()))
                .unwrap()
                .len(),
            2
        );
    }

    #[test]
    fn mixes_new_and_existing_agitations_in_one_save() {
        let (db, ids, worksite) = seeded();
        let existing = create_agitation(db.conn(), &worksite, "Unpaid overtime", &ids)
            .unwrap()
            .agitation;

        let saved = replace_agitations(
            db.conn(),
            &worksite,
            &[existing, agitation("client-generated", "Broken rota")],
            &ids,
        )
        .unwrap();

        assert_eq!(saved.len(), 2);
        assert!(texts(&saved).contains(&"Unpaid overtime"));
        assert!(texts(&saved).contains(&"Broken rota"));
    }

    #[test]
    fn renames_an_agitation_in_place_keeping_its_id_and_assignments() {
        let (db, ids, worksite) = seeded();
        let existing = create_agitation(db.conn(), &worksite, "Unpaid overtime", &ids)
            .unwrap()
            .agitation;
        db.conn()
            .execute(
                "INSERT INTO worker_agitations (worker_id, agitation_id) VALUES (?1, ?2)",
                params![WORKER, existing.id],
            )
            .unwrap();

        replace_agitations(
            db.conn(),
            &worksite,
            &[agitation(&existing.id, "Overtime is unpaid")],
            &ids,
        )
        .unwrap();

        assert_eq!(
            get_agitations(db.conn(), &Some(worksite.clone())).unwrap(),
            [agitation(&existing.id, "Overtime is unpaid")]
        );
        assert_eq!(assigned_agitation_ids(db.conn()), [existing.id]);
    }

    #[test]
    fn swaps_two_texts_in_one_save_without_tripping_the_unique_constraint() {
        let (db, ids, worksite) = seeded();
        let alpha = create_agitation(db.conn(), &worksite, "Alpha", &ids)
            .unwrap()
            .agitation;
        let beta = create_agitation(db.conn(), &worksite, "Beta", &ids)
            .unwrap()
            .agitation;

        let saved = replace_agitations(
            db.conn(),
            &worksite,
            &[agitation(&alpha.id, "Beta"), agitation(&beta.id, "Alpha")],
            &ids,
        )
        .unwrap();

        assert_eq!(texts(&saved), ["Alpha", "Beta"]);
        assert_eq!(
            find_agitation_by_text(db.conn(), &worksite, "Alpha")
                .unwrap()
                .map(|agitation| agitation.id),
            Some(beta.id)
        );
    }

    #[test]
    fn parks_every_kept_id_on_one_minted_id_each() {
        let (db, ids, worksite) = seeded();
        let alpha = create_agitation(db.conn(), &worksite, "Alpha", &ids)
            .unwrap()
            .agitation;
        let beta = create_agitation(db.conn(), &worksite, "Beta", &ids)
            .unwrap()
            .agitation;

        replace_agitations(db.conn(), &worksite, &[alpha, beta], &ids).unwrap();

        // 1-4 were the seed, 5 and 6 the two creates, 7 and 8 the two parked rows.
        assert_eq!(ids.next_id(), counter_id(9));
    }

    #[test]
    fn deletes_an_omitted_agitation_and_the_assignments_that_pointed_at_it() {
        let (db, ids, worksite) = seeded();
        let kept = create_agitation(db.conn(), &worksite, "Kept", &ids)
            .unwrap()
            .agitation;
        let dropped = create_agitation(db.conn(), &worksite, "Dropped", &ids)
            .unwrap()
            .agitation;
        for id in [&kept.id, &dropped.id] {
            db.conn()
                .execute(
                    "INSERT INTO worker_agitations (worker_id, agitation_id) VALUES (?1, ?2)",
                    params![WORKER, id],
                )
                .unwrap();
        }

        replace_agitations(db.conn(), &worksite, std::slice::from_ref(&kept), &ids).unwrap();

        assert_eq!(
            get_agitations(db.conn(), &Some(worksite.clone())).unwrap(),
            std::slice::from_ref(&kept)
        );
        assert_eq!(assigned_agitation_ids(db.conn()), [kept.id]);
    }

    #[test]
    fn can_empty_the_list() {
        let (db, ids, worksite) = seeded();
        create_agitation(db.conn(), &worksite, "Unpaid overtime", &ids).unwrap();

        assert_eq!(
            replace_agitations(db.conn(), &worksite, &[], &ids).unwrap(),
            Vec::new()
        );
    }

    #[test]
    fn orders_by_text_ignoring_case() {
        let (db, ids, worksite) = seeded();
        for text in ["zebra crossing", "Alpha", "broken rota"] {
            create_agitation(db.conn(), &worksite, text, &ids).unwrap();
        }

        assert_eq!(
            texts(&get_agitations(db.conn(), &Some(worksite.clone())).unwrap()),
            ["Alpha", "broken rota", "zebra crossing"]
        );
    }

    #[test]
    fn rejects_an_agitation_owned_by_another_worksite() {
        let (db, _ids, worksite) = seeded();
        db.conn()
            .execute(
                "INSERT INTO worksites (id, name, committee_target) VALUES ('other', 'Other', 5)",
                [],
            )
            .unwrap();
        db.conn()
            .execute(
                "INSERT INTO agitations (id, worksite_id, text) VALUES ('shared', 'other', 'Pay')",
                [],
            )
            .unwrap();

        let error = replace_agitations(
            db.conn(),
            &worksite,
            &[agitation("shared", "Pay")],
            &CounterId::new(),
        )
        .unwrap_err();

        assert!(
            matches!(error, Error::Message(message) if message == "Agitation \"shared\" belongs to another Worksite.")
        );
        assert_eq!(
            get_agitations(db.conn(), &Some(worksite.clone())).unwrap(),
            Vec::new()
        );
    }
}
