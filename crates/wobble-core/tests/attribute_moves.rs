//! Cross-Attribute moves and promotions: an answer that leaves its Attribute for another
//! proposed Attribute, or becomes an Attribute of its own.
//!
//! The Configuration preview names every branch that leaves an Attribute and every saved
//! holder whose value loses an answer. A confirmed Save acknowledges each lossy move, keeps
//! answer ids stable, strips the moved answers from Worker drafts, and writes the definitions
//! and Worker values in one transaction.

mod common;

use common::http::{request, NoIds};
use serde_json::{json, Value};
use wobble_core::db::{open_seeded, Db};
use wobble_core::handle::Response;
use wobble_core::id::CounterId;
use wobble_core::router::dispatch;

const AREA: &str = "area";
const SITE: &str = "site";
const CENTRAL: &str = "central";
const STORE_A: &str = "store-a";
const STORE_B: &str = "store-b";
const DESK: &str = "desk";
const SITE_X: &str = "site-x";
const LEVEL_1: &str = "level-1";
const LEVEL_2: &str = "level-2";
const LEVEL_3: &str = "level-3";
const LEVEL_4: &str = "level-4";
const LEVEL_5: &str = "level-5";
const OTHER: &str = "other";

fn area(kind: &str, options: Value) -> Value {
    json!({ "id": AREA, "name": "Area", "kind": kind, "options": options })
}

fn site(options: Value) -> Value {
    json!({ "id": SITE, "name": "Site", "kind": "category", "options": options })
}

/// Central, its child Store A with the child Desk, and a root Store B.
fn area_options() -> Value {
    json!([
        { "id": CENTRAL, "value": "Central" },
        { "id": STORE_A, "value": "Store A", "parentId": CENTRAL },
        { "id": DESK, "value": "Desk", "parentId": STORE_A },
        { "id": STORE_B, "value": "Store B" }
    ])
}

fn site_options() -> Value {
    json!([{ "id": SITE_X, "value": "Site X" }])
}

fn worker_update(name: &str, attributes: Value) -> Value {
    json!({
        "name": name,
        "email": "",
        "phone": "",
        "assessment": "Unassessed",
        "attributes": attributes,
        "agitations": [],
        "languages": [],
        "relationships": [],
        "notes": []
    })
}

fn acknowledge(source: &str, answer: &str) -> Value {
    json!({ "sourceAttributeId": source, "answerId": answer })
}

fn resolutions(attribute_moves: Vec<Value>) -> Value {
    json!({
        "removedAnswers": [],
        "removedAttributes": [],
        "cardinality": [],
        "attributeMoves": attribute_moves
    })
}

fn attribute(dataset: &Value, id: &str) -> Value {
    dataset["attributes"]
        .as_array()
        .expect("attributes")
        .iter()
        .find(|attribute| attribute["id"] == json!(id))
        .unwrap_or_else(|| panic!("the Attribute {id}"))
        .clone()
}

fn option_ids(attribute: &Value) -> Vec<String> {
    attribute["options"]
        .as_array()
        .expect("options")
        .iter()
        .map(|answer| answer["id"].as_str().expect("an answer id").to_owned())
        .collect()
}

fn option<'a>(attribute: &'a Value, id: &str) -> &'a Value {
    attribute["options"]
        .as_array()
        .expect("options")
        .iter()
        .find(|answer| answer["id"] == json!(id))
        .unwrap_or_else(|| panic!("the answer {id}"))
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

/// A Save of `attributes` acknowledging every move it names, through a fresh preview.
fn confirmed_save(fixture: &Fixture, attributes: Value, moves: Vec<Value>) -> Response {
    let preview = fixture.preview(attributes.clone());
    assert_eq!(preview.status, 200, "{:?}", preview.body);
    let base = preview.body["base"].as_str().expect("a preview base");
    fixture.save(attributes, base, resolutions(moves))
}

#[test]
fn a_leaf_that_moves_is_previewed_as_one_move_without_writing() {
    let fixture = Fixture::new(json!([area("tag", area_options()), site(site_options())]));
    fixture.create_worker("Alex", json!({ AREA: [STORE_B], SITE: "" }));
    let moved = json!([
        area(
            "tag",
            json!([
                { "id": CENTRAL, "value": "Central" },
                { "id": STORE_A, "value": "Store A", "parentId": CENTRAL },
                { "id": DESK, "value": "Desk", "parentId": STORE_A }
            ])
        ),
        site(json!([
            { "id": SITE_X, "value": "Site X" },
            { "id": STORE_B, "value": "Store B" }
        ]))
    ]);

    let before = fixture.total_changes();
    let response = fixture.preview(moved);
    assert_eq!(response.status, 200, "{:?}", response.body);
    assert_eq!(
        fixture.total_changes(),
        before,
        "the preview writes nothing"
    );

    assert_eq!(response.body["removedAnswers"], json!([]));
    let moves = response.body["attributeMoves"]
        .as_array()
        .expect("attributeMoves");
    assert_eq!(moves.len(), 1, "{moves:?}");
    let detected = &moves[0];
    assert_eq!(detected["sourceAttributeId"], AREA);
    assert_eq!(detected["answerId"], STORE_B);
    assert_eq!(detected["targetAttributeId"], SITE);
    assert_eq!(detected["promoted"], false);
    assert_eq!(detected["subtreeAnswerIds"], json!([STORE_B]));
    assert_eq!(detected["affectedWorkers"], 1);
    assert_eq!(detected["holders"][0]["lostAnswerIds"], json!([STORE_B]));
    assert_eq!(detected["holders"][0]["keptAnswerIds"], json!([]));

    let change = response.body["changes"]
        .as_array()
        .expect("changes")
        .iter()
        .find(|change| change["operation"] == "moveToAttribute")
        .expect("a moveToAttribute change");
    assert_eq!(change["id"], STORE_B);
    assert_eq!(change["attributeId"], AREA);
    assert_eq!(change["affectedWorkers"], 1);
    assert_eq!(change["lossyWorkers"], 1);
    assert_eq!(change["discardedValues"], 1);
}

#[test]
fn a_confirmed_leaf_move_strips_the_holder_and_does_not_give_it_to_the_target() {
    let fixture = Fixture::new(json!([area("tag", area_options()), site(site_options())]));
    fixture.create_worker("Alex", json!({ AREA: [STORE_B], SITE: "" }));
    fixture.create_worker("Blair", json!({ AREA: [], SITE: SITE_X }));
    let moved = json!([
        area(
            "tag",
            json!([
                { "id": CENTRAL, "value": "Central" },
                { "id": STORE_A, "value": "Store A", "parentId": CENTRAL },
                { "id": DESK, "value": "Desk", "parentId": STORE_A }
            ])
        ),
        site(json!([
            { "id": SITE_X, "value": "Site X" },
            { "id": STORE_B, "value": "Store B" }
        ]))
    ]);

    let saved = confirmed_save(&fixture, moved, vec![acknowledge(AREA, STORE_B)]);
    assert_eq!(saved.status, 200, "{:?}", saved.body);

    let dataset = fixture.dataset();
    let area_now = attribute(&dataset, AREA);
    assert_eq!(option_ids(&area_now), [CENTRAL, STORE_A, DESK]);
    let site_now = attribute(&dataset, SITE);
    assert_eq!(
        option_ids(&site_now),
        [SITE_X, STORE_B],
        "the answer id is stable"
    );
    assert_eq!(
        fixture.worker(&dataset, "Alex")["attributes"],
        json!({ AREA: [], SITE: "" }),
        "the holder loses the answer and gains nothing in the target"
    );
    assert_eq!(
        fixture.worker(&dataset, "Blair")["attributes"],
        json!({ AREA: [], SITE: SITE_X }),
        "a target holder is unchanged"
    );
}

#[test]
fn a_leaf_that_lands_nowhere_is_still_an_ordinary_removal() {
    let fixture = Fixture::new(json!([area("tag", area_options()), site(site_options())]));
    fixture.create_worker("Alex", json!({ AREA: [STORE_B], SITE: "" }));
    let removed = json!([
        area(
            "tag",
            json!([
                { "id": CENTRAL, "value": "Central" },
                { "id": STORE_A, "value": "Store A", "parentId": CENTRAL },
                { "id": DESK, "value": "Desk", "parentId": STORE_A }
            ])
        ),
        site(site_options())
    ]);

    let response = fixture.preview(removed);
    assert_eq!(response.status, 200, "{:?}", response.body);
    assert_eq!(response.body["attributeMoves"], json!([]));
    assert_eq!(
        response.body["removedAnswers"]
            .as_array()
            .expect("removedAnswers")
            .len(),
        1
    );
}

#[test]
fn a_moved_branch_strips_a_holder_of_a_deep_descendant_and_keeps_every_id() {
    let fixture = Fixture::new(json!([area("tag", area_options()), site(site_options())]));
    fixture.create_worker("Alex", json!({ AREA: [DESK, STORE_B], SITE: "" }));
    fixture.create_worker("Blair", json!({ AREA: [STORE_B], SITE: "" }));
    let moved = json!([
        area(
            "tag",
            json!([
                { "id": CENTRAL, "value": "Central" },
                { "id": STORE_B, "value": "Store B" }
            ])
        ),
        site(json!([
            { "id": SITE_X, "value": "Site X" },
            { "id": STORE_A, "value": "Store A" },
            { "id": DESK, "value": "Desk", "parentId": STORE_A }
        ]))
    ]);

    let preview = fixture.preview(moved.clone());
    assert_eq!(preview.status, 200, "{:?}", preview.body);
    let detected = &preview.body["attributeMoves"][0];
    assert_eq!(detected["answerId"], STORE_A);
    assert_eq!(detected["subtreeAnswerIds"], json!([STORE_A, DESK]));
    assert_eq!(
        detected["affectedWorkers"], 1,
        "Blair holds neither answer of the branch"
    );
    assert_eq!(detected["holders"][0]["lostAnswerIds"], json!([DESK]));

    let saved = confirmed_save(&fixture, moved, vec![acknowledge(AREA, STORE_A)]);
    assert_eq!(saved.status, 200, "{:?}", saved.body);

    let dataset = fixture.dataset();
    assert_eq!(
        fixture.worker(&dataset, "Alex")["attributes"],
        json!({ AREA: [STORE_B], SITE: "" })
    );
    assert_eq!(
        fixture.worker(&dataset, "Blair")["attributes"],
        json!({ AREA: [STORE_B], SITE: "" })
    );
    let site_now = attribute(&dataset, SITE);
    assert_eq!(option_ids(&site_now), [SITE_X, STORE_A, DESK]);
    assert_eq!(
        option(&site_now, DESK)["parentId"],
        json!(STORE_A),
        "the parent link moved with the branch"
    );
}

#[test]
fn a_category_holder_of_a_moved_branch_loses_its_answer() {
    let fixture = Fixture::new(json!([
        area("category", area_options()),
        site(site_options())
    ]));
    fixture.create_worker("Alex", json!({ AREA: DESK, SITE: "" }));
    let moved = json!([
        area(
            "category",
            json!([
                { "id": CENTRAL, "value": "Central" },
                { "id": STORE_B, "value": "Store B" }
            ])
        ),
        site(json!([
            { "id": SITE_X, "value": "Site X" },
            { "id": STORE_A, "value": "Store A" },
            { "id": DESK, "value": "Desk", "parentId": STORE_A }
        ]))
    ]);

    let saved = confirmed_save(&fixture, moved, vec![acknowledge(AREA, STORE_A)]);
    assert_eq!(saved.status, 200, "{:?}", saved.body);

    let dataset = fixture.dataset();
    assert_eq!(
        fixture.worker(&dataset, "Alex")["attributes"],
        json!({ AREA: "", SITE: "" })
    );
}

#[test]
fn a_moved_branch_drops_the_moved_answers_from_worker_drafts_and_keeps_their_notes() {
    let fixture = Fixture::new(json!([area("tag", area_options()), site(site_options())]));
    let alex = fixture.create_worker("Alex", json!({ AREA: [DESK, STORE_B], SITE: "" }));
    let held = worker_update("Alex", json!({ AREA: [DESK, STORE_B], SITE: "" }));
    fixture.save_draft(&alex, held.clone(), Some(held));
    let moved = json!([
        area(
            "tag",
            json!([
                { "id": CENTRAL, "value": "Central" },
                { "id": STORE_B, "value": "Store B" }
            ])
        ),
        site(json!([
            { "id": SITE_X, "value": "Site X" },
            { "id": STORE_A, "value": "Store A" },
            { "id": DESK, "value": "Desk", "parentId": STORE_A }
        ]))
    ]);

    let saved = confirmed_save(&fixture, moved, vec![acknowledge(AREA, STORE_A)]);
    assert_eq!(saved.status, 200, "{:?}", saved.body);

    let draft = fixture.draft(&alex);
    assert_eq!(
        draft["update"]["attributes"],
        json!({ AREA: [STORE_B], SITE: "" })
    );
    assert_eq!(
        draft["base"]["attributes"],
        json!({ AREA: [STORE_B], SITE: "" })
    );
    assert_eq!(draft["pendingNote"]["text"], "keep me");
}

#[test]
fn a_promoted_answer_takes_its_holder_out_and_keeps_the_descendants_a_holder_has() {
    let fixture = Fixture::new(json!([area("tag", area_options()), site(site_options())]));
    fixture.create_worker("Alex", json!({ AREA: [STORE_A], SITE: "" }));
    fixture.create_worker("Blair", json!({ AREA: [DESK], SITE: "" }));
    fixture.create_worker("Casey", json!({ AREA: [STORE_A, DESK], SITE: "" }));
    let promoted = json!([
        area("tag", json!([
            { "id": CENTRAL, "value": "Central" },
            { "id": STORE_B, "value": "Store B" }
        ])),
        site(site_options()),
        { "id": STORE_A, "name": "Store A", "kind": "tag", "options": [
            { "id": DESK, "value": "Desk" }
        ] }
    ]);

    let preview = fixture.preview(promoted.clone());
    assert_eq!(preview.status, 200, "{:?}", preview.body);
    let detected = &preview.body["attributeMoves"][0];
    assert_eq!(detected["promoted"], true);
    assert_eq!(detected["answerId"], STORE_A);
    assert_eq!(detected["targetAttributeId"], STORE_A);
    assert_eq!(detected["subtreeAnswerIds"], json!([STORE_A, DESK]));
    assert_eq!(detected["affectedWorkers"], 3);
    let change = preview.body["changes"]
        .as_array()
        .expect("changes")
        .iter()
        .find(|change| change["operation"] == "promote")
        .expect("a promote change");
    assert_eq!(change["lossyWorkers"], 2, "Alex and Casey lose Store A");
    assert_eq!(change["discardedValues"], 2);

    let saved = confirmed_save(&fixture, promoted, vec![acknowledge(AREA, STORE_A)]);
    assert_eq!(saved.status, 200, "{:?}", saved.body);

    let dataset = fixture.dataset();
    let promoted_now = attribute(&dataset, STORE_A);
    assert_eq!(promoted_now["name"], "Store A");
    assert_eq!(promoted_now["kind"], "tag");
    assert_eq!(option_ids(&promoted_now), [DESK]);
    assert_eq!(option(&promoted_now, DESK)["parentId"], Value::Null);
    assert_eq!(
        fixture.worker(&dataset, "Alex")["attributes"][STORE_A],
        json!([]),
        "the holder of the answer itself holds nothing in the new Attribute"
    );
    assert_eq!(
        fixture.worker(&dataset, "Blair")["attributes"][STORE_A],
        json!([DESK]),
        "a holder of a descendant keeps it in the new Attribute"
    );
    assert_eq!(
        fixture.worker(&dataset, "Casey")["attributes"][STORE_A],
        json!([DESK])
    );
    assert_eq!(
        fixture.worker(&dataset, "Blair")["attributes"][AREA],
        json!([])
    );
}

#[test]
fn a_promotion_whose_holders_only_keep_descendants_needs_no_acknowledgement() {
    let fixture = Fixture::new(json!([area("tag", area_options()), site(site_options())]));
    fixture.create_worker("Blair", json!({ AREA: [DESK], SITE: "" }));
    let promoted = json!([
        area("tag", json!([
            { "id": CENTRAL, "value": "Central" },
            { "id": STORE_B, "value": "Store B" }
        ])),
        site(site_options()),
        { "id": STORE_A, "name": "Store A", "kind": "tag", "options": [
            { "id": DESK, "value": "Desk" }
        ] }
    ]);

    let saved = confirmed_save(&fixture, promoted, Vec::new());
    assert_eq!(saved.status, 200, "{:?}", saved.body);
    let dataset = fixture.dataset();
    assert_eq!(
        fixture.worker(&dataset, "Blair")["attributes"][STORE_A],
        json!([DESK])
    );
}

#[test]
fn a_promoted_category_keeps_its_kind_and_seeds_the_held_descendant() {
    let fixture = Fixture::new(json!([
        area("category", area_options()),
        site(site_options())
    ]));
    fixture.create_worker("Alex", json!({ AREA: DESK, SITE: "" }));
    let promoted = json!([
        area("category", json!([
            { "id": CENTRAL, "value": "Central" },
            { "id": STORE_B, "value": "Store B" }
        ])),
        site(site_options()),
        { "id": STORE_A, "name": "Store A", "kind": "category", "options": [
            { "id": DESK, "value": "Desk" }
        ] }
    ]);

    let saved = confirmed_save(&fixture, promoted, Vec::new());
    assert_eq!(saved.status, 200, "{:?}", saved.body);
    let dataset = fixture.dataset();
    assert_eq!(attribute(&dataset, STORE_A)["kind"], "category");
    assert_eq!(
        fixture.worker(&dataset, "Alex")["attributes"],
        json!({ AREA: "", SITE: "", STORE_A: DESK })
    );
}

#[test]
fn a_branch_five_levels_deep_moves_with_every_descendant() {
    let deep = json!([
        { "id": LEVEL_1, "value": "Level 1" },
        { "id": LEVEL_2, "value": "Level 2", "parentId": LEVEL_1 },
        { "id": LEVEL_3, "value": "Level 3", "parentId": LEVEL_2 },
        { "id": LEVEL_4, "value": "Level 4", "parentId": LEVEL_3 },
        { "id": LEVEL_5, "value": "Level 5", "parentId": LEVEL_4 },
        { "id": OTHER, "value": "Other" }
    ]);
    let fixture = Fixture::new(json!([area("tag", deep), site(site_options())]));
    fixture.create_worker("Alex", json!({ AREA: [LEVEL_5, OTHER], SITE: "" }));
    let moved = json!([
        area(
            "tag",
            json!([
                { "id": LEVEL_1, "value": "Level 1" },
                { "id": OTHER, "value": "Other" }
            ])
        ),
        site(json!([
            { "id": SITE_X, "value": "Site X" },
            { "id": LEVEL_2, "value": "Level 2" },
            { "id": LEVEL_3, "value": "Level 3", "parentId": LEVEL_2 },
            { "id": LEVEL_4, "value": "Level 4", "parentId": LEVEL_3 },
            { "id": LEVEL_5, "value": "Level 5", "parentId": LEVEL_4 }
        ]))
    ]);

    let preview = fixture.preview(moved.clone());
    assert_eq!(preview.status, 200, "{:?}", preview.body);
    let detected = &preview.body["attributeMoves"][0];
    assert_eq!(detected["answerId"], LEVEL_2);
    assert_eq!(
        detected["subtreeAnswerIds"],
        json!([LEVEL_2, LEVEL_3, LEVEL_4, LEVEL_5])
    );
    assert_eq!(detected["holders"][0]["lostAnswerIds"], json!([LEVEL_5]));

    let saved = confirmed_save(&fixture, moved, vec![acknowledge(AREA, LEVEL_2)]);
    assert_eq!(saved.status, 200, "{:?}", saved.body);
    let dataset = fixture.dataset();
    assert_eq!(
        fixture.worker(&dataset, "Alex")["attributes"],
        json!({ AREA: [OTHER], SITE: "" })
    );
    assert_eq!(
        option_ids(&attribute(&dataset, SITE)),
        [SITE_X, LEVEL_2, LEVEL_3, LEVEL_4, LEVEL_5]
    );
}

#[test]
fn a_lossy_move_without_its_acknowledgement_is_refused_and_writes_nothing() {
    let fixture = Fixture::new(json!([area("tag", area_options()), site(site_options())]));
    fixture.create_worker("Alex", json!({ AREA: [STORE_B], SITE: "" }));
    let moved = json!([
        area(
            "tag",
            json!([
                { "id": CENTRAL, "value": "Central" },
                { "id": STORE_A, "value": "Store A", "parentId": CENTRAL },
                { "id": DESK, "value": "Desk", "parentId": STORE_A }
            ])
        ),
        site(json!([
            { "id": SITE_X, "value": "Site X" },
            { "id": STORE_B, "value": "Store B" }
        ]))
    ]);
    let before = fixture.dataset();

    let refused = confirmed_save(&fixture, moved, Vec::new());
    assert_eq!(refused.status, 409, "{:?}", refused.body);
    assert_eq!(refused.body["code"], "configuration_resolution_required");
    assert_eq!(fixture.dataset(), before, "nothing was written");
}

#[test]
fn an_acknowledgement_that_names_no_move_or_repeats_one_is_refused_and_writes_nothing() {
    let fixture = Fixture::new(json!([area("tag", area_options()), site(site_options())]));
    fixture.create_worker("Alex", json!({ AREA: [STORE_B], SITE: "" }));
    let moved = json!([
        area(
            "tag",
            json!([
                { "id": CENTRAL, "value": "Central" },
                { "id": STORE_A, "value": "Store A", "parentId": CENTRAL },
                { "id": DESK, "value": "Desk", "parentId": STORE_A }
            ])
        ),
        site(json!([
            { "id": SITE_X, "value": "Site X" },
            { "id": STORE_B, "value": "Store B" }
        ]))
    ]);
    let before = fixture.dataset();

    let unknown = confirmed_save(&fixture, moved.clone(), vec![acknowledge(AREA, DESK)]);
    assert_eq!(unknown.status, 400, "{:?}", unknown.body);
    assert_eq!(unknown.body["code"], "configuration_replacement_invalid");

    let repeated = confirmed_save(
        &fixture,
        moved,
        vec![acknowledge(AREA, STORE_B), acknowledge(AREA, STORE_B)],
    );
    assert_eq!(repeated.status, 409, "{:?}", repeated.body);
    assert_eq!(repeated.body["code"], "configuration_resolution_required");

    assert_eq!(fixture.dataset(), before, "nothing was written");
}

#[test]
fn the_legacy_array_save_refuses_a_lossy_move_and_allows_a_lossless_one() {
    let fixture = Fixture::new(json!([area("tag", area_options()), site(site_options())]));
    fixture.create_worker("Alex", json!({ AREA: [STORE_B], SITE: "" }));
    let before = fixture.dataset();
    let lossy = json!([
        area(
            "tag",
            json!([
                { "id": CENTRAL, "value": "Central" },
                { "id": STORE_A, "value": "Store A", "parentId": CENTRAL },
                { "id": DESK, "value": "Desk", "parentId": STORE_A }
            ])
        ),
        site(json!([
            { "id": SITE_X, "value": "Site X" },
            { "id": STORE_B, "value": "Store B" }
        ]))
    ]);

    let refused = fixture.send("PUT", "/api/attributes", Some(lossy));
    assert_eq!(refused.status, 409, "{:?}", refused.body);
    assert_eq!(refused.body["code"], "configuration_resolution_required");
    assert_eq!(fixture.dataset(), before, "nothing was written");

    // Store B is held by nobody, so the same move through the array Save is lossless.
    let fixture = Fixture::new(json!([area("tag", area_options()), site(site_options())]));
    fixture.create_worker("Alex", json!({ AREA: [CENTRAL], SITE: "" }));
    let lossless = json!([
        area(
            "tag",
            json!([
                { "id": CENTRAL, "value": "Central" },
                { "id": STORE_A, "value": "Store A", "parentId": CENTRAL },
                { "id": DESK, "value": "Desk", "parentId": STORE_A }
            ])
        ),
        site(json!([
            { "id": SITE_X, "value": "Site X" },
            { "id": STORE_B, "value": "Store B" }
        ]))
    ]);
    let saved = fixture.send("PUT", "/api/attributes", Some(lossless));
    assert_eq!(saved.status, 200, "{:?}", saved.body);
    let dataset = fixture.dataset();
    assert_eq!(option_ids(&attribute(&dataset, SITE)), [SITE_X, STORE_B]);
    assert_eq!(
        fixture.worker(&dataset, "Alex")["attributes"],
        json!({ AREA: [CENTRAL], SITE: "" })
    );
}

#[test]
fn a_duplicate_attribute_name_is_a_coded_refusal_on_preview_and_resolution_save() {
    let fixture = Fixture::new(json!([area("tag", area_options()), site(site_options())]));
    let repeated = json!([
        area("tag", area_options()),
        { "id": SITE, "name": " area ", "kind": "category", "options": site_options() }
    ]);
    let message = "An Attribute named \"area\" already exists. Attribute names must be different, ignoring case and spacing.";

    // The legacy array Save keeps its recorded generic refusal (frozen replay fixture).
    let array_save = fixture.send("PUT", "/api/attributes", Some(repeated.clone()));
    assert_eq!(array_save.status, 400, "{:?}", array_save.body);
    assert!(
        array_save.body.get("code").is_none(),
        "{:?}",
        array_save.body
    );

    let resolution_save = fixture.save(repeated.clone(), "any-base", resolutions(Vec::new()));
    assert_eq!(resolution_save.status, 400, "{:?}", resolution_save.body);
    assert_eq!(
        resolution_save.body["code"],
        "configuration_attribute_name_exists"
    );

    let preview = fixture.preview(repeated);
    assert_eq!(preview.status, 400, "{:?}", preview.body);
    assert_eq!(preview.body["code"], "configuration_attribute_name_exists");
    assert_eq!(preview.body["message"], message);
}
