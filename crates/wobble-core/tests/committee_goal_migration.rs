//! The v25 migration added `worksites.committee_goal` beside `committee_target`; the v27 migration
//! drops `committee_target` once the goal is the only name in use, and refuses to continue when
//! the two disagree. Synthetic data only.

mod common;

use common::legacy_db::{add_worksite, finish_source, migration_rows, raw_version, start_source};
use rusqlite::Connection;
use serde_json::{json, Value};
use wobble_core::handle::{App, Request};
use wobble_core::id::RandomId;
use wobble_core::schema::apply_migrations;

fn goals(conn: &Connection) -> Vec<(String, i64)> {
    let mut statement = conn
        .prepare("SELECT id, committee_goal FROM worksites ORDER BY id")
        .expect("reads the goal column");
    statement
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
        .expect("the worksites")
        .collect::<rusqlite::Result<_>>()
        .expect("the worksites")
}

fn has_target_column(conn: &Connection) -> bool {
    conn.prepare("SELECT 1 FROM pragma_table_info('worksites') WHERE name = 'committee_target'")
        .expect("reads the table info")
        .exists([])
        .expect("reads the table info")
}

fn set_goal(conn: &Connection, id: &str, goal: i64) {
    conn.execute(
        "UPDATE worksites SET committee_goal = ?1 WHERE id = ?2",
        rusqlite::params![goal, id],
    )
    .expect("sets the committee goal");
}

#[test]
fn every_upgradable_version_keeps_the_goal_and_drops_the_target_column() {
    for version in [12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26] {
        let (path, conn) = start_source("committee-goal", &format!("v{version}"));
        add_worksite(&conn, "ws-a", "Worksite Alpha");
        add_worksite(&conn, "ws-b", "Worksite Bravo");
        set_goal(&conn, "ws-a", 7);
        set_goal(&conn, "ws-b", 100);
        finish_source(&path, conn, version);

        let _app = App::open_legacy_fixture(&path);
        // LEGACY-PLAINTEXT-FIXTURE: temp-constructed legacy-schema source for upgrade-read test (intentional plaintext, never production).
        let conn = Connection::open(&path).expect("opens the upgraded database");
        assert_eq!(raw_version(&conn), Some(27), "v{version}");
        assert_eq!(
            migration_rows(&conn).last().unwrap(),
            &(27, "committee-goal-contract".to_owned()),
            "v{version}"
        );
        assert!(!has_target_column(&conn), "v{version}");
        assert_eq!(
            goals(&conn),
            vec![("ws-a".to_owned(), 7), ("ws-b".to_owned(), 100)],
            "v{version}"
        );
    }
}

#[test]
fn the_upgraded_worksite_route_answers_with_the_goal_alone() {
    let (path, conn) = start_source("committee-goal", "route");
    add_worksite(&conn, "ws-a", "Worksite Alpha");
    set_goal(&conn, "ws-a", 9);
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
    assert!(worksite.get("committeeTarget").is_none());
}

#[test]
fn opening_an_upgraded_file_again_changes_nothing() {
    let (path, conn) = start_source("committee-goal", "twice");
    add_worksite(&conn, "ws-a", "Worksite Alpha");
    set_goal(&conn, "ws-a", 4);
    finish_source(&path, conn, 26);

    drop(App::open_legacy_fixture(&path));
    drop(App::open_legacy_fixture(&path));
    // LEGACY-PLAINTEXT-FIXTURE: temp-constructed legacy-schema source for upgrade-read test (intentional plaintext, never production).
    let conn = Connection::open(&path).unwrap();
    assert_eq!(raw_version(&conn), Some(27));
    assert!(!has_target_column(&conn));
    assert_eq!(goals(&conn), vec![("ws-a".to_owned(), 4)]);
    assert_eq!(
        migration_rows(&conn)
            .iter()
            .filter(|(version, _)| *version == 27)
            .count(),
        1,
        "the migration is recorded once"
    );
}

#[test]
fn a_file_whose_goal_and_target_disagree_fails_the_upgrade_and_rolls_back() {
    let (path, conn) = start_source("committee-goal", "disagree");
    add_worksite(&conn, "ws-a", "Worksite Alpha");
    set_goal(&conn, "ws-a", 4);
    finish_source(&path, conn, 26);
    // LEGACY-PLAINTEXT-FIXTURE: temp-constructed legacy-schema source for upgrade-read test (intentional plaintext, never production).
    let conn = Connection::open(&path).unwrap();
    conn.execute("UPDATE worksites SET committee_target = 6", [])
        .unwrap();

    let error = apply_migrations(&conn).expect_err("a disagreement must stop the upgrade");
    assert!(error.to_string().contains("disagree"), "{error}");
    assert_eq!(raw_version(&conn), Some(26), "the version is not advanced");
    assert!(has_target_column(&conn), "the column is kept");
    assert_eq!(goals(&conn), vec![("ws-a".to_owned(), 4)]);
}
