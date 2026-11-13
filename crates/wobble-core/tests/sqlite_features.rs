//! C02 gate: bundled SQLite features, pragmas, v12 create + seed, and non-v12 refusal.

use rusqlite::Connection;

mod common;

use common::temp_db_path;
use wobble_core::abbreviation_lists::REVISION;
use wobble_core::abbreviation_revision::revision_key;
use wobble_core::db::{self, Db};
use wobble_core::handle::{App, Request};
use wobble_core::id::{counter_id, CounterId};
use wobble_core::schema;

#[test]
fn bundled_sqlite_is_at_least_3_38() {
    // LEGACY-PLAINTEXT-FIXTURE: temp-constructed legacy-schema source for upgrade-read test (intentional plaintext, never production).
    let conn = Connection::open_in_memory().unwrap();
    let version: String = conn
        .query_row("SELECT sqlite_version()", [], |row| row.get(0))
        .unwrap();
    let mut parts = version.split('.').map(|p| p.parse::<u32>().unwrap_or(0));
    let major = parts.next().unwrap_or(0);
    let minor = parts.next().unwrap_or(0);
    assert!(
        major > 3 || (major == 3 && minor >= 38),
        "bundled sqlite_version = {version}"
    );
}

#[test]
fn json_functions_are_available() {
    // LEGACY-PLAINTEXT-FIXTURE: temp-constructed legacy-schema source for upgrade-read test (intentional plaintext, never production).
    let conn = Connection::open_in_memory().unwrap();
    let valid: i64 = conn
        .query_row(r#"SELECT json_valid('{"a":1}')"#, [], |row| row.get(0))
        .unwrap();
    assert_eq!(valid, 1);
    let invalid: i64 = conn
        .query_row("SELECT json_valid('not json')", [], |row| row.get(0))
        .unwrap();
    assert_eq!(invalid, 0);

    conn.execute_batch(
        "CREATE TABLE t (id TEXT, grp TEXT); INSERT INTO t VALUES ('b','g'), ('a','g');",
    )
    .unwrap();
    let array: String = conn
        .query_row(
            "SELECT json_group_array(id) FROM t WHERE grp = 'g'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    let array_value: serde_json::Value = serde_json::from_str(&array).unwrap();
    let ids: Vec<&str> = array_value
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_str().unwrap())
        .collect();
    assert!(ids.contains(&"a") && ids.contains(&"b"));
    let object: String = conn
        .query_row(
            "SELECT json_group_object(id, id) FROM t WHERE grp = 'g'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    let value: serde_json::Value = serde_json::from_str(&object).unwrap();
    assert!(value.get("a").is_some() && value.get("b").is_some());
}

#[test]
fn collate_nocase_enforces_case_insensitive_uniqueness() {
    // LEGACY-PLAINTEXT-FIXTURE: temp-constructed legacy-schema source for upgrade-read test (intentional plaintext, never production).
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch(
        "CREATE TABLE t (name TEXT NOT NULL COLLATE NOCASE, UNIQUE(name)); INSERT INTO t VALUES ('Pay');",
    )
    .unwrap();
    let duplicate = conn.execute_batch("INSERT INTO t VALUES ('pay');");
    assert!(
        duplicate.is_err(),
        "case-insensitive duplicate must be rejected"
    );
}

#[test]
fn same_worksite_trigger_rejects_cross_worksite_relationships() {
    let db = Db::open(":memory:").unwrap();
    let conn = db.conn();
    conn.execute_batch("INSERT INTO worksites (id, name) VALUES ('ws1','One'), ('ws2','Two');")
        .unwrap();
    conn.execute_batch(
        "INSERT INTO workers (id, worksite_id, name, email, phone, assessment, notes) VALUES          ('w1','ws1','A','','','Unassessed','[]'), ('w2','ws2','B','','','Unassessed','[]');",
    )
    .unwrap();
    let cross = conn.execute_batch(
        "INSERT INTO worker_relationships (worker_a_id, worker_b_id) VALUES ('w1','w2');",
    );
    assert!(
        cross.is_err(),
        "cross-worksite relationship must be rejected"
    );

    conn.execute_batch(
        "INSERT INTO workers (id, worksite_id, name, email, phone, assessment, notes) VALUES          ('w3','ws1','C','','','Unassessed','[]');",
    )
    .unwrap();
    conn.execute_batch(
        "INSERT INTO worker_relationships (worker_a_id, worker_b_id) VALUES ('w1','w3');",
    )
    .unwrap();
    let count: i64 = conn
        .query_row("SELECT COUNT(*) FROM worker_relationships", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(count, 1);
}

#[test]
fn open_sets_foreign_keys_wal_and_busy_timeout() {
    let path = temp_db_path("pragmas.sqlite");
    let _ = std::fs::remove_file(&path);
    {
        let db = Db::open_keyed(
            &path,
            Some(&wobble_core::key::Secret::from_passphrase("sqlite feature fixture").unwrap()),
        )
        .unwrap();
        let foreign_keys: i64 = db
            .conn()
            .query_row("PRAGMA foreign_keys", [], |row| row.get(0))
            .unwrap();
        assert_eq!(foreign_keys, 1);
        let journal: String = db
            .conn()
            .query_row("PRAGMA journal_mode", [], |row| row.get(0))
            .unwrap();
        assert_eq!(journal.to_lowercase(), "wal");
        let busy_timeout: i64 = db
            .conn()
            .query_row("PRAGMA busy_timeout", [], |row| row.get(0))
            .unwrap();
        assert_eq!(busy_timeout, 5000);
    }
    let _ = std::fs::remove_file(&path);
    let _ = std::fs::remove_file(format!("{path}-wal"));
    let _ = std::fs::remove_file(format!("{path}-shm"));
}

#[test]
fn fresh_create_and_seed_matches_node() {
    let db = db::open_seeded(":memory:", &CounterId::new()).unwrap();
    let conn = db.conn();

    let version: i64 = conn
        .query_row("SELECT MAX(version) FROM schema_migrations", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(version, 25);
    let migration_name: String = conn
        .query_row(
            "SELECT name FROM schema_migrations WHERE version = 25",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(migration_name, "current-schema-bootstrap");

    let settings: Vec<(String, String)> = conn
        .prepare("SELECT key, value FROM app_settings ORDER BY rowid")
        .unwrap()
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    assert_eq!(
        settings,
        [
            ("theme".to_owned(), "system".to_owned()),
            ("density".to_owned(), "standard".to_owned()),
            // Seeding records the bundled lists revision: a fresh Worksite has nothing to resolve.
            (revision_key(&counter_id(1)), REVISION.to_owned())
        ]
    );

    let (name, target): (String, i64) = conn
        .query_row("SELECT name, committee_target FROM worksites", [], |row| {
            Ok((row.get(0)?, row.get(1)?))
        })
        .unwrap();
    assert_eq!(name, "My Worksite");
    assert_eq!(target, 5);

    let mut statement = conn
        .prepare("SELECT name, kind, position FROM worker_attributes ORDER BY position")
        .unwrap();
    let rows: Vec<(String, String, i64)> = statement
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    assert_eq!(rows.len(), 3);
    assert_eq!(rows[0].0, "Department");
    assert_eq!(rows[0].1, "category");
    assert_eq!(rows[1].0, "Role");
    assert_eq!(rows[2].0, "Shifts");
    assert_eq!(rows[2].1, "tag");
}

#[test]
fn non_v12_is_refused_with_the_node_message() {
    // LEGACY-PLAINTEXT-FIXTURE: temp-constructed legacy-schema source for upgrade-read test (intentional plaintext, never production).
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch(
        "CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY NOT NULL, name TEXT NOT NULL,          applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);          INSERT INTO schema_migrations (version, name) VALUES (3, 'ancient');",
    )
    .unwrap();
    let error = schema::apply_migrations(&conn).unwrap_err();
    let message = error.to_string();
    assert!(message.contains("unsupported"), "{message}");
    assert!(message.contains("version 20"), "{message}");
    assert!(message.contains("version 19"), "{message}");
    assert!(message.contains("version 18"), "{message}");
    assert!(message.contains("version 12"), "{message}");
    assert!(message.contains("version 13"), "{message}");
    assert!(message.contains("version 14"), "{message}");
    assert!(message.contains("version 15"), "{message}");
    assert!(message.contains("version 16"), "{message}");
    assert!(message.contains('3'), "{message}");
}

#[test]
fn non_v12_handle_returns_500_for_every_request() {
    let path = temp_db_path("non-v12.sqlite");
    let _ = std::fs::remove_file(&path);
    {
        // LEGACY-PLAINTEXT-FIXTURE: temp-constructed legacy-schema source for upgrade-read test (intentional plaintext, never production).
        let conn = Connection::open(&path).unwrap();
        conn.execute_batch(
            "CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY NOT NULL, name TEXT NOT NULL,              applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);              INSERT INTO schema_migrations (version, name) VALUES (3, 'ancient');",
        )
        .unwrap();
    }

    let app = App::open_legacy_fixture(&path);
    for (method, path) in [
        ("GET", "/api/settings"),
        ("GET", "/api/worksite"),
        ("GET", "/api/dataset"),
        ("POST", "/api/workers"),
    ] {
        let response = app.handle(
            &Request {
                method: method.to_owned(),
                path: path.to_owned(),
                query: String::new(),
                headers: vec![],
                body: None,
            },
            &CounterId::new(),
        );
        assert_eq!(response.status, 500, "{method} {path}");
        let message = response.body["message"].as_str().unwrap_or("");
        assert!(message.contains('3'), "{method} {path}: {message}");
        assert!(
            message.contains("unsupported"),
            "{method} {path}: {message}"
        );
    }

    let _ = std::fs::remove_file(&path);
}
