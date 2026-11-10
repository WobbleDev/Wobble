//! Worker relationships: read, add, remove, and replace the normalized worker pairs.

use rusqlite::{params, Connection, OptionalExtension, Transaction, TransactionBehavior};

use crate::error::Result;
use crate::schema::Worksite;

/// `orderedWorkerPair`: the pair in lexicographic order, so one relationship is one
/// row however the caller ordered the ids. A self-pair keeps the same id twice, as the
/// TS ternary does.
fn ordered_worker_pair<'a>(first: &'a str, second: &'a str) -> (&'a str, &'a str) {
    if first < second {
        (first, second)
    } else {
        (second, first)
    }
}

/// `findWorkerById`: does this Worksite have that worker?
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

/// `hasInvalidRelationship`: a relation to itself, or to an id this Worksite does not
/// have. The loop is manual because the check is fallible.
pub fn has_invalid_relationship(
    conn: &Connection,
    worksite: &Worksite,
    worker_id: &str,
    related_ids: &[String],
) -> Result<bool> {
    for related_id in related_ids {
        if related_id.as_str() == worker_id || !worker_exists(conn, related_id, &worksite.id)? {
            return Ok(true);
        }
    }

    Ok(false)
}

/// Is this pair stored? The pair is normalized first, so the answer does not depend
/// on the argument order.
pub fn relationship_exists(
    conn: &Connection,
    worker_a_id: &str,
    worker_b_id: &str,
) -> Result<bool> {
    let (worker_a_id, worker_b_id) = ordered_worker_pair(worker_a_id, worker_b_id);
    let exists: Option<i64> = conn
        .query_row(
            "SELECT 1 FROM worker_relationships \
             WHERE worker_a_id = ?1 AND worker_b_id = ?2",
            params![worker_a_id, worker_b_id],
            |row| row.get(0),
        )
        .optional()?;

    Ok(exists.is_some())
}

/// Adds one normalized pair, answering whether it was new. The primary key makes a
/// repeat insert a no-op rather than a second row.
pub fn add_relationship_pair(
    conn: &Connection,
    worker_a_id: &str,
    worker_b_id: &str,
) -> Result<bool> {
    let (worker_a_id, worker_b_id) = ordered_worker_pair(worker_a_id, worker_b_id);
    let inserted = conn.execute(
        "INSERT OR IGNORE INTO worker_relationships (worker_a_id, worker_b_id) \
         VALUES (?1, ?2)",
        params![worker_a_id, worker_b_id],
    )?;

    Ok(inserted > 0)
}

/// Removes one normalized pair, answering whether it was there.
pub fn remove_relationship_pair(
    conn: &Connection,
    worker_a_id: &str,
    worker_b_id: &str,
) -> Result<bool> {
    let (worker_a_id, worker_b_id) = ordered_worker_pair(worker_a_id, worker_b_id);
    let removed = conn.execute(
        "DELETE FROM worker_relationships WHERE worker_a_id = ?1 AND worker_b_id = ?2",
        params![worker_a_id, worker_b_id],
    )?;

    Ok(removed > 0)
}

/// `replaceRelationships`: a no-op for a worker this Worksite does not have, otherwise
/// the worker's rows go and the given ids are inserted — both in one deferred
/// transaction, with the pair stored in lexicographic order.
///
/// better-sqlite3 nests a `db.transaction` inside an already-open one as a savepoint; the
/// worker service calls this inside its own transaction (C08), so the writes simply join
/// the caller's. An error then rolls back both together, exactly as the savepoint would.
pub fn replace_relationships(
    conn: &Connection,
    worksite: &Worksite,
    worker_id: &str,
    related_ids: &[String],
) -> Result<()> {
    if !worker_exists(conn, worker_id, &worksite.id)? {
        return Ok(());
    }

    let transaction = if conn.is_autocommit() {
        Some(Transaction::new_unchecked(
            conn,
            TransactionBehavior::Deferred,
        )?)
    } else {
        None
    };
    let write_conn: &Connection = match &transaction {
        Some(transaction) => transaction,
        None => conn,
    };

    // The `EXISTS` clause is the TS's second same-Worksite guard on the delete.
    write_conn.execute(
        "DELETE FROM worker_relationships \
         WHERE (worker_a_id = ?1 OR worker_b_id = ?2) \
           AND EXISTS (SELECT 1 FROM workers WHERE id = ?3 AND worksite_id = ?4)",
        params![worker_id, worker_id, worker_id, worksite.id],
    )?;

    {
        let mut insert = write_conn.prepare(
            "INSERT INTO worker_relationships (worker_a_id, worker_b_id) VALUES (?1, ?2)",
        )?;
        for related_id in related_ids {
            let (worker_a_id, worker_b_id) = ordered_worker_pair(worker_id, related_id);
            insert.execute(params![worker_a_id, worker_b_id])?;
        }
    }

    if let Some(transaction) = transaction {
        transaction.commit()?;
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::worker_persistence::insert_bare_worker;

    use crate::assembly::read_worker;
    use crate::attribute_persistence::get_worker_attributes;
    use crate::db::{open_seeded, Db};
    use crate::id::CounterId;
    use crate::worksite_persistence::resolve_active_worksite;

    fn seeded() -> (Db, CounterId, Worksite) {
        let ids = CounterId::new();
        let db = open_seeded(":memory:", &ids).unwrap();
        let worksite = resolve_active_worksite(db.conn(), None).unwrap().unwrap();
        (db, ids, worksite)
    }

    /// The spec's `makeWorker`: a worker row plus one attribute value per seeded
    /// attribute, holding that kind's empty value.
    fn add_worker(conn: &Connection, worksite: &Worksite, id: &str, name: &str) {
        insert_bare_worker(conn, &worksite.id, id, name, "");

        for attribute in get_worker_attributes(conn, &Some(worksite.clone())).unwrap() {
            let empty = if attribute.kind == "category" {
                serde_json::json!("")
            } else {
                serde_json::json!([])
            };
            conn.execute(
                "INSERT INTO worker_attribute_values (worker_id, attribute_id, value) \
                 VALUES (?1, ?2, ?3)",
                params![id, attribute.id, serde_json::to_string(&empty).unwrap()],
            )
            .unwrap();
        }
    }

    fn relationships(db: &Db, worksite: &Worksite, worker_id: &str) -> Vec<String> {
        read_worker(db.conn(), &Some(worksite.clone()), worker_id)
            .unwrap()
            .unwrap()
            .relationships
    }

    fn stored_pair(db: &Db) -> Vec<(String, String)> {
        let mut statement = db
            .conn()
            .prepare("SELECT worker_a_id, worker_b_id FROM worker_relationships ORDER BY rowid")
            .unwrap();
        statement
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
            .unwrap()
            .collect::<rusqlite::Result<Vec<(String, String)>>>()
            .unwrap()
    }

    #[test]
    fn orders_worker_pairs_lexicographically() {
        assert_eq!(ordered_worker_pair("a", "b"), ("a", "b"));
        assert_eq!(ordered_worker_pair("b", "a"), ("a", "b"));
        assert_eq!(ordered_worker_pair("a", "a"), ("a", "a"));
    }

    #[test]
    fn stores_a_relationship_once_and_reads_it_back_from_both_workers() {
        let (db, _ids, worksite) = seeded();
        add_worker(db.conn(), &worksite, "w1", "First");
        add_worker(db.conn(), &worksite, "w2", "Second");

        replace_relationships(db.conn(), &worksite, "w1", &["w2".to_owned()]).unwrap();

        assert_eq!(relationships(&db, &worksite, "w1"), ["w2"]);
        assert_eq!(relationships(&db, &worksite, "w2"), ["w1"]);
        assert_eq!(stored_pair(&db), [("w1".to_owned(), "w2".to_owned())]);
    }

    #[test]
    fn orders_the_stored_pair_regardless_of_which_worker_was_passed_first() {
        let (db, _ids, worksite) = seeded();
        add_worker(db.conn(), &worksite, "w1", "First");
        add_worker(db.conn(), &worksite, "w2", "Second");

        replace_relationships(db.conn(), &worksite, "w2", &["w1".to_owned()]).unwrap();

        assert_eq!(stored_pair(&db), [("w1".to_owned(), "w2".to_owned())]);
        assert_eq!(relationships(&db, &worksite, "w1"), ["w2"]);
        assert_eq!(relationships(&db, &worksite, "w2"), ["w1"]);
    }

    #[test]
    fn replaces_a_workers_relationships_instead_of_accumulating_them() {
        let (db, _ids, worksite) = seeded();
        add_worker(db.conn(), &worksite, "w1", "First");
        add_worker(db.conn(), &worksite, "w2", "Second");
        add_worker(db.conn(), &worksite, "w3", "Third");

        replace_relationships(db.conn(), &worksite, "w1", &["w2".to_owned()]).unwrap();
        replace_relationships(db.conn(), &worksite, "w1", &["w3".to_owned()]).unwrap();

        assert_eq!(relationships(&db, &worksite, "w1"), ["w3"]);
        assert_eq!(relationships(&db, &worksite, "w2"), Vec::<String>::new());
        assert_eq!(stored_pair(&db), [("w1".to_owned(), "w3".to_owned())]);
    }

    #[test]
    fn no_ops_for_a_worker_this_worksite_does_not_have() {
        let (db, _ids, worksite) = seeded();
        add_worker(db.conn(), &worksite, "w2", "Second");

        replace_relationships(db.conn(), &worksite, "ghost", &["w2".to_owned()]).unwrap();

        assert_eq!(stored_pair(&db), Vec::new());
    }

    #[test]
    fn accepts_an_existing_worker_that_is_not_itself() {
        let (db, _ids, worksite) = seeded();
        add_worker(db.conn(), &worksite, "w1", "First");
        add_worker(db.conn(), &worksite, "w2", "Second");

        assert!(!has_invalid_relationship(db.conn(), &worksite, "w1", &["w2".to_owned()]).unwrap());
        assert!(!has_invalid_relationship(db.conn(), &worksite, "w1", &[]).unwrap());
    }

    #[test]
    fn rejects_a_worker_relating_to_itself() {
        let (db, _ids, worksite) = seeded();
        add_worker(db.conn(), &worksite, "w1", "First");

        assert!(has_invalid_relationship(db.conn(), &worksite, "w1", &["w1".to_owned()]).unwrap());
    }

    #[test]
    fn rejects_a_relationship_that_points_at_nobody() {
        let (db, _ids, worksite) = seeded();
        add_worker(db.conn(), &worksite, "w1", "First");

        assert!(
            has_invalid_relationship(db.conn(), &worksite, "w1", &["nope".to_owned()]).unwrap()
        );
    }

    #[test]
    fn adds_one_pair_and_answers_whether_it_was_new() {
        let (db, _ids, worksite) = seeded();
        add_worker(db.conn(), &worksite, "w1", "First");
        add_worker(db.conn(), &worksite, "w2", "Second");

        assert!(add_relationship_pair(db.conn(), "w1", "w2").unwrap());
        assert_eq!(stored_pair(&db), [("w1".to_owned(), "w2".to_owned())]);
        // The same pair, named the other way round, is already there.
        assert!(!add_relationship_pair(db.conn(), "w2", "w1").unwrap());
        assert_eq!(stored_pair(&db), [("w1".to_owned(), "w2".to_owned())]);
        assert!(relationship_exists(db.conn(), "w2", "w1").unwrap());
        assert!(relationship_exists(db.conn(), "w1", "w2").unwrap());
    }

    #[test]
    fn removes_one_pair_regardless_of_argument_order() {
        let (db, _ids, worksite) = seeded();
        add_worker(db.conn(), &worksite, "w1", "First");
        add_worker(db.conn(), &worksite, "w2", "Second");
        add_relationship_pair(db.conn(), "w1", "w2").unwrap();

        // The caller saw the relation from w2, so it names the pair in that order.
        assert!(remove_relationship_pair(db.conn(), "w2", "w1").unwrap());
        assert_eq!(stored_pair(&db), Vec::new());
        assert!(!relationship_exists(db.conn(), "w1", "w2").unwrap());
        // A second removal has nothing left to take.
        assert!(!remove_relationship_pair(db.conn(), "w1", "w2").unwrap());
    }
}
