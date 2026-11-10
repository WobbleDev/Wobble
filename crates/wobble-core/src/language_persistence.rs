//! Worksite Languages: list, create, replace, and assign them to workers.
//!
//! ADR-0015 keeps this deliberately parallel to agitation_persistence.rs: two tables,
//! two modules, no shared code.

use std::collections::HashSet;

use rusqlite::{params, Connection, OptionalExtension, Transaction, TransactionBehavior};
use serde::Serialize;

use crate::error::{Error, Result};
use crate::id::IdSource;
use crate::schema::Worksite;

/// A Language as the handlers surface it.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
pub struct Language {
    pub id: String,
    pub name: String,
}

/// `LanguageCreateResult`: whether a row was inserted, plus the language either way.
#[derive(Debug, Clone, PartialEq)]
pub struct LanguageCreateResult {
    pub created: bool,
    pub language: Language,
}

/// `getLanguages`: the Worksite's languages, case-insensitively ordered by name.
/// No Worksite reads nothing.
pub fn get_languages(conn: &Connection, worksite: &Option<Worksite>) -> Result<Vec<Language>> {
    let Some(worksite) = worksite else {
        return Ok(Vec::new());
    };

    let mut statement = conn.prepare(
        "SELECT id, name FROM languages WHERE worksite_id = ?1 ORDER BY name COLLATE NOCASE",
    )?;
    let languages = statement
        .query_map([&worksite.id], |row| {
            Ok(Language {
                id: row.get(0)?,
                name: row.get(1)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<Language>>>()?;

    Ok(languages)
}

/// `findLanguageByName`: the `name` column is `COLLATE NOCASE`, so this compares
/// case-insensitively without a `COLLATE` of its own — that is what makes create
/// idempotent.
fn find_language_by_name(
    conn: &Connection,
    worksite: &Worksite,
    name: &str,
) -> Result<Option<Language>> {
    let language = conn
        .query_row(
            "SELECT id, name FROM languages WHERE worksite_id = ?1 AND name = ?2",
            params![worksite.id, name],
            |row| {
                Ok(Language {
                    id: row.get(0)?,
                    name: row.get(1)?,
                })
            },
        )
        .optional()?;

    Ok(language)
}

/// `findUnknownLanguageIds`: the subset of the given ids this Worksite does not have.
pub fn find_unknown_language_ids(
    conn: &Connection,
    worksite: &Worksite,
    ids: &[String],
) -> Result<Vec<String>> {
    let mut statement =
        conn.prepare("SELECT 1 FROM languages WHERE id = ?1 AND worksite_id = ?2")?;

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

/// `saveWorkerLanguages`: the worker's assignments go, then each id is inserted through
/// the same-Worksite `EXISTS` guards. The callers hold the transaction.
pub fn save_worker_languages(
    conn: &Connection,
    worksite: &Worksite,
    worker_id: &str,
    ids: &[String],
) -> Result<()> {
    conn.execute(
        "DELETE FROM worker_languages \
         WHERE worker_id = ?1 \
           AND worker_id IN (SELECT id FROM workers WHERE worksite_id = ?2) \
           AND language_id IN (SELECT id FROM languages WHERE worksite_id = ?3)",
        params![worker_id, worksite.id, worksite.id],
    )?;

    let mut insert = conn.prepare(
        "INSERT INTO worker_languages (worker_id, language_id) \
         SELECT ?1, ?2 \
         WHERE EXISTS (SELECT 1 FROM workers WHERE id = ?3 AND worksite_id = ?4) \
           AND EXISTS (SELECT 1 FROM languages WHERE id = ?5 AND worksite_id = ?6)",
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

/// `createLanguage`: an already-listed name wins and keeps its stored spelling,
/// otherwise a new row is minted. One deferred transaction; no trim here — the route
/// trims.
pub fn create_language(
    conn: &Connection,
    worksite: &Worksite,
    name: &str,
    id_source: &impl IdSource,
) -> Result<LanguageCreateResult> {
    let tx = Transaction::new_unchecked(conn, TransactionBehavior::Deferred)?;

    let result = match find_language_by_name(&tx, worksite, name)? {
        Some(language) => LanguageCreateResult {
            created: false,
            language,
        },
        None => {
            let language = Language {
                id: id_source.next_id(),
                name: name.to_owned(),
            };
            tx.execute(
                "INSERT INTO languages (id, worksite_id, name) VALUES (?1, ?2, ?3)",
                params![language.id, worksite.id, language.name],
            )?;

            LanguageCreateResult {
                created: true,
                language,
            }
        }
    };

    tx.commit()?;

    Ok(result)
}

/// One Language removed from the list by a merge: its assignments move to the kept
/// survivor, and the folded row is deleted.
#[derive(Debug, Clone, PartialEq)]
pub struct LanguageMerge {
    pub folded_id: String,
    pub survivor_id: String,
}

/// A proposed kept Language that another Worksite owns is not this Worksite's to save.
/// The read-only preview refuses it through the same helper and the same message.
pub fn reject_foreign_language_ids(
    conn: &Connection,
    worksite: &Worksite,
    languages: &[Language],
) -> Result<()> {
    let mut find_owner = conn.prepare("SELECT worksite_id FROM languages WHERE id = ?1")?;
    for language in languages {
        let owner: Option<String> = find_owner
            .query_row([&language.id], |row| row.get(0))
            .optional()?;
        if let Some(owner) = owner {
            if owner != worksite.id {
                return Err(Error::Message(format!(
                    "Language \"{}\" belongs to another Worksite.",
                    language.id
                )));
            }
        }
    }

    Ok(())
}

/// Every merge a replacement proposes, checked against the stored ids and the list's kept
/// ids exactly as the Save checks them. The read-only preview calls this too, so it never
/// reports an effect for a Save that would fail.
pub fn validate_language_merges(
    stored_ids: &[String],
    kept_ids: &HashSet<&str>,
    merges: &[LanguageMerge],
) -> Result<()> {
    let stored: HashSet<&str> = stored_ids.iter().map(String::as_str).collect();
    for merge in merges {
        if merge.folded_id == merge.survivor_id
            || kept_ids.contains(merge.folded_id.as_str())
            || !stored.contains(merge.folded_id.as_str())
        {
            return Err(Error::Message(format!(
                "Language \"{}\" cannot be merged into \"{}\".",
                merge.folded_id, merge.survivor_id
            )));
        }
        if !kept_ids.contains(merge.survivor_id.as_str())
            || !stored.contains(merge.survivor_id.as_str())
        {
            return Err(Error::Message(format!(
                "Merge survivor \"{}\" is not a kept Language of this Worksite.",
                merge.survivor_id
            )));
        }
    }

    Ok(())
}

/// `replaceLanguages`: ids left out are deleted, kept rows are parked on throwaway
/// names and then rewritten, unknown ids are inserted — all in one deferred
/// transaction, so a name swap never trips `UNIQUE (worksite_id, name)`.
pub fn replace_languages(
    conn: &Connection,
    worksite: &Worksite,
    languages: &[Language],
    id_source: &impl IdSource,
) -> Result<Vec<Language>> {
    replace_languages_with_merges(conn, worksite, languages, &[], id_source)
}

/// `replaceLanguages` with merges: as above, plus each merge remaps the folded
/// Language's assignments to its survivor (a Worker holding both holds the survivor
/// once), then deletes the folded row. Survivors keep their id and position; every
/// check runs before the first write, and the one transaction rolls back on any error.
pub fn replace_languages_with_merges(
    conn: &Connection,
    worksite: &Worksite,
    languages: &[Language],
    merges: &[LanguageMerge],
    id_source: &impl IdSource,
) -> Result<Vec<Language>> {
    let tx = Transaction::new_unchecked(conn, TransactionBehavior::Deferred)?;

    // Unlike the attribute replace, this check lives *inside* the transaction, as the
    // TS `db.transaction` callback does. The read-only preview calls the same helper.
    reject_foreign_language_ids(&tx, worksite, languages)?;

    let stored_ids = {
        let mut statement = tx.prepare("SELECT id FROM languages WHERE worksite_id = ?1")?;
        let ids = statement
            .query_map([&worksite.id], |row| row.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<String>>>()?;
        ids
    };
    let kept_ids: HashSet<&str> = languages
        .iter()
        .map(|language| language.id.as_str())
        .collect();
    validate_language_merges(&stored_ids, &kept_ids, merges)?;

    {
        let mut remap_shared = tx.prepare(
            "DELETE FROM worker_languages WHERE language_id = ?1 \
               AND worker_id IN (SELECT worker_id FROM worker_languages WHERE language_id = ?2)",
        )?;
        let mut remap =
            tx.prepare("UPDATE worker_languages SET language_id = ?2 WHERE language_id = ?1")?;
        let mut fold = tx.prepare("DELETE FROM languages WHERE id = ?1 AND worksite_id = ?2")?;
        for merge in merges {
            remap_shared.execute(params![merge.folded_id, merge.survivor_id])?;
            remap.execute(params![merge.folded_id, merge.survivor_id])?;
            fold.execute(params![merge.folded_id, worksite.id])?;
        }
    }

    {
        let mut delete = tx.prepare("DELETE FROM languages WHERE id = ?1 AND worksite_id = ?2")?;
        for stored_id in &stored_ids {
            if !kept_ids.contains(stored_id.as_str()) {
                delete.execute(params![stored_id, worksite.id])?;
            }
        }
    }

    {
        let mut park =
            tx.prepare("UPDATE languages SET name = ?1 WHERE id = ?2 AND worksite_id = ?3")?;
        for language in languages {
            if stored_ids.contains(&language.id) {
                // `__updating_${randomUUID()}`: the parking name is thrown away by the
                // rewrite below, but the id is still minted so the counter the recorder
                // stubbed stays in lock-step with this port.
                park.execute(params![
                    format!("__updating_{}", id_source.next_id()),
                    language.id,
                    worksite.id
                ])?;
            }
        }
    }

    {
        let mut rename =
            tx.prepare("UPDATE languages SET name = ?1 WHERE id = ?2 AND worksite_id = ?3")?;
        let mut insert =
            tx.prepare("INSERT INTO languages (id, worksite_id, name) VALUES (?1, ?2, ?3)")?;
        for language in languages {
            if stored_ids.contains(&language.id) {
                rename.execute(params![language.name, language.id, worksite.id])?;
            } else {
                insert.execute(params![language.id, worksite.id, language.name])?;
            }
        }
    }

    tx.commit()?;

    get_languages(conn, &Some(worksite.clone()))
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

    fn language(id: &str, name: &str) -> Language {
        Language {
            id: id.to_owned(),
            name: name.to_owned(),
        }
    }

    fn names(languages: &[Language]) -> Vec<&str> {
        languages
            .iter()
            .map(|language| language.name.as_str())
            .collect()
    }

    fn assigned_language_ids(conn: &Connection) -> Vec<String> {
        let mut statement = conn
            .prepare("SELECT language_id FROM worker_languages WHERE worker_id = ?1")
            .unwrap();
        statement
            .query_map([WORKER], |row| row.get::<_, String>(0))
            .unwrap()
            .collect::<rusqlite::Result<Vec<String>>>()
            .unwrap()
    }

    #[test]
    fn get_languages_reads_nothing_without_a_worksite() {
        let (db, _ids, worksite) = seeded();
        create_language(db.conn(), &worksite, "Spanish", &CounterId::new()).unwrap();

        assert_eq!(get_languages(db.conn(), &None).unwrap(), Vec::new());
    }

    #[test]
    fn creates_a_language_and_reports_it_as_created() {
        let (db, ids, worksite) = seeded();

        let result = create_language(db.conn(), &worksite, "Spanish", &ids).unwrap();

        assert!(result.created);
        assert_eq!(result.language.name, "Spanish");
        assert_eq!(result.language.id, counter_id(5));
        assert_eq!(
            get_languages(db.conn(), &Some(worksite.clone())).unwrap(),
            [result.language]
        );
    }

    #[test]
    fn returns_the_existing_language_when_the_worksite_already_lists_the_name() {
        let (db, ids, worksite) = seeded();
        let first = create_language(db.conn(), &worksite, "Spanish", &ids).unwrap();

        let second = create_language(db.conn(), &worksite, "spanish", &ids).unwrap();

        assert!(!second.created);
        assert_eq!(second.language.id, first.language.id);
        // The stored spelling wins: the match did not overwrite it.
        assert_eq!(second.language.name, "Spanish");
        assert_eq!(
            get_languages(db.conn(), &Some(worksite.clone()))
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

        let saved = replace_languages(
            db.conn(),
            &worksite,
            &[
                language("client-generated-1", "Spanish"),
                language("client-generated-2", "Polish"),
            ],
            &CounterId::new(),
        )
        .unwrap();

        assert_eq!(names(&saved), ["Polish", "Spanish"]);
        assert_eq!(
            get_languages(db.conn(), &Some(worksite.clone()))
                .unwrap()
                .len(),
            2
        );
    }

    #[test]
    fn mixes_new_and_existing_languages_in_one_save() {
        let (db, ids, worksite) = seeded();
        let existing = create_language(db.conn(), &worksite, "Spanish", &ids)
            .unwrap()
            .language;

        let saved = replace_languages(
            db.conn(),
            &worksite,
            &[existing, language("client-generated", "Polish")],
            &ids,
        )
        .unwrap();

        assert_eq!(saved.len(), 2);
        assert!(names(&saved).contains(&"Spanish"));
        assert!(names(&saved).contains(&"Polish"));
    }

    #[test]
    fn renames_a_language_in_place_keeping_its_id_and_assignments() {
        let (db, ids, worksite) = seeded();
        let existing = create_language(db.conn(), &worksite, "Spanish", &ids)
            .unwrap()
            .language;
        db.conn()
            .execute(
                "INSERT INTO worker_languages (worker_id, language_id) VALUES (?1, ?2)",
                params![WORKER, existing.id],
            )
            .unwrap();

        replace_languages(
            db.conn(),
            &worksite,
            &[language(&existing.id, "Castilian")],
            &ids,
        )
        .unwrap();

        assert_eq!(
            get_languages(db.conn(), &Some(worksite.clone())).unwrap(),
            [language(&existing.id, "Castilian")]
        );
        assert_eq!(assigned_language_ids(db.conn()), [existing.id]);
    }

    #[test]
    fn swaps_two_names_in_one_save_without_tripping_the_unique_constraint() {
        let (db, ids, worksite) = seeded();
        let alpha = create_language(db.conn(), &worksite, "Alpha", &ids)
            .unwrap()
            .language;
        let beta = create_language(db.conn(), &worksite, "Beta", &ids)
            .unwrap()
            .language;

        let saved = replace_languages(
            db.conn(),
            &worksite,
            &[language(&alpha.id, "Beta"), language(&beta.id, "Alpha")],
            &ids,
        )
        .unwrap();

        assert_eq!(names(&saved), ["Alpha", "Beta"]);
        assert_eq!(
            find_language_by_name(db.conn(), &worksite, "Alpha")
                .unwrap()
                .map(|language| language.id),
            Some(beta.id)
        );
    }

    #[test]
    fn parks_every_kept_id_on_one_minted_id_each() {
        let (db, ids, worksite) = seeded();
        let alpha = create_language(db.conn(), &worksite, "Alpha", &ids)
            .unwrap()
            .language;
        let beta = create_language(db.conn(), &worksite, "Beta", &ids)
            .unwrap()
            .language;

        replace_languages(db.conn(), &worksite, &[alpha, beta], &ids).unwrap();

        // 1-4 were the seed, 5 and 6 the two creates, 7 and 8 the two parked rows.
        assert_eq!(ids.next_id(), counter_id(9));
    }

    #[test]
    fn deletes_an_omitted_language_and_the_assignments_that_pointed_at_it() {
        let (db, ids, worksite) = seeded();
        let kept = create_language(db.conn(), &worksite, "Kept", &ids)
            .unwrap()
            .language;
        let dropped = create_language(db.conn(), &worksite, "Dropped", &ids)
            .unwrap()
            .language;
        for id in [&kept.id, &dropped.id] {
            db.conn()
                .execute(
                    "INSERT INTO worker_languages (worker_id, language_id) VALUES (?1, ?2)",
                    params![WORKER, id],
                )
                .unwrap();
        }

        replace_languages(db.conn(), &worksite, std::slice::from_ref(&kept), &ids).unwrap();

        assert_eq!(
            get_languages(db.conn(), &Some(worksite.clone())).unwrap(),
            std::slice::from_ref(&kept)
        );
        assert_eq!(assigned_language_ids(db.conn()), [kept.id]);
    }

    #[test]
    fn can_empty_the_list() {
        let (db, ids, worksite) = seeded();
        create_language(db.conn(), &worksite, "Spanish", &ids).unwrap();

        assert_eq!(
            replace_languages(db.conn(), &worksite, &[], &ids).unwrap(),
            Vec::new()
        );
    }

    #[test]
    fn orders_by_name_ignoring_case() {
        let (db, ids, worksite) = seeded();
        for name in ["zulu", "Alpha", "polish"] {
            create_language(db.conn(), &worksite, name, &ids).unwrap();
        }

        assert_eq!(
            names(&get_languages(db.conn(), &Some(worksite.clone())).unwrap()),
            ["Alpha", "polish", "zulu"]
        );
    }

    #[test]
    fn rejects_a_language_owned_by_another_worksite() {
        let (db, _ids, worksite) = seeded();
        db.conn()
            .execute(
                "INSERT INTO worksites (id, name, committee_target) VALUES ('other', 'Other', 5)",
                [],
            )
            .unwrap();
        db.conn()
            .execute(
                "INSERT INTO languages (id, worksite_id, name) VALUES ('shared', 'other', 'Polish')",
                [],
            )
            .unwrap();

        let error = replace_languages(
            db.conn(),
            &worksite,
            &[language("shared", "Polish")],
            &CounterId::new(),
        )
        .unwrap_err();

        assert!(
            matches!(error, Error::Message(message) if message == "Language \"shared\" belongs to another Worksite.")
        );
        assert_eq!(
            get_languages(db.conn(), &Some(worksite.clone())).unwrap(),
            Vec::new()
        );
    }
}
