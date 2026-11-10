//! Ticket 11: moving an answer branch to another parent.
//!
//! The Configuration preview reports the branch root, the path it leaves and the path it
//! gains, plus every Worker value whose reading follows. A confirmed Save changes only the
//! stored parent links; answer ids, order and Worker values stay as they are.

mod common;

use common::http::{request, NoIds};
use serde_json::{json, Value};
use wobble_core::db::{open_seeded, Db};
use wobble_core::handle::Response;
use wobble_core::id::CounterId;
use wobble_core::router::dispatch;

const AREA: &str = "area";
const CENTRAL: &str = "central";
const STORE_A: &str = "store-a";
const STORE_B: &str = "store-b";

fn attribute(options: Value) -> Value {
    json!({ "id": AREA, "name": "Area", "kind": "category", "options": options })
}

fn attributes(store_a_parent: &str) -> Value {
    json!([attribute(json!([
        { "id": CENTRAL, "value": "Central" },
        { "id": STORE_A, "value": "Store A", "parentId": store_a_parent },
        { "id": STORE_B, "value": "Store B" }
    ]))])
}

fn worker_update(name: &str, area: &str) -> Value {
    json!({
        "name": name,
        "email": "",
        "phone": "",
        "assessment": "Unassessed",
        "attributes": { AREA: area },
        "agitations": [],
        "languages": [],
        "relationships": [],
        "notes": []
    })
}

struct Fixture {
    db: Db,
    ids: CounterId,
    worksite: String,
}

impl Fixture {
    fn new(store_a_parent: &str) -> Self {
        let ids = CounterId::new();
        let db = open_seeded(":memory:", &ids).expect("a seeded database");
        let worksite = dispatch(&db, &request("GET", "/api/worksite", None, None), &ids).body
            ["worksite"]["id"]
            .as_str()
            .expect("the seeded worksite id")
            .to_owned();
        let fixture = Self { db, ids, worksite };
        let configured = fixture.send("PUT", "/api/attributes", Some(attributes(store_a_parent)));
        assert_eq!(configured.status, 200, "{:?}", configured.body);
        fixture
    }

    fn send(&self, method: &str, path: &str, body: Option<Value>) -> Response {
        dispatch(
            &self.db,
            &request(method, path, Some(&self.worksite), body),
            &self.ids,
        )
    }

    fn preview(&self, definitions: Value) -> Response {
        dispatch(
            &self.db,
            &request(
                "POST",
                "/api/configuration/preview",
                Some(&self.worksite),
                Some(json!({
                    "attributes": definitions,
                    "agitations": [],
                    "languages": []
                })),
            ),
            &NoIds,
        )
    }

    fn create_worker(&self, name: &str, area: &str) {
        let response = self.send("POST", "/api/workers", Some(worker_update(name, area)));
        assert_eq!(response.status, 201, "{:?}", response.body);
    }

    fn dataset(&self) -> Value {
        let response = self.send("GET", "/api/dataset", None);
        assert_eq!(response.status, 200, "{:?}", response.body);
        response.body
    }

    fn worker<'a>(&self, dataset: &'a Value, name: &str) -> &'a Value {
        dataset["workers"]
            .as_array()
            .expect("workers")
            .iter()
            .find(|worker| worker["name"] == json!(name))
            .unwrap_or_else(|| panic!("the Worker {name}"))
    }

    fn save_body(&self, attributes: Value, base: &str) -> Value {
        json!({
            "attributes": attributes,
            "base": base,
            "resolutions": {
                "removedAnswers": [],
                "removedAttributes": [],
                "cardinality": []
            }
        })
    }
}

#[test]
fn the_preview_reports_the_moved_path_and_every_holder_without_writing() {
    let fixture = Fixture::new(CENTRAL);
    fixture.create_worker("Alex", STORE_A);
    fixture.create_worker("Blair", CENTRAL);

    let before = fixture
        .db
        .conn()
        .query_row("SELECT total_changes()", [], |row| row.get::<_, i64>(0))
        .unwrap();
    let response = fixture.preview(attributes(STORE_B));
    assert_eq!(response.status, 200, "{:?}", response.body);
    assert_eq!(
        fixture
            .db
            .conn()
            .query_row("SELECT total_changes()", [], |row| row.get::<_, i64>(0))
            .unwrap(),
        before
    );

    let moves = response.body["moves"].as_array().expect("moves");
    assert_eq!(moves.len(), 1);
    let impact = &moves[0];
    assert_eq!(impact["attributeId"], AREA);
    assert_eq!(impact["answerId"], STORE_A);
    assert_eq!(impact["parentId"], STORE_B);
    assert_eq!(impact["previousParentId"], CENTRAL);
    assert_eq!(impact["previousPath"], json!(["Central", "Store A"]));
    assert_eq!(impact["path"], json!(["Store B", "Store A"]));
    assert_eq!(impact["subtreeAnswerIds"], json!([STORE_A]));
    assert_eq!(impact["affectedWorkers"], 1);
    assert_eq!(
        impact["holders"][0]["workerId"],
        impact["holders"][0]["workerId"]
    );
    assert_eq!(impact["holders"][0]["kind"], "worker");
    assert_eq!(impact["holders"][0]["heldAnswerId"], STORE_A);
    assert_eq!(
        impact["holders"][0]["previousPath"],
        json!(["Central", "Store A"])
    );
    assert_eq!(impact["holders"][0]["path"], json!(["Store B", "Store A"]));
}

#[test]
fn a_confirmed_move_changes_only_the_parent_links() {
    let fixture = Fixture::new(CENTRAL);
    fixture.create_worker("Alex", STORE_A);
    fixture.create_worker("Blair", CENTRAL);
    let preview = fixture.preview(attributes(STORE_B));
    let base = preview.body["base"].as_str().expect("a preview base");

    let saved = fixture.send(
        "PUT",
        "/api/attributes",
        Some(fixture.save_body(attributes(STORE_B), base)),
    );
    assert_eq!(saved.status, 200, "{:?}", saved.body);
    let dataset = fixture.dataset();
    let options = dataset["attributes"][0]["options"]
        .as_array()
        .expect("options");
    let parent = |id: &str| {
        options
            .iter()
            .find(|answer| answer["id"] == json!(id))
            .expect("the answer")["parentId"]
            .clone()
    };
    assert_eq!(parent(STORE_A), STORE_B);
    assert_eq!(parent(CENTRAL), Value::Null);
    assert_eq!(
        fixture.worker(&dataset, "Alex")["attributes"][AREA],
        STORE_A,
        "the Worker's selection keeps its id"
    );
    assert_eq!(
        fixture.worker(&dataset, "Blair")["attributes"][AREA],
        CENTRAL
    );
}

#[test]
fn a_move_without_holders_is_still_reported_and_saved() {
    let fixture = Fixture::new(CENTRAL);
    let preview = fixture.preview(attributes(STORE_B));
    assert_eq!(preview.status, 200, "{:?}", preview.body);
    let impact = &preview.body["moves"][0];
    assert_eq!(impact["affectedWorkers"], 0);
    assert_eq!(impact["holders"], json!([]));
    let base = preview.body["base"].as_str().expect("a preview base");
    let saved = fixture.send(
        "PUT",
        "/api/attributes",
        Some(fixture.save_body(attributes(STORE_B), base)),
    );
    assert_eq!(saved.status, 200, "{:?}", saved.body);
}

#[test]
fn a_stale_move_preview_is_refused_before_any_write() {
    let fixture = Fixture::new(CENTRAL);
    fixture.create_worker("Alex", STORE_A);
    let preview = fixture.preview(attributes(STORE_B));
    let base = preview.body["base"].as_str().expect("a preview base");
    let created = fixture.send(
        "POST",
        "/api/workers",
        Some(worker_update("Casey", STORE_B)),
    );
    assert_eq!(created.status, 201, "{:?}", created.body);

    let refused = fixture.send(
        "PUT",
        "/api/attributes",
        Some(fixture.save_body(attributes(STORE_B), base)),
    );
    assert_eq!(refused.status, 409, "{:?}", refused.body);
    assert_eq!(refused.body["code"], "stale_configuration_preview");
}

#[test]
fn a_cycle_or_self_move_is_refused_without_writing() {
    let fixture = Fixture::new(CENTRAL);
    fixture.create_worker("Alex", STORE_A);
    let before = fixture.dataset();

    // An answer cannot become its own child.
    let self_move = json!([attribute(json!([
        { "id": CENTRAL, "value": "Central", "parentId": STORE_A },
        { "id": STORE_A, "value": "Store A", "parentId": CENTRAL },
        { "id": STORE_B, "value": "Store B" }
    ]))]);
    let refused = fixture.preview(self_move);
    assert_eq!(refused.status, 400, "{:?}", refused.body);

    // A cycle through another answer is equally invalid.
    let cycle = json!([attribute(json!([
        { "id": CENTRAL, "value": "Central", "parentId": STORE_B },
        { "id": STORE_A, "value": "Store A", "parentId": CENTRAL },
        { "id": STORE_B, "value": "Store B", "parentId": STORE_A }
    ]))]);
    let refused = fixture.preview(cycle);
    assert_eq!(refused.status, 400, "{:?}", refused.body);
    assert_eq!(fixture.dataset(), before, "nothing moved");
}

#[test]
fn a_sibling_label_collision_is_refused_until_the_name_changes() {
    let fixture = Fixture::new(CENTRAL);
    // Store B gains a child with the same name as the answer being moved under it.
    let collision = json!([attribute(json!([
        { "id": CENTRAL, "value": "Central" },
        { "id": STORE_A, "value": "Store A", "parentId": STORE_B },
        { "id": STORE_B, "value": "Store B" },
        { "id": "store-c", "value": "Store A", "parentId": STORE_B }
    ]))]);
    let refused = fixture.preview(collision);
    assert_eq!(refused.status, 400, "{:?}", refused.body);
    assert_eq!(
        refused.body["code"], "configuration_sibling_label_conflict",
        "{}",
        refused.body
    );

    // Renaming the sibling makes the move valid.
    let renamed = json!([attribute(json!([
        { "id": CENTRAL, "value": "Central" },
        { "id": STORE_A, "value": "Store A", "parentId": STORE_B },
        { "id": STORE_B, "value": "Store B" },
        { "id": "store-c", "value": "Store C", "parentId": STORE_B }
    ]))]);
    let accepted = fixture.preview(renamed);
    assert_eq!(accepted.status, 200, "{:?}", accepted.body);
}
