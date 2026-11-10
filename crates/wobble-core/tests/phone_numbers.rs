//! The Phone rule at the request boundary (ADR-0021): a strict single-field patch
//! stores a complete formatted number or nothing, and refuses anything else.

mod common;

use common::{remove_database, temp_db_path};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use wobble_core::db::open_seeded_keyed;
use wobble_core::handle::{App, Request, Response};
use wobble_core::id::CounterId;

/// One app on a scratch seeded database, with the id source that seeded it.
struct Harness {
    app: App,
    ids: CounterId,
    path: String,
}

impl Harness {
    fn new(name: &str) -> Self {
        let path = temp_db_path(&format!("phone-{name}.sqlite"));
        remove_database(&path);
        let ids = CounterId::new();
        let key = wobble_core::key::Secret::from_passphrase("phone fixture credential").unwrap();
        {
            open_seeded_keyed(&path, Some(&key), &ids).expect("a seeded database");
        }
        Self {
            app: App::open_keyed(&path, Some(&key)),
            ids,
            path,
        }
    }

    fn handle(&self, method: &str, path: &str, body: Option<Value>) -> Response {
        self.app.handle(
            &Request {
                method: method.to_owned(),
                path: path.to_owned(),
                query: String::new(),
                headers: vec![("content-type".to_owned(), "application/json".to_owned())],
                body: body.map(|body| serde_json::to_string(&body).expect("a JSON body")),
            },
            &self.ids,
        )
    }

    /// Creates one Worker through the route and answers its minted id.
    fn create_worker(&self, name: &str) -> String {
        let created = self.handle("POST", "/api/workers", Some(json!({ "name": name })));
        assert_eq!(created.status, 201, "{}", created.body);
        created.body["worker"]["id"]
            .as_str()
            .expect("a minted worker id")
            .to_owned()
    }

    /// The stored Phone of this Worker, read back through the dataset route.
    fn stored_phone(&self, worker_id: &str) -> String {
        let dataset = self.handle("GET", "/api/dataset", None);
        assert_eq!(dataset.status, 200, "{}", dataset.body);
        dataset.body["workers"]
            .as_array()
            .expect("the Worksite's workers")
            .iter()
            .find(|worker| worker["id"] == json!(worker_id))
            .and_then(|worker| worker["phone"].as_str())
            .unwrap_or_else(|| panic!("Worker {worker_id} is in the dataset"))
            .to_owned()
    }
}

impl Harness {
    /// A whole-record update body with every field defaulted and this Phone.
    fn update_body(&self, name: &str, phone: &str) -> Value {
        let dataset = self.handle("GET", "/api/dataset", None);
        let attributes: serde_json::Map<String, Value> = dataset.body["attributes"]
            .as_array()
            .expect("the Worksite's attributes")
            .iter()
            .map(|attribute| {
                let id = attribute["id"].as_str().expect("an attribute id");
                let empty = if attribute["kind"].as_str() == Some("tag") {
                    json!([])
                } else {
                    json!("")
                };
                (id.to_owned(), empty)
            })
            .collect();

        json!({
            "name": name,
            "email": "",
            "phone": phone,
            "assessment": "Unassessed",
            "attributes": attributes,
            "agitations": [],
            "languages": [],
            "relationships": [],
            "notes": []
        })
    }
}

impl Drop for Harness {
    fn drop(&mut self) {
        remove_database(&self.path);
    }
}

#[test]
fn the_phone_patch_stores_ten_digits_formatted() {
    let harness = Harness::new("patch-stores-ten");
    let worker_id = harness.create_worker("Ada");

    let response = harness.handle(
        "PATCH",
        &format!("/api/workers/{worker_id}"),
        Some(json!({ "field": "phone", "value": "5550100100" })),
    );

    assert_eq!(response.status, 200, "{}", response.body);
    assert_eq!(response.body["worker"]["phone"], json!("(555) 010-0100"));
    assert_eq!(harness.stored_phone(&worker_id), "(555) 010-0100");
}
#[test]
fn the_phone_patch_accepts_each_separator_style_a_prefix_and_empty() {
    let harness = Harness::new("patch-styles");
    let worker_id = harness.create_worker("Ada");

    for (value, expected) in [
        ("5550100100", "(555) 010-0100"),
        ("555.010.0100", "(555) 010-0100"),
        ("555-010-0100", "(555) 010-0100"),
        ("(555) 010-0100", "(555) 010-0100"),
        ("+1 555 010 0100", "(555) 010-0100"),
        ("1-555-010-0100", "(555) 010-0100"),
    ] {
        let response = harness.handle(
            "PATCH",
            &format!("/api/workers/{worker_id}"),
            Some(json!({ "field": "phone", "value": value })),
        );
        assert_eq!(response.status, 200, "{value}: {}", response.body);
        assert_eq!(response.body["worker"]["phone"], json!(expected), "{value}");
        assert_eq!(harness.stored_phone(&worker_id), expected, "{value}");
    }

    let cleared = harness.handle(
        "PATCH",
        &format!("/api/workers/{worker_id}"),
        Some(json!({ "field": "phone", "value": "   " })),
    );
    assert_eq!(cleared.status, 200, "{}", cleared.body);
    assert_eq!(cleared.body["worker"]["phone"], json!(""));
    assert_eq!(harness.stored_phone(&worker_id), "");
}

#[test]
fn the_phone_patch_refuses_an_incomplete_or_unusable_value_and_writes_nothing() {
    let harness = Harness::new("patch-refuses");
    let worker_id = harness.create_worker("Ada");

    let saved = harness.handle(
        "PATCH",
        &format!("/api/workers/{worker_id}"),
        Some(json!({ "field": "phone", "value": "5550100100" })),
    );
    assert_eq!(saved.status, 200, "{}", saved.body);

    for value in [
        "555-0100",
        "5550100",
        "55501001000",
        "abc",
        "call after 5",
        "call 555-010-0100",
        "555-010-0100 x12",
    ] {
        let response = harness.handle(
            "PATCH",
            &format!("/api/workers/{worker_id}"),
            Some(json!({ "field": "phone", "value": value })),
        );
        assert_eq!(response.status, 400, "{value}: {}", response.body);
        assert_eq!(
            response.body,
            json!({
                "message": "Worker phone must be a 10-digit US or Canada number.",
                "code": "invalid_worker"
            }),
            "{value}"
        );
        assert_eq!(
            harness.stored_phone(&worker_id),
            "(555) 010-0100",
            "{value}"
        );
    }
}

#[test]
fn the_whole_record_update_formats_a_clean_number_and_keeps_any_other_value_verbatim() {
    let harness = Harness::new("whole-record");
    let worker_id = harness.create_worker("Ada");

    let created = harness.handle(
        "POST",
        "/api/workers",
        Some(harness.update_body("Grace", "5550100100")),
    );
    assert_eq!(created.status, 201, "{}", created.body);
    assert_eq!(created.body["worker"]["phone"], json!("(555) 010-0100"));

    for (value, expected) in [
        ("5550100100", "(555) 010-0100"),
        ("  (555) 010-0100  ", "(555) 010-0100"),
        (" 555-0100 ", "555-0100"),
        (" call after 5 ", "call after 5"),
        (" call 555-010-0100 ", "call 555-010-0100"),
        ("   ", ""),
    ] {
        let response = harness.handle(
            "PUT",
            &format!("/api/workers/{worker_id}"),
            Some(harness.update_body("Ada", value)),
        );
        assert_eq!(response.status, 200, "{value}: {}", response.body);
        assert_eq!(response.body["worker"]["phone"], json!(expected), "{value}");
        assert_eq!(harness.stored_phone(&worker_id), expected, "{value}");
    }
}

#[test]
fn the_contact_import_stores_a_clean_number_formatted_and_anything_else_blank() {
    let harness = Harness::new("import");

    let imported = harness.handle(
        "POST",
        "/api/workers",
        Some(json!([
            { "name": "Ada Lovelace", "email": "ada@example.test", "phone": "5550100100" },
            { "name": "Grace Hopper", "phone": "+1 555 010 0101" },
            { "name": "Katherine Johnson", "phone": "555-0101" },
            { "name": "Mary Jackson", "phone": "abc" },
            { "name": "Annie Easley", "phone": "   " },
            { "name": "Hedy Lamarr", "phone": "call 555-010-0100" },
            { "name": "Dorothy Vaughan" }
        ])),
    );
    assert_eq!(imported.status, 200, "{}", imported.body);
    assert_eq!(imported.body["imported"], json!(7));
    // Each created id answers against its source row, in order.
    let rows: Vec<u64> = imported.body["created"]
        .as_array()
        .unwrap()
        .iter()
        .map(|created| created["row"].as_u64().unwrap())
        .collect();
    assert_eq!(rows, [1, 2, 3, 4, 5, 6, 7]);

    let dataset = harness.handle("GET", "/api/dataset", None);
    assert_eq!(dataset.status, 200, "{}", dataset.body);
    let phones: BTreeMap<String, String> = dataset.body["workers"]
        .as_array()
        .expect("the Worksite's workers")
        .iter()
        .map(|worker| {
            (
                worker["name"].as_str().expect("a name").to_owned(),
                worker["phone"].as_str().expect("a phone").to_owned(),
            )
        })
        .collect();

    assert_eq!(
        phones,
        BTreeMap::from([
            ("Ada Lovelace".to_owned(), "(555) 010-0100".to_owned()),
            ("Grace Hopper".to_owned(), "(555) 010-0101".to_owned()),
            ("Katherine Johnson".to_owned(), String::new()),
            ("Mary Jackson".to_owned(), String::new()),
            ("Annie Easley".to_owned(), String::new()),
            ("Hedy Lamarr".to_owned(), "(555) 010-0100".to_owned()),
            ("Dorothy Vaughan".to_owned(), String::new()),
        ])
    );
}

#[test]
fn undo_restores_a_previous_phone_that_predates_the_format() {
    let harness = Harness::new("restore");
    let worker_id = harness.create_worker("Ada");

    let saved = harness.handle(
        "PATCH",
        &format!("/api/workers/{worker_id}"),
        Some(json!({ "field": "phone", "value": "5550100100" })),
    );
    assert_eq!(saved.status, 200, "{}", saved.body);

    // The previous value was not a clean number, so only the restore path accepts it.
    let refused = harness.handle(
        "PATCH",
        &format!("/api/workers/{worker_id}"),
        Some(json!({ "field": "phone", "value": "555-0100" })),
    );
    assert_eq!(refused.status, 400, "{}", refused.body);
    assert_eq!(refused.body["code"], json!("invalid_worker"));

    let restored = harness.handle(
        "PATCH",
        &format!("/api/workers/{worker_id}"),
        Some(json!({ "field": "phone", "value": " 555-0100 ", "action": "restore" })),
    );
    assert_eq!(restored.status, 200, "{}", restored.body);
    assert_eq!(restored.body["worker"]["phone"], json!("555-0100"));
    assert_eq!(harness.stored_phone(&worker_id), "555-0100");

    // Restore is a Phone-only exemption, not a general way around validation.
    for body in [
        json!({ "field": "email", "value": "not-an-address", "action": "restore" }),
        json!({ "field": "name", "value": "", "action": "restore" }),
        json!({ "field": "phone", "value": "555-0100", "action": "relax" }),
    ] {
        let response = harness.handle(
            "PATCH",
            &format!("/api/workers/{worker_id}"),
            Some(body.clone()),
        );
        assert_eq!(response.status, 400, "{body}: {}", response.body);
        assert_eq!(response.body["code"], json!("invalid_worker"), "{body}");
    }
}
