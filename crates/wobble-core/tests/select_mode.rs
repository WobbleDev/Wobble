//! Per-value select modes (ADR 0043): every value with sub-values is Single-Select or
//! Multi-Select for its own sub-values; the Attribute governs the top level.
//!
//! Workers may hold several sub-values of a Multi-Select group inside a Single-Select
//! Attribute. Switching a value to Single-Select trims the Workers who hold several of its
//! branches, after the preview lists them and the Save acknowledges them.

mod common;

use common::http::{request, NoIds};
use serde_json::{json, Value};
use wobble_core::db::{open_seeded, Db};
use wobble_core::handle::Response;
use wobble_core::id::CounterId;
use wobble_core::router::dispatch;

const DEPT: &str = "dept";
const FOH: &str = "foh";
const SERVER: &str = "server";
const HOST: &str = "host";
const BUSSER: &str = "busser";
const BOH: &str = "boh";
const COOK: &str = "cook";

fn department(foh_mode: Option<&str>, kind: &str) -> Value {
    let mut foh = json!({ "id": FOH, "value": "Front of House" });
    if let Some(mode) = foh_mode {
        foh["mode"] = json!(mode);
    }
    json!({ "id": DEPT, "name": "Department", "kind": kind, "options": [
        foh,
        { "id": SERVER, "value": "Server", "parentId": FOH },
        { "id": HOST, "value": "Host", "parentId": FOH },
        { "id": BUSSER, "value": "Busser", "parentId": FOH },
        { "id": BOH, "value": "Back of House" },
        { "id": COOK, "value": "Cook", "parentId": BOH }
    ] })
}

fn worker_update(name: &str, attributes: Value) -> Value {
    json!({
        "name": name, "email": "", "phone": "", "assessment": "Unassessed",
        "attributes": attributes, "agitations": [], "languages": [], "relationships": [], "notes": []
    })
}

fn resolutions(mode_changes: Vec<Value>) -> Value {
    json!({ "removedAnswers": [], "removedAttributes": [], "cardinality": [], "attributeMoves": [], "modeChanges": mode_changes })
}

struct Fixture {
    db: Db,
    ids: CounterId,
    worksite: String,
}

impl Fixture {
    fn new(attributes: Value) -> Self {
        let ids = CounterId::new();
        let db = open_seeded(":memory:", &ids).expect("a seeded database");
        let worksite = dispatch(&db, &request("GET", "/api/worksite", None, None), &ids).body
            ["worksite"]["id"]
            .as_str()
            .expect("the seeded worksite id")
            .to_owned();
        let fixture = Self { db, ids, worksite };
        let configured = fixture.send("PUT", "/api/attributes", Some(attributes));
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

    fn create_worker(&self, name: &str, attributes: Value) -> String {
        let response = self.send(
            "POST",
            "/api/workers",
            Some(worker_update(name, attributes)),
        );
        assert_eq!(response.status, 201, "{:?}", response.body);
        response.body["worker"]["id"]
            .as_str()
            .expect("the created worker id")
            .to_owned()
    }

    fn save_draft(&self, worker_id: &str, update: Value, base: Option<Value>) {
        let response = self.send(
            "PUT",
            &format!("/api/worker-drafts/{worker_id}"),
            Some(json!({
                "update": update,
                "pendingNote": { "text": "keep me" },
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

    fn total_changes(&self) -> i64 {
        self.db
            .conn()
            .query_row("SELECT total_changes()", [], |row| row.get(0))
            .unwrap()
    }

    fn save(&self, attributes: Value, base: &str, resolutions: Value) -> Response {
        self.send(
            "PUT",
            "/api/attributes",
            Some(json!({
                "attributes": attributes,
                "base": base,
                "resolutions": resolutions
            })),
        )
    }
}

fn create_failure(fixture: &Fixture, attributes: Value) -> Response {
    fixture.send(
        "POST",
        "/api/workers",
        Some(worker_update("Bad", attributes)),
    )
}

fn extra_attributes(fixture: &Fixture, mut attributes: Value) -> Value {
    // The seeded Worksite carries other Attributes; every Worker body names all of them.
    let dataset = fixture.dataset();
    for attribute in dataset["attributes"].as_array().expect("attributes") {
        let id = attribute["id"].as_str().expect("id");
        if id != DEPT {
            attributes[id] = if attribute["kind"] == "tag" {
                json!([])
            } else {
                json!("")
            };
        }
    }
    attributes
}

#[test]
fn a_multi_group_in_a_single_select_attribute_holds_several_sub_values_as_a_list() {
    let fixture = Fixture::new(json!([department(Some("multi"), "category")]));
    let body = extra_attributes(&fixture, json!({ DEPT: [SERVER, HOST] }));
    let created = fixture.send("POST", "/api/workers", Some(worker_update("Alex", body)));
    assert_eq!(created.status, 201, "{:?}", created.body);

    let dataset = fixture.dataset();
    assert_eq!(
        fixture.worker(&dataset, "Alex")["attributes"][DEPT],
        json!([SERVER, HOST])
    );
    assert_eq!(attribute_mode(&dataset, FOH), json!("multi"));
}

fn attribute_mode(dataset: &Value, answer: &str) -> Value {
    dataset["attributes"][0]["options"]
        .as_array()
        .expect("options")
        .iter()
        .find(|candidate| candidate["id"] == json!(answer))
        .expect("the answer")["mode"]
        .clone()
}

#[test]
fn the_attribute_still_governs_the_top_level() {
    let fixture = Fixture::new(json!([department(Some("multi"), "category")]));
    let body = extra_attributes(&fixture, json!({ DEPT: [SERVER, COOK] }));
    assert_eq!(create_failure(&fixture, body).status, 400);
}

#[test]
fn a_single_group_refuses_two_branches_and_a_list_needs_a_multi_group() {
    let fixture = Fixture::new(json!([department(Some("single"), "tag")]));
    let two = extra_attributes(&fixture, json!({ DEPT: [SERVER, HOST] }));
    assert_eq!(create_failure(&fixture, two).status, 400);
    let one = extra_attributes(&fixture, json!({ DEPT: [FOH, SERVER, COOK] }));
    let created = fixture.send("POST", "/api/workers", Some(worker_update("Ok", one)));
    assert_eq!(created.status, 201, "{:?}", created.body);

    let plain = Fixture::new(json!([department(None, "category")]));
    let list = extra_attributes(&plain, json!({ DEPT: [SERVER] }));
    assert_eq!(
        create_failure(&plain, list).status,
        400,
        "a list needs a Multi-Select group"
    );
}

#[test]
fn switching_a_value_to_single_select_previews_and_needs_acknowledgement_then_keeps_the_first() {
    let fixture = Fixture::new(json!([department(Some("multi"), "category")]));
    let body = extra_attributes(&fixture, json!({ DEPT: [HOST, SERVER, BUSSER] }));
    let created = fixture.send("POST", "/api/workers", Some(worker_update("Alex", body)));
    assert_eq!(created.status, 201, "{:?}", created.body);
    let target = json!([department(Some("single"), "category")]);

    let before = fixture.total_changes();
    let preview = fixture.preview(target.clone());
    assert_eq!(preview.status, 200, "{:?}", preview.body);
    assert_eq!(
        fixture.total_changes(),
        before,
        "the preview writes nothing"
    );
    let impacts = preview.body["modeChanges"].as_array().expect("modeChanges");
    assert_eq!(impacts.len(), 1, "{impacts:?}");
    assert_eq!(impacts[0]["attributeId"], DEPT);
    let holder = &impacts[0]["holders"][0];
    assert_eq!(holder["surface"], "value");
    assert_eq!(holder["held"], json!([HOST, SERVER, BUSSER]));
    assert_eq!(
        holder["kept"],
        json!([SERVER]),
        "the first branch by item order"
    );
    assert_eq!(holder["dropped"], json!([HOST, BUSSER]));
    let change = preview.body["changes"]
        .as_array()
        .unwrap()
        .iter()
        .find(|change| change["operation"] == "selectMode")
        .expect("a selectMode change");
    assert_eq!(change["lossyWorkers"], 1);
    assert_eq!(change["discardedValues"], 2);
    let base = preview.body["base"].as_str().expect("base").to_owned();

    let refused = fixture.save(target.clone(), &base, resolutions(vec![]));
    assert_eq!(refused.status, 409, "{:?}", refused.body);
    assert_eq!(refused.body["code"], "configuration_resolution_required");
    let legacy = fixture.send("PUT", "/api/attributes", Some(target.clone()));
    assert_eq!(
        legacy.status, 409,
        "the array Save cannot trim silently: {:?}",
        legacy.body
    );

    let saved = fixture.save(
        target,
        &base,
        resolutions(vec![json!({ "attributeId": DEPT })]),
    );
    assert_eq!(saved.status, 200, "{:?}", saved.body);
    let dataset = fixture.dataset();
    assert_eq!(
        fixture.worker(&dataset, "Alex")["attributes"][DEPT],
        json!(SERVER),
        "a Single-Select Attribute with no Multi-Select group is a string again"
    );
}

#[test]
fn switching_to_multi_select_is_lossless_and_converts_the_stored_shape() {
    let fixture = Fixture::new(json!([department(None, "category")]));
    let body = extra_attributes(&fixture, json!({ DEPT: SERVER }));
    let created = fixture.send("POST", "/api/workers", Some(worker_update("Alex", body)));
    assert_eq!(created.status, 201, "{:?}", created.body);
    let target = json!([department(Some("multi"), "category")]);

    let preview = fixture.preview(target.clone());
    assert_eq!(preview.body["modeChanges"], json!([]));
    let base = preview.body["base"].as_str().expect("base").to_owned();
    let saved = fixture.save(target, &base, resolutions(vec![]));
    assert_eq!(saved.status, 200, "{:?}", saved.body);
    let dataset = fixture.dataset();
    assert_eq!(
        fixture.worker(&dataset, "Alex")["attributes"][DEPT],
        json!([SERVER])
    );
}

#[test]
fn an_unmoded_value_follows_the_attribute_and_a_childless_mode_is_not_kept() {
    let fixture = Fixture::new(json!([department(None, "tag")]));
    let body = extra_attributes(&fixture, json!({ DEPT: [SERVER, HOST, COOK] }));
    let created = fixture.send("POST", "/api/workers", Some(worker_update("Alex", body)));
    assert_eq!(created.status, 201, "{:?}", created.body);

    let mut childless = department(None, "tag");
    childless["options"][2]["mode"] = json!("multi");
    let preview = fixture.preview(json!([childless.clone()]));
    let base = preview.body["base"].as_str().expect("base").to_owned();
    let saved = fixture.save(json!([childless]), &base, resolutions(vec![]));
    assert_eq!(saved.status, 200, "{:?}", saved.body);
    let dataset = fixture.dataset();
    assert!(dataset["attributes"][0]["options"][2].get("mode").is_none());
}

#[test]
fn a_draft_holding_two_branches_follows_the_acknowledged_trim() {
    let fixture = Fixture::new(json!([department(Some("multi"), "category")]));
    let body = extra_attributes(&fixture, json!({ DEPT: [] }));
    let id = fixture.create_worker("Alex", body.clone());
    let held = extra_attributes(&fixture, json!({ DEPT: [HOST, BUSSER] }));
    fixture.save_draft(
        &id,
        worker_update("Alex", held),
        Some(worker_update("Alex", body)),
    );
    let target = json!([department(Some("single"), "category")]);
    let preview = fixture.preview(target.clone());
    let impacts = preview.body["modeChanges"].as_array().expect("modeChanges");
    assert_eq!(impacts[0]["holders"][0]["surface"], "draft");
    let base = preview.body["base"].as_str().expect("base").to_owned();
    let saved = fixture.save(
        target,
        &base,
        resolutions(vec![json!({ "attributeId": DEPT })]),
    );
    assert_eq!(saved.status, 200, "{:?}", saved.body);
    assert_eq!(
        fixture.draft(&id)["update"]["attributes"][DEPT],
        json!(HOST)
    );
}
