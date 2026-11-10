//! Ticket 10: merging two leaf Attribute answers with explicit Worker-value resolutions.
//!
//! The Configuration preview reports every saved Worker value and Worker draft surface that
//! holds the folded answer, and the survivor that keeps its identity. The Save follows the
//! survivor by id inside each holder's value; a merge offers no other replacement.

mod common;

use common::http::{request, NoIds};
use serde_json::{json, Value};
use wobble_core::db::{open_seeded, Db};
use wobble_core::handle::Response;
use wobble_core::id::CounterId;
use wobble_core::router::dispatch;

const JOB: &str = "job";
const CASHIER: &str = "cashier";
const SALES: &str = "sales";
const STOCKER: &str = "stocker";

fn attribute(options: Value) -> Value {
    json!({ "id": JOB, "name": "Job", "kind": "tag", "options": options })
}

fn attributes() -> Value {
    json!([attribute(json!([
        { "id": CASHIER, "value": "Cashier" },
        { "id": SALES, "value": "Sales" },
        { "id": STOCKER, "value": "Stocker" }
    ]))])
}

fn merged_attributes() -> Value {
    json!([attribute(json!([
        { "id": CASHIER, "value": "Cashier", "mergedInto": SALES },
        { "id": SALES, "value": "Sales" },
        { "id": STOCKER, "value": "Stocker" }
    ]))])
}

fn worker_update(name: &str, job: Value, email: &str) -> Value {
    json!({
        "name": name,
        "email": email,
        "phone": "",
        "assessment": "Unassessed",
        "attributes": { JOB: job },
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

    fn create_worker(&self, name: &str, job: Value) -> String {
        let response = self.send("POST", "/api/workers", Some(worker_update(name, job, "")));
        assert_eq!(response.status, 201, "{:?}", response.body);
        response.body["worker"]["id"]
            .as_str()
            .expect("the created worker id")
            .to_owned()
    }

    fn save_draft(&self, worker_id: &str, update: Value, base: Value, note: &str) {
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

struct Seeded {
    fixture: Fixture,
    alex: String,
    blair: String,
}

fn seeded() -> Seeded {
    let fixture = Fixture::new();
    let alex = fixture.create_worker("Alex", json!([CASHIER, STOCKER]));
    fixture.save_draft(
        &alex,
        worker_update("Alex", json!([CASHIER, STOCKER]), "alex@example.com"),
        worker_update("Alex", json!([CASHIER]), ""),
        "keep this note",
    );
    let blair = fixture.create_worker("Blair", json!([CASHIER]));
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

fn resolutions(values: &[(&str, Option<&str>)]) -> Value {
    let holders: Vec<Value> = values
        .iter()
        .map(|(worker_id, surface)| match surface {
            Some(surface) => json!({
                "workerId": worker_id,
                "surface": surface,
                "replacement": SALES
            }),
            None => json!({ "workerId": worker_id, "replacement": SALES }),
        })
        .collect();
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
fn a_merge_reports_the_survivor_and_moves_every_holder_by_id() {
    let Seeded {
        fixture,
        alex,
        blair,
    } = seeded();
    let response = fixture.preview(merged_attributes());
    assert_eq!(response.status, 200, "{:?}", response.body);

    let impact = impact(&response.body);
    assert_eq!(impact["mergeInto"], SALES);
    assert_eq!(impact["affectedWorkers"], 2);
    assert_eq!(impact["affectedDrafts"], 1);
    assert_eq!(impact["removedValues"], 0, "a merge discards nothing");

    let value = holder(impact, &alex, None);
    assert_eq!(value["value"], json!([CASHIER, STOCKER]));
    assert_eq!(
        value["replacements"],
        json!([{ "answerId": SALES, "resultingValue": [SALES, STOCKER] }])
    );
    let base = holder(impact, &alex, Some("base"));
    assert_eq!(
        base["replacements"],
        json!([{ "answerId": SALES, "resultingValue": [SALES] }])
    );
    let blair_value = holder(impact, &blair, None);
    assert_eq!(
        blair_value["replacements"],
        json!([{ "answerId": SALES, "resultingValue": [SALES] }])
    );
}

#[test]
fn the_saved_value_and_both_draft_surfaces_follow_the_survivor() {
    let Seeded {
        fixture,
        alex,
        blair,
    } = seeded();
    let preview = fixture.preview(merged_attributes());
    let base = preview.body["base"].as_str().expect("a preview base");
    let saved = fixture.send(
        "PUT",
        "/api/attributes",
        Some(fixture.save_body(
            merged_attributes(),
            base,
            resolutions(&[
                (&alex, None),
                (&alex, Some("draft")),
                (&alex, Some("base")),
                (&blair, None),
            ]),
        )),
    );
    assert_eq!(saved.status, 200, "{:?}", saved.body);

    let dataset = fixture.dataset();
    assert_eq!(
        fixture.worker(&dataset, "Alex")["attributes"][JOB],
        json!([SALES, STOCKER])
    );
    assert_eq!(
        fixture.worker(&dataset, "Blair")["attributes"][JOB],
        json!([SALES])
    );
    let draft = fixture.draft(&alex);
    assert_eq!(draft["update"]["attributes"][JOB], json!([SALES, STOCKER]));
    assert_eq!(draft["base"]["attributes"][JOB], json!([SALES]));
    assert_eq!(draft["update"]["email"], "alex@example.com");
    assert_eq!(draft["pendingNote"]["text"], "keep this note");
    assert!(
        !dataset["attributes"][0]["options"]
            .as_array()
            .expect("options")
            .iter()
            .any(|answer| answer["id"] == json!(CASHIER)),
        "the folded answer leaves the stored definition"
    );
}

#[test]
fn a_merge_resolution_must_keep_the_chosen_survivor() {
    let Seeded {
        fixture,
        alex,
        blair,
    } = seeded();
    let preview = fixture.preview(merged_attributes());
    let base = preview.body["base"].as_str().expect("a preview base");
    let refused = fixture.send(
        "PUT",
        "/api/attributes",
        Some(fixture.save_body(
            merged_attributes(),
            base,
            json!({
                "removedAnswers": [{
                    "attributeId": JOB,
                    "answerId": CASHIER,
                    "holders": [
                        { "workerId": alex, "replacement": STOCKER },
                        { "workerId": alex, "surface": "draft", "replacement": STOCKER },
                        { "workerId": alex, "surface": "base", "replacement": STOCKER },
                        { "workerId": blair, "replacement": STOCKER }
                    ]
                }],
                "removedAttributes": [],
                "cardinality": []
            }),
        )),
    );
    assert_eq!(refused.status, 400, "{:?}", refused.body);
    assert_eq!(refused.body["code"], "configuration_replacement_invalid");
}

#[test]
fn an_incomplete_merge_plan_is_refused_without_writing() {
    let Seeded { fixture, alex, .. } = seeded();
    let preview = fixture.preview(merged_attributes());
    let base = preview.body["base"].as_str().expect("a preview base");
    let before = fixture
        .db
        .conn()
        .query_row("SELECT total_changes()", [], |row| row.get::<_, i64>(0))
        .unwrap();
    let refused = fixture.send(
        "PUT",
        "/api/attributes",
        Some(fixture.save_body(merged_attributes(), base, resolutions(&[(&alex, None)]))),
    );
    assert_eq!(refused.status, 409, "{:?}", refused.body);
    assert_eq!(refused.body["code"], "configuration_resolution_required");
    assert_eq!(
        fixture
            .db
            .conn()
            .query_row("SELECT total_changes()", [], |row| row.get::<_, i64>(0))
            .unwrap(),
        before
    );
}

#[test]
fn a_stale_merge_preview_is_refused_before_any_write() {
    let Seeded {
        fixture,
        alex,
        blair,
    } = seeded();
    let preview = fixture.preview(merged_attributes());
    let base = preview.body["base"].as_str().expect("a preview base");
    let updated = fixture.send(
        "PUT",
        &format!("/api/workers/{alex}"),
        Some(worker_update("Alex", json!([STOCKER]), "")),
    );
    assert_eq!(updated.status, 200, "{:?}", updated.body);

    let refused = fixture.send(
        "PUT",
        "/api/attributes",
        Some(fixture.save_body(
            merged_attributes(),
            base,
            resolutions(&[
                (&alex, None),
                (&alex, Some("draft")),
                (&alex, Some("base")),
                (&blair, None),
            ]),
        )),
    );
    assert_eq!(refused.status, 409, "{:?}", refused.body);
    assert_eq!(refused.body["code"], "stale_configuration_preview");
}

#[test]
fn a_worker_holding_both_folded_answers_ends_with_the_survivor_once() {
    let fixture = Fixture::new();
    let alex = fixture.create_worker("Alex", json!([CASHIER, SALES]));
    let preview = fixture.preview(merged_attributes());
    let base = preview.body["base"].as_str().expect("a preview base");
    let saved = fixture.send(
        "PUT",
        "/api/attributes",
        Some(fixture.save_body(merged_attributes(), base, resolutions(&[(&alex, None)]))),
    );
    assert_eq!(saved.status, 200, "{:?}", saved.body);
    assert_eq!(
        fixture.worker(&fixture.dataset(), "Alex")["attributes"][JOB],
        json!([SALES])
    );
}
