//! Ticket 03: the 15 to 16 upgrade reformats stored clean phone numbers at the request
//! boundary (`App::open`, then reads through `App::handle`), leaves every other stored
//! value alone, and preserves the supported migration chain through schema 25.

mod common;

use std::collections::BTreeMap;

use common::legacy_db::{add_attribute, add_worker, add_worksite, finish_source, start_source};
use common::{remove_database, temp_db_path};
use rusqlite::{params, Connection};
use serde_json::{json, Value};
use wobble_core::db::open_seeded_keyed;
use wobble_core::handle::{App, Request};
use wobble_core::id::CounterId;

/// A database whose tables match `version`, with the version row lowered after a fresh
/// bootstrap and the given Workers written straight to `workers`. This is how a legacy
/// database holds values the current routes would never write: a Phone typed before the
/// format existed. The v13 fixture carries no Attributes, because the 13 to 14 answer-id
/// step is not what these tests cover and hand-writing its input would reimplement it.
type StarterAttribute<'a> = (&'a str, &'a str, &'a str, &'a [(&'a str, &'a str)]);

fn database_at_version(name: &str, version: i64, phones: &[(&str, &str)]) -> String {
    let (path, conn) = start_source("phone-migration", name);
    add_worksite(&conn, "ws-phone", "Phone");
    // The v13 fixture carries no Attributes, because the 13 to 14 answer-id step is not
    // what these tests cover and hand-writing its input would reimplement it.
    let attributes: &[StarterAttribute<'_>] = if version == 13 {
        &[]
    } else {
        &[
            (
                "department",
                "Department",
                "category",
                &[("front", "Front")],
            ),
            ("role", "Role", "category", &[("server", "Server")]),
            ("shifts", "Shifts", "tag", &[("day", "Day")]),
        ]
    };
    for (position, (id, label, kind, answers)) in attributes.iter().enumerate() {
        add_attribute(
            &conn,
            "ws-phone",
            id,
            label,
            kind,
            "worker",
            true,
            answers,
            position as i64,
        );
    }
    for (worker_id, phone) in phones {
        add_worker(&conn, "ws-phone", worker_id, worker_id);
        conn.execute(
            "UPDATE workers SET phone = ?1 WHERE id = ?2",
            params![phone, worker_id],
        )
        .expect("a legacy phone");
        for (attribute_id, _, kind, _) in attributes {
            let answer = if *kind == "tag" { "[]" } else { "\"\"" };
            conn.execute(
                "INSERT INTO worker_attribute_values (worker_id, attribute_id, value) \
                 VALUES (?1, ?2, ?3)",
                params![worker_id, attribute_id, answer],
            )
            .expect("an unanswered attribute value");
        }
    }
    finish_source(&path, conn, version);
    path
}

fn dataset(app: &App) -> Value {
    let response = app.handle(
        &Request {
            method: "GET".to_owned(),
            path: "/api/dataset".to_owned(),
            query: String::new(),
            headers: Vec::new(),
            body: None,
        },
        &CounterId::new(),
    );
    assert_eq!(response.status, 200, "{}", response.body);
    response.body
}

/// Every Worker's stored Phone, keyed by Worker id, as the dataset route reads it.
fn phones(app: &App) -> BTreeMap<String, String> {
    dataset(app)["workers"]
        .as_array()
        .expect("the Worksite's workers")
        .iter()
        .map(|worker| {
            (
                worker["id"].as_str().expect("a worker id").to_owned(),
                worker["phone"].as_str().expect("a phone").to_owned(),
            )
        })
        .collect()
}

fn migration_rows(path: &str) -> Vec<(i64, String)> {
    // LEGACY-PLAINTEXT-FIXTURE: temp-constructed legacy-schema source for upgrade-read test (intentional plaintext, never production).
    let conn = Connection::open(path).expect("opens the upgraded database");
    let rows = conn
        .prepare("SELECT version, name FROM schema_migrations ORDER BY version")
        .expect("reads the migration rows")
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
        .expect("the migration rows")
        .collect::<rusqlite::Result<_>>()
        .expect("the migration rows");
    rows
}

fn current_key() -> wobble_core::key::Secret {
    wobble_core::key::Secret::from_passphrase("phone migration current fixture").unwrap()
}
fn current_migration_rows(path: &str) -> Vec<(i64, String)> {
    let conn =
        wobble_core::key::open_keyed_readonly(std::path::Path::new(path), Some(&current_key()))
            .unwrap();
    let mut statement = conn
        .prepare("SELECT version, name FROM schema_migrations ORDER BY version")
        .unwrap();
    statement
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap()
}

#[test]
fn upgrading_a_version_15_database_reformats_clean_phones_and_leaves_others_alone() {
    let path = database_at_version(
        "v15",
        15,
        &[
            ("w-digits", "5550100100"),
            ("w-dots", "555.010.0100"),
            ("w-prefix", "+1 555 010 0100"),
            ("w-formatted", "(555) 010-0100"),
            ("w-international", "+44 20 7946 0958"),
            ("w-short", "555-0101"),
            ("w-text", "call after 5"),
            ("w-notes", "call 555-010-0100"),
            ("w-empty", ""),
        ],
    );

    let app = App::open_legacy_fixture(&path);
    assert_eq!(
        phones(&app),
        BTreeMap::from([
            ("w-digits".to_owned(), "(555) 010-0100".to_owned()),
            ("w-dots".to_owned(), "(555) 010-0100".to_owned()),
            ("w-prefix".to_owned(), "(555) 010-0100".to_owned()),
            ("w-formatted".to_owned(), "(555) 010-0100".to_owned()),
            ("w-international".to_owned(), "+44 20 7946 0958".to_owned()),
            ("w-short".to_owned(), "555-0101".to_owned()),
            ("w-text".to_owned(), "call after 5".to_owned()),
            ("w-notes".to_owned(), "call 555-010-0100".to_owned()),
            ("w-empty".to_owned(), String::new()),
        ])
    );

    assert_eq!(
        migration_rows(&path),
        [
            (15, "current-schema-bootstrap".to_owned()),
            (16, "phone-format".to_owned()),
            (17, "app-settings-registry".to_owned()),
            (18, "workplace-attribute-contract".to_owned()),
            (19, "work-assignments".to_owned()),
            (20, "work-assignment-drafts".to_owned()),
            (21, "legacy-work-assignments".to_owned()),
            (22, "flatten-work-assignments".to_owned()),
            (23, "short-forms".to_owned()),
            (24, "saved-views".to_owned()),
            (25, "committee-goal".to_owned()),
        ]
    );

    remove_database(&path);
}

#[test]
fn upgrading_a_version_14_database_chains_through_15_to_20() {
    let path = database_at_version(
        "v14",
        14,
        &[("w-raw", "5550100100"), ("w-text", "call after 5")],
    );

    let app = App::open_legacy_fixture(&path);
    assert_eq!(
        phones(&app),
        BTreeMap::from([
            ("w-raw".to_owned(), "(555) 010-0100".to_owned()),
            ("w-text".to_owned(), "call after 5".to_owned()),
        ])
    );
    assert_eq!(
        migration_rows(&path),
        [
            (14, "current-schema-bootstrap".to_owned()),
            (15, "lookup-indexes".to_owned()),
            (16, "phone-format".to_owned()),
            (17, "app-settings-registry".to_owned()),
            (18, "workplace-attribute-contract".to_owned()),
            (19, "work-assignments".to_owned()),
            (20, "work-assignment-drafts".to_owned()),
            (21, "legacy-work-assignments".to_owned()),
            (22, "flatten-work-assignments".to_owned()),
            (23, "short-forms".to_owned()),
            (24, "saved-views".to_owned()),
            (25, "committee-goal".to_owned()),
        ]
    );

    remove_database(&path);
}

#[test]
fn upgrading_a_version_13_database_chains_through_14_and_15_to_20() {
    let path = database_at_version("v13", 13, &[("w-raw", "555.010.0100")]);

    let app = App::open_legacy_fixture(&path);
    assert_eq!(
        phones(&app),
        BTreeMap::from([("w-raw".to_owned(), "(555) 010-0100".to_owned())])
    );
    assert_eq!(
        migration_rows(&path),
        [
            (13, "current-schema-bootstrap".to_owned()),
            (14, "answer-ids".to_owned()),
            (15, "lookup-indexes".to_owned()),
            (16, "phone-format".to_owned()),
            (17, "app-settings-registry".to_owned()),
            (18, "workplace-attribute-contract".to_owned()),
            (19, "work-assignments".to_owned()),
            (20, "work-assignment-drafts".to_owned()),
            (21, "legacy-work-assignments".to_owned()),
            (22, "flatten-work-assignments".to_owned()),
            (23, "short-forms".to_owned()),
            (24, "saved-views".to_owned()),
            (25, "committee-goal".to_owned()),
        ]
    );

    remove_database(&path);
}

#[test]
fn upgrading_a_version_12_database_chains_through_16_to_20_and_reformats_its_phones() {
    let fixture = format!(
        "{}/../../contract/fixtures/node-v12.sqlite",
        env!("CARGO_MANIFEST_DIR")
    );
    let path = temp_db_path("phone-migration-v12.sqlite");
    remove_database(&path);
    std::fs::copy(&fixture, &path).expect("copies the committed v12 fixture");
    {
        // LEGACY-PLAINTEXT-FIXTURE: temp-constructed legacy-schema source for upgrade-read test (intentional plaintext, never production).
        let conn = Connection::open(&path).expect("opens the fixture copy");
        conn.execute(
            "UPDATE workers SET phone = ?1 WHERE id = 'worker-a'",
            ["5550100100"],
        )
        .expect("writes a legacy phone");
        conn.execute(
            "UPDATE workers SET phone = ?1 WHERE id = 'worker-b'",
            ["call after 5"],
        )
        .expect("writes free text");
        // The fixture predates a value for every Attribute on every Worker; the dataset
        // route reads the whole record, so fill the gaps the way v12 could store them.
        for (worker_id, attribute, value) in [
            ("worker-a", "Role", "\"Server\""),
            ("worker-b", "Department", "\"\""),
            ("worker-b", "Role", "\"\""),
            ("worker-b", "Shifts", "[]"),
        ] {
            conn.execute(
                "INSERT INTO worker_attribute_values (worker_id, attribute_id, value) \
                 SELECT ?1, id, ?3 FROM worker_attributes WHERE name = ?2",
                params![worker_id, attribute, value],
            )
            .expect("an unanswered attribute value");
        }
    }

    let app = App::open_legacy_fixture(&path);
    assert_eq!(
        phones(&app),
        BTreeMap::from([
            ("worker-a".to_owned(), "(555) 010-0100".to_owned()),
            ("worker-b".to_owned(), "call after 5".to_owned()),
        ])
    );
    assert_eq!(
        migration_rows(&path),
        [
            (12, "current-schema-bootstrap".to_owned()),
            (13, "worker-drafts".to_owned()),
            (14, "answer-ids".to_owned()),
            (15, "lookup-indexes".to_owned()),
            (16, "phone-format".to_owned()),
            (17, "app-settings-registry".to_owned()),
            (18, "workplace-attribute-contract".to_owned()),
            (19, "work-assignments".to_owned()),
            (20, "work-assignment-drafts".to_owned()),
            (21, "legacy-work-assignments".to_owned()),
            (22, "flatten-work-assignments".to_owned()),
            (23, "short-forms".to_owned()),
            (24, "saved-views".to_owned()),
            (25, "committee-goal".to_owned()),
        ]
    );

    remove_database(&path);
}

#[test]
fn a_fresh_database_bootstraps_at_version_24() {
    let path = temp_db_path("phone-migration-fresh.sqlite");
    remove_database(&path);

    let app = App::open_keyed(&path, Some(&current_key()));
    assert_eq!(dataset(&app)["workers"], json!([]));
    assert_eq!(
        current_migration_rows(&path),
        [(25, "current-schema-bootstrap".to_owned())]
    );

    remove_database(&path);
}

#[test]
fn upgrading_a_version_20_database_runs_the_legacy_conversion_once() {
    let path = database_at_version(
        "v20-current",
        20,
        &[("w-raw", "5550100100"), ("w-text", "call after 5")],
    );

    let app = App::open_legacy_fixture(&path);
    assert_eq!(
        phones(&app),
        BTreeMap::from([
            ("w-raw".to_owned(), "5550100100".to_owned()),
            ("w-text".to_owned(), "call after 5".to_owned()),
        ])
    );
    // Version 20 is an upgradable source now, so its open records exactly v21.
    assert_eq!(
        migration_rows(&path),
        [
            (20, "current-schema-bootstrap".to_owned()),
            (21, "legacy-work-assignments".to_owned()),
            (22, "flatten-work-assignments".to_owned()),
            (23, "short-forms".to_owned()),
            (24, "saved-views".to_owned()),
            (25, "committee-goal".to_owned()),
        ]
    );

    remove_database(&path);
}

#[test]
fn opening_a_current_version_24_database_writes_nothing() {
    let path = temp_db_path("phone-migration-v24-current.sqlite");
    remove_database(&path);
    {
        open_seeded_keyed(&path, Some(&current_key()), &CounterId::new())
            .expect("a seeded current database");
    }

    let app = App::open_keyed(&path, Some(&current_key()));
    assert_eq!(dataset(&app)["workers"], json!([]));
    assert_eq!(
        current_migration_rows(&path),
        [(25, "current-schema-bootstrap".to_owned())],
        "opening a current database writes nothing, not even another migration row"
    );

    remove_database(&path);
}

#[test]
fn upgrading_a_version17_database_flattens_its_starter_questions() {
    let path = database_at_version("v17", 17, &[("w-one", "5550100100")]);
    let app = App::open_legacy_fixture(&path);

    assert_eq!(phones(&app)["w-one"], "5550100100");
    let body = dataset(&app);
    assert!(
        body["workers"][0].get("assignments").is_none(),
        "the current Worker payload carries no assignments"
    );
    assert_eq!(
        body["workers"][0]["attributes"],
        json!({ "department": "", "role": "", "shifts": "" }),
        "the starter questions are ordinary empty Worker values"
    );
    // LEGACY-PLAINTEXT-FIXTURE: temp-constructed legacy-schema source for upgrade-read test (intentional plaintext, never production).
    let conn = Connection::open(&path).unwrap();
    let kinds: Vec<(String, String)> = conn
        .prepare("SELECT name, kind FROM worker_attributes ORDER BY position")
        .unwrap()
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap();
    assert_eq!(
        kinds,
        [
            ("Department".to_owned(), "category".to_owned()),
            ("Role".to_owned(), "category".to_owned()),
            ("Shifts".to_owned(), "category".to_owned()),
        ],
        "an unused former assignment Attribute is Single-Select"
    );
    assert_eq!(
        migration_rows(&path),
        [
            (17, "current-schema-bootstrap".to_owned()),
            (18, "workplace-attribute-contract".to_owned()),
            (19, "work-assignments".to_owned()),
            (20, "work-assignment-drafts".to_owned()),
            (21, "legacy-work-assignments".to_owned()),
            (22, "flatten-work-assignments".to_owned()),
            (23, "short-forms".to_owned()),
            (24, "saved-views".to_owned()),
            (25, "committee-goal".to_owned()),
        ]
    );
    remove_database(&path);
}

#[test]
fn a_version_16_database_keeps_its_phones_while_the_settings_registry_upgrades() {
    let path = database_at_version(
        "v16-phones",
        16,
        &[("w-raw", "5550100100"), ("w-text", "call after 5")],
    );

    let app = App::open_legacy_fixture(&path);
    assert_eq!(
        phones(&app),
        BTreeMap::from([
            ("w-raw".to_owned(), "5550100100".to_owned()),
            ("w-text".to_owned(), "call after 5".to_owned()),
        ])
    );
    assert_eq!(
        migration_rows(&path),
        [
            (16, "current-schema-bootstrap".to_owned()),
            (17, "app-settings-registry".to_owned()),
            (18, "workplace-attribute-contract".to_owned()),
            (19, "work-assignments".to_owned()),
            (20, "work-assignment-drafts".to_owned()),
            (21, "legacy-work-assignments".to_owned()),
            (22, "flatten-work-assignments".to_owned()),
            (23, "short-forms".to_owned()),
            (24, "saved-views".to_owned()),
            (25, "committee-goal".to_owned()),
        ]
    );

    remove_database(&path);
}
