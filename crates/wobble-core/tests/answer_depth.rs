//! Answer nesting has no depth limit: a five-level tree validates, saves, reads back and
//! keeps a Worker's deepest answer through the Worker round trip.

mod common;

use common::http::request;
use serde_json::{json, Value};
use wobble_core::db::open_seeded;
use wobble_core::id::CounterId;
use wobble_core::router::dispatch;

fn five_levels() -> Value {
    json!([
        { "id": "l1", "value": "Level 1" },
        { "id": "l2", "value": "Level 2", "parentId": "l1" },
        { "id": "l3", "value": "Level 3", "parentId": "l2" },
        { "id": "l4", "value": "Level 4", "parentId": "l3" },
        { "id": "l5", "value": "Level 5", "parentId": "l4" }
    ])
}

fn worker(attributes: Value) -> Value {
    json!({
        "name": "Deep", "email": "", "phone": "", "assessment": "Unassessed",
        "attributes": attributes, "agitations": [], "languages": [],
        "relationships": [], "notes": []
    })
}

#[test]
fn a_five_level_answer_tree_saves_reads_back_and_is_held_by_a_worker() {
    for kind in ["category", "tag"] {
        let ids = CounterId::new();
        let db = open_seeded(":memory:", &ids).expect("a seeded database");
        let site = dispatch(&db, &request("GET", "/api/worksite", None, None), &ids).body
            ["worksite"]["id"]
            .as_str()
            .expect("worksite id")
            .to_owned();
        let send = |method: &str, path: &str, body: Option<Value>| {
            dispatch(&db, &request(method, path, Some(&site), body), &ids)
        };

        let saved = send(
            "PUT",
            "/api/attributes",
            Some(json!([{ "id": "deep", "name": "Deep", "kind": kind, "options": five_levels() }])),
        );
        assert_eq!(saved.status, 200, "{kind}: {:?}", saved.body);

        let held = if kind == "tag" {
            json!(["l5"])
        } else {
            json!("l5")
        };
        let created = send(
            "POST",
            "/api/workers",
            Some(worker(json!({ "deep": held }))),
        );
        assert_eq!(created.status, 201, "{kind}: {:?}", created.body);

        let dataset = send("GET", "/api/dataset", None).body;
        let attribute = dataset["attributes"]
            .as_array()
            .expect("attributes")
            .iter()
            .find(|a| a["id"] == json!("deep"))
            .expect("the Deep Attribute");
        // Every value carries its generated Short form; these names all fit in 10 graphemes.
        let mut expected = five_levels();
        for option in expected.as_array_mut().expect("options") {
            option["shortForm"] = option["value"].clone();
            option["shortFormOrigin"] = json!("generated");
            option["abbreviation"] = option["value"].clone();
            option["abbreviationOrigin"] = json!("generated");
        }
        assert_eq!(attribute["options"], expected, "{kind}");
        assert_eq!(dataset["workers"][0]["attributes"]["deep"], held, "{kind}");
    }
}

#[test]
fn a_five_level_tree_still_refuses_a_cycle_and_a_duplicate_sibling() {
    let ids = CounterId::new();
    let db = open_seeded(":memory:", &ids).expect("a seeded database");
    let site = dispatch(&db, &request("GET", "/api/worksite", None, None), &ids).body["worksite"]
        ["id"]
        .as_str()
        .expect("worksite id")
        .to_owned();
    let put = |options: Value| {
        dispatch(
            &db,
            &request(
                "PUT",
                "/api/attributes",
                Some(&site),
                Some(json!([{ "id": "deep", "name": "Deep", "kind": "tag", "options": options }])),
            ),
            &ids,
        )
    };

    let mut cyclic = five_levels();
    cyclic[0]["parentId"] = json!("l5");
    assert_eq!(put(cyclic).status, 400);

    let mut duplicate = five_levels();
    duplicate
        .as_array_mut()
        .unwrap()
        .push(json!({ "id": "l5b", "value": "Level 5", "parentId": "l4" }));
    assert_eq!(put(duplicate).status, 400);
}
