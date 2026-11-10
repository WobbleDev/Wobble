//! Worksite storage: list, find, select, create, delete, and update the name and committee target.

use rusqlite::{params, Connection, Row, Transaction, TransactionBehavior};

use crate::error::Result;
use crate::id::IdSource;
use crate::schema::{self, Worksite, WorksiteTemplateLocale};

/// `SELECT id, name, committee_target AS committeeTarget` in one row mapper.
fn row_to_worksite(row: &Row) -> rusqlite::Result<Worksite> {
    Ok(Worksite {
        id: row.get(0)?,
        name: row.get(1)?,
        committee_target: row.get(2)?,
    })
}

/// `listWorksites`: every Worksite, in insertion order (`ORDER BY rowid`).
pub fn list_worksites(conn: &Connection) -> Result<Vec<Worksite>> {
    let mut statement =
        conn.prepare("SELECT id, name, committee_target FROM worksites ORDER BY rowid")?;
    let worksites = statement
        .query_map([], row_to_worksite)?
        .collect::<rusqlite::Result<Vec<Worksite>>>()?;
    Ok(worksites)
}

/// A Worksite's Worker count, from the grouped count query.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorksiteWorkerCount {
    pub worksite_id: String,
    pub workers: i64,
}

/// Every Worksite with its Worker count, in insertion order, from one grouped query. A
/// Worksite with no Workers counts 0 (LEFT JOIN), so the list is as long as the Worksite
/// list and each count is that Worksite's `workers` rows.
pub fn count_worksite_workers(conn: &Connection) -> Result<Vec<WorksiteWorkerCount>> {
    let mut statement = conn.prepare(
        "SELECT s.id, COUNT(w.id) FROM worksites s \
         LEFT JOIN workers w ON w.worksite_id = s.id \
         GROUP BY s.id ORDER BY s.rowid",
    )?;
    let counts = statement
        .query_map([], |row| {
            Ok(WorksiteWorkerCount {
                worksite_id: row.get(0)?,
                workers: row.get(1)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(counts)
}

/// `findWorksite`: one Worksite by exact id, or null.
pub fn find_worksite(conn: &Connection, id: &str) -> Result<Option<Worksite>> {
    let mut statement =
        conn.prepare("SELECT id, name, committee_target FROM worksites WHERE id = ?1")?;
    let mut rows = statement.query_map([id], row_to_worksite)?;
    match rows.next() {
        Some(row) => Ok(Some(row?)),
        None => Ok(None),
    }
}

/// A valid saved preference wins; otherwise the first inserted Worksite is the safe
/// fallback. An absent or empty preference is no preference at all.
pub fn resolve_active_worksite(
    conn: &Connection,
    preferred: Option<&str>,
) -> Result<Option<Worksite>> {
    if let Some(id) = preferred.filter(|id| !id.is_empty()) {
        if let Some(worksite) = find_worksite(conn, id)? {
            return Ok(Some(worksite));
        }
    }

    Ok(list_worksites(conn)?.into_iter().next())
}

/// `selectWorksite`: looks up a requested selection exactly and never substitutes
/// a fallback, so this is `find_worksite` without the resolve step.
pub fn select_worksite(conn: &Connection, id: &str) -> Result<Option<Worksite>> {
    find_worksite(conn, id)
}

/// `createWorksite`: the first unused default name, then the seeded attributes,
/// all inside one immediate transaction. `Transaction::new_unchecked` keeps the
/// `&Connection` signature the router can supply; the connection is single-threaded
/// here, so the missing nested-transaction guard costs nothing.
pub fn create_worksite(conn: &Connection, id_source: &impl IdSource) -> Result<Worksite> {
    create_worksite_with_template(conn, id_source, WorksiteTemplateLocale::En)
}

/// `createWorksite` with an optional creation template. The English template is the
/// legacy default; a Spanish template changes only the new, editable labels. Name
/// uniqueness, identity generation, seeding and persistence stay shared.
pub fn create_worksite_with_template(
    conn: &Connection,
    id_source: &impl IdSource,
    locale: WorksiteTemplateLocale,
) -> Result<Worksite> {
    let tx = Transaction::new_unchecked(conn, TransactionBehavior::Immediate)?;

    let used_names = {
        let mut statement = tx.prepare("SELECT name FROM worksites")?;
        let names = statement
            .query_map([], |row| row.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<String>>>()?;
        names
    };

    let default_name = locale.default_name();
    let mut name = default_name.to_owned();
    let mut suffix = 2;
    while used_names.iter().any(|used| used == &name) {
        name = format!("{default_name} {suffix}");
        suffix += 1;
    }

    let worksite = schema::insert_worksite(&tx, &name, id_source)?;
    schema::seed_default_worker_attributes_for(&tx, &worksite.id, id_source, locale)?;
    tx.commit()?;

    Ok(worksite)
}

/// `deleteWorksite`: removes the Worksite and everything it owns through the
/// schema's cascading foreign keys. True when a row was removed.
pub fn delete_worksite(conn: &Connection, id: &str) -> Result<bool> {
    let removed = conn.execute("DELETE FROM worksites WHERE id = ?1", params![id])?;
    Ok(removed > 0)
}

/// `saveWorksiteName`: writes the name and returns the updated Worksite.
pub fn save_worksite_name(conn: &Connection, worksite: &Worksite, name: &str) -> Result<Worksite> {
    conn.execute(
        "UPDATE worksites SET name = ?1 WHERE id = ?2",
        params![name, worksite.id],
    )?;

    Ok(Worksite {
        name: name.to_owned(),
        ..worksite.clone()
    })
}

/// `saveWorksiteCommitteeTarget`: writes the target and returns the updated Worksite.
pub fn save_worksite_committee_target(
    conn: &Connection,
    worksite: &Worksite,
    target: i64,
) -> Result<Worksite> {
    conn.execute(
        "UPDATE worksites SET committee_target = ?1 WHERE id = ?2",
        params![target, worksite.id],
    )?;

    Ok(Worksite {
        committee_target: target,
        ..worksite.clone()
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::open_seeded;
    use crate::id::CounterId;
    use crate::schema::DEFAULT_WORKSITE_NAME;

    fn seeded() -> crate::db::Db {
        open_seeded(":memory:", &CounterId::new()).expect("a seeded database")
    }

    fn seeded_with_ids() -> (crate::db::Db, CounterId) {
        let id_source = CounterId::new();
        let db = open_seeded(":memory:", &id_source).expect("a seeded database");
        (db, id_source)
    }

    #[test]
    fn lists_and_finds_the_seeded_worksite() {
        let db = seeded();
        let worksites = list_worksites(db.conn()).unwrap();

        assert_eq!(worksites.len(), 1);
        assert_eq!(worksites[0].name, DEFAULT_WORKSITE_NAME);
        assert_eq!(worksites[0].committee_target, 5);
        assert_eq!(
            find_worksite(db.conn(), &worksites[0].id).unwrap(),
            Some(worksites[0].clone())
        );
        assert_eq!(find_worksite(db.conn(), "ghost").unwrap(), None);
    }

    #[test]
    fn resolve_falls_back_to_the_first_worksite_and_honours_a_valid_preference() {
        let (db, ids) = seeded_with_ids();
        let first = list_worksites(db.conn()).unwrap().remove(0);
        let second = create_worksite(db.conn(), &ids).unwrap();

        // Absent, empty, and unknown preferences all fall back to the first.
        assert_eq!(
            resolve_active_worksite(db.conn(), None).unwrap(),
            Some(first.clone())
        );
        assert_eq!(
            resolve_active_worksite(db.conn(), Some("")).unwrap(),
            Some(first.clone())
        );
        assert_eq!(
            resolve_active_worksite(db.conn(), Some("ghost")).unwrap(),
            Some(first.clone())
        );
        assert_eq!(
            resolve_active_worksite(db.conn(), Some(&second.id)).unwrap(),
            Some(second)
        );
    }

    #[test]
    fn select_never_substitutes_a_fallback() {
        let db = seeded();
        assert_eq!(select_worksite(db.conn(), "ghost").unwrap(), None);
    }

    #[test]
    fn create_suffixes_taken_default_names_and_seeds_attributes() {
        let (db, ids) = seeded_with_ids();
        let second = create_worksite(db.conn(), &ids).unwrap();
        let third = create_worksite(db.conn(), &ids).unwrap();

        assert_eq!(second.name, "My Worksite 2");
        assert_eq!(third.name, "My Worksite 3");
        assert_eq!(list_worksites(db.conn()).unwrap().len(), 3);

        let attributes: Vec<(String, String, i64)> = db
            .conn()
            .prepare(
                "SELECT name, kind, position \
                 FROM worker_attributes WHERE worksite_id = ?1 ORDER BY position",
            )
            .unwrap()
            .query_map(params![third.id], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?))
            })
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap();
        assert_eq!(
            attributes,
            [
                ("Department".to_owned(), "category".to_owned(), 0),
                ("Role".to_owned(), "category".to_owned(), 1),
                ("Shifts".to_owned(), "tag".to_owned(), 2),
            ],
            "a new Worksite keeps the localized starter names and the original type mix"
        );
        let scope_columns: i64 = db
            .conn()
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('worker_attributes') \
                 WHERE name IN ('scope', 'inference_eligible')",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(scope_columns, 0, "the current schema has no scope metadata");
    }

    #[test]
    fn a_spanish_worksite_keeps_the_localized_starter_names_and_types() {
        let (db, ids) = seeded_with_ids();
        let worksite =
            create_worksite_with_template(db.conn(), &ids, WorksiteTemplateLocale::Es419).unwrap();
        assert_eq!(worksite.name, "Mi lugar de trabajo");

        let attributes: Vec<(String, String)> = db
            .conn()
            .prepare(
                "SELECT name, kind FROM worker_attributes \
                 WHERE worksite_id = ?1 ORDER BY position",
            )
            .unwrap()
            .query_map(params![worksite.id], |row| Ok((row.get(0)?, row.get(1)?)))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap();
        assert_eq!(
            attributes,
            [
                ("Departamento".to_owned(), "category".to_owned()),
                ("Puesto".to_owned(), "category".to_owned()),
                ("Turnos".to_owned(), "tag".to_owned()),
            ]
        );
    }

    #[test]
    fn delete_reports_whether_a_row_went_away_and_cascades() {
        let db = seeded();
        let first = list_worksites(db.conn()).unwrap().remove(0);

        assert!(!delete_worksite(db.conn(), "ghost").unwrap());
        assert!(delete_worksite(db.conn(), &first.id).unwrap());
        assert!(list_worksites(db.conn()).unwrap().is_empty());

        let attributes: i64 = db
            .conn()
            .query_row("SELECT COUNT(*) FROM worker_attributes", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(attributes, 0);
    }

    #[test]
    fn saves_rebuild_the_worksite_return_value() {
        let db = seeded();
        let worksite = list_worksites(db.conn()).unwrap().remove(0);

        let renamed = save_worksite_name(db.conn(), &worksite, "Renamed").unwrap();
        assert_eq!(renamed.name, "Renamed");
        assert_eq!(renamed.id, worksite.id);
        assert_eq!(renamed.committee_target, 5);

        let retargeted = save_worksite_committee_target(db.conn(), &renamed, 12).unwrap();
        assert_eq!(retargeted.committee_target, 12);
        assert_eq!(
            find_worksite(db.conn(), &worksite.id).unwrap(),
            Some(retargeted)
        );
    }
}
