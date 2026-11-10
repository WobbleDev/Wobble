//! Product gap 13: the read-only Configuration preview over shared Agitations and
//! Languages, and over drafts that change both the Attribute and shared sets.
//!
//! Every scenario starts from the guide's synthetic fixture, drives the real routes, and
//! asserts the fixed preview contract: per-change and deduplicated totals, no writes, no
//! consumed ids, and the same reconciliation the Save applies.

use serde_json::{json, Value};
use wobble_core::db::{open_seeded, Db};
use wobble_core::handle::{Request, Response};
use wobble_core::id::{CounterId, IdSource};
use wobble_core::router::dispatch;
use wobble_core::worksite_persistence::resolve_active_worksite;

const HEADER: &str = "x-wobble-worksite";

const DEPARTMENT: &str = "pg13-department";
const ROLES: &str = "pg13-roles";
const SHIFTS: &str = "pg13-shifts";

const PACKING: &str = "pg13-packing";
const DELIVERY: &str = "pg13-delivery";
const NO_DEPARTMENT: &str = "pg13-no-department";
const TRAINER: &str = "pg13-trainer";
const STEWARD: &str = "pg13-steward";
const EQUIPMENT: &str = "pg13-equipment";
const SCHEDULE: &str = "pg13-schedule";
const ENGLISH: &str = "pg13-english";
const SPANISH: &str = "pg13-spanish";

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

fn agitation(id: &str, text: &str) -> Value {
    json!({ "id": id, "text": text })
}

fn language(id: &str, name: &str) -> Value {
    json!({ "id": id, "name": name })
}

fn baseline_agitations() -> Value {
    json!([
        agitation(EQUIPMENT, "Equipment"),
        agitation(SCHEDULE, "Schedule")
    ])
}

fn baseline_languages() -> Value {
    json!([language(ENGLISH, "English"), language(SPANISH, "Spanish")])
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

fn worker<'a>(dataset: &'a Value, name: &str) -> &'a Value {
    dataset["workers"]
        .as_array()
        .expect("workers is an array")
        .iter()
        .find(|worker| worker["name"] == json!(name))
        .unwrap_or_else(|| panic!("Worker {name} in {dataset}"))
}

#[test]
fn product_gap_13_removing_equipment_reports_two_affected_lossy_and_discarded() {
    let fixture = Fixture::new();
    let response = fixture.preview(proposal(
        baseline_attributes(),
        json!([agitation(SCHEDULE, "Schedule")]),
        baseline_languages(),
    ));

    assert_eq!(response.status, 200, "{:?}", response.body);
    let change = change_for(&response.body, EQUIPMENT);
    assert_eq!(change["entity"], "agitation");
    assert_eq!(change["operation"], "remove");
    assert_eq!(count(change, "affectedWorkers"), 2);
    assert_eq!(count(change, "lossyWorkers"), 2);
    assert_eq!(count(change, "discardedValues"), 2);
    assert!(change.get("attributeId").is_none());
    assert!(change.get("survivorId").is_none());
    // Only Equipment was removed; the Languages and Attributes contribute no change entry.
    assert_eq!(response.body["changes"].as_array().unwrap().len(), 1);
    assert_totals(&response.body, 2, 2, 2);
}

#[test]
fn product_gap_13_removing_spanish_reports_blair_and_casey_once_each() {
    let fixture = Fixture::new();
    let response = fixture.preview(proposal(
        baseline_attributes(),
        baseline_agitations(),
        json!([language(ENGLISH, "English")]),
    ));

    assert_eq!(response.status, 200, "{:?}", response.body);
    let change = change_for(&response.body, SPANISH);
    assert_eq!(change["entity"], "language");
    assert_eq!(change["operation"], "remove");
    assert_eq!(count(change, "affectedWorkers"), 2);
    assert_eq!(count(change, "lossyWorkers"), 2);
    assert_eq!(count(change, "discardedValues"), 2);
    assert_eq!(response.body["changes"].as_array().unwrap().len(), 1);
    assert_totals(&response.body, 2, 2, 2);
}

#[test]
fn product_gap_13_shared_renames_produce_no_change_and_keep_ids_and_holders() {
    let fixture = Fixture::new();
    let before = fixture.dataset();
    let renamed = proposal(
        baseline_attributes(),
        json!([agitation(EQUIPMENT, "Kit"), agitation(SCHEDULE, "Schedule")]),
        json!([language(ENGLISH, "Anglais"), language(SPANISH, "Spanish")]),
    );

    let response = fixture.preview(renamed.clone());
    assert_eq!(response.status, 200, "{:?}", response.body);
    assert_eq!(response.body["changes"], json!([]));
    assert_totals(&response.body, 0, 0, 0);

    let saved = fixture.send(
        "PUT",
        "/api/agitations",
        Some(renamed["agitations"].clone()),
    );
    assert_eq!(saved.status, 200, "{:?}", saved.body);
    let saved = fixture.send("PUT", "/api/languages", Some(renamed["languages"].clone()));
    assert_eq!(saved.status, 200, "{:?}", saved.body);

    let after = fixture.dataset();
    assert_eq!(
        after.body["agitations"],
        json!([agitation(EQUIPMENT, "Kit"), agitation(SCHEDULE, "Schedule")])
    );
    assert_eq!(
        after.body["languages"],
        json!([language(ENGLISH, "Anglais"), language(SPANISH, "Spanish")])
    );
    for name in ["Alex", "Blair", "Casey", "Drew"] {
        assert_eq!(
            worker(&after.body, name)["agitations"],
            worker(&before.body, name)["agitations"],
            "{name}'s Agitations"
        );
        assert_eq!(
            worker(&after.body, name)["languages"],
            worker(&before.body, name)["languages"],
            "{name}'s Languages"
        );
    }
}

#[test]
fn product_gap_13_merging_english_into_spanish_preserves_holders_and_deduplicates() {
    let fixture = Fixture::new();
    let merge = proposal(
        baseline_attributes(),
        baseline_agitations(),
        json!([
            { "id": ENGLISH, "name": "English", "mergedInto": SPANISH },
            language(SPANISH, "Spanish")
        ]),
    );
    let response = fixture.preview(merge.clone());

    assert_eq!(response.status, 200, "{:?}", response.body);
    let change = change_for(&response.body, ENGLISH);
    assert_eq!(change["entity"], "language");
    assert_eq!(change["operation"], "merge");
    assert_eq!(change["survivorId"], SPANISH);
    assert_eq!(count(change, "affectedWorkers"), 2);
    assert_eq!(count(change, "lossyWorkers"), 0);
    assert_eq!(count(change, "discardedValues"), 0);
    assert_eq!(response.body["changes"].as_array().unwrap().len(), 1);
    assert_totals(&response.body, 2, 0, 0);

    let saved = fixture.send("PUT", "/api/languages", Some(merge["languages"].clone()));
    assert_eq!(saved.status, 200, "{:?}", saved.body);
    let after = fixture.dataset();
    assert_eq!(
        after.body["languages"],
        json!([language(SPANISH, "Spanish")])
    );
    // Casey held both, and now holds the survivor once; every original holder is preserved.
    assert_eq!(worker(&after.body, "Alex")["languages"], json!([SPANISH]));
    assert_eq!(worker(&after.body, "Blair")["languages"], json!([SPANISH]));
    assert_eq!(worker(&after.body, "Casey")["languages"], json!([SPANISH]));
    assert_eq!(worker(&after.body, "Drew")["languages"], json!([]));
}

#[test]
fn product_gap_13_mixed_removals_deduplicate_workers_and_count_each_lost_assignment() {
    let fixture = Fixture::new();
    let response = fixture.preview(proposal(
        json!([
            department(
                "category",
                json!([
                    answer(DELIVERY, "Delivery"),
                    answer(NO_DEPARTMENT, "No Department")
                ])
            ),
            roles("tag", roles_options()),
            shifts()
        ]),
        json!([agitation(SCHEDULE, "Schedule")]),
        baseline_languages(),
    ));

    assert_eq!(response.status, 200, "{:?}", response.body);
    let equipment = change_for(&response.body, EQUIPMENT);
    assert_eq!(equipment["entity"], "agitation");
    assert_eq!(count(equipment, "affectedWorkers"), 2);
    assert_eq!(count(equipment, "discardedValues"), 2);
    let packing = change_for(&response.body, PACKING);
    assert_eq!(packing["entity"], "answer");
    assert_eq!(count(packing, "affectedWorkers"), 1);
    assert_eq!(count(packing, "discardedValues"), 1);
    // Alex is affected by both removals and counts once overall; each of the three saved
    // assignments is a distinct discarded value.
    assert_totals(&response.body, 2, 2, 3);
}

#[test]
fn product_gap_13_merging_trainer_then_removing_steward_reports_the_final_effect() {
    let fixture = Fixture::new();
    let merge = baseline_proposal(json!([
        department("category", department_options()),
        roles(
            "tag",
            json!([
                folded(TRAINER, "Trainer", STEWARD),
                answer(STEWARD, "Steward")
            ])
        ),
        shifts()
    ]));
    let staged = fixture.preview(merge);
    assert_eq!(staged.status, 200, "{:?}", staged.body);
    assert_totals(&staged.body, 2, 0, 0);

    // Removing the survivor removes what was folded into it, so the final state is no
    // Roles answers at all: both removals are reported and the staged merge is gone.
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
fn product_gap_13_merging_a_shared_value_then_removing_the_survivor_reports_the_final_effect() {
    let fixture = Fixture::new();
    let merge = proposal(
        baseline_attributes(),
        baseline_agitations(),
        json!([
            { "id": ENGLISH, "name": "English", "mergedInto": SPANISH },
            language(SPANISH, "Spanish")
        ]),
    );
    let staged = fixture.preview(merge);
    assert_eq!(staged.status, 200, "{:?}", staged.body);
    assert_totals(&staged.body, 2, 0, 0);

    let response = fixture.preview(proposal(
        baseline_attributes(),
        baseline_agitations(),
        json!([]),
    ));

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
        count(change_for(&response.body, ENGLISH), "affectedWorkers"),
        2
    );
    assert_eq!(
        count(change_for(&response.body, SPANISH), "affectedWorkers"),
        2
    );
    // Casey held both Languages, so the four original assignments are discarded across
    // three Workers: the same final-effect shape as the Attribute merge-then-remove.
    assert_totals(&response.body, 3, 3, 4);
}

#[test]
fn product_gap_13_removing_an_unused_shared_value_reports_the_definition_removal() {
    let fixture = Fixture::new();
    let unused = "pg13-unused";
    let saved = fixture.send(
        "PUT",
        "/api/agitations",
        Some(json!([
            agitation(EQUIPMENT, "Equipment"),
            agitation(SCHEDULE, "Schedule"),
            agitation(unused, "Unused")
        ])),
    );
    assert_eq!(saved.status, 200, "{:?}", saved.body);

    let response = fixture.preview(baseline_proposal(json!([
        department("category", department_options()),
        roles("tag", roles_options()),
        shifts()
    ])));

    assert_eq!(response.status, 200, "{:?}", response.body);
    let changes = response.body["changes"].as_array().unwrap();
    assert_eq!(changes.len(), 1, "{:?}", response.body);
    let change = change_for(&response.body, unused);
    assert_eq!(change["entity"], "agitation");
    assert_eq!(change["operation"], "remove");
    assert_eq!(count(change, "affectedWorkers"), 0);
    assert_eq!(count(change, "lossyWorkers"), 0);
    assert_eq!(count(change, "discardedValues"), 0);
    assert_totals(&response.body, 0, 0, 0);
}

#[test]
fn product_gap_13_preview_writes_nothing_and_consumes_no_id_for_shared_changes() {
    let fixture = Fixture::new();
    let before_dataset = fixture.dataset();
    let before_changes: i64 = fixture
        .db
        .conn()
        .query_row("SELECT total_changes()", [], |row| row.get(0))
        .unwrap();

    let response = fixture.preview(proposal(
        json!([
            department(
                "category",
                json!([
                    answer(DELIVERY, "Delivery"),
                    answer(NO_DEPARTMENT, "No Department")
                ])
            ),
            roles("tag", roles_options()),
            shifts()
        ]),
        json!([
            agitation(SCHEDULE, "Schedule"),
            { "id": EQUIPMENT, "text": "Equipment", "mergedInto": SCHEDULE }
        ]),
        json!([]),
    ));
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
fn product_gap_13_refuses_a_shared_merge_the_save_would_reject() {
    let fixture = Fixture::new();
    let before = fixture.dataset();

    // The survivor is kept by the request but is not a saved Language, exactly the shape
    // the Save's own merge check refuses. The preview must not report a misleading zero.
    let response = fixture.preview(proposal(
        baseline_attributes(),
        baseline_agitations(),
        json!([
            { "id": ENGLISH, "name": "English", "mergedInto": "pg13-new-language" },
            language("pg13-new-language", "New")
        ]),
    ));

    assert_eq!(response.status, 500, "{:?}", response.body);
    assert!(response.body.get("totals").is_none(), "{:?}", response.body);
    assert_eq!(fixture.dataset().body, before.body);
}

#[test]
fn product_gap_13_removing_an_agitation_and_a_language_counts_each_assignment_once() {
    let fixture = Fixture::new();
    let response = fixture.preview(proposal(
        baseline_attributes(),
        json!([agitation(SCHEDULE, "Schedule")]),
        json!([language(ENGLISH, "English")]),
    ));

    assert_eq!(response.status, 200, "{:?}", response.body);
    assert_eq!(
        count(change_for(&response.body, EQUIPMENT), "discardedValues"),
        2
    );
    assert_eq!(
        count(change_for(&response.body, SPANISH), "discardedValues"),
        2
    );
    // Alex, Blair and Casey hold one of the two lost values each; Casey holds both, so the
    // 4 saved assignments are discarded across 3 Workers.
    assert_totals(&response.body, 3, 3, 4);
}
