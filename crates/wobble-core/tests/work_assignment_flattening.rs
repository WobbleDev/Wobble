//! Ticket 02: the v22 migration turns saved Work Assignment answers into ordinary Worker
//! Attribute values through the public open lifecycle.

mod common;

use common::legacy_db::{
    add_assignment_draft, add_attribute, add_saved_assignment, add_worker, add_worker_draft,
    add_worksite, count, finish_source, migration_rows, raw_version, set_value, start_source,
};
use common::remove_database;
use rusqlite::{params, Connection};
use serde_json::{json, Value};
use wobble_core::db::Db;
use wobble_core::handle::{App, Request, Response};
use wobble_core::id::RandomId;

const WS: &str = "ws-store";
const WS_OTHER: &str = "ws-other";
const NEW_WORKER: &str = "new";

fn request(worksite: &str, method: &str, path: &str, body: Option<Value>) -> Request {
    Request {
        method: method.to_owned(),
        path: path.to_owned(),
        query: String::new(),
        headers: vec![
            ("x-wobble-worksite".to_owned(), worksite.to_owned()),
            ("content-type".to_owned(), "application/json".to_owned()),
        ],
        body: body.map(|body| serde_json::to_string(&body).unwrap()),
    }
}

fn dispatch(app: &App, worksite: &str, method: &str, path: &str, body: Option<Value>) -> Response {
    app.handle(&request(worksite, method, path, body), &RandomId)
}

fn dataset(app: &App, worksite: &str) -> Value {
    let response = dispatch(app, worksite, "GET", "/api/dataset", None);
    assert_eq!(response.status, 200, "{}", response.body);
    response.body
}

fn worker<'a>(dataset: &'a Value, id: &str) -> &'a Value {
    dataset["workers"]
        .as_array()
        .expect("the Worksite's workers")
        .iter()
        .find(|worker| worker["id"] == id)
        .unwrap_or_else(|| panic!("worker {id} is in the dataset"))
}

fn definition<'a>(dataset: &'a Value, id: &str) -> &'a Value {
    dataset["attributes"]
        .as_array()
        .expect("the Worksite's definitions")
        .iter()
        .find(|attribute| attribute["id"] == id)
        .unwrap_or_else(|| panic!("attribute {id} is in the dataset"))
}

fn draft(app: &App, worksite: &str, worker_id: &str) -> Value {
    let response = dispatch(
        app,
        worksite,
        "GET",
        &format!("/api/worker-drafts/{worker_id}"),
        None,
    );
    assert_eq!(response.status, 200, "{}", response.body);
    response.body["draft"].clone()
}

fn stored_payload(path: &str, worksite: &str, worker_id: &str) -> String {
    // LEGACY-PLAINTEXT-FIXTURE: temp-constructed legacy-schema source for upgrade-read test (intentional plaintext, never production).
    Connection::open(path)
        .expect("opens the upgraded database")
        .query_row(
            "SELECT payload FROM worker_drafts WHERE worksite_id = ?1 AND worker_id = ?2",
            params![worksite, worker_id],
            |row| row.get(0),
        )
        .expect("the stored draft")
}

fn has_table(path: &str, table: &str) -> bool {
    // LEGACY-PLAINTEXT-FIXTURE: temp-constructed legacy-schema source for upgrade-read test (intentional plaintext, never production).
    Connection::open(path)
        .expect("opens the database")
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?1",
            [table],
            |row| row.get::<_, i64>(0),
        )
        .expect("reads sqlite_master")
        == 1
}

fn columns(path: &str, table: &str) -> Vec<String> {
    // LEGACY-PLAINTEXT-FIXTURE: temp-constructed legacy-schema source for upgrade-read test (intentional plaintext, never production).
    Connection::open(path)
        .expect("opens the database")
        .prepare(&format!("PRAGMA table_info({table})"))
        .expect("reads table_info")
        .query_map([], |row| row.get(1))
        .expect("the columns")
        .collect::<rusqlite::Result<_>>()
        .expect("the columns")
}

fn semantic_gone(path: &str, table: &str) {
    assert!(
        !has_table(path, table),
        "{table} is gone from the final schema"
    );
}

/// The spec's required example: Ada holds two saved assignments, Bea one, Cy none.
fn seed_ada_bea_cy(name: &str) -> String {
    let (path, conn) = start_source("work-assignment-flattening", name);
    add_worksite(&conn, WS, "Store");
    add_attribute(
        &conn,
        WS,
        "store",
        "Store",
        "category",
        "workAssignment",
        false,
        &[("store-a", "Store A"), ("store-b", "Store B")],
        0,
    );
    add_attribute(
        &conn,
        WS,
        "job",
        "Job",
        "category",
        "workAssignment",
        false,
        &[
            ("cashier", "Cashier"),
            ("stocker", "Stocker"),
            ("shift-lead", "Shift Lead"),
        ],
        1,
    );
    add_attribute(
        &conn,
        WS,
        "shift",
        "Shift",
        "category",
        "workAssignment",
        false,
        &[("day", "Day"), ("night", "Night")],
        2,
    );
    for (id, name) in [("ada", "Ada"), ("bea", "Bea"), ("cy", "Cy")] {
        add_worker(&conn, WS, id, name);
    }
    add_saved_assignment(
        &conn,
        "ada",
        "ada-a",
        0,
        &[("store", "store-a"), ("job", "cashier"), ("shift", "day")],
    );
    add_saved_assignment(
        &conn,
        "ada",
        "ada-b",
        1,
        &[("store", "store-b"), ("job", "stocker"), ("shift", "day")],
    );
    add_saved_assignment(
        &conn,
        "bea",
        "bea-a",
        0,
        &[("store", "store-a"), ("job", "cashier"), ("shift", "night")],
    );
    finish_source(&path, conn, 21);
    path
}

#[test]
fn converts_the_required_ada_bea_cy_example() {
    let path = seed_ada_bea_cy("ada-bea-cy");
    let app = App::open_legacy_fixture(&path);
    let data = dataset(&app, WS);

    assert_eq!(definition(&data, "store")["kind"], "tag");
    assert_eq!(definition(&data, "job")["kind"], "tag");
    assert_eq!(definition(&data, "shift")["kind"], "category");

    assert_eq!(
        worker(&data, "ada")["attributes"],
        json!({
            "store": ["store-a", "store-b"],
            "job": ["cashier", "stocker"],
            "shift": "day",
        })
    );
    assert_eq!(
        worker(&data, "bea")["attributes"],
        json!({
            "store": ["store-a"],
            "job": ["cashier"],
            "shift": "night",
        })
    );
    assert_eq!(
        worker(&data, "cy")["attributes"],
        json!({ "store": [], "job": [], "shift": "" })
    );

    // The independent filter "Store B + Cashier" matches Ada alone.
    let matches = |worker: &Value| {
        let attributes = worker["attributes"].as_object().expect("an attribute map");
        attributes
            .get("store")
            .and_then(Value::as_array)
            .is_some_and(|values| values.contains(&json!("store-b")))
            && attributes
                .get("job")
                .and_then(Value::as_array)
                .is_some_and(|values| values.contains(&json!("cashier")))
    };
    let matched: Vec<&str> = data["workers"]
        .as_array()
        .expect("the Workers")
        .iter()
        .filter(|worker| matches(worker))
        .map(|worker| worker["id"].as_str().expect("a Worker id"))
        .collect();
    assert_eq!(matched, ["ada"]);

    assert!(
        worker(&data, "ada").get("assignments").is_none(),
        "the current Worker payload carries no assignments"
    );

    // LEGACY-PLAINTEXT-FIXTURE: temp-constructed legacy-schema source for upgrade-read test (intentional plaintext, never production).
    let conn = Connection::open(&path).expect("opens the upgraded database");
    assert_eq!(raw_version(&conn), Some(26));
    for table in [
        "work_assignments",
        "work_assignment_answers",
        "work_assignment_drafts",
    ] {
        semantic_gone(&path, table);
    }
    let attribute_columns = columns(&path, "worker_attributes");
    assert!(!attribute_columns.contains(&"scope".to_owned()));
    assert!(!attribute_columns.contains(&"inference_eligible".to_owned()));
}

#[test]
fn preserves_parent_and_child_duplicate_labels_configured_order_and_worksite_isolation() {
    let (path, conn) = start_source("work-assignment-flattening", "ordering");
    add_worksite(&conn, WS, "Store");
    add_worksite(&conn, WS_OTHER, "Other");
    add_attribute(
        &conn,
        WS,
        "area",
        "Area",
        "category",
        "workAssignment",
        false,
        &[
            ("north", "North"),
            ("north-downtown", "Downtown"),
            ("south", "South"),
            ("south-downtown", "Downtown"),
        ],
        0,
    );
    // Two same-labelled "Downtown" values under different branches.
    conn.execute(
        "UPDATE worker_attributes SET options = ?1 WHERE id = 'area'",
        [r#"[{"id":"north","value":"North"},{"id":"north-downtown","value":"Downtown","parentId":"north"},{"id":"south","value":"South"},{"id":"south-downtown","value":"Downtown","parentId":"south"}]"#],
    )
    .expect("the nested Area answers");
    // Configured order is deliberately not the recorded order: the value order wins.
    add_attribute(
        &conn,
        WS,
        "stock",
        "Stock",
        "category",
        "workAssignment",
        false,
        &[("produce", "Produce"), ("dry", "Dry")],
        1,
    );
    add_attribute(
        &conn,
        WS,
        "unused",
        "Unused",
        "category",
        "workAssignment",
        false,
        &[("only", "Only")],
        2,
    );
    add_attribute(
        &conn,
        WS_OTHER,
        "area-other",
        "Area",
        "category",
        "workAssignment",
        false,
        &[("north", "North"), ("north-downtown", "Downtown")],
        0,
    );
    add_worker(&conn, WS, "w-one", "One");
    add_worker(&conn, WS_OTHER, "w-other", "Other");
    // A duplicate across assignments deduplicates; the directly selected parent and child
    // both survive; recorded order is south-downtown, north, north-downtown, dry, produce.
    add_saved_assignment(
        &conn,
        "w-one",
        "a1",
        0,
        &[("area", "south-downtown"), ("stock", "dry")],
    );
    add_saved_assignment(
        &conn,
        "w-one",
        "a2",
        1,
        &[("area", "north"), ("stock", "produce")],
    );
    add_saved_assignment(&conn, "w-one", "a3", 2, &[("area", "north-downtown")]);
    add_saved_assignment(&conn, "w-other", "o1", 0, &[("area-other", "north")]);
    finish_source(&path, conn, 21);

    let app = App::open_legacy_fixture(&path);
    let data = dataset(&app, WS);
    assert_eq!(definition(&data, "area")["kind"], "tag");
    assert_eq!(
        worker(&data, "w-one")["attributes"]["area"],
        json!(["north", "north-downtown", "south-downtown"]),
        "configured order, parent and child, duplicate label in separate branches, dedupe"
    );
    assert_eq!(
        worker(&data, "w-one")["attributes"]["stock"],
        json!(["produce", "dry"]),
        "configured order, not recorded order"
    );
    assert_eq!(definition(&data, "stock")["kind"], "tag");
    assert_eq!(
        definition(&data, "unused")["kind"],
        "category",
        "an unused former assignment Attribute is Single-Select"
    );
    assert_eq!(worker(&data, "w-one")["attributes"]["unused"], "");

    let other = dataset(&app, WS_OTHER);
    assert_eq!(
        definition(&other, "area-other")["kind"],
        "category",
        "cardinality is judged per Worksite"
    );
    assert_eq!(
        worker(&other, "w-other")["attributes"]["area-other"],
        "north"
    );
}

#[test]
fn keeps_existing_worker_scoped_attribute_kinds_and_selections() {
    let (path, conn) = start_source("work-assignment-flattening", "worker-attributes");
    add_worksite(&conn, WS, "Mixed");
    add_attribute(
        &conn,
        WS,
        "certs",
        "Certificates",
        "tag",
        "worker",
        true,
        &[("food", "Food"), ("first-aid", "First Aid")],
        0,
    );
    add_attribute(
        &conn,
        WS,
        "team",
        "Team",
        "category",
        "worker",
        true,
        &[("front", "Front"), ("back", "Back")],
        1,
    );
    add_attribute(
        &conn,
        WS,
        "store",
        "Store",
        "category",
        "workAssignment",
        false,
        &[("store-a", "Store A"), ("store-b", "Store B")],
        2,
    );
    add_worker(&conn, WS, "w-one", "One");
    set_value(&conn, "w-one", "certs", json!(["first-aid"]));
    set_value(&conn, "w-one", "team", json!("back"));
    add_saved_assignment(&conn, "w-one", "a1", 0, &[("store", "store-a")]);
    finish_source(&path, conn, 21);

    let app = App::open_legacy_fixture(&path);
    let data = dataset(&app, WS);
    assert_eq!(definition(&data, "certs")["kind"], "tag");
    assert_eq!(definition(&data, "team")["kind"], "category");
    assert_eq!(
        worker(&data, "w-one")["attributes"],
        json!({
            "certs": ["first-aid"],
            "team": "back",
            "store": "store-a",
        })
    );
}

#[test]
fn assignment_drafts_never_influence_values_or_cardinality_and_are_removed() {
    let (path, conn) = start_source("work-assignment-flattening", "assignment-drafts");
    add_worksite(&conn, WS, "Drafts");
    add_attribute(
        &conn,
        WS,
        "store",
        "Store",
        "category",
        "workAssignment",
        false,
        &[("store-a", "Store A"), ("store-b", "Store B")],
        0,
    );
    add_attribute(
        &conn,
        WS,
        "shift",
        "Shift",
        "category",
        "workAssignment",
        false,
        &[("day", "Day"), ("night", "Night")],
        1,
    );
    add_attribute(
        &conn,
        WS,
        "unused",
        "Unused",
        "category",
        "workAssignment",
        false,
        &[("one", "One"), ("two", "Two")],
        2,
    );
    add_worker(&conn, WS, "w-one", "One");
    add_saved_assignment(
        &conn,
        "w-one",
        "a1",
        0,
        &[("store", "store-a"), ("shift", "day")],
    );
    // A replacement: the draft says night while the saved answer is day.
    add_assignment_draft(
        &conn,
        WS,
        "w-one",
        "a1",
        json!({}),
        json!({ "shift": "night", "store": "store-b" }),
        "2026-10-01T00:00:00.000Z",
    );
    // Two pending drafts could make Unused Multi-Select if drafts counted.
    add_assignment_draft(
        &conn,
        WS,
        "w-one",
        "pending-1",
        json!({}),
        json!({ "unused": "one" }),
        "2026-10-01T00:00:01.000Z",
    );
    add_assignment_draft(
        &conn,
        WS,
        "w-one",
        "pending-2",
        json!({}),
        json!({ "unused": "two" }),
        "2026-10-01T00:00:02.000Z",
    );
    add_assignment_draft(
        &conn,
        WS,
        NEW_WORKER,
        "pending-new",
        json!({}),
        json!({ "store": "store-b", "unused": "one" }),
        "2026-10-01T00:00:03.000Z",
    );
    finish_source(&path, conn, 21);

    let app = App::open_legacy_fixture(&path);
    let data = dataset(&app, WS);
    assert_eq!(definition(&data, "store")["kind"], "category");
    assert_eq!(definition(&data, "shift")["kind"], "category");
    assert_eq!(
        definition(&data, "unused")["kind"],
        "category",
        "unfinished drafts never raise cardinality"
    );
    assert_eq!(
        worker(&data, "w-one")["attributes"],
        json!({ "store": "store-a", "shift": "day", "unused": "" })
    );
    for table in ["work_assignment_drafts", "work_assignments"] {
        semantic_gone(&path, table);
    }

    // No assignment-draft recovery route survives the upgrade.
    let response = dispatch(
        &app,
        WS,
        "GET",
        "/api/workers/w-one/assignment-drafts",
        None,
    );
    assert_eq!(response.status, 501, "{}", response.body);
}

#[test]
fn preserves_ordinary_worker_drafts_and_populates_the_flattened_attributes() {
    let (path, conn) = start_source("work-assignment-flattening", "worker-drafts");
    add_worksite(&conn, WS, "Worker drafts");
    add_attribute(
        &conn,
        WS,
        "store",
        "Store",
        "category",
        "workAssignment",
        false,
        &[("store-a", "Store A"), ("store-b", "Store B")],
        0,
    );
    add_attribute(
        &conn,
        WS,
        "shift",
        "Shift",
        "category",
        "workAssignment",
        false,
        &[("day", "Day"), ("night", "Night")],
        1,
    );
    add_attribute(
        &conn,
        WS,
        "certs",
        "Certificates",
        "tag",
        "worker",
        true,
        &[("food", "Food"), ("first-aid", "First Aid")],
        2,
    );
    add_worker(&conn, WS, "w-one", "One");
    set_value(&conn, "w-one", "certs", json!(["food"]));
    add_saved_assignment(
        &conn,
        "w-one",
        "a1",
        0,
        &[("store", "store-a"), ("shift", "day")],
    );
    add_saved_assignment(
        &conn,
        "w-one",
        "a2",
        1,
        &[("store", "store-b"), ("shift", "day")],
    );

    let personal_update = json!({
        "name": "One Edited",
        "email": "one@example.com",
        "phone": "(555) 010-2000",
        "assessment": "Leader",
        "attributes": {
            "store": "store-a",
            "shift": "night",
            "certs": ["first-aid"],
        },
        "agitations": [],
        "languages": [],
        "relationships": [],
        "notes": [{ "id": "n1", "text": "Called back." }],
    });
    let personal_base = json!({
        "name": "One",
        "email": "",
        "phone": "",
        "assessment": "Unassessed",
        "attributes": {
            "shift": "day",
            "certs": ["food"],
        },
        "agitations": [],
        "languages": [],
        "relationships": [],
        "notes": [],
    });
    add_worker_draft(
        &conn,
        WS,
        "w-one",
        &json!({
            "update": personal_update,
            "pendingNote": { "text": "half a note" },
            "base": personal_base,
        }),
        "2026-10-02T09:30:00.000Z",
    );
    add_worker_draft(
        &conn,
        WS,
        NEW_WORKER,
        &json!({
            "update": {
                "name": "Sam",
                "email": "sam@example.com",
                "phone": "",
                "assessment": "Unassessed",
                "attributes": { "certs": ["food"] },
                "agitations": [],
                "languages": [],
                "relationships": [],
                "notes": [],
            },
            "pendingNote": { "text": "new worker note" },
            "base": null,
        }),
        "2026-10-02T10:30:00.000Z",
    );
    // A payload the current form never wrote stays byte-identical.
    conn.execute(
        "INSERT INTO worker_drafts (worksite_id, worker_id, payload, updated_at) \
         VALUES (?1, 'w-broken', '{}', '2026-10-02T11:30:00.000Z')",
        [WS],
    )
    .expect("a malformed draft");
    finish_source(&path, conn, 21);

    let app = App::open_legacy_fixture(&path);

    let personal = draft(&app, WS, "w-one");
    assert_eq!(personal["updatedAt"], "2026-10-02T09:30:00.000Z");
    assert_eq!(personal["update"]["name"], "One Edited");
    assert_eq!(personal["update"]["email"], "one@example.com");
    assert_eq!(personal["pendingNote"]["text"], "half a note");
    assert_eq!(personal["update"]["notes"][0]["text"], "Called back.");
    assert_eq!(
        personal["update"]["attributes"],
        json!({
            "store": ["store-a", "store-b"],
            "shift": "day",
            "certs": ["first-aid"],
        }),
        "the migrated saved value replaces the draft snapshot in the update"
    );
    assert_eq!(
        personal["base"]["attributes"],
        json!({
            "store": ["store-a", "store-b"],
            "shift": "day",
            "certs": ["food"],
        }),
        "the base cannot clear a newly migrated value"
    );
    assert_eq!(personal["base"]["email"], "");

    let new_worker = draft(&app, WS, NEW_WORKER);
    assert_eq!(new_worker["pendingNote"]["text"], "new worker note");
    assert_eq!(
        new_worker["update"]["attributes"],
        json!({ "store": [], "shift": "", "certs": ["food"] }),
        "the New Worker draft receives the final empty values and keeps its own edits"
    );

    assert_eq!(stored_payload(&path, WS, "w-broken"), "{}");
    let broken = dispatch(&app, WS, "GET", "/api/worker-drafts/w-broken", None);
    assert_eq!(broken.status, 500, "{}", broken.body);
    assert!(
        broken.body["message"]
            .as_str()
            .unwrap_or_default()
            .contains("Invalid Worker draft stored for w-broken."),
        "{}",
        broken.body
    );
}

#[test]
fn an_invalid_committed_answer_rolls_the_upgrade_back() {
    let (path, conn) = start_source("work-assignment-flattening", "rollback");
    add_worksite(&conn, WS, "Rollback");
    add_attribute(
        &conn,
        WS,
        "store",
        "Store",
        "category",
        "workAssignment",
        false,
        &[("store-a", "Store A")],
        0,
    );
    add_worker(&conn, WS, "w-one", "One");
    add_saved_assignment(&conn, "w-one", "a1", 0, &[("store", "not-configured")]);
    finish_source(&path, conn, 21);

    let app = App::open_legacy_fixture(&path);
    let response = dispatch(&app, WS, "GET", "/api/dataset", None);
    assert_eq!(response.status, 500);
    assert!(
        response.body["message"]
            .as_str()
            .unwrap_or_default()
            .contains("Invalid Work Assignment answer stored"),
        "{}",
        response.body
    );

    // LEGACY-PLAINTEXT-FIXTURE: temp-constructed legacy-schema source for upgrade-read test (intentional plaintext, never production).
    let conn = Connection::open(&path).expect("opens the source again");
    assert_eq!(raw_version(&conn), Some(21), "the source is unchanged");
    assert!(
        !migration_rows(&conn)
            .iter()
            .any(|(version, _)| *version == 22),
        "no v22 record survives"
    );
    assert_eq!(count(&conn, "work_assignments"), 1, "the rows survive");
    assert_eq!(count(&conn, "work_assignment_answers"), 1);
    assert_eq!(count(&conn, "worker_attribute_values"), 0);
    let kind: String = conn
        .query_row(
            "SELECT kind FROM worker_attributes WHERE id = 'store'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(kind, "category");
}

#[test]
fn an_unknown_committed_attribute_rolls_the_upgrade_back() {
    let (path, conn) = start_source("work-assignment-flattening", "unknown-attribute");
    add_worksite(&conn, WS, "Unknown");
    add_attribute(
        &conn,
        WS,
        "store",
        "Store",
        "category",
        "workAssignment",
        false,
        &[("store-a", "Store A")],
        0,
    );
    add_worker(&conn, WS, "w-one", "One");
    // Corrupt committed data: an answer whose Attribute row does not exist. Foreign keys
    // are off for this synthetic write so the source can hold it; the migration must
    // refuse it rather than drop the answer with the assignment table.
    add_saved_assignment(&conn, "w-one", "a1", 0, &[]);
    conn.execute_batch("PRAGMA foreign_keys = OFF;")
        .expect("foreign keys off for the corrupt write");
    conn.execute(
        "INSERT INTO work_assignment_answers (assignment_id, attribute_id, answer_id) \
         VALUES ('a1', 'ghost', 'store-a')",
        [],
    )
    .expect("an answer for an unknown Attribute");
    finish_source(&path, conn, 21);

    let app = App::open_legacy_fixture(&path);
    let response = dispatch(&app, WS, "GET", "/api/dataset", None);
    assert_eq!(response.status, 500);
    assert!(
        response.body["message"]
            .as_str()
            .unwrap_or_default()
            .contains("Invalid Work Assignment answer stored"),
        "{}",
        response.body
    );

    // LEGACY-PLAINTEXT-FIXTURE: temp-constructed legacy-schema source for upgrade-read test (intentional plaintext, never production).
    let conn = Connection::open(&path).expect("opens the source again");
    assert_eq!(raw_version(&conn), Some(21));
    assert_eq!(count(&conn, "work_assignments"), 1);
    assert_eq!(count(&conn, "work_assignment_answers"), 1);
    assert_eq!(count(&conn, "worker_attribute_values"), 0);

    remove_database(&path);
}

/// An answer may name an Attribute that exists in the Worker's Worksite but is not
/// assignment-scoped. The Worksite here configures no assignment-scoped Attribute at all, so
/// the conversion has nothing to flatten; the corrupt answer must still fail the upgrade
/// instead of disappearing with the obsolete table.
#[test]
fn a_committed_answer_for_a_worker_scoped_attribute_rolls_the_upgrade_back() {
    let (path, conn) = start_source("work-assignment-flattening", "worker-scoped-attribute");
    add_worksite(&conn, WS, "Worker scoped");
    add_attribute(
        &conn,
        WS,
        "certs",
        "Certs",
        "tag",
        "worker",
        false,
        &[("food", "Food")],
        0,
    );
    add_worker(&conn, WS, "w-one", "One");
    add_saved_assignment(&conn, "w-one", "a1", 0, &[("certs", "food")]);
    finish_source(&path, conn, 21);

    let error = Db::open_legacy_fixture(&path)
        .err()
        .expect("a corrupt committed answer must fail the upgrade");
    assert!(
        error
            .to_string()
            .contains("Invalid Work Assignment answer stored"),
        "{error}"
    );
    let app = App::open_legacy_fixture(&path);
    let response = dispatch(&app, WS, "GET", "/api/dataset", None);
    assert_eq!(response.status, 500);

    // LEGACY-PLAINTEXT-FIXTURE: temp-constructed legacy-schema source for upgrade-read test (intentional plaintext, never production).
    let conn = Connection::open(&path).expect("opens the source again");
    assert_eq!(raw_version(&conn), Some(21), "the file stays at version 21");
    assert!(
        !migration_rows(&conn)
            .iter()
            .any(|(version, _)| *version == 22),
        "no v22 record survives"
    );
    assert_eq!(
        count(&conn, "work_assignment_answers"),
        1,
        "the answer row survives"
    );

    remove_database(&path);
}

#[test]
fn reopening_v22_is_a_no_op_and_does_not_reconvert() {
    let path = seed_ada_bea_cy("reopen");
    let first = {
        let db = Db::open_legacy_fixture(&path).expect("the first open upgrades");
        wobble_core::replay::dump_state(db.conn()).expect("dumps the upgraded state")
    };
    let second = {
        let db = Db::open_legacy_fixture(&path).expect("the second open is a no-op");
        wobble_core::replay::dump_state(db.conn()).expect("dumps the reopened state")
    };
    assert_eq!(first, second, "reopening writes nothing");

    // LEGACY-PLAINTEXT-FIXTURE: temp-constructed legacy-schema source for upgrade-read test (intentional plaintext, never production).
    let conn = Connection::open(&path).expect("opens the database");
    assert_eq!(
        migration_rows(&conn)
            .iter()
            .filter(|(version, _)| *version == 22)
            .count(),
        1,
        "v22 is recorded once"
    );
    assert_eq!(count(&conn, "worker_attribute_values"), 9);
}

#[test]
fn every_previously_supported_source_version_reaches_v26() {
    for version in 12..=21 {
        let name = format!("version-{version}");
        let (path, conn) = start_source("work-assignment-flattening", &name);
        add_worksite(&conn, WS, "Versioned");
        add_attribute(
            &conn,
            WS,
            "dept",
            "Department",
            "category",
            "worker",
            true,
            &[("front", "Front")],
            0,
        );
        add_worker(&conn, WS, "w-one", "One");
        set_value(&conn, "w-one", "dept", json!("front"));
        // A v21 source also carries a committed assignment to convert.
        if version == 21 {
            add_attribute(
                &conn,
                WS,
                "store",
                "Store",
                "category",
                "workAssignment",
                false,
                &[("store-a", "Store A")],
                1,
            );
            add_saved_assignment(&conn, "w-one", "a1", 0, &[("store", "store-a")]);
        }
        finish_source(&path, conn, version);

        let app = App::open_legacy_fixture(&path);
        let data = dataset(&app, WS);
        // LEGACY-PLAINTEXT-FIXTURE: temp-constructed legacy-schema source for upgrade-read test (intentional plaintext, never production).
        let conn = Connection::open(&path).expect("opens the upgraded database");
        assert_eq!(raw_version(&conn), Some(26), "v{version}");
        let rows = migration_rows(&conn);
        assert_eq!(rows.last().unwrap(), &(26, "abbreviation".to_owned()));
        assert_eq!(
            rows.len() as i64,
            27 - version,
            "v{version} runs each step once"
        );
        assert_eq!(rows[0].0, version);
        let front_id = definition(&data, "dept")["options"][0]["id"]
            .as_str()
            .expect("the configured answer id");
        assert_eq!(worker(&data, "w-one")["attributes"]["dept"], front_id);
        if version == 21 {
            assert_eq!(worker(&data, "w-one")["attributes"]["store"], "store-a");
        }
        std::fs::remove_file(&path).ok();
    }
}
