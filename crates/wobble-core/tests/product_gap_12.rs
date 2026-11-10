//! Product gap 12: the read-only Configuration impact preview at its request boundary.
//!
//! Every scenario starts from the guide's synthetic fixture, drives the real routes, and
//! asserts the fixed preview contract: per-change and deduplicated totals, no writes, and
//! no consumed ids. Product gap 13 removes this slice's intermediate refusal of changed
//! shared sets.

use serde_json::{json, Value};
use wobble_core::db::{open_seeded, Db};
use wobble_core::handle::{Request, Response};
use wobble_core::id::{CounterId, IdSource};
use wobble_core::router::dispatch;
use wobble_core::worksite_persistence::resolve_active_worksite;

const HEADER: &str = "x-wobble-worksite";

const DEPARTMENT: &str = "pg12-department";
const ROLES: &str = "pg12-roles";
const SHIFTS: &str = "pg12-shifts";

const PACKING: &str = "pg12-packing";
const DELIVERY: &str = "pg12-delivery";
const NO_DEPARTMENT: &str = "pg12-no-department";
const TRAINER: &str = "pg12-trainer";
const STEWARD: &str = "pg12-steward";
const EQUIPMENT: &str = "pg12-equipment";
const SCHEDULE: &str = "pg12-schedule";
const ENGLISH: &str = "pg12-english";
const SPANISH: &str = "pg12-spanish";

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

struct Fixture {
    db: Db,
    ids: CounterId,
    worksite: String,
}

impl Fixture {
    fn new() -> Self {
        let ids = CounterId::new();
        let db = open_seeded(":memory:", &ids).expect("a seeded database");
        let worksite = resolve_active_worksite(db.conn(), None)
            .expect("the seeded worksite reads")
            .expect("a seeded worksite");

        let fixture = Fixture {
            db,
            ids,
            worksite: worksite.id,
        };

        let configured = fixture.send("PUT", "/api/attributes", Some(baseline_attributes()));
        assert_eq!(configured.status, 200, "{:?}", configured.body);

        let agitations = fixture.send("PUT", "/api/agitations", Some(baseline_agitations()));
        assert_eq!(agitations.status, 200, "{:?}", agitations.body);
        let languages = fixture.send("PUT", "/api/languages", Some(baseline_languages()));
        assert_eq!(languages.status, 200, "{:?}", languages.body);

        fixture.add_worker(
            "Alex",
            "Leader",
            PACKING,
            json!([TRAINER]),
            json!([ENGLISH]),
            json!([EQUIPMENT]),
        );
        fixture.add_worker(
            "Blair",
            "Supporter",
            DELIVERY,
            json!([TRAINER, STEWARD]),
            json!([SPANISH]),
            json!([SCHEDULE]),
        );
        fixture.add_worker(
            "Casey",
            "Unassessed",
            "",
            json!([]),
            json!([ENGLISH, SPANISH]),
            json!([EQUIPMENT]),
        );
        fixture.add_worker(
            "Drew",
            "Activist",
            NO_DEPARTMENT,
            json!([STEWARD]),
            json!([]),
            json!([]),
        );

        fixture
    }

    fn send(&self, method: &str, path: &str, body: Option<Value>) -> Response {
        dispatch(
            &self.db,
            &request(method, path, Some(&self.worksite), body),
            &self.ids,
        )
    }

    /// A preview must never need an id, so every preview runs with a source that panics.
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

    fn preview_as(&self, worksite: &str, body: Value) -> Response {
        dispatch(
            &self.db,
            &request(
                "POST",
                "/api/configuration/preview",
                Some(worksite),
                Some(body),
            ),
            &NoIds,
        )
    }

    fn add_worker(
        &self,
        name: &str,
        assessment: &str,
        department: &str,
        roles: Value,
        languages: Value,
        agitations: Value,
    ) {
        let response = self.send(
            "POST",
            "/api/workers",
            Some(json!({
                "name": name,
                "email": "",
                "phone": "",
                "assessment": assessment,
                "attributes": {
                    DEPARTMENT: department,
                    ROLES: roles,
                    SHIFTS: []
                },
                "agitations": agitations,
                "languages": languages,
                "relationships": [],
                "notes": []
            })),
        );
        assert_eq!(response.status, 201, "{name}: {:?}", response.body);
    }

    fn dataset(&self) -> Response {
        self.send("GET", "/api/dataset", None)
    }
}

fn answer(id: &str, value: &str) -> Value {
    json!({ "id": id, "value": value })
}

fn folded(id: &str, value: &str, into: &str) -> Value {
    json!({ "id": id, "value": value, "mergedInto": into })
}

fn department(kind: &str, options: Value) -> Value {
    json!({ "id": DEPARTMENT, "name": "Department", "kind": kind, "options": options })
}

fn roles(kind: &str, options: Value) -> Value {
    json!({ "id": ROLES, "name": "Roles", "kind": kind, "options": options })
}

fn shifts() -> Value {
    json!({ "id": SHIFTS, "name": "Shifts", "kind": "tag", "options": [] })
}

fn department_options() -> Value {
    json!([
        answer(PACKING, "Packing"),
        answer(DELIVERY, "Delivery"),
        answer(NO_DEPARTMENT, "No Department")
    ])
}

fn roles_options() -> Value {
    json!([answer(TRAINER, "Trainer"), answer(STEWARD, "Steward")])
}

fn baseline_attributes() -> Value {
    json!([
        department("category", department_options()),
        roles("tag", roles_options()),
        shifts()
    ])
}

fn baseline_agitations() -> Value {
    json!([
        { "id": EQUIPMENT, "text": "Equipment" },
        { "id": SCHEDULE, "text": "Schedule" }
    ])
}

fn baseline_languages() -> Value {
    json!([
        { "id": ENGLISH, "name": "English" },
        { "id": SPANISH, "name": "Spanish" }
    ])
}

fn proposal(attributes: Value, agitations: Value, languages: Value) -> Value {
    json!({
        "attributes": attributes,
        "agitations": agitations,
        "languages": languages
    })
}

fn baseline_proposal(attributes: Value) -> Value {
    proposal(attributes, baseline_agitations(), baseline_languages())
}

/// One explicit retained choice per lossy Worker surface: the fixture records the first
/// answer first, so that is the answer the conversion keeps. No Worker draft exists here.
fn cardinality_resolutions(preview: &Value) -> Value {
    let resolutions: Vec<Value> = preview["cardinality"]
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or_default()
        .iter()
        .map(|impact| {
            json!({
                "attributeId": impact["attributeId"],
                "holders": impact["holders"].as_array().expect("holders").iter().map(|holder| json!({
                    "workerId": holder["workerId"],
                    "surface": holder["surface"],
                    "retained": holder["held"][0]
                })).collect::<Vec<_>>()
            })
        })
        .collect();
    json!(resolutions)
}

/// The resolution-aware Save that carries the preview's base and its retained choices.
fn save_previewed(fixture: &Fixture, conversion: Value, preview: &Value) -> Response {
    fixture.send(
        "PUT",
        "/api/attributes",
        Some(json!({
            "attributes": conversion,
            "base": preview["base"],
            "resolutions": {
                "removedAnswers": [],
                "removedAttributes": [],
                "cardinality": cardinality_resolutions(preview)
            }
        })),
    )
}

fn change_for<'a>(body: &'a Value, id: &str) -> &'a Value {
    body["changes"]
        .as_array()
        .unwrap_or_else(|| panic!("changes is an array: {body}"))
        .iter()
        .find(|change| change["id"] == json!(id))
        .unwrap_or_else(|| panic!("a change for {id} in {body}"))
}

fn totals(body: &Value) -> (u64, u64, u64) {
    let totals = &body["totals"];
    (
        totals["affectedWorkers"].as_u64().expect("affectedWorkers"),
        totals["lossyWorkers"].as_u64().expect("lossyWorkers"),
        totals["discardedValues"].as_u64().expect("discardedValues"),
    )
}

fn assert_totals(body: &Value, affected: u64, lossy: u64, discarded: u64) {
    assert_eq!(
        totals(body),
        (affected, lossy, discarded),
        "totals in {body}"
    );
}

fn count(value: &Value, key: &str) -> u64 {
    value[key]
        .as_u64()
        .unwrap_or_else(|| panic!("{key} is a nonnegative integer in {value}"))
}

fn worker_attributes<'a>(dataset: &'a Value, name: &str) -> &'a Value {
    let worker = dataset["workers"]
        .as_array()
        .expect("workers is an array")
        .iter()
        .find(|worker| worker["name"] == json!(name))
        .unwrap_or_else(|| panic!("Worker {name} in {dataset}"));

    &worker["attributes"]
}

#[test]
fn product_gap_12_removing_department_reports_three_affected_lossy_and_discarded() {
    let fixture = Fixture::new();
    let response = fixture.preview(baseline_proposal(json!([
        roles("tag", roles_options()),
        shifts()
    ])));

    assert_eq!(response.status, 200, "{:?}", response.body);
    let change = change_for(&response.body, DEPARTMENT);
    assert_eq!(change["entity"], "attribute");
    assert_eq!(change["operation"], "remove");
    assert_eq!(count(change, "affectedWorkers"), 3);
    assert_eq!(count(change, "lossyWorkers"), 3);
    assert_eq!(count(change, "discardedValues"), 3);
    // Roles and Shifts did not change, so they contribute no change entry.
    assert_eq!(response.body["changes"].as_array().unwrap().len(), 1);
    assert_totals(&response.body, 3, 3, 3);
}

#[test]
fn product_gap_12_removing_packing_reports_one_affected_lossy_and_discarded() {
    let fixture = Fixture::new();
    let response = fixture.preview(baseline_proposal(json!([
        department(
            "category",
            json!([
                answer(DELIVERY, "Delivery"),
                answer(NO_DEPARTMENT, "No Department")
            ])
        ),
        roles("tag", roles_options()),
        shifts()
    ])));

    assert_eq!(response.status, 200, "{:?}", response.body);
    let change = change_for(&response.body, PACKING);
    assert_eq!(change["entity"], "answer");
    assert_eq!(change["attributeId"], DEPARTMENT);
    assert_eq!(change["operation"], "remove");
    assert_eq!(count(change, "affectedWorkers"), 1);
    assert_eq!(count(change, "lossyWorkers"), 1);
    assert_eq!(count(change, "discardedValues"), 1);
    assert_totals(&response.body, 1, 1, 1);
}

#[test]
fn product_gap_12_removing_trainer_reports_two_affected_lossy_and_discarded() {
    let fixture = Fixture::new();
    let response = fixture.preview(baseline_proposal(json!([
        department("category", department_options()),
        roles("tag", json!([answer(STEWARD, "Steward")])),
        shifts()
    ])));

    assert_eq!(response.status, 200, "{:?}", response.body);
    let change = change_for(&response.body, TRAINER);
    assert_eq!(change["entity"], "answer");
    assert_eq!(change["operation"], "remove");
    assert_eq!(count(change, "affectedWorkers"), 2);
    assert_eq!(count(change, "lossyWorkers"), 2);
    assert_eq!(count(change, "discardedValues"), 2);
    assert_totals(&response.body, 2, 2, 2);
}

#[test]
fn product_gap_12_converting_roles_to_single_select_reports_three_one_one() {
    let fixture = Fixture::new();
    let conversion = json!([
        department("category", department_options()),
        roles("category", roles_options()),
        shifts()
    ]);
    let response = fixture.preview(baseline_proposal(conversion.clone()));

    assert_eq!(response.status, 200, "{:?}", response.body);
    let change = change_for(&response.body, ROLES);
    assert_eq!(change["entity"], "attribute");
    assert_eq!(change["operation"], "convert");
    assert_eq!(count(change, "affectedWorkers"), 3);
    assert_eq!(count(change, "lossyWorkers"), 1);
    assert_eq!(count(change, "discardedValues"), 1);
    assert_totals(&response.body, 3, 1, 1);

    // The saved result agrees with the preview: each Worker keeps the answer their own
    // explicit resolution retained, and Casey stays empty.
    let saved = save_previewed(&fixture, conversion, &response.body);
    assert_eq!(saved.status, 200, "{:?}", saved.body);
    let dataset = fixture.dataset();
    assert_eq!(
        worker_attributes(&dataset.body, "Alex")[ROLES],
        json!(TRAINER)
    );
    assert_eq!(
        worker_attributes(&dataset.body, "Blair")[ROLES],
        json!(TRAINER)
    );
    assert_eq!(
        worker_attributes(&dataset.body, "Drew")[ROLES],
        json!(STEWARD)
    );
    assert_eq!(worker_attributes(&dataset.body, "Casey")[ROLES], json!(""));
}

#[test]
fn product_gap_12_reordering_the_options_does_not_change_which_answer_a_conversion_keeps() {
    let fixture = Fixture::new();
    // Steward is displayed first, yet Blair recorded Trainer first and keeps it.
    let conversion = json!([
        department("category", department_options()),
        roles(
            "category",
            json!([answer(STEWARD, "Steward"), answer(TRAINER, "Trainer")])
        ),
        shifts()
    ]);
    let response = fixture.preview(baseline_proposal(conversion.clone()));
    assert_eq!(response.status, 200, "{:?}", response.body);
    assert_totals(&response.body, 3, 1, 1);

    let saved = save_previewed(&fixture, conversion, &response.body);
    assert_eq!(saved.status, 200, "{:?}", saved.body);
    let dataset = fixture.dataset();
    assert_eq!(
        worker_attributes(&dataset.body, "Blair")[ROLES],
        json!(TRAINER)
    );
    assert_eq!(
        worker_attributes(&dataset.body, "Alex")[ROLES],
        json!(TRAINER)
    );
    assert_eq!(
        worker_attributes(&dataset.body, "Drew")[ROLES],
        json!(STEWARD)
    );
}

#[test]
fn product_gap_12_merging_trainer_into_steward_preserves_assignments_and_deduplicates() {
    let fixture = Fixture::new();
    let merge = json!([
        department("category", department_options()),
        roles(
            "tag",
            json!([
                folded(TRAINER, "Trainer", STEWARD),
                answer(STEWARD, "Steward")
            ])
        ),
        shifts()
    ]);
    let response = fixture.preview(baseline_proposal(merge.clone()));

    assert_eq!(response.status, 200, "{:?}", response.body);
    let change = change_for(&response.body, TRAINER);
    assert_eq!(change["entity"], "answer");
    assert_eq!(change["attributeId"], ROLES);
    assert_eq!(change["operation"], "merge");
    assert_eq!(change["survivorId"], STEWARD);
    assert_eq!(count(change, "affectedWorkers"), 2);
    assert_eq!(count(change, "lossyWorkers"), 0);
    assert_eq!(count(change, "discardedValues"), 0);
    assert_totals(&response.body, 2, 0, 0);

    let saved = fixture.send("PUT", "/api/attributes", Some(merge));
    assert_eq!(saved.status, 200, "{:?}", saved.body);
    let dataset = fixture.dataset();
    assert_eq!(
        worker_attributes(&dataset.body, "Blair")[ROLES],
        json!([STEWARD])
    );
    assert_eq!(
        worker_attributes(&dataset.body, "Alex")[ROLES],
        json!([STEWARD])
    );
    assert_eq!(
        worker_attributes(&dataset.body, "Drew")[ROLES],
        json!([STEWARD])
    );
}

#[test]
fn product_gap_12_a_removal_supersedes_a_staged_merge_and_deduplicates_totals() {
    let fixture = Fixture::new();
    // Removing Steward removes Trainer too (it was folded into Steward): the final state
    // is no Roles answers at all, and the original assignments are what is discarded.
    let response = fixture.preview(baseline_proposal(json!([
        department("category", department_options()),
        roles("tag", json!([])),
        shifts()
    ])));

    assert_eq!(response.status, 200, "{:?}", response.body);
    let changes = response.body["changes"].as_array().unwrap();
    assert_eq!(changes.len(), 2, "{:?}", response.body);
    assert!(
        changes
            .iter()
            .all(|change| change["operation"] == json!("remove")),
        "no merge survives the final removal: {:?}",
        response.body
    );
    assert_eq!(
        count(change_for(&response.body, TRAINER), "affectedWorkers"),
        2
    );
    assert_eq!(
        count(change_for(&response.body, STEWARD), "affectedWorkers"),
        2
    );
    assert_totals(&response.body, 3, 3, 4);
}

#[test]
fn product_gap_12_removing_an_unused_attribute_still_reports_the_definition_removal() {
    let fixture = Fixture::new();
    let response = fixture.preview(baseline_proposal(json!([
        department("category", department_options()),
        roles("tag", roles_options())
    ])));

    assert_eq!(response.status, 200, "{:?}", response.body);
    let changes = response.body["changes"].as_array().unwrap();
    assert_eq!(changes.len(), 1, "{:?}", response.body);
    let change = change_for(&response.body, SHIFTS);
    assert_eq!(change["entity"], "attribute");
    assert_eq!(change["operation"], "remove");
    assert_eq!(count(change, "affectedWorkers"), 0);
    assert_eq!(count(change, "lossyWorkers"), 0);
    assert_eq!(count(change, "discardedValues"), 0);
    assert_totals(&response.body, 0, 0, 0);
}

#[test]
fn product_gap_12_harmless_renames_produce_no_change_entry() {
    let fixture = Fixture::new();
    let response = fixture.preview(baseline_proposal(json!([
        json!({
            "id": DEPARTMENT,
            "name": "Team",
            "kind": "category",
            "options": [
                answer(PACKING, "Dispatch"),
                answer(DELIVERY, "Delivery"),
                answer(NO_DEPARTMENT, "No Department")
            ]
        }),
        json!({
            "id": ROLES,
            "name": "Responsibilities",
            "kind": "tag",
            "options": [answer(TRAINER, "Coach"), answer(STEWARD, "Steward")]
        }),
        shifts()
    ])));

    assert_eq!(response.status, 200, "{:?}", response.body);
    assert_eq!(response.body["changes"], json!([]));
    assert_totals(&response.body, 0, 0, 0);
}

#[test]
fn product_gap_12_preview_writes_nothing() {
    let fixture = Fixture::new();
    let before_dataset = fixture.dataset();
    let before_changes: i64 = fixture
        .db
        .conn()
        .query_row("SELECT total_changes()", [], |row| row.get(0))
        .unwrap();

    let response = fixture.preview(baseline_proposal(json!([
        roles("tag", roles_options()),
        shifts()
    ])));
    assert_eq!(response.status, 200, "{:?}", response.body);

    let after_dataset = fixture.dataset();
    assert_eq!(after_dataset.body, before_dataset.body);
    let after_changes: i64 = fixture
        .db
        .conn()
        .query_row("SELECT total_changes()", [], |row| row.get(0))
        .unwrap();
    assert_eq!(after_changes, before_changes);
}

#[test]
fn product_gap_12_requires_all_three_proposed_sets() {
    let fixture = Fixture::new();
    let before = fixture.dataset();

    for body in [
        json!({}),
        json!({ "attributes": baseline_attributes() }),
        json!({
            "attributes": baseline_attributes(),
            "agitations": baseline_agitations()
        }),
        json!({
            "attributes": baseline_attributes(),
            "languages": baseline_languages()
        }),
        json!([]),
    ] {
        let response = fixture.preview(body.clone());
        assert_eq!(response.status, 400, "{body}: {:?}", response.body);
        assert_eq!(
            response.body["code"], "invalid_configuration_preview",
            "{body}: {:?}",
            response.body
        );
        assert!(
            response.body.get("totals").is_none(),
            "a refused preview reports no zero totals: {body}"
        );
    }

    assert_eq!(fixture.dataset().body, before.body);
}

#[test]
fn product_gap_12_rejects_invalid_proposed_sets() {
    let fixture = Fixture::new();
    let before = fixture.dataset();

    let invalid = [
        // A pre-v14 answer: plain text instead of {id, value}.
        baseline_proposal(json!([
            department("category", json!(["Packing"])),
            roles("tag", roles_options()),
            shifts()
        ])),
        // A merge into an answer the Attribute does not keep.
        baseline_proposal(json!([
            department("category", department_options()),
            roles("tag", json!([folded(TRAINER, "Trainer", "gone")])),
            shifts()
        ])),
        proposal(
            baseline_attributes(),
            json!([{ "id": EQUIPMENT, "text": "   " }]),
            baseline_languages(),
        ),
        proposal(
            baseline_attributes(),
            baseline_agitations(),
            json!([{ "id": ENGLISH }]),
        ),
    ];

    for body in invalid {
        let response = fixture.preview(body.clone());
        assert_eq!(response.status, 400, "{body}: {:?}", response.body);
        assert_eq!(
            response.body["code"], "invalid_configuration_preview",
            "{body}: {:?}",
            response.body
        );
    }

    // Two Attributes with the same name have their own stable code, not the generic refusal.
    let repeated_name = fixture.preview(baseline_proposal(json!([
        department("category", department_options()),
        roles("tag", roles_options()),
        json!({ "id": SHIFTS, "name": "Department", "kind": "tag", "options": [] })
    ])));
    assert_eq!(repeated_name.status, 400, "{:?}", repeated_name.body);
    assert_eq!(
        repeated_name.body["code"], "configuration_attribute_name_exists",
        "{:?}",
        repeated_name.body
    );

    assert_eq!(fixture.dataset().body, before.body);
}

#[test]
fn product_gap_12_preview_is_scoped_to_the_named_active_worksite() {
    let fixture = Fixture::new();
    let created = fixture.send("POST", "/api/worksite", None);
    assert_eq!(created.status, 201, "{:?}", created.body);
    let second = created.body["worksite"]["id"]
        .as_str()
        .expect("the created worksite id")
        .to_owned();

    // The second Worksite has no Workers and its own seeded Attributes: removing all of
    // them costs nothing, even though the first Worksite's Department would lose answers.
    let response = fixture.preview_as(&second, proposal(json!([]), json!([]), json!([])));
    assert_eq!(response.status, 200, "{:?}", response.body);
    assert_totals(&response.body, 0, 0, 0);

    let changes = response.body["changes"].as_array().unwrap();
    assert_eq!(changes.len(), 3, "{:?}", response.body);
    assert!(
        changes
            .iter()
            .all(|change| change["id"] != json!(DEPARTMENT)),
        "the first Worksite's Attributes are not in scope: {:?}",
        response.body
    );
}
