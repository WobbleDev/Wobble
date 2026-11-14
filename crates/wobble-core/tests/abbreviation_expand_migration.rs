//! The v26 migration adds `abbreviation` and `abbreviationOrigin` beside `shortForm` and
//! `shortFormOrigin` in every stored answer, and copies each lists-revision setting to its new
//! key. It never guesses: two different values on one answer or setting fail the upgrade.
//! Synthetic data only.

mod common;

use common::legacy_db::{add_worksite, finish_source, migration_rows, raw_version, start_source};
use rusqlite::Connection;
use serde_json::{json, Value};
use wobble_core::handle::App;
use wobble_core::schema::apply_migrations;

const WS: &str = "ws-abbr";

fn put_options(conn: &Connection, id: &str, options: &Value) {
    conn.execute(
        "UPDATE worker_attributes SET options = ?1 WHERE id = ?2",
        rusqlite::params![options.to_string(), id],
    )
    .expect("writes raw options");
}

fn options_of(conn: &Connection, id: &str) -> Value {
    let text: String = conn
        .query_row(
            "SELECT options FROM worker_attributes WHERE id = ?1",
            [id],
            |row| row.get(0),
        )
        .expect("reads options");
    serde_json::from_str(&text).expect("options are JSON")
}

fn setting(conn: &Connection, key: &str) -> Option<String> {
    conn.query_row(
        "SELECT value FROM app_settings WHERE key = ?1",
        [key],
        |row| row.get(0),
    )
    .ok()
}

/// A v25 source holding answers with only the old keys, written as raw JSON the way v24 and
/// v25 stored them.
fn v25_source(name: &str) -> (String, Connection) {
    let (path, conn) = start_source("abbreviation-expand", name);
    add_worksite(&conn, WS, "Worksite Alpha");
    common::legacy_db::add_attribute(
        &conn,
        WS,
        "dept",
        "Department",
        "category",
        "worker",
        true,
        &[("a", "x")],
        0,
    );
    put_options(
        &conn,
        "dept",
        &json!([
            { "id": "a", "value": "Customer Service North", "shortForm": "CS North",
              "shortFormOrigin": "edited" },
            { "id": "b", "value": "Back of House", "parentId": "a", "mode": "single",
              "shortForm": "Back of Ho…", "shortFormOrigin": "generated" }
        ]),
    );
    conn.execute(
        "INSERT INTO app_settings (key, value) VALUES (?1, 'rev-1')",
        [format!("shortFormListsRevision::{WS}")],
    )
    .expect("a lists revision setting");
    (path, conn)
}

#[test]
fn a_v25_database_gains_the_new_keys_beside_the_old_and_keeps_everything_else() {
    let (path, conn) = v25_source("copy");
    finish_source(&path, conn, 25);

    drop(App::open_legacy_fixture(&path));
    // LEGACY-PLAINTEXT-FIXTURE: temp-constructed legacy-schema source for upgrade-read test (intentional plaintext, never production).
    let conn = Connection::open(&path).unwrap();
    assert_eq!(raw_version(&conn), Some(26));
    assert_eq!(
        migration_rows(&conn).last().unwrap(),
        &(26, "abbreviation".to_owned())
    );
    assert_eq!(
        options_of(&conn, "dept"),
        json!([
            { "id": "a", "value": "Customer Service North", "shortForm": "CS North",
              "shortFormOrigin": "edited", "abbreviation": "CS North",
              "abbreviationOrigin": "edited" },
            { "id": "b", "value": "Back of House", "parentId": "a", "mode": "single",
              "shortForm": "Back of Ho…", "shortFormOrigin": "generated",
              "abbreviation": "Back of Ho…", "abbreviationOrigin": "generated" }
        ])
    );
    assert_eq!(
        setting(&conn, &format!("abbreviationListsRevision::{WS}")).as_deref(),
        Some("rev-1")
    );
    assert_eq!(
        setting(&conn, &format!("shortFormListsRevision::{WS}")).as_deref(),
        Some("rev-1"),
        "the old key stays until the contract step"
    );
}

#[test]
fn every_upgradable_version_ends_with_both_key_sets_equal() {
    for version in [12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22] {
        let (path, conn) = start_source("abbreviation-expand", &format!("v{version}"));
        add_worksite(&conn, WS, "Worksite Alpha");
        common::legacy_db::add_attribute(
            &conn,
            WS,
            "dept",
            "Department",
            "category",
            "worker",
            true,
            &[("front", "Front"), ("long", "Back of House Maintenance")],
            0,
        );
        finish_source(&path, conn, version);

        drop(App::open_legacy_fixture(&path));
        // LEGACY-PLAINTEXT-FIXTURE: temp-constructed legacy-schema source for upgrade-read test (intentional plaintext, never production).
        let conn = Connection::open(&path).unwrap();
        assert_eq!(raw_version(&conn), Some(26), "v{version}");
        let options = options_of(&conn, "dept");
        let answers = options.as_array().unwrap();
        assert_eq!(answers.len(), 2, "v{version}");
        for answer in answers {
            assert!(answer["abbreviation"].is_string(), "v{version}");
            assert_eq!(answer["abbreviation"], answer["shortForm"], "v{version}");
            assert_eq!(
                answer["abbreviationOrigin"], answer["shortFormOrigin"],
                "v{version}"
            );
        }
    }
}

#[test]
fn opening_twice_changes_nothing_and_records_the_step_once() {
    let (path, conn) = v25_source("twice");
    finish_source(&path, conn, 25);
    drop(App::open_legacy_fixture(&path));
    // LEGACY-PLAINTEXT-FIXTURE: temp-constructed legacy-schema source for upgrade-read test (intentional plaintext, never production).
    let first = options_of(&Connection::open(&path).unwrap(), "dept");
    drop(App::open_legacy_fixture(&path));
    // LEGACY-PLAINTEXT-FIXTURE: temp-constructed legacy-schema source for upgrade-read test (intentional plaintext, never production).
    let conn = Connection::open(&path).unwrap();
    assert_eq!(options_of(&conn, "dept"), first);
    assert_eq!(
        migration_rows(&conn)
            .iter()
            .filter(|(version, _)| *version == 26)
            .count(),
        1
    );
}

#[test]
fn an_answer_whose_two_names_disagree_fails_the_upgrade_and_rolls_back() {
    let (path, conn) = v25_source("disagree");
    finish_source(&path, conn, 25);
    // LEGACY-PLAINTEXT-FIXTURE: temp-constructed legacy-schema source for upgrade-read test (intentional plaintext, never production).
    let conn = Connection::open(&path).unwrap();
    let mut options = options_of(&conn, "dept");
    options[0]["abbreviation"] = json!("Different");
    options[0]["abbreviationOrigin"] = json!("edited");
    put_options(&conn, "dept", &options);

    let error = apply_migrations(&conn).expect_err("a disagreement must stop the upgrade");
    assert!(error.to_string().contains("disagree"), "{error}");
    assert_eq!(raw_version(&conn), Some(25), "the version is not advanced");
    assert_eq!(options_of(&conn, "dept"), options, "nothing was rewritten");
    assert_eq!(
        setting(&conn, &format!("abbreviationListsRevision::{WS}")),
        None,
        "no setting was copied"
    );
}

#[test]
fn a_lists_revision_whose_two_keys_disagree_fails_the_upgrade_and_rolls_back() {
    let (path, conn) = v25_source("setting");
    finish_source(&path, conn, 25);
    // LEGACY-PLAINTEXT-FIXTURE: temp-constructed legacy-schema source for upgrade-read test (intentional plaintext, never production).
    let conn = Connection::open(&path).unwrap();
    conn.execute(
        "INSERT INTO app_settings (key, value) VALUES (?1, 'rev-2')",
        [format!("abbreviationListsRevision::{WS}")],
    )
    .unwrap();

    let error = apply_migrations(&conn).expect_err("a disagreement must stop the upgrade");
    assert!(error.to_string().contains("disagree"), "{error}");
    assert_eq!(raw_version(&conn), Some(25));
}
