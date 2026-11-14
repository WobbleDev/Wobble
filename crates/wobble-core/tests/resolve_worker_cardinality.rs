//! Ticket 15: resolving a Worker-scoped Multi-Select to Single-Select change.
//!
//! Every test drives the real request boundary. The Configuration preview names each Worker
//! value, Worker draft update, and Worker draft base that holds several answers. Save carries
//! one retained answer or no-answer resolution per lossy surface, and the write is atomic. A preview
//! writes nothing and consumes no ids; an incomplete plan, a foreign retained answer and a
//! stale base are refused, and the reverse conversion stays lossless.

use serde_json::{json, Value};
use wobble_core::db::{open_seeded, Db};
use wobble_core::handle::{Request, Response};
use wobble_core::id::{CounterId, IdSource};
use wobble_core::router::dispatch;

const HEADER: &str = "x-wobble-worksite";

const SHIFT: &str = "shift";
const DEPARTMENT: &str = "department";
const TRAINER: &str = "trainer";
const STEWARD: &str = "steward";
const LEAD: &str = "lead";
const FRONT: &str = "front";
const BACK: &str = "back";

/// An id source that fails the test the moment a preview consumes one.
struct NoIds;

impl IdSource for NoIds {
    fn next_id(&self) -> String {
        panic!("the preview consumed an id");
    }
}

fn request(method: &str, path: &str, worksite: Option<&str>, body: Option<Value>) -> Request {
    let mut headers = vec![("content-type".to_owned(), "application/json".to_owned())];
    if let Some(worksite) = worksite {
        headers.push((HEADER.to_owned(), worksite.to_owned()));
    }
    Request {
        method: method.to_owned(),
        path: path.to_owned(),
        query: String::new(),
        headers,
        body: body.map(|body| body.to_string()),
    }
}

fn answer(id: &str, value: &str) -> Value {
    let short_form = if value.chars().count() <= 10 {
        value.to_owned()
    } else {
        format!("{}…", value.chars().take(9).collect::<String>())
    };
    json!({ "id": id, "value": value, "shortForm": short_form, "shortFormOrigin": "generated",
            "abbreviation": short_form, "abbreviationOrigin": "generated" })
}

fn worker_attribute(id: &str, name: &str, kind: &str, options: Value) -> Value {
    json!({
        "id": id,
        "name": name,
        "kind": kind,
        "options": options
    })
}

fn shift(kind: &str) -> Value {
    worker_attribute(
        SHIFT,
        "Shift",
        kind,
        json!([
            answer(TRAINER, "Trainer"),
            answer(STEWARD, "Steward"),
            answer(LEAD, "Lead")
        ]),
    )
}

fn department() -> Value {
    worker_attribute(
        DEPARTMENT,
        "Department",
        "category",
        json!([answer(FRONT, "Front"), answer(BACK, "Back")]),
    )
}

/// Shift starts as Multi-Select; the proposal below turns it into Single-Select.
fn tagged_attributes() -> Value {
    json!([shift("tag"), department()])
}

fn single_select_attributes() -> Value {
    json!([shift("category"), department()])
}

fn proposal(attributes: Value) -> Value {
    json!({
        "attributes": attributes,
        "agitations": [],
        "languages": []
    })
}

fn worker_draft_body(
    name: &str,
    department: &str,
    shift_update: Value,
    shift_base: Value,
) -> Value {
    json!({
        "update": {
            "name": name,
            "email": "alex@example.com",
            "phone": "",
            "assessment": "Unassessed",
            "attributes": { SHIFT: shift_update, DEPARTMENT: department },
            "agitations": [],
            "languages": [],
            "relationships": [],
            "notes": []
        },
        "pendingNote": { "text": "keep this note" },
        "base": {
            "name": name,
            "email": "alex@example.com",
            "phone": "",
            "assessment": "Unassessed",
            "attributes": { SHIFT: shift_base, DEPARTMENT: department },
            "agitations": [],
            "languages": [],
            "relationships": [],
            "notes": []
        }
    })
}

struct Fixture {
    db: Db,
    ids: CounterId,
    worksite: String,
}

impl Fixture {
    fn new(configuration: Value) -> Self {
        let ids = CounterId::new();
        let db = open_seeded(":memory:", &ids).expect("a seeded database");
        let worksite = dispatch(&db, &request("GET", "/api/worksite", None, None), &ids).body
            ["worksite"]["id"]
            .as_str()
            .expect("the seeded worksite id")
            .to_owned();
        let fixture = Self { db, ids, worksite };
        let configured = fixture.send("PUT", "/api/attributes", Some(configuration));
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

    fn preview(&self, body: Value) -> Response {
        dispatch(
            &self.db,
            &request(
                "POST",
                "/api/configuration/preview",
                Some(&self.worksite),
                Some(body),
            ),
            &NoIds,
        )
    }

    fn preview_attributes(&self, attributes: Value) -> Response {
        self.preview(proposal(attributes))
    }

    fn create_worker(&self, name: &str, attributes: Value) -> String {
        let response = self.send(
            "POST",
            "/api/workers",
            Some(json!({
                "name": name,
                "email": "",
                "phone": "",
                "assessment": "Unassessed",
                "attributes": attributes,
                "agitations": [],
                "languages": [],
                "relationships": [],
                "notes": []
            })),
        );
        assert_eq!(response.status, 201, "{:?}", response.body);
        response.body["worker"]["id"]
            .as_str()
            .expect("the created worker id")
            .to_owned()
    }

    fn save_worker_draft(&self, worker_id: &str, body: Value) {
        let response = self.send(
            "PUT",
            &format!("/api/worker-drafts/{worker_id}"),
            Some(body),
        );
        assert_eq!(response.status, 200, "{:?}", response.body);
    }

    fn worker_draft(&self, worker_id: &str) -> Value {
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

    fn attribute<'a>(&self, dataset: &'a Value, id: &str) -> &'a Value {
        dataset["attributes"]
            .as_array()
            .expect("attributes")
            .iter()
            .find(|attribute| attribute["id"] == json!(id))
            .unwrap_or_else(|| panic!("the Attribute {id}"))
    }

    fn total_changes(&self) -> i64 {
        self.db
            .conn()
            .query_row("SELECT total_changes()", [], |row| row.get(0))
            .unwrap()
    }
}

fn cardinality_impact<'a>(body: &'a Value, attribute_id: &str) -> &'a Value {
    body["cardinality"]
        .as_array()
        .unwrap_or_else(|| panic!("cardinality is an array: {body}"))
        .iter()
        .find(|impact| impact["attributeId"] == json!(attribute_id))
        .unwrap_or_else(|| panic!("a cardinality impact for {attribute_id} in {body}"))
}

fn surface<'a>(impact: &'a Value, worker_id: &str, surface: &str) -> &'a Value {
    impact["holders"]
        .as_array()
        .expect("holders")
        .iter()
        .find(|holder| {
            holder["workerId"] == json!(worker_id) && holder["surface"] == json!(surface)
        })
        .unwrap_or_else(|| panic!("the {surface} surface of {worker_id} in {impact}"))
}

fn resolution(attribute_id: &str, holders: Value) -> Value {
    json!({ "attributeId": attribute_id, "holders": holders })
}

fn save_body(attributes: Value, base: &str, cardinality: Value) -> Value {
    json!({
        "attributes": attributes,
        "base": base,
        "resolutions": {
            "removedAnswers": [],
            "removedAttributes": [],
            "cardinality": cardinality
        }
    })
}

/// The F15-Shift fixture: Alex's saved value is Trainer/Steward, draft update is Trainer/Lead,
/// and draft base is Steward/Lead. Blair holds Steward alone and Casey holds nothing.
struct LossyFixture {
    fixture: Fixture,
    alex: String,
    blair: String,
    casey: String,
}

fn lossy_fixture() -> LossyFixture {
    let fixture = Fixture::new(tagged_attributes());
    let alex = fixture.create_worker(
        "Alex",
        json!({ SHIFT: [TRAINER, STEWARD], DEPARTMENT: FRONT }),
    );
    fixture.save_worker_draft(
        &alex,
        worker_draft_body(
            "Alex",
            FRONT,
            json!([TRAINER, LEAD]),
            json!([STEWARD, LEAD]),
        ),
    );
    let blair = fixture.create_worker("Blair", json!({ SHIFT: [STEWARD], DEPARTMENT: BACK }));
    let casey = fixture.create_worker("Casey", json!({ SHIFT: [], DEPARTMENT: "" }));
    LossyFixture {
        fixture,
        alex,
        blair,
        casey,
    }
}

#[test]
fn preview_names_all_lossy_surfaces_and_writes_nothing() {
    let LossyFixture {
        fixture,
        alex,
        blair,
        casey,
    } = lossy_fixture();
    let before_dataset = fixture.dataset();
    let before_changes = fixture.total_changes();

    let preview = fixture.preview_attributes(single_select_attributes());
    assert_eq!(preview.status, 200, "{:?}", preview.body);
    assert_eq!(preview.body["cardinality"].as_array().unwrap().len(), 1);

    let impact = cardinality_impact(&preview.body, SHIFT);
    assert_eq!(impact["from"], "tag");
    assert_eq!(impact["to"], "category");
    assert_eq!(impact["holders"].as_array().unwrap().len(), 3);

    let value_surface = surface(impact, &alex, "value");
    assert_eq!(value_surface["held"], json!([TRAINER, STEWARD]));
    assert_eq!(value_surface["hasDraft"], json!(true));
    assert_eq!(value_surface["workerName"], "Alex");

    let draft_surface = surface(impact, &alex, "draft");
    assert_eq!(draft_surface["held"], json!([TRAINER, LEAD]));
    let base_surface = surface(impact, &alex, "base");
    assert_eq!(base_surface["held"], json!([STEWARD, LEAD]));

    // Blair and Casey hold at most one answer on each surface, so they need no choice.
    assert!(impact["holders"]
        .as_array()
        .unwrap()
        .iter()
        .all(|holder| holder["workerId"] == json!(alex)));

    // Alex's Steward and Lead are the answers the conversion would discard; the saved value
    // and the unfinished draft are counted once each.
    let change = preview.body["changes"]
        .as_array()
        .unwrap()
        .iter()
        .find(|change| change["id"] == json!(SHIFT))
        .expect("the Shift conversion row");
    assert_eq!(change["operation"], "convert");
    assert_eq!(change["affectedWorkers"], json!(2));
    assert_eq!(change["lossyWorkers"], json!(1));
    assert_eq!(change["discardedValues"], json!(2));
    assert_eq!(preview.body["totals"]["affectedWorkers"], json!(2));
    assert_eq!(preview.body["totals"]["lossyWorkers"], json!(1));
    assert_eq!(preview.body["totals"]["discardedValues"], json!(2));
    assert_eq!(preview.body["totals"]["affectedDrafts"], json!(1));

    // The preview is an observation: no stored row, value or draft changed.
    assert_eq!(fixture.dataset(), before_dataset);
    assert_eq!(fixture.total_changes(), before_changes);
    let _ = (blair, casey);
}

#[test]
fn an_incomplete_or_invalid_choice_is_refused_without_writing() {
    let LossyFixture { fixture, alex, .. } = lossy_fixture();
    let before = fixture.dataset();
    let preview = fixture.preview_attributes(single_select_attributes());
    let base = preview.body["base"]
        .as_str()
        .expect("a preview base")
        .to_owned();

    // No resolution at all: the plan is incomplete.
    let missing = fixture.send(
        "PUT",
        "/api/attributes",
        Some(save_body(single_select_attributes(), &base, json!([]))),
    );
    assert_eq!(missing.status, 409, "{:?}", missing.body);
    assert_eq!(missing.body["code"], "configuration_resolution_required");
    assert_eq!(fixture.dataset(), before);

    // Only the saved value and draft update are resolved; the draft base is still missing.
    let partial = json!([resolution(
        SHIFT,
        json!([
            { "workerId": alex, "surface": "value", "retained": STEWARD },
            { "workerId": alex, "surface": "draft", "retained": LEAD }
        ])
    )]);
    let missing_draft = fixture.send(
        "PUT",
        "/api/attributes",
        Some(save_body(single_select_attributes(), &base, partial)),
    );
    assert_eq!(missing_draft.status, 409, "{:?}", missing_draft.body);
    assert_eq!(
        missing_draft.body["code"],
        "configuration_resolution_required"
    );
    assert_eq!(fixture.dataset(), before);

    // A retained answer the saved value does not hold is not a choice.
    let foreign = json!([resolution(
        SHIFT,
        json!([
            { "workerId": alex, "surface": "value", "retained": LEAD },
            { "workerId": alex, "surface": "draft", "retained": LEAD },
            { "workerId": alex, "surface": "base", "retained": LEAD }
        ])
    )]);
    let invalid = fixture.send(
        "PUT",
        "/api/attributes",
        Some(save_body(single_select_attributes(), &base, foreign)),
    );
    assert_eq!(invalid.status, 400, "{:?}", invalid.body);
    assert_eq!(invalid.body["code"], "configuration_replacement_invalid");

    // A choice for a surface that holds only one answer is not a lossy holder either.
    let not_lossy = json!([resolution(
        SHIFT,
        json!([{ "workerId": alex, "surface": "value", "retained": STEWARD }])
    )]);
    let unknown_surface = fixture.send(
        "PUT",
        "/api/attributes",
        Some(save_body(
            single_select_attributes(),
            &base,
            json!([resolution(
                SHIFT,
                json!([{ "workerId": alex, "surface": "elsewhere", "retained": STEWARD }])
            )]),
        )),
    );
    assert_eq!(unknown_surface.status, 400, "{:?}", unknown_surface.body);
    assert_eq!(
        unknown_surface.body["code"],
        "configuration_replacement_invalid"
    );
    let _ = not_lossy;
    assert_eq!(fixture.dataset(), before);
}

#[test]
fn the_chosen_answers_are_saved_atomically_and_unrelated_data_is_preserved() {
    let LossyFixture {
        fixture,
        alex,
        blair,
        casey,
    } = lossy_fixture();
    let preview = fixture.preview_attributes(single_select_attributes());
    let base = preview.body["base"]
        .as_str()
        .expect("a preview base")
        .to_owned();

    let choices = json!([resolution(
        SHIFT,
        json!([
            { "workerId": alex, "surface": "value", "retained": STEWARD },
            { "workerId": alex, "surface": "draft", "retained": TRAINER },
            { "workerId": alex, "surface": "base", "retained": LEAD }
        ])
    )]);
    let saved = fixture.send(
        "PUT",
        "/api/attributes",
        Some(save_body(single_select_attributes(), &base, choices)),
    );
    assert_eq!(saved.status, 200, "{:?}", saved.body);

    let dataset = fixture.dataset();
    // The chosen retained answers replace the first-survivor shortcut.
    assert_eq!(
        fixture.worker(&dataset, "Alex")["attributes"],
        json!({ SHIFT: STEWARD, DEPARTMENT: FRONT })
    );
    assert_eq!(
        fixture.worker(&dataset, "Blair")["attributes"],
        json!({ SHIFT: STEWARD, DEPARTMENT: BACK })
    );
    assert_eq!(
        fixture.worker(&dataset, "Casey")["attributes"],
        json!({ SHIFT: "", DEPARTMENT: "" })
    );

    // The draft keeps its contact input and pending note; update and base use their separate
    // explicit choices.
    let draft = fixture.worker_draft(&alex);
    assert_eq!(draft["update"]["name"], "Alex");
    assert_eq!(draft["update"]["email"], "alex@example.com");
    assert_eq!(draft["pendingNote"]["text"], "keep this note");
    assert_eq!(
        draft["update"]["attributes"],
        json!({ SHIFT: TRAINER, DEPARTMENT: FRONT })
    );
    assert_eq!(
        draft["base"]["attributes"],
        json!({ SHIFT: LEAD, DEPARTMENT: FRONT })
    );

    // The Attribute keeps every answer id, label and order; only its cardinality changed.
    let shift_definition = fixture.attribute(&dataset, SHIFT);
    assert_eq!(shift_definition["kind"], "category");
    assert_eq!(
        shift_definition["options"],
        json!([
            answer(TRAINER, "Trainer"),
            answer(STEWARD, "Steward"),
            answer(LEAD, "Lead")
        ])
    );

    // The Save is one transaction: the Worker values and the draft moved together.
    let after = fixture.dataset();
    assert_eq!(
        fixture.worker(&after, "Blair")["attributes"],
        json!({ SHIFT: STEWARD, DEPARTMENT: BACK })
    );
    let _ = (blair, casey);
}

#[test]
fn a_no_answer_choice_is_explicit_without_touching_other_answers() {
    let LossyFixture { fixture, alex, .. } = lossy_fixture();
    let preview = fixture.preview_attributes(single_select_attributes());
    let base = preview.body["base"]
        .as_str()
        .expect("a preview base")
        .to_owned();

    let choices = json!([resolution(
        SHIFT,
        json!([
            { "workerId": alex, "surface": "value", "retained": null },
            { "workerId": alex, "surface": "draft", "retained": null },
            { "workerId": alex, "surface": "base", "retained": null }
        ])
    )]);
    let saved = fixture.send(
        "PUT",
        "/api/attributes",
        Some(save_body(single_select_attributes(), &base, choices)),
    );
    assert_eq!(saved.status, 200, "{:?}", saved.body);

    let dataset = fixture.dataset();
    assert_eq!(
        fixture.worker(&dataset, "Alex")["attributes"],
        json!({ SHIFT: "", DEPARTMENT: FRONT })
    );
    let draft = fixture.worker_draft(&alex);
    assert_eq!(
        draft["update"]["attributes"],
        json!({ SHIFT: "", DEPARTMENT: FRONT })
    );
    assert_eq!(
        draft["base"]["attributes"],
        json!({ SHIFT: "", DEPARTMENT: FRONT })
    );
    assert_eq!(draft["update"]["email"], "alex@example.com");
}

#[test]
fn single_select_to_multi_select_is_lossless_and_needs_no_resolution() {
    let fixture = Fixture::new(single_select_attributes());
    let alex = fixture.create_worker("Alex", json!({ SHIFT: TRAINER, DEPARTMENT: FRONT }));
    fixture.save_worker_draft(
        &alex,
        worker_draft_body("Alex", FRONT, json!(LEAD), json!(TRAINER)),
    );

    let preview = fixture.preview_attributes(tagged_attributes());
    assert_eq!(preview.status, 200, "{:?}", preview.body);
    assert_eq!(preview.body["cardinality"], json!([]));
    assert_eq!(preview.body["totals"]["lossyWorkers"], json!(0));
    assert_eq!(preview.body["totals"]["discardedValues"], json!(0));

    // The legacy array Save is lossless here, so it needs no resolutions.
    let saved = fixture.send("PUT", "/api/attributes", Some(tagged_attributes()));
    assert_eq!(saved.status, 200, "{:?}", saved.body);

    let dataset = fixture.dataset();
    assert_eq!(
        fixture.worker(&dataset, "Alex")["attributes"],
        json!({ SHIFT: [TRAINER], DEPARTMENT: FRONT })
    );
    let draft = fixture.worker_draft(&alex);
    assert_eq!(
        draft["update"]["attributes"],
        json!({ SHIFT: [LEAD], DEPARTMENT: FRONT })
    );
    assert_eq!(
        draft["base"]["attributes"],
        json!({ SHIFT: [TRAINER], DEPARTMENT: FRONT })
    );
}

#[test]
fn the_legacy_array_save_refuses_a_lossy_conversion() {
    let LossyFixture { fixture, .. } = lossy_fixture();
    let before = fixture.dataset();

    let refused = fixture.send("PUT", "/api/attributes", Some(single_select_attributes()));
    assert_eq!(refused.status, 409, "{:?}", refused.body);
    assert_eq!(refused.body["code"], "configuration_resolution_required");
    assert_eq!(fixture.dataset(), before);
}

#[test]
fn a_worker_value_change_after_the_preview_is_refused_as_stale() {
    let LossyFixture { fixture, alex, .. } = lossy_fixture();
    let preview = fixture.preview_attributes(single_select_attributes());
    let base = preview.body["base"]
        .as_str()
        .expect("a preview base")
        .to_owned();
    let choices = json!([resolution(
        SHIFT,
        json!([
            { "workerId": alex, "surface": "value", "retained": STEWARD },
            { "workerId": alex, "surface": "draft", "retained": LEAD },
            { "workerId": alex, "surface": "base", "retained": LEAD }
        ])
    )]);

    // A Worker value edit lands between the preview and the confirmation.
    let changed = fixture.send(
        "PATCH",
        &format!("/api/workers/{alex}"),
        Some(json!({ "attributeId": SHIFT, "value": [TRAINER] })),
    );
    assert_eq!(changed.status, 200, "{:?}", changed.body);
    let before = fixture.dataset();

    let stale = fixture.send(
        "PUT",
        "/api/attributes",
        Some(save_body(single_select_attributes(), &base, choices)),
    );
    assert_eq!(stale.status, 409, "{:?}", stale.body);
    assert_eq!(stale.body["code"], "stale_configuration_preview");
    assert_eq!(fixture.dataset(), before);
}

#[test]
fn a_worker_draft_change_after_the_preview_is_refused_as_stale() {
    let LossyFixture { fixture, alex, .. } = lossy_fixture();
    let preview = fixture.preview_attributes(single_select_attributes());
    let base = preview.body["base"]
        .as_str()
        .expect("a preview base")
        .to_owned();
    let choices = json!([resolution(
        SHIFT,
        json!([
            { "workerId": alex, "surface": "value", "retained": STEWARD },
            { "workerId": alex, "surface": "draft", "retained": LEAD },
            { "workerId": alex, "surface": "base", "retained": LEAD }
        ])
    )]);

    // Another editor rewrites the same draft's unfinished answers after the preview.
    fixture.save_worker_draft(
        &alex,
        worker_draft_body(
            "Alex",
            FRONT,
            json!([STEWARD, LEAD]),
            json!([TRAINER, STEWARD]),
        ),
    );
    let before = fixture.dataset();
    let before_draft = fixture.worker_draft(&alex);

    let stale = fixture.send(
        "PUT",
        "/api/attributes",
        Some(save_body(single_select_attributes(), &base, choices)),
    );
    assert_eq!(stale.status, 409, "{:?}", stale.body);
    assert_eq!(stale.body["code"], "stale_configuration_preview");
    assert_eq!(fixture.dataset(), before);
    assert_eq!(fixture.worker_draft(&alex), before_draft);
}
