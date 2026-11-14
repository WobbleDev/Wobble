//! The v25 migration adds `worksites.committee_goal` beside `committee_target`, copies every
//! value across, and refuses to continue when the two disagree. Synthetic data only.

mod common;

use common::legacy_db::{add_worksite, finish_source, migration_rows, raw_version, start_source};
use rusqlite::Connection;
use serde_json::{json, Value};
use wobble_core::handle::{App, Request};
use wobble_core::id::RandomId;
use wobble_core::schema::apply_migrations;

fn worksite_pairs(conn: &Connection) -> Vec<(String, i64, i64)> {
    let mut statement = conn
        .prepare("SELECT id, committee_goal, committee_target FROM worksites ORDER BY id")
        .expect("reads both columns");
    statement
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
        .expect("the worksites")
        .collect::<rusqlite::Result<_>>()
        .expect("the worksites")
}

fn set_target(conn: &Connection, id: &str, target: i64) {
    conn.execute(
        "UPDATE worksites SET committee_target = ?1 WHERE id = ?2",
        rusqlite::params![target, id],
    )
    .expect("sets the committee target");
}

#[test]
fn every_upgradable_version_copies_the_target_into_the_goal() {
    for version in [12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24] {
        let (path, conn) = start_source("committee-goal", &format!("v{version}"));
        add_worksite(&conn, "ws-a", "Worksite Alpha");
        add_worksite(&conn, "ws-b", "Worksite Bravo");
        set_target(&conn, "ws-a", 7);
        set_target(&conn, "ws-b", 100);
        finish_source(&path, conn, version);

        let _app = App::open_legacy_fixture(&path);
        // LEGACY-PLAINTEXT-FIXTURE: temp-constructed legacy-schema source for upgrade-read test (intentional plaintext, never production).
        let conn = Connection::open(&path).expect("opens the upgraded database");
        assert_eq!(raw_version(&conn), Some(26), "v{version}");
        assert_eq!(
            migration_rows(&conn).last().unwrap(),
            &(26, "abbreviation".to_owned()),
            "v{version}"
        );
        assert_eq!(
            worksite_pairs(&conn),
            vec![("ws-a".to_owned(), 7, 7), ("ws-b".to_owned(), 100, 100)],
            "v{version}"
        );
    }
}

#[test]
fn the_upgraded_worksite_route_answers_with_both_names() {
    let (path, conn) = start_source("committee-goal", "route");
    add_worksite(&conn, "ws-a", "Worksite Alpha");
    set_target(&conn, "ws-a", 9);
    finish_source(&path, conn, 24);

    let app = App::open_legacy_fixture(&path);
    let response = app.handle(
        &Request {
            method: "GET".to_owned(),
            path: "/api/worksite".to_owned(),
            query: String::new(),
            headers: vec![("x-wobble-worksite".to_owned(), "ws-a".to_owned())],
            body: None,
        },
        &RandomId,
    );
    assert_eq!(response.status, 200, "{}", response.body);
    let worksite: &Value = &response.body["worksite"];
    assert_eq!(worksite["committeeGoal"], json!(9));
    assert_eq!(worksite["committeeTarget"], json!(9));
}

#[test]
fn a_half_migrated_file_with_matching_columns_upgrades_and_opening_twice_changes_nothing() {
    let (path, conn) = start_source("committee-goal", "half");
    add_worksite(&conn, "ws-a", "Worksite Alpha");
    set_target(&conn, "ws-a", 4);
    finish_source(&path, conn, 24);
    {
        // LEGACY-PLAINTEXT-FIXTURE: temp-constructed legacy-schema source for upgrade-read test (intentional plaintext, never production).
        let conn = Connection::open(&path).unwrap();
        conn.execute_batch(
            "ALTER TABLE worksites ADD COLUMN committee_goal INTEGER NOT NULL DEFAULT 5;
             UPDATE worksites SET committee_goal = committee_target;",
        )
        .unwrap();
    }

    drop(App::open_legacy_fixture(&path));
    drop(App::open_legacy_fixture(&path));
    // LEGACY-PLAINTEXT-FIXTURE: temp-constructed legacy-schema source for upgrade-read test (intentional plaintext, never production).
    let conn = Connection::open(&path).unwrap();
    assert_eq!(raw_version(&conn), Some(26));
    assert_eq!(worksite_pairs(&conn), vec![("ws-a".to_owned(), 4, 4)]);
    assert_eq!(
        migration_rows(&conn)
            .iter()
            .filter(|(version, _)| *version == 25)
            .count(),
        1,
        "the migration is recorded once"
    );
}

#[test]
fn a_file_whose_goal_and_target_disagree_fails_the_upgrade_and_rolls_back() {
    let (path, conn) = start_source("committee-goal", "disagree");
    add_worksite(&conn, "ws-a", "Worksite Alpha");
    set_target(&conn, "ws-a", 4);
    finish_source(&path, conn, 24);
    // LEGACY-PLAINTEXT-FIXTURE: temp-constructed legacy-schema source for upgrade-read test (intentional plaintext, never production).
    let conn = Connection::open(&path).unwrap();
    conn.execute_batch(
        "ALTER TABLE worksites ADD COLUMN committee_goal INTEGER NOT NULL DEFAULT 5;
         UPDATE worksites SET committee_goal = 6;",
    )
    .unwrap();

    let error = apply_migrations(&conn).expect_err("a disagreement must stop the upgrade");
    assert!(error.to_string().contains("disagree"), "{error}");
    assert_eq!(raw_version(&conn), Some(24), "the version is not advanced");
    assert_eq!(worksite_pairs(&conn), vec![("ws-a".to_owned(), 6, 4)]);
}
