//! Ticket 09: removing a leaf Attribute answer with explicit Worker-value resolutions.
//!
//! The Configuration preview reports every saved Worker value and every Worker draft
//! surface that holds the answer, then the Save carries one replacement or no-answer
//! resolution per holder. Previews write nothing and consume no ids; a stale base or an
//! incomplete plan is refused before any write.

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
const STOCKER: &str = "stocker";
const STORE_A: &str = "store-a";
const STORE_B: &str = "store-b";

fn attribute(id: &str, name: &str, kind: &str, options: Value) -> Value {
    json!({ "id": id, "name": name, "kind": kind, "options": options })
}

fn attributes() -> Value {
    json!([
        attribute(
            JOB,
            "Job",
            "category",
            json!([
                { "id": CASHIER, "value": "Cashier" },
                { "id": SALES, "value": "Sales" },
                { "id": STOCKER, "value": "Stocker" }
            ])
        ),
        attribute(
            LOCATION,
            "Location",
            "tag",
            json!([
                { "id": STORE_A, "value": "Store A" },
                { "id": STORE_B, "value": "Store B" }
            ])
        )
    ])
}

fn attributes_without_cashier() -> Value {
    json!([
        attribute(
            JOB,
            "Job",
            "category",
            json!([
                { "id": SALES, "value": "Sales" },
                { "id": STOCKER, "value": "Stocker" }
            ])
        ),
        attribute(
            LOCATION,
            "Location",
            "tag",
            json!([
                { "id": STORE_A, "value": "Store A" },
                { "id": STORE_B, "value": "Store B" }
            ])
        )
    ])
}

fn proposal(attributes: Value) -> Value {
    json!({ "attributes": attributes, "agitations": [], "languages": [] })
}

fn worker_update(name: &str, email: &str, job: &str, location: Value) -> Value {
    json!({
        "name": name,
        "email": email,
        "phone": "",
        "assessment": "Unassessed",
        "attributes": { JOB: job, LOCATION: location },
        "agitations": [],
        "languages": [],
        "relationships": [],
        "notes": []
    })
}

fn draft_body(update: Value, base: Option<Value>, note: &str) -> Value {
    json!({ "update": update, "pendingNote": { "text": note }, "base": base })
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
                Some(proposal(definitions)),
            ),
            &NoIds,
        )
    }

    fn create_worker(&self, name: &str, job: &str, location: Value) -> String {
        let response = self.send(
            "POST",
            "/api/workers",
            Some(worker_update(name, "", job, location)),
        );
        assert_eq!(response.status, 201, "{:?}", response.body);
        response.body["worker"]["id"]
            .as_str()
            .expect("the created worker id")
            .to_owned()
    }

    fn save_draft(&self, worker_id: &str, body: Value) {
        let response = self.send(
            "PUT",
            &format!("/api/worker-drafts/{worker_id}"),
            Some(body),
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

    fn total_changes(&self) -> i64 {
        self.db
            .conn()
            .query_row("SELECT total_changes()", [], |row| row.get(0))
            .unwrap()
    }

    fn save_body(&self, attributes: Value, base: &str, resolutions: Value) -> Value {
        json!({ "attributes": attributes, "base": base, "resolutions": resolutions })
    }
}

struct Seeded {
    fixture: Fixture,
    alex: String,
    blair: String,
}

/// Alex holds Cashier in the saved value and in both draft surfaces; Blair holds Cashier
/// in the saved value only; Casey holds Sales.
fn seeded() -> Seeded {
    let fixture = Fixture::new();
    let alex = fixture.create_worker("Alex", CASHIER, json!([STORE_A]));
    fixture.save_draft(
        &alex,
        draft_body(
            {
                let mut update =
                    worker_update("Alex", "alex@example.com", CASHIER, json!([STORE_A]));
                update["assessment"] = json!("Leader");
                update
            },
            Some(worker_update("Alex", "", CASHIER, json!([STORE_A]))),
            "keep this note",
        ),
    );
    let blair = fixture.create_worker("Blair", CASHIER, json!([STORE_B]));
    fixture.create_worker("Casey", SALES, json!([STORE_A]));
    Seeded {
        fixture,
        alex,
        blair,
    }
}

fn impact(preview: &Value) -> &Value {
    preview["removedAnswers"]
        .as_array()
        .expect("removedAnswers")
        .iter()
        .find(|impact| impact["attributeId"] == json!(JOB) && impact["answerId"] == json!(CASHIER))
        .unwrap_or_else(|| panic!("a Cashier impact in {preview}"))
}

fn holder<'a>(impact: &'a Value, worker_id: &str, surface: Option<&str>) -> &'a Value {
    impact["holders"]
        .as_array()
        .expect("holders")
        .iter()
        .find(|holder| {
            holder["workerId"] == json!(worker_id)
                && surface.is_none_or(|surface| holder["surface"] == json!(surface))
        })
        .unwrap_or_else(|| panic!("the {surface:?} holder of {worker_id} in {impact}"))
}

fn replacement_value(holder: &Value, answer_id: &str) -> Value {
    holder["replacements"]
        .as_array()
        .expect("replacements")
        .iter()
        .find(|replacement| replacement["answerId"] == json!(answer_id))
        .unwrap_or_else(|| panic!("a {answer_id} replacement in {holder}"))["resultingValue"]
        .clone()
}

fn resolutions(holders: Value) -> Value {
    json!({
        "removedAnswers": [{
            "attributeId": JOB,
            "answerId": CASHIER,
            "holders": holders
        }],
        "removedAttributes": [],
        "cardinality": []
    })
}

#[test]
fn the_preview_reports_every_holder_and_resulting_value_without_writing() {
    let Seeded { fixture, alex, .. } = seeded();
    let before = fixture.total_changes();

    let response = fixture.preview(attributes_without_cashier());
    assert_eq!(response.status, 200, "{:?}", response.body);
    assert_eq!(fixture.total_changes(), before, "a preview writes nothing");

    let impact = impact(&response.body);
    assert_eq!(impact["affectedWorkers"], 2);
    assert_eq!(impact["affectedDrafts"], 1);
    assert_eq!(
        impact["removedValues"], 4,
        "the saved value plus both draft surfaces of one Worker, and another saved value"
    );

    let value = holder(impact, &alex, None);
    assert_eq!(value["kind"], "worker");
    assert_eq!(value["workerName"], "Alex");
    assert_eq!(value["value"], CASHIER);
    assert_eq!(replacement_value(value, SALES), SALES);
    assert_eq!(replacement_value(value, STOCKER), STOCKER);

    let update = holder(impact, &alex, Some("draft"));
    assert_eq!(update["kind"], "workerDraft");
    assert_eq!(update["value"], CASHIER);
    let base = holder(impact, &alex, Some("base"));
    assert_eq!(base["value"], CASHIER);
}

#[test]
fn a_replacement_applies_to_the_saved_value_and_keeps_every_other_draft_field() {
    let Seeded {
        fixture,
        alex,
        blair,
    } = seeded();
    let preview = fixture.preview(attributes_without_cashier());
    let base = preview.body["base"].as_str().expect("a preview base");

    let holders = json!([
        { "workerId": alex, "replacement": SALES },
        { "workerId": alex, "surface": "draft", "replacement": SALES },
        { "workerId": alex, "surface": "base", "replacement": STOCKER },
        { "workerId": blair, "replacement": null }
    ]);
    let saved = fixture.send(
        "PUT",
        "/api/attributes",
        Some(fixture.save_body(attributes_without_cashier(), base, resolutions(holders))),
    );
    assert_eq!(saved.status, 200, "{:?}", saved.body);

    let dataset = fixture.dataset();
    assert_eq!(fixture.worker(&dataset, "Alex")["attributes"][JOB], SALES);
    assert_eq!(fixture.worker(&dataset, "Blair")["attributes"][JOB], "");
    assert_eq!(fixture.worker(&dataset, "Casey")["attributes"][JOB], SALES);

    let draft = fixture.draft(&alex);
    assert_eq!(draft["update"]["attributes"][JOB], SALES);
    assert_eq!(draft["base"]["attributes"][JOB], STOCKER);
    assert_eq!(draft["update"]["email"], "alex@example.com");
    assert_eq!(draft["update"]["assessment"], "Leader");
    assert_eq!(draft["pendingNote"]["text"], "keep this note");
}

#[test]
fn a_no_answer_resolution_clears_the_saved_value_and_the_draft_surfaces() {
    let Seeded {
        fixture,
        alex,
        blair,
    } = seeded();
    let preview = fixture.preview(attributes_without_cashier());
    let base = preview.body["base"].as_str().expect("a preview base");
    let holders = json!([
        { "workerId": alex, "replacement": null },
        { "workerId": alex, "surface": "draft", "replacement": null },
        { "workerId": alex, "surface": "base", "replacement": null },
        { "workerId": blair, "replacement": null }
    ]);
    let saved = fixture.send(
        "PUT",
        "/api/attributes",
        Some(fixture.save_body(attributes_without_cashier(), base, resolutions(holders))),
    );
    assert_eq!(saved.status, 200, "{:?}", saved.body);

    assert_eq!(
        fixture.worker(&fixture.dataset(), "Alex")["attributes"][JOB],
        ""
    );
    let draft = fixture.draft(&alex);
    assert_eq!(draft["update"]["attributes"][JOB], "");
    assert_eq!(draft["base"]["attributes"][JOB], "");
}

#[test]
fn every_affected_holder_needs_its_own_resolution_before_anything_changes() {
    let Seeded { fixture, alex, .. } = seeded();
    let preview = fixture.preview(attributes_without_cashier());
    let base = preview.body["base"].as_str().expect("a preview base");
    let before = fixture.total_changes();

    let holders = json!([{ "workerId": alex, "replacement": SALES }]);
    let refused = fixture.send(
        "PUT",
        "/api/attributes",
        Some(fixture.save_body(attributes_without_cashier(), base, resolutions(holders))),
    );
    assert_eq!(refused.status, 409, "{:?}", refused.body);
    assert_eq!(refused.body["code"], "configuration_resolution_required");
    assert_eq!(fixture.total_changes(), before, "nothing was written");
}

#[test]
fn a_replacement_must_be_a_kept_answer_of_the_same_attribute() {
    let Seeded {
        fixture,
        alex,
        blair,
    } = seeded();
    let preview = fixture.preview(attributes_without_cashier());
    let base = preview.body["base"].as_str().expect("a preview base");
    let holders = json!([
        { "workerId": alex, "replacement": "not-an-answer" },
        { "workerId": alex, "surface": "draft", "replacement": SALES },
        { "workerId": alex, "surface": "base", "replacement": SALES },
        { "workerId": blair, "replacement": SALES }
    ]);
    let refused = fixture.send(
        "PUT",
        "/api/attributes",
        Some(fixture.save_body(attributes_without_cashier(), base, resolutions(holders))),
    );
    assert_eq!(refused.status, 400, "{:?}", refused.body);
    assert_eq!(refused.body["code"], "configuration_replacement_invalid");
}

#[test]
fn a_stale_preview_base_is_refused_before_any_write() {
    let Seeded {
        fixture,
        alex,
        blair,
    } = seeded();
    let preview = fixture.preview(attributes_without_cashier());
    let base = preview.body["base"].as_str().expect("a preview base");
    // A Worker value changes after the preview was taken.
    let updated = fixture.send(
        "PUT",
        &format!("/api/workers/{alex}"),
        Some(worker_update("Alex", "", SALES, json!([STORE_A]))),
    );
    assert_eq!(updated.status, 200, "{:?}", updated.body);

    let holders = json!([
        { "workerId": alex, "replacement": SALES },
        { "workerId": alex, "surface": "draft", "replacement": SALES },
        { "workerId": alex, "surface": "base", "replacement": SALES },
        { "workerId": blair, "replacement": SALES }
    ]);
    let refused = fixture.send(
        "PUT",
        "/api/attributes",
        Some(fixture.save_body(attributes_without_cashier(), base, resolutions(holders))),
    );
    assert_eq!(refused.status, 409, "{:?}", refused.body);
    assert_eq!(refused.body["code"], "stale_configuration_preview");
}

#[test]
fn the_legacy_array_save_still_prunes_every_holder() {
    let Seeded { fixture, .. } = seeded();
    let saved = fixture.send("PUT", "/api/attributes", Some(attributes_without_cashier()));
    assert_eq!(saved.status, 200, "{:?}", saved.body);
    let dataset = fixture.dataset();
    assert_eq!(fixture.worker(&dataset, "Alex")["attributes"][JOB], "");
    assert_eq!(fixture.worker(&dataset, "Blair")["attributes"][JOB], "");
    assert_eq!(fixture.worker(&dataset, "Casey")["attributes"][JOB], SALES);
}
