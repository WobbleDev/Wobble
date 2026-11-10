//! Ticket 14: removing an entire Attribute only after acknowledging the saved Worker
//! values and Worker drafts that depend on it.
//!
//! The preview names every holder and every discarded answer. The Save carries one
//! acknowledgement per removed Attribute and applies the definition cascade, the Worker
//! value removal and the draft pruning in one transaction.

mod common;

use common::http::{request, NoIds};
use serde_json::{json, Value};
use wobble_core::db::{open_seeded, Db};
use wobble_core::handle::Response;
use wobble_core::id::CounterId;
use wobble_core::router::dispatch;

const JOB: &str = "job";
const LOCATION: &str = "location";
const CASHIER: &str = "cashier";
const SALES: &str = "sales";
const STORE_A: &str = "store-a";
const STORE_B: &str = "store-b";

fn attributes() -> Value {
    json!([
        {
            "id": JOB,
            "name": "Job",
            "kind": "category",
            "options": [
                { "id": CASHIER, "value": "Cashier" },
                { "id": SALES, "value": "Sales" }
            ]
        },
        {
            "id": LOCATION,
            "name": "Location",
            "kind": "tag",
            "options": [
                { "id": STORE_A, "value": "Store A" },
                { "id": STORE_B, "value": "Store B" }
            ]
        }
    ])
}

fn without_job() -> Value {
    json!([{
        "id": LOCATION,
        "name": "Location",
        "kind": "tag",
        "options": [
            { "id": STORE_A, "value": "Store A" },
            { "id": STORE_B, "value": "Store B" }
        ]
    }])
}

fn worker_update(name: &str, job: &str, location: Value) -> Value {
    json!({
        "name": name,
        "email": "",
        "phone": "",
        "assessment": "Unassessed",
        "attributes": { JOB: job, LOCATION: location },
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
    fn new() -> Self {
        let ids = CounterId::new();
        let db = open_seeded(":memory:", &ids).expect("a seeded database");
        let worksite = dispatch(&db, &request("GET", "/api/worksite", None, None), &ids).body
            ["worksite"]["id"]
            .as_str()
            .expect("the seeded worksite id")
            .to_owned();
        let fixture = Self { db, ids, worksite };
        let configured = fixture.send("PUT", "/api/attributes", Some(attributes()));
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

    fn create_worker(&self, name: &str, job: &str, location: Value) -> String {
        let response = self.send(
            "POST",
            "/api/workers",
            Some(worker_update(name, job, location)),
        );
        assert_eq!(response.status, 201, "{:?}", response.body);
        response.body["worker"]["id"]
            .as_str()
            .expect("the created worker id")
            .to_owned()
    }

    fn save_draft(&self, worker_id: &str, update: Value, base: Option<Value>, note: &str) {
        let response = self.send(
            "PUT",
            &format!("/api/worker-drafts/{worker_id}"),
            Some(json!({
                "update": update,
                "pendingNote": { "text": note },
                "base": base
            })),
        );
        assert_eq!(response.status, 200, "{:?}", response.body);
    }

    fn draft(&self, worker_id: &str) -> Value {
        let response = self.send("GET", &format!("/api/worker-drafts/{worker_id}"), None);
        assert_eq!(response.status, 200, "{:?}", response.body);
        response.body["draft"].clone()
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

    fn save_body(&self, attributes: Value, base: &str, resolutions: Value) -> Value {
        json!({ "attributes": attributes, "base": base, "resolutions": resolutions })
    }
}

#[test]
fn the_preview_names_every_holder_without_writing() {
    let fixture = Fixture::new();
    let alex = fixture.create_worker("Alex", CASHIER, json!([STORE_A]));
    fixture.save_draft(
        &alex,
        worker_update("Alex", CASHIER, json!([STORE_A])),
        Some(worker_update("Alex", CASHIER, json!([STORE_A]))),
        "keep me",
    );
    fixture.create_worker("Blair", SALES, json!([STORE_A, STORE_B]));

    let before = fixture
        .db
        .conn()
        .query_row("SELECT total_changes()", [], |row| row.get::<_, i64>(0))
        .unwrap();
    let response = fixture.preview(without_job());
    assert_eq!(response.status, 200, "{:?}", response.body);
    assert_eq!(
        fixture
            .db
            .conn()
            .query_row("SELECT total_changes()", [], |row| row.get::<_, i64>(0))
            .unwrap(),
        before
    );

    let impacts = response.body["removedAttributes"]
        .as_array()
        .expect("removedAttributes");
    assert_eq!(impacts.len(), 1);
    let impact = &impacts[0];
    assert_eq!(impact["attributeId"], JOB);
    assert_eq!(impact["answerIds"], json!([CASHIER, SALES]));
    assert_eq!(impact["affectedWorkers"], 2);
    assert_eq!(impact["affectedDrafts"], 1);
    assert_eq!(
        impact["removedValues"], 2,
        "one discarded answer per Worker and Attribute"
    );
    let surfaces: Vec<&str> = impact["holders"]
        .as_array()
        .expect("holders")
        .iter()
        .map(|holder| holder["surface"].as_str().unwrap_or("value"))
        .collect();
    assert!(surfaces.contains(&"value"));
    assert!(surfaces.contains(&"draft"));
    assert!(surfaces.contains(&"base"));
}

#[test]
fn an_acknowledged_removal_deletes_the_values_and_prunes_the_drafts() {
    let fixture = Fixture::new();
    let alex = fixture.create_worker("Alex", CASHIER, json!([STORE_A]));
    fixture.save_draft(
        &alex,
        worker_update("Alex", CASHIER, json!([STORE_A])),
        Some(worker_update("Alex", CASHIER, json!([STORE_A]))),
        "keep me",
    );
    fixture.create_worker("Blair", SALES, json!([STORE_A, STORE_B]));

    let preview = fixture.preview(without_job());
    let base = preview.body["base"].as_str().expect("a preview base");
    let saved = fixture.send(
        "PUT",
        "/api/attributes",
        Some(fixture.save_body(
            without_job(),
            base,
            json!({
                "removedAnswers": [],
                "removedAttributes": [{ "attributeId": JOB }],
                "cardinality": []
            }),
        )),
    );
    assert_eq!(saved.status, 200, "{:?}", saved.body);

    let dataset = fixture.dataset();
    assert_eq!(
        dataset["attributes"].as_array().expect("attributes").len(),
        1
    );
    assert_eq!(
        fixture.worker(&dataset, "Alex")["attributes"],
        json!({ LOCATION: [STORE_A] })
    );
    assert_eq!(
        fixture.worker(&dataset, "Blair")["attributes"],
        json!({ LOCATION: [STORE_A, STORE_B] })
    );

    let draft = fixture.draft(&alex);
    assert_eq!(
        draft["update"]["attributes"],
        json!({ LOCATION: [STORE_A] })
    );
    assert_eq!(draft["base"]["attributes"], json!({ LOCATION: [STORE_A] }));
    assert_eq!(draft["pendingNote"]["text"], "keep me");
}

#[test]
fn an_unacknowledged_removal_is_refused_without_writing() {
    let fixture = Fixture::new();
    fixture.create_worker("Alex", CASHIER, json!([STORE_A]));
    let preview = fixture.preview(without_job());
    let base = preview.body["base"].as_str().expect("a preview base");

    let refused = fixture.send(
        "PUT",
        "/api/attributes",
        Some(fixture.save_body(
            without_job(),
            base,
            json!({
                "removedAnswers": [],
                "removedAttributes": [],
                "cardinality": []
            }),
        )),
    );
    assert_eq!(refused.status, 409, "{:?}", refused.body);
    assert_eq!(refused.body["code"], "configuration_resolution_required");
    assert_eq!(
        fixture.dataset()["attributes"]
            .as_array()
            .expect("attributes")
            .len(),
        2,
        "the definition was not removed"
    );
}

#[test]
fn acknowledging_an_attribute_that_is_not_removed_is_refused() {
    let fixture = Fixture::new();
    fixture.create_worker("Alex", CASHIER, json!([STORE_A]));
    // A pure rename: no Attribute is removed, so the acknowledgement names nothing.
    let mut renamed = attributes();
    renamed[0]["name"] = json!("Position");
    let preview = fixture.preview(renamed.clone());
    let base = preview.body["base"].as_str().expect("a preview base");
    let refused = fixture.send(
        "PUT",
        "/api/attributes",
        Some(fixture.save_body(
            renamed,
            base,
            json!({
                "removedAnswers": [],
                "removedAttributes": [{ "attributeId": JOB }],
                "cardinality": []
            }),
        )),
    );
    assert_eq!(refused.status, 400, "{:?}", refused.body);
    assert_eq!(refused.body["code"], "configuration_replacement_invalid");
}

#[test]
fn a_stale_preview_refuses_the_removal() {
    let fixture = Fixture::new();
    let alex = fixture.create_worker("Alex", CASHIER, json!([STORE_A]));
    let preview = fixture.preview(without_job());
    let base = preview.body["base"].as_str().expect("a preview base");
    let updated = fixture.send(
        "PUT",
        &format!("/api/workers/{alex}"),
        Some(worker_update("Alex", SALES, json!([STORE_A]))),
    );
    assert_eq!(updated.status, 200, "{:?}", updated.body);

    let refused = fixture.send(
        "PUT",
        "/api/attributes",
        Some(fixture.save_body(
            without_job(),
            base,
            json!({
                "removedAnswers": [],
                "removedAttributes": [{ "attributeId": JOB }],
                "cardinality": []
            }),
        )),
    );
    assert_eq!(refused.status, 409, "{:?}", refused.body);
    assert_eq!(refused.body["code"], "stale_configuration_preview");
}
