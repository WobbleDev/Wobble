//! C02/C09 gates: the two cross-open directions.
//!
//! (a) a Node-created v12 database (`node-v12.sqlite`) read fully by Rust, and (b) a
//! Rust-created v12 database (`rust-v12.sqlite`) read by Rust here. The Node direction of
//! (b) lived in the old Node runner at git tag `pre-tauri-node`.

use std::path::Path;

use rusqlite::Connection;
use serde_json::json;

use wobble_core::assembly::read_workers;
use wobble_core::attribute_persistence::get_worker_attributes;
use wobble_core::db::{open_seeded_legacy_fixture, Db};
mod common;

use common::temp_db_path;
use wobble_core::handle::Request;
use wobble_core::id::{counter_id, CounterId};
use wobble_core::replay::dump_state;
use wobble_core::router;
use wobble_core::schema::Worksite;
use wobble_core::worksite_persistence::resolve_active_worksite;

/// Copies a committed v12 fixture to a scratch path and opens the copy, so the upgrade to
/// the current schema runs without touching the committed file.
// LEGACY-PLAINTEXT-FIXTURE: tracked binary fixtures rust-v12.sqlite / node-v12.sqlite are legacy-read inputs (never re-encrypted in place, always copy-then-upgrade).
fn open_upgraded_copy(fixture: &str, name: &str) -> Db {
    let path = temp_db_path(&format!("cross-open-{name}.sqlite"));
    let _ = std::fs::remove_file(&path);
    std::fs::copy(fixture, &path).expect("copies the fixture");
    Db::open_legacy_fixture(&path).expect("upgrades the copy to the current schema")
}

fn active_worksite(conn: &Connection) -> Worksite {
    resolve_active_worksite(conn, None)
        .expect("resolves the active Worksite")
        .expect("the fixture has one")
}

fn fixture_path(name: &str) -> String {
    format!(
        "{}/../../contract/fixtures/{name}",
        env!("CARGO_MANIFEST_DIR")
    )
}

fn node_fixture_path() -> String {
    fixture_path("node-v12.sqlite")
}

fn rust_fixture_path() -> String {
    fixture_path("rust-v12.sqlite")
}

#[test]
fn reads_a_node_created_v12_database_fully() {
    let db = open_upgraded_copy(&node_fixture_path(), "node");
    let conn = db.conn();
    let state = dump_state(conn).expect("dumps every table");

    assert_eq!(state.len(), 12, "all 12 current tables are dumped");
    assert_eq!(
        state["schema_migrations"].len(),
        13,
        "12, then 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23 and 24"
    );
    assert_eq!(state["app_settings"].len(), 2);
    assert_eq!(state["worksites"].len(), 1);
    assert_eq!(state["worker_attributes"].len(), 3);
    assert_eq!(state["workers"].len(), 2);
    assert_eq!(state["worker_relationships"].len(), 1);
    assert_eq!(
        state["worker_attribute_values"].len(),
        6,
        "every flattened Attribute has a value row for every Worker"
    );
    assert!(!state.contains_key("work_assignments"));
    assert!(!state.contains_key("work_assignment_answers"));
    assert_eq!(state["agitations"].len(), 1);
    assert_eq!(state["worker_agitations"].len(), 1);
    assert_eq!(state["languages"].len(), 1);
    assert_eq!(state["worker_languages"].len(), 1);

    let worksite = &state["worksites"][0];
    assert_eq!(worksite["name"], "My Worksite");
    assert_eq!(worksite["committee_target"], 5);

    let setting = |key: &str| {
        state["app_settings"]
            .iter()
            .find(|row| row["key"] == key)
            .unwrap_or_else(|| panic!("{key} is stored"))["value"]
            .clone()
    };
    assert_eq!(setting("theme"), "system");
    assert_eq!(setting("density"), "standard");

    let migrations = &state["schema_migrations"];
    assert_eq!(migrations[0]["version"], 12);
    assert_eq!(migrations[2]["version"], 14);
    assert_eq!(migrations[2]["applied_at"], "$t");
    assert_eq!(migrations[3]["version"], 15);
    assert_eq!(migrations[3]["name"], "lookup-indexes");
    assert_eq!(migrations[3]["applied_at"], "$t");
    assert_eq!(migrations[4]["version"], 16);
    assert_eq!(migrations[4]["name"], "phone-format");
    assert_eq!(migrations[4]["applied_at"], "$t");
    assert_eq!(migrations[5]["version"], 17);
    assert_eq!(migrations[5]["name"], "app-settings-registry");
    assert_eq!(migrations[5]["applied_at"], "$t");
    assert_eq!(migrations[6]["version"], 18);
    assert_eq!(migrations[6]["name"], "workplace-attribute-contract");
    assert_eq!(migrations[7]["version"], 19);
    assert_eq!(migrations[7]["name"], "work-assignments");
    assert_eq!(migrations[8]["version"], 20);
    assert_eq!(migrations[8]["name"], "work-assignment-drafts");
    assert_eq!(migrations[9]["version"], 21);
    assert_eq!(migrations[9]["name"], "legacy-work-assignments");
    assert_eq!(migrations[9]["applied_at"], "$t");
    assert_eq!(migrations[10]["version"], 22);
    assert_eq!(migrations[10]["name"], "flatten-work-assignments");
    assert_eq!(migrations[10]["applied_at"], "$t");
    assert_eq!(migrations[11]["version"], 23);
    assert_eq!(migrations[11]["name"], "short-forms");
    assert_eq!(migrations[11]["applied_at"], "$t");
    assert_eq!(migrations[12]["version"], 24);
    assert_eq!(migrations[12]["name"], "saved-views");
    assert_eq!(migrations[12]["applied_at"], "$t");

    // The answers are `{id, value}` now: the reader returns each one with its id.
    let worksite = active_worksite(conn);
    let department = get_worker_attributes(conn, &Some(worksite.clone()))
        .expect("reads the configuration")
        .into_iter()
        .find(|attribute| attribute.name == "Department")
        .expect("the Department attribute");
    let texts: Vec<&str> = department
        .options
        .iter()
        .map(|answer| answer.value.as_str())
        .collect();
    assert_eq!(
        texts,
        ["Front of House", "Back of House", "Middle of House"]
    );
    assert!(department
        .options
        .iter()
        .all(|answer| !answer.id.is_empty()));
    let worker = &state["workers"][0];
    assert_eq!(worker["name"], "Rosalind Franklin");
    assert_eq!(worker["notes"], "[]");
}

#[test]
fn reads_a_rust_created_v12_database_fully() {
    let db = open_upgraded_copy(&rust_fixture_path(), "rust");
    let conn = db.conn();

    let migrations = dump_state(conn).expect("dumps every table")["schema_migrations"].clone();
    assert_eq!(migrations.len(), 13);
    assert_eq!(migrations[2]["version"], 14);
    assert_eq!(migrations[3]["version"], 15);
    assert_eq!(migrations[3]["name"], "lookup-indexes");
    assert_eq!(migrations[4]["version"], 16);
    assert_eq!(migrations[4]["name"], "phone-format");
    assert_eq!(migrations[5]["version"], 17);
    assert_eq!(migrations[5]["name"], "app-settings-registry");
    assert_eq!(migrations[6]["version"], 18);
    assert_eq!(migrations[6]["name"], "workplace-attribute-contract");
    assert_eq!(migrations[7]["version"], 19);
    assert_eq!(migrations[7]["name"], "work-assignments");
    assert_eq!(migrations[8]["version"], 20);
    assert_eq!(migrations[8]["name"], "work-assignment-drafts");
    assert_eq!(migrations[9]["version"], 21);
    assert_eq!(migrations[9]["name"], "legacy-work-assignments");
    assert_eq!(migrations[9]["applied_at"], "$t");
    assert_eq!(migrations[10]["version"], 22);
    assert_eq!(migrations[10]["name"], "flatten-work-assignments");
    assert_eq!(migrations[10]["applied_at"], "$t");
    assert_eq!(migrations[11]["version"], 23);
    assert_eq!(migrations[11]["name"], "short-forms");
    assert_eq!(migrations[11]["applied_at"], "$t");
    assert_eq!(migrations[12]["version"], 24);
    assert_eq!(migrations[12]["name"], "saved-views");
    assert_eq!(migrations[12]["applied_at"], "$t");

    let workers = read_workers(conn, &Some(active_worksite(conn))).expect("decodes both workers");
    assert_eq!(workers.len(), 2);
    assert_eq!(workers[0].name, "Rosalind Franklin");
    assert_eq!(workers[0].assessment, "Leader");
    assert_eq!(workers[0].relationships, [counter_id(6)]);
    assert_eq!(workers[0].agitations, ["agitation-1"]);
    assert_eq!(workers[0].languages, ["language-1"]);
    // The bounded legacy answer is an ordinary Worker value after v22.
    let attributes =
        get_worker_attributes(conn, &Some(active_worksite(conn))).expect("reads the configuration");
    let department = attributes
        .iter()
        .find(|candidate| candidate.name == "Department")
        .expect("the Department attribute");
    let front = department
        .options
        .iter()
        .find(|answer| answer.value == "Front of House")
        .expect("the Front of House answer")
        .id
        .clone();
    assert_eq!(workers[0].attributes, json!({ "dept": front }));
    assert_eq!(workers[0].notes, json!([]));
    assert_eq!(workers[1].name, "Max Planck");
    assert_eq!(workers[1].attributes, json!({ "dept": "" }));
}

/// The request sequence that builds `rust-v12.sqlite`, with each step's expected status.
/// The ids are `CounterId` literals: `…001` is the seeded Worksite and `…005`/`…006` are
/// the two workers. The configuration rows carry literal ids, as `node-v12.sqlite` does.
fn fixture_requests() -> Vec<(Request, u16)> {
    let first_worker = counter_id(5);
    let second_worker = counter_id(6);

    let request = |method: &str, path: &str, body: serde_json::Value| Request {
        method: method.to_owned(),
        path: path.to_owned(),
        query: String::new(),
        headers: vec![
            ("x-wobble-worksite".to_owned(), counter_id(1)),
            ("content-type".to_owned(), "application/json".to_owned()),
        ],
        body: Some(serde_json::to_string(&body).expect("serializes the request body")),
    };

    let first_created = json!({
        "name": "Rosalind Franklin",
        "email": "rosalind@example.test",
        "phone": "",
        "assessment": "Leader",
        "attributes": { "dept": "" },
        "agitations": [],
        "languages": [],
        "relationships": [],
        "notes": []
    });
    let second_created = json!({
        "name": "Max Planck",
        "email": "",
        "phone": "",
        "assessment": "Supporter",
        "attributes": { "dept": "" },
        "agitations": [],
        "languages": [],
        "relationships": [first_worker.clone()],
        "notes": []
    });
    let first_updated = json!({
        "name": "Rosalind Franklin",
        "email": "rosalind@example.test",
        "phone": "",
        "assessment": "Leader",
        "attributes": { "dept": "dept-foh" },
        "agitations": ["agitation-1"],
        "languages": ["language-1"],
        "relationships": [second_worker.clone()],
        "notes": []
    });

    vec![
        (
            request(
                "PUT",
                "/api/attributes",
                json!([{
                    "id": "dept",
                    "name": "Department",
                    "kind": "category",
                    "options": [
                        { "id": "dept-foh", "value": "Front of House" },
                        { "id": "dept-boh", "value": "Back of House" },
                        { "id": "dept-moh", "value": "Middle of House" }
                    ]
                }]),
            ),
            200,
        ),
        (
            request(
                "PUT",
                "/api/agitations",
                json!([{ "id": "agitation-1", "text": "Unpaid overtime" }]),
            ),
            200,
        ),
        (
            request(
                "PUT",
                "/api/languages",
                json!([{ "id": "language-1", "name": "Polish" }]),
            ),
            200,
        ),
        (request("POST", "/api/workers", first_created), 201),
        (request("POST", "/api/workers", second_created), 201),
        (
            request(
                "PUT",
                &format!("/api/workers/{first_worker}"),
                first_updated,
            ),
            200,
        ),
    ]
}

/// The fixture's contents, asserted both right after generating it and when reading the
/// committed file back — the second time through the port's own worker reader, which is
/// what the Node spec does on the other side of the cross-open.
fn assert_fixture_contents(conn: &Connection) {
    let state = dump_state(conn).expect("dumps every table");

    assert_eq!(state.len(), 12, "all 12 current tables are dumped");
    assert_eq!(state["schema_migrations"].len(), 1);
    assert_eq!(state["app_settings"].len(), 2);
    assert_eq!(state["worksites"].len(), 1);
    assert_eq!(state["worker_attributes"].len(), 1);
    assert_eq!(state["workers"].len(), 2);
    assert_eq!(state["worker_relationships"].len(), 1);
    assert_eq!(state["worker_attribute_values"].len(), 2);
    assert_eq!(state["agitations"].len(), 1);
    assert_eq!(state["worker_agitations"].len(), 1);
    assert_eq!(state["languages"].len(), 1);
    assert_eq!(state["worker_languages"].len(), 1);

    let worksite = &state["worksites"][0];
    assert_eq!(worksite["id"], counter_id(1));
    assert_eq!(worksite["name"], "My Worksite");
    assert_eq!(worksite["committee_target"], 5);

    let setting = |key: &str| {
        state["app_settings"]
            .iter()
            .find(|row| row["key"] == key)
            .unwrap_or_else(|| panic!("{key} is stored"))["value"]
            .clone()
    };
    assert_eq!(setting("theme"), "system");
    assert_eq!(setting("density"), "standard");

    let migration = &state["schema_migrations"][0];
    assert_eq!(migration["version"], 17);
    assert_eq!(migration["name"], "current-schema-bootstrap");
    assert_eq!(migration["applied_at"], "$t");

    // The configuration, the two workers, and the rows that join them.
    let department = &state["worker_attributes"][0];
    assert_eq!(department["id"], "dept");
    assert_eq!(department["name"], "Department");
    assert_eq!(department["kind"], "category");
    assert_eq!(
        department["options"],
        r#"[{"id":"dept-foh","value":"Front of House"},{"id":"dept-boh","value":"Back of House"},{"id":"dept-moh","value":"Middle of House"}]"#
    );

    let first = &state["workers"][0];
    assert_eq!(first["id"], counter_id(5));
    assert_eq!(first["name"], "Rosalind Franklin");
    assert_eq!(first["email"], "rosalind@example.test");
    assert_eq!(first["assessment"], "Leader");
    assert_eq!(first["notes"], "[]");
    let second = &state["workers"][1];
    assert_eq!(second["id"], counter_id(6));
    assert_eq!(second["name"], "Max Planck");
    assert_eq!(second["assessment"], "Supporter");
    assert_eq!(second["notes"], "[]");

    let relationship = &state["worker_relationships"][0];
    assert_eq!(relationship["worker_a_id"], counter_id(5));
    assert_eq!(relationship["worker_b_id"], counter_id(6));

    // Sorted by worker id: the update path rewrites worker `…005`'s value row by deleting
    // and re-inserting it, so its rowid is no longer the first one.
    let mut values: Vec<(String, String)> = state["worker_attribute_values"]
        .iter()
        .map(|row| {
            (
                row["worker_id"].as_str().unwrap().to_owned(),
                row["value"].as_str().unwrap().to_owned(),
            )
        })
        .collect();
    values.sort();
    assert_eq!(
        values,
        [
            (counter_id(5), "\"dept-foh\"".to_owned()),
            (counter_id(6), "\"\"".to_owned()),
        ]
    );

    let agitation = &state["agitations"][0];
    assert_eq!(agitation["id"], "agitation-1");
    assert_eq!(agitation["text"], "Unpaid overtime");
    assert_eq!(state["worker_agitations"][0]["worker_id"], counter_id(5));

    let language = &state["languages"][0];
    assert_eq!(language["id"], "language-1");
    assert_eq!(language["name"], "Polish");
    assert_eq!(state["worker_languages"][0]["worker_id"], counter_id(5));

    // The port's own reader decodes the whole file.
    let worksite = resolve_active_worksite(conn, None)
        .expect("resolves the active Worksite")
        .expect("the fixture has one");
    let workers = read_workers(conn, &Some(worksite)).expect("decodes both workers");

    assert_eq!(workers.len(), 2);
    assert_eq!(workers[0].name, "Rosalind Franklin");
    assert_eq!(workers[0].assessment, "Leader");
    assert_eq!(workers[0].relationships, [counter_id(6)]);
    assert_eq!(workers[0].agitations, ["agitation-1"]);
    assert_eq!(workers[0].languages, ["language-1"]);
    // A Worker holds the answer id of "Front of House", not its text.
    let department = get_worker_attributes(conn, &Some(active_worksite(conn)))
        .expect("reads the configuration")
        .into_iter()
        .find(|attribute| attribute.name == "Department")
        .expect("the Department attribute");
    let front = department
        .options
        .iter()
        .find(|answer| answer.value == "Front of House")
        .expect("the Front of House answer")
        .id
        .clone();
    assert_eq!(workers[0].attributes, json!({ "dept": front }));
    assert_eq!(workers[0].notes, json!([]));
    assert_eq!(workers[1].name, "Max Planck");
    assert_eq!(workers[1].assessment, "Supporter");
    assert_eq!(workers[1].relationships, [counter_id(5)]);
    assert_eq!(workers[1].agitations, Vec::<String>::new());
    assert_eq!(workers[1].languages, Vec::<String>::new());
    assert_eq!(workers[1].attributes, json!({ "dept": "" }));
}

/// Regenerates the committed cross-open (b) fixture. Ignored by default, so `cargo test`
/// only ever *reads* the committed file:
///
/// ```sh
/// cargo test -p wobble-core --test cross_open -- --ignored regenerate_the_rust_fixture
/// ```
#[test]
#[ignore = "regenerates the committed contract/fixtures/rust-v12.sqlite"]
fn regenerate_the_rust_fixture() {
    let path = rust_fixture_path();
    for suffix in ["", "-wal", "-shm", "-journal"] {
        let _ = std::fs::remove_file(format!("{path}{suffix}"));
    }

    let ids = CounterId::new();
    let db = open_seeded_legacy_fixture(&path, &ids).expect("creates the fixture database");
    for (request, expected_status) in fixture_requests() {
        let response = router::dispatch(&db, &request, &ids);
        assert_eq!(
            response.status, expected_status,
            "{} {} answered {}",
            request.method, request.path, response.status
        );
    }
    assert_fixture_contents(db.conn());

    // The committed fixture must stay one self-contained file, like `node-v12.sqlite`:
    // drop the WAL the port opens with, so no `-wal`/`-shm` sidecars outlive generation.
    db.conn()
        .execute_batch("PRAGMA journal_mode = DELETE;")
        .expect("leaves the fixture in DELETE journal mode");
    drop(db);

    for suffix in ["-wal", "-shm", "-journal"] {
        assert!(
            !Path::new(&format!("{path}{suffix}")).exists(),
            "the fixture has no {suffix} sidecar"
        );
    }
}
