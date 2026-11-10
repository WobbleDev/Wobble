//! Short forms (ADR 0046) through the request boundary: every Attribute value carries a
//! stored Short form of at most 10 graphemes and its origin, generated or edited.

mod common;

use common::http::request;
use serde_json::{json, Value};
use wobble_core::db::{open_seeded, Db};
use wobble_core::id::CounterId;
use wobble_core::router::dispatch;
use wobble_core::short_form_lists::REVISION;
use wobble_core::short_form_revision::revision_key;

struct Site {
    db: Db,
    ids: CounterId,
    worksite: String,
}

impl Site {
    fn new() -> Self {
        let ids = CounterId::new();
        let db = open_seeded(":memory:", &ids).expect("a seeded database");
        let worksite = dispatch(&db, &request("GET", "/api/worksite", None, None), &ids).body
            ["worksite"]["id"]
            .as_str()
            .expect("worksite id")
            .to_owned();
        Self { db, ids, worksite }
    }

    fn send(&self, method: &str, path: &str, body: Option<Value>) -> wobble_core::handle::Response {
        dispatch(
            &self.db,
            &request(method, path, Some(&self.worksite), body),
            &self.ids,
        )
    }

    fn save(&self, options: Value) -> wobble_core::handle::Response {
        self.send(
            "PUT",
            "/api/attributes",
            Some(json!([{ "id": "dept", "name": "Dept", "kind": "category", "options": options }])),
        )
    }

    fn save_in(&self, locale: &str, options: Value) -> wobble_core::handle::Response {
        let mut request = request(
            "PUT",
            "/api/attributes",
            Some(&self.worksite),
            Some(json!([{ "id": "dept", "name": "Dept", "kind": "category", "options": options }])),
        );
        request
            .headers
            .push(("x-wobble-locale".to_owned(), locale.to_owned()));
        dispatch(&self.db, &request, &self.ids)
    }

    fn forms(&self) -> Vec<String> {
        self.options()
            .as_array()
            .expect("options")
            .iter()
            .map(|option| option["shortForm"].as_str().expect("form").to_owned())
            .collect()
    }

    fn options(&self) -> Value {
        let read = self.send("GET", "/api/dataset", None);
        read.body["attributes"][0]["options"].clone()
    }
}

#[test]
fn a_value_that_fits_keeps_its_full_name_and_a_long_one_is_cut_with_an_ellipsis() {
    let site = Site::new();
    let saved = site.save(json!([
        { "id": "a", "value": "Kitchen" },
        { "id": "b", "value": "Ten chars!!" },
        { "id": "c", "value": "Customer Service North" }
    ]));
    assert_eq!(saved.status, 200, "{:?}", saved.body);

    for options in [
        saved.body["attributes"][0]["options"].clone(),
        site.options(),
    ] {
        assert_eq!(
            options,
            json!([
                { "id": "a", "value": "Kitchen", "shortForm": "Kitchen", "shortFormOrigin": "generated" },
                { "id": "b", "value": "Ten chars!!", "shortForm": "Ten chars…", "shortFormOrigin": "generated" },
                { "id": "c", "value": "Customer Service North", "shortForm": "Customer …", "shortFormOrigin": "generated" }
            ])
        );
    }
}

#[test]
fn the_limit_counts_graphemes_not_bytes_or_code_points() {
    let site = Site::new();
    // Ten family emoji are ten graphemes (many code points each); ten accents are too.
    let family = "👨‍👩‍👧‍👦".repeat(10);
    let accented = "e\u{301}".repeat(10);
    let saved = site.save(json!([
        { "id": "a", "value": family },
        { "id": "b", "value": accented }
    ]));
    assert_eq!(saved.status, 200, "{:?}", saved.body);
    let options = site.options();
    assert_eq!(options[0]["shortForm"], family);
    // Judged and stored in NFC: ten decomposed accents are ten composed ones.
    assert_eq!(options[1]["shortForm"], "\u{e9}".repeat(10));
}

#[test]
fn an_edited_short_form_round_trips_and_survives_a_rename() {
    let site = Site::new();
    let saved = site.save(json!([
        { "id": "a", "value": "Customer Service North",
          "shortForm": "CS North", "shortFormOrigin": "edited" },
        { "id": "b", "value": "Back of House Maintenance" }
    ]));
    assert_eq!(saved.status, 200, "{:?}", saved.body);
    let options = site.options();
    assert_eq!(options[0]["shortForm"], "CS North");
    assert_eq!(options[0]["shortFormOrigin"], "edited");

    // Renaming leaves the edited form alone and makes a generated one follow the name.
    let renamed = site.save(json!([
        { "id": "a", "value": "Customer Service South",
          "shortForm": "CS North", "shortFormOrigin": "edited" },
        { "id": "b", "value": "Front of House Cleaning",
          "shortForm": "Back of Ho…", "shortFormOrigin": "generated" }
    ]));
    assert_eq!(renamed.status, 200, "{:?}", renamed.body);
    let options = site.options();
    assert_eq!(options[0]["shortForm"], "CS North");
    assert_eq!(options[0]["shortFormOrigin"], "edited");
    assert_eq!(options[1]["shortForm"], "FHC");
    assert_eq!(options[1]["shortFormOrigin"], "generated");
}

#[test]
fn an_edited_short_form_is_trimmed_and_limited_to_ten_graphemes_with_a_coded_error() {
    let site = Site::new();
    let trimmed = site.save(json!([
        { "id": "a", "value": "Kitchen staff", "shortForm": "  KS  ", "shortFormOrigin": "edited" }
    ]));
    assert_eq!(trimmed.status, 200, "{:?}", trimmed.body);
    assert_eq!(site.options()[0]["shortForm"], "KS");

    for too_long in ["Eleven char", "", "   "] {
        let refused = site.save(json!([
            { "id": "a", "value": "Kitchen staff",
              "shortForm": too_long, "shortFormOrigin": "edited" }
        ]));
        assert_eq!(refused.status, 400, "{too_long:?}");
        assert_eq!(refused.body["code"], "short_form_invalid", "{too_long:?}");
    }
    // The refused saves changed nothing.
    assert_eq!(site.options()[0]["shortForm"], "KS");
}

#[test]
fn a_malformed_origin_or_a_form_without_an_origin_is_refused() {
    let site = Site::new();
    for answer in [
        json!({ "id": "a", "value": "Kitchen", "shortForm": "K", "shortFormOrigin": "typed" }),
        json!({ "id": "a", "value": "Kitchen", "shortForm": "K" }),
        json!({ "id": "a", "value": "Kitchen", "shortFormOrigin": "edited" }),
        json!({ "id": "a", "value": "Kitchen", "shortForm": 5, "shortFormOrigin": "edited" }),
    ] {
        let refused = site.save(json!([answer]));
        assert_eq!(refused.status, 400, "{answer}");
    }
}

#[test]
fn a_new_value_gets_a_readable_short_form_through_save() {
    let site = Site::new();
    let saved = site.save(json!([
        { "id": "a", "value": "Customer Service" },
        { "id": "b", "value": "Department of Human Resources" },
        { "id": "c", "value": "Technical Advisory Board (TAB)" },
        { "id": "d", "value": "Maintenance Hub" },
        { "id": "e", "value": "MAINTENANCE" }
    ]));
    assert_eq!(saved.status, 200, "{:?}", saved.body);
    assert_eq!(
        site.forms(),
        ["Cust. Svc.", "DHR", "TAB", "Maint. Hub", "MAINT."]
    );
}

#[test]
fn the_locale_the_request_carries_selects_the_word_lists_for_new_values() {
    let site = Site::new();
    let saved = site.save_in(
        "es-MX",
        json!([{ "id": "a", "value": "Administración" }, { "id": "b", "value": "Departamento Sur" }]),
    );
    assert_eq!(saved.status, 200, "{:?}", saved.body);
    assert_eq!(site.forms(), ["Admón.", "Depto. Sur"]);
    // A value first saved under English reads English lists, whatever its language.
    let english = Site::new();
    english.save_in("en", json!([{ "id": "a", "value": "Administración" }]));
    assert_eq!(english.forms(), ["Administr…"]);
    // A missing, empty or odd locale reads the English lists.
    for locale in ["", "fr", "-"] {
        let site = Site::new();
        site.save_in(locale, json!([{ "id": "a", "value": "Maintenance" }]));
        assert_eq!(site.forms(), ["Maint."], "{locale:?}");
    }
    let site = Site::new();
    site.save_in("es_MX", json!([{ "id": "a", "value": "Mantenimiento" }]));
    assert_eq!(site.forms(), ["Mant."]);
    let site = Site::new();
    site.save(json!([{ "id": "a", "value": "Maintenance" }]));
    assert_eq!(site.forms(), ["Maint."]);
}

#[test]
fn a_change_of_locale_regenerates_nothing() {
    let site = Site::new();
    let options = json!([
        { "id": "a", "value": "Administración" },
        { "id": "b", "value": "Departamento Sur" }
    ]);
    site.save_in("es-MX", options.clone());
    assert_eq!(site.save_in("en", options.clone()).status, 200);
    assert_eq!(site.forms(), ["Admón.", "Depto. Sur"]);
    // Even a stale form sent back by the client does not move a stored one.
    let stale = json!([
        { "id": "a", "value": "Administración", "shortForm": "Administr…", "shortFormOrigin": "generated" },
        { "id": "b", "value": "Departamento Sur" }
    ]);
    assert_eq!(site.save_in("en", stale).status, 200);
    assert_eq!(site.forms(), ["Admón.", "Depto. Sur"]);
}

#[test]
fn a_rename_regenerates_only_the_renamed_value() {
    let site = Site::new();
    site.save_in(
        "es",
        json!([{ "id": "a", "value": "Administración" }, { "id": "b", "value": "Mantenimiento" }]),
    );
    assert_eq!(site.forms(), ["Admón.", "Mant."]);
    let renamed = site.save_in(
        "en",
        json!([{ "id": "a", "value": "Customer Service" }, { "id": "b", "value": "Mantenimiento" }]),
    );
    assert_eq!(renamed.status, 200, "{:?}", renamed.body);
    assert_eq!(site.forms(), ["Cust. Svc.", "Mant."]);
}

#[test]
fn unrelated_saves_reorders_and_inserts_move_no_other_form() {
    let site = Site::new();
    site.save(json!([
        { "id": "a", "value": "Customer Service" },
        { "id": "b", "value": "Customer Svc." }
    ]));
    assert_eq!(site.forms(), ["Cust. Svc.", "Customer …"]);
    // Reordered and with a new value in front: "b" keeps what it had, and so does "a".
    let saved = site.save(json!([
        { "id": "c", "value": "Kitchen" },
        { "id": "b", "value": "Customer Svc." },
        { "id": "a", "value": "Customer Service" }
    ]));
    assert_eq!(saved.status, 200, "{:?}", saved.body);
    assert_eq!(site.forms(), ["Kitchen", "Customer …", "Cust. Svc."]);
}

#[test]
fn a_preview_with_a_locale_header_writes_nothing() {
    let site = Site::new();
    site.save_in("es", json!([{ "id": "a", "value": "Administración" }]));
    for locale in ["en", "es-MX", "", "fr"] {
        let mut preview = request(
            "POST",
            "/api/configuration/preview",
            Some(&site.worksite),
            Some(json!({
                "attributes": [{ "id": "dept", "name": "Dept", "kind": "category",
                    "options": [{ "id": "a", "value": "Customer Service" }] }],
                "agitations": [],
                "languages": []
            })),
        );
        preview
            .headers
            .push(("x-wobble-locale".to_owned(), locale.to_owned()));
        let reply = dispatch(&site.db, &preview, &site.ids);
        assert_eq!(reply.status, 200, "{locale:?}: {:?}", reply.body);
    }
    assert_eq!(site.forms(), ["Admón."]);
}

#[test]
fn two_values_of_one_attribute_never_share_a_generated_form() {
    let site = Site::new();
    let saved = site.save(json!([
        { "id": "a", "value": "Customer Service" },
        { "id": "b", "value": "Customer Svc." }
    ]));
    assert_eq!(saved.status, 200, "{:?}", saved.body);
    assert_eq!(site.forms(), ["Cust. Svc.", "Customer …"]);
}

#[test]
fn a_generated_form_gives_way_to_an_edited_one_which_is_never_moved() {
    let site = Site::new();
    let saved = site.save(json!([
        { "id": "a", "value": "Customer Service" },
        { "id": "b", "value": "Customer Support", "shortForm": "Cust. Svc.", "shortFormOrigin": "edited" }
    ]));
    assert_eq!(saved.status, 200, "{:?}", saved.body);
    assert_eq!(site.forms(), ["Customer …", "Cust. Svc."]);
}

#[test]
fn a_decomposed_edited_form_is_stored_normalised() {
    let site = Site::new();
    let saved = site.save(json!([
        { "id": "a", "value": "Kitchen", "shortForm": " Cafe\u{301} ", "shortFormOrigin": "edited" }
    ]));
    assert_eq!(saved.status, 200, "{:?}", saved.body);
    assert_eq!(site.forms(), ["Caf\u{e9}"]);
}

impl Site {
    /// The suggested forms a preview of `options` reports for the `dept` Attribute, as
    /// `(answer id, form, origin)`, under the given locale header.
    fn suggestions(&self, locale: Option<&str>, options: Value) -> Vec<(String, String, String)> {
        self.suggestions_from("/api/configuration/short-forms", locale, options)
    }

    fn suggestions_from(
        &self,
        path: &str,
        locale: Option<&str>,
        options: Value,
    ) -> Vec<(String, String, String)> {
        let mut preview = request(
            "POST",
            path,
            Some(&self.worksite),
            Some(json!({
                "attributes": [{ "id": "dept", "name": "Dept", "kind": "category", "options": options }],
                "agitations": [],
                "languages": []
            })),
        );
        if let Some(locale) = locale {
            preview
                .headers
                .push(("x-wobble-locale".to_owned(), locale.to_owned()));
        }
        let reply = dispatch(&self.db, &preview, &self.ids);
        assert_eq!(reply.status, 200, "{:?}", reply.body);
        reply.body["shortForms"]
            .as_array()
            .expect("shortForms")
            .iter()
            .map(|entry| {
                assert_eq!(entry["attributeId"], "dept");
                (
                    entry["answerId"].as_str().unwrap().to_owned(),
                    entry["shortForm"].as_str().unwrap().to_owned(),
                    entry["shortFormOrigin"].as_str().unwrap().to_owned(),
                )
            })
            .collect()
    }
}

fn suggested(id: &str, form: &str, origin: &str) -> (String, String, String) {
    (id.to_owned(), form.to_owned(), origin.to_owned())
}

#[test]
fn a_preview_suggests_a_form_for_an_unsaved_value_and_a_renamed_generated_one() {
    let site = Site::new();
    site.save(json!([
        { "id": "a", "value": "Customer Service" },
        { "id": "b", "value": "Maintenance Hub" }
    ]));
    let before = site.forms();

    let reply = site.suggestions(
        None,
        json!([
            { "id": "a", "value": "Night Service" },
            { "id": "b", "value": "Maintenance Hub" },
            { "id": "c", "value": "Department of Human Resources" }
        ]),
    );
    assert_eq!(
        reply,
        [
            suggested("a", "Night Svc.", "generated"),
            suggested("b", "Maint. Hub", "generated"),
            suggested("c", "DHR", "generated"),
        ]
    );
    // A preview writes nothing.
    assert_eq!(site.forms(), before);
}

#[test]
fn a_preview_leaves_an_edited_form_alone_through_a_rename_and_a_merge() {
    let site = Site::new();
    site.save(json!([
        { "id": "a", "value": "Customer Service",
          "shortForm": "CS", "shortFormOrigin": "edited" },
        { "id": "b", "value": "Maintenance Hub" }
    ]));
    let renamed = site.suggestions(
        None,
        json!([
            { "id": "a", "value": "Night Service", "shortForm": "CS", "shortFormOrigin": "edited" },
            { "id": "b", "value": "Maintenance Hub" }
        ]),
    );
    assert_eq!(
        renamed,
        [
            suggested("a", "CS", "edited"),
            suggested("b", "Maint. Hub", "generated")
        ]
    );
    // Folding b into a keeps a's edited form; the folded value is not suggested.
    let merged = site.suggestions(
        None,
        json!([
            { "id": "a", "value": "Customer Service", "shortForm": "CS", "shortFormOrigin": "edited" },
            { "id": "b", "value": "Maintenance Hub", "mergedInto": "a" }
        ]),
    );
    assert_eq!(merged, [suggested("a", "CS", "edited")]);
    // The same merge saved keeps it too.
    let saved = site.save(json!([
        { "id": "a", "value": "Customer Service", "shortForm": "CS", "shortFormOrigin": "edited" },
        { "id": "b", "value": "Maintenance Hub", "mergedInto": "a" }
    ]));
    assert_eq!(saved.status, 200, "{:?}", saved.body);
    assert_eq!(site.forms(), ["CS"]);
}

#[test]
fn clearing_an_edited_form_makes_the_next_preview_suggest_a_fresh_generated_one() {
    let site = Site::new();
    site.save(json!([
        { "id": "a", "value": "Customer Service",
          "shortForm": "CS", "shortFormOrigin": "edited" }
    ]));
    // The draft sends neither field once the edit is cleared.
    let cleared = site.suggestions(None, json!([{ "id": "a", "value": "Customer Service" }]));
    assert_eq!(cleared, [suggested("a", "Cust. Svc.", "generated")]);
}

#[test]
fn a_preview_under_another_locale_keeps_stored_forms_and_suggests_in_that_locale_for_new_ones() {
    let site = Site::new();
    site.save_in("es", json!([{ "id": "a", "value": "Administración" }]));
    let reply = site.suggestions(
        Some("en"),
        json!([
            { "id": "a", "value": "Administración" },
            { "id": "b", "value": "Maintenance" }
        ]),
    );
    assert_eq!(
        reply,
        [
            suggested("a", "Admón.", "generated"),
            suggested("b", "Maint.", "generated")
        ]
    );
}

#[test]
fn a_preview_suggestion_is_what_saving_the_same_draft_stores() {
    let site = Site::new();
    let draft = json!([
        { "id": "a", "value": "Customer Service" },
        { "id": "b", "value": "Customer Svc." },
        { "id": "c", "value": "Cust. Svc. East", "shortForm": "Cust. Svc.", "shortFormOrigin": "edited" }
    ]);
    let suggestions = site.suggestions(None, draft.clone());
    assert_eq!(site.save(draft).status, 200);
    let stored: Vec<_> = site
        .options()
        .as_array()
        .unwrap()
        .iter()
        .map(|option| {
            suggested(
                option["id"].as_str().unwrap(),
                option["shortForm"].as_str().unwrap(),
                option["shortFormOrigin"].as_str().unwrap(),
            )
        })
        .collect();
    assert_eq!(suggestions, stored);
}

#[test]
fn the_configuration_preview_reports_the_same_suggestions_as_the_short_forms_route() {
    let site = Site::new();
    site.save(json!([{ "id": "a", "value": "Customer Service" }]));
    let draft = json!([
        { "id": "a", "value": "Night Service" },
        { "id": "b", "value": "Maintenance Hub", "shortForm": "MX", "shortFormOrigin": "edited" }
    ]);
    assert_eq!(
        site.suggestions_from("/api/configuration/preview", None, draft.clone()),
        site.suggestions(None, draft)
    );
}

#[test]
fn the_short_forms_route_refuses_an_invalid_draft_and_writes_nothing() {
    let site = Site::new();
    site.save(json!([{ "id": "a", "value": "Customer Service" }]));
    let refused = site.send(
        "POST",
        "/api/configuration/short-forms",
        Some(json!({ "attributes": [{ "id": "dept", "name": "Dept", "kind": "category",
            "options": [{ "id": "a", "value": "X", "shortForm": "Eleven char", "shortFormOrigin": "edited" }] }],
            "agitations": [], "languages": [] })),
    );
    assert_eq!(refused.status, 400);
    let missing = site.send("POST", "/api/configuration/short-forms", Some(json!({})));
    assert_eq!(missing.status, 400);
    assert_eq!(site.forms(), ["Cust. Svc."]);
}

#[test]
fn the_short_forms_route_answers_only_the_suggestions() {
    let site = Site::new();
    let reply = site.send(
        "POST",
        "/api/configuration/short-forms",
        Some(
            json!({ "attributes": [{ "id": "dept", "name": "Dept", "kind": "category",
            "options": [{ "id": "a", "value": "Kitchen" }] }],
            "agitations": [], "languages": [] }),
        ),
    );
    assert_eq!(reply.status, 200, "{:?}", reply.body);
    assert_eq!(
        reply.body,
        json!({ "shortForms": [
            { "attributeId": "dept", "answerId": "a", "shortForm": "Kitchen", "shortFormOrigin": "generated" }
        ] })
    );
}

impl Site {
    /// `(value, shortForm, shortFormOrigin)` of every option of Attribute `id`, in order.
    fn attribute_forms(&self, id: &str) -> Vec<(String, String, String)> {
        let read = self.send("GET", "/api/dataset", None);
        read.body["attributes"]
            .as_array()
            .expect("attributes")
            .iter()
            .find(|attribute| attribute["id"] == id)
            .unwrap_or_else(|| panic!("{id} is not configured"))["options"]
            .as_array()
            .expect("options")
            .iter()
            .map(|option| {
                (
                    option["value"].as_str().unwrap_or_default().to_owned(),
                    option["shortForm"].as_str().unwrap_or_default().to_owned(),
                    option["shortFormOrigin"]
                        .as_str()
                        .unwrap_or_default()
                        .to_owned(),
                )
            })
            .collect()
    }
}

// Sourced acronyms (ADR 0046): generation uses the worksite's own values across every
// Attribute, not just the one being saved. "PR" for "Public Relations" is the seed
// acronym's ambiguous pair with "Payroll" (crate::short_form_lists::ENGLISH).

#[test]
fn adding_a_value_in_another_attribute_regenerates_a_generated_acronym_that_now_conflicts() {
    let site = Site::new();
    let first = site.send(
        "PUT",
        "/api/attributes",
        Some(json!([
            { "id": "dept", "name": "Dept", "kind": "category",
              "options": [{ "id": "pr", "value": "Public Relations" }] }
        ])),
    );
    assert_eq!(first.status, 200, "{:?}", first.body);
    assert_eq!(
        site.attribute_forms("dept"),
        [(
            "Public Relations".to_owned(),
            "PR".to_owned(),
            "generated".to_owned()
        )]
    );

    // Adding "Payroll" in a different Attribute makes the stored "PR" ambiguous: the next
    // save regenerates it, even though "dept" itself did not change.
    let added = site.send(
        "PUT",
        "/api/attributes",
        Some(json!([
            { "id": "dept", "name": "Dept", "kind": "category",
              "options": [{ "id": "pr", "value": "Public Relations" }] },
            { "id": "other", "name": "Other", "kind": "category",
              "options": [{ "id": "payroll", "value": "Payroll" }] }
        ])),
    );
    assert_eq!(added.status, 200, "{:?}", added.body);
    let dept = site.attribute_forms("dept");
    assert_eq!(dept[0].0, "Public Relations");
    assert_ne!(dept[0].1, "PR");
    assert_eq!(dept[0].2, "generated");
}

#[test]
fn an_edited_acronym_is_never_regenerated_by_a_worksite_conflict() {
    let site = Site::new();
    site.send(
        "PUT",
        "/api/attributes",
        Some(json!([
            { "id": "dept", "name": "Dept", "kind": "category",
              "options": [{ "id": "pr", "value": "Public Relations",
                  "shortForm": "PR", "shortFormOrigin": "edited" }] }
        ])),
    );
    let added = site.send(
        "PUT",
        "/api/attributes",
        Some(json!([
            { "id": "dept", "name": "Dept", "kind": "category",
              "options": [{ "id": "pr", "value": "Public Relations",
                  "shortForm": "PR", "shortFormOrigin": "edited" }] },
            { "id": "other", "name": "Other", "kind": "category",
              "options": [{ "id": "payroll", "value": "Payroll" }] }
        ])),
    );
    assert_eq!(added.status, 200, "{:?}", added.body);
    assert_eq!(
        site.attribute_forms("dept"),
        [(
            "Public Relations".to_owned(),
            "PR".to_owned(),
            "edited".to_owned()
        )]
    );
}

#[test]
fn a_merge_that_removes_the_conflict_lets_the_next_regeneration_use_the_acronym() {
    let site = Site::new();
    site.send(
        "PUT",
        "/api/attributes",
        Some(json!([
            { "id": "dept", "name": "Dept", "kind": "category",
              "options": [{ "id": "pr", "value": "Public Relations" }] },
            { "id": "other", "name": "Other", "kind": "category",
              "options": [
                  { "id": "payroll", "value": "Payroll" },
                  { "id": "pay", "value": "Pay" }
              ] }
        ])),
    );
    // The conflicting "Payroll" blocks the acronym.
    assert_ne!(site.attribute_forms("dept")[0].1, "PR");

    // Merging "Payroll" away removes the conflict.
    let merged = site.send(
        "PUT",
        "/api/attributes",
        Some(json!([
            { "id": "dept", "name": "Dept", "kind": "category",
              "options": [{ "id": "pr", "value": "Public Relations" }] },
            { "id": "other", "name": "Other", "kind": "category",
              "options": [
                  { "id": "payroll", "value": "Payroll", "mergedInto": "pay" },
                  { "id": "pay", "value": "Pay" }
              ] }
        ])),
    );
    assert_eq!(merged.status, 200, "{:?}", merged.body);
    assert_eq!(
        site.attribute_forms("dept"),
        [(
            "Public Relations".to_owned(),
            "PR".to_owned(),
            "generated".to_owned()
        )]
    );
}

// Ticket 05 (ADR 0046): the bundled lists carry a versioned revision, and each Worksite
// records the revision its generated Short forms were last resolved against. A Save or
// preview whose stored revision disagrees regenerates every still-generated Short form
// once and never touches an edited one; a Save then records the new revision. These tests
// forge an older stored revision with plain SQL, the way an app update from an older
// snapshot would leave one behind.

/// The lists revision the Worksite recorded, if any.
fn stored_lists_revision(site: &Site) -> Option<String> {
    site.db
        .conn()
        .query_row(
            "SELECT value FROM app_settings WHERE key = ?1",
            (revision_key(&site.worksite),),
            |row| row.get(0),
        )
        .ok()
}

/// Forge the stored lists revision the way an app update from an older snapshot would
/// leave one behind.
fn forge_lists_revision(site: &Site, revision: &str) {
    site.db
        .conn()
        .execute(
            "INSERT INTO app_settings (key, value) VALUES (?1, ?2) \
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            (revision_key(&site.worksite), revision.to_owned()),
        )
        .expect("forge the stored lists revision");
}

/// Replace the stored `dept` options the way an older snapshot would have stored them.
fn forge_stored_options(site: &Site, options: Value) {
    site.db
        .conn()
        .execute(
            "UPDATE worker_attributes SET options = ?1 WHERE id = 'dept'",
            (serde_json::to_string(&options).expect("options JSON"),),
        )
        .expect("forge the stored options");
}

#[test]
fn a_save_records_the_bundled_lists_revision() {
    // Seeding records the bundled revision: a fresh Worksite has nothing to resolve.
    let site = Site::new();
    assert_eq!(stored_lists_revision(&site).as_deref(), Some(REVISION));
    let saved = site.save(json!([{ "id": "a", "value": "Customer Service" }]));
    assert_eq!(saved.status, 200, "{:?}", saved.body);
    assert_eq!(stored_lists_revision(&site).as_deref(), Some(REVISION));
}

#[test]
fn a_list_revision_change_regenerates_a_stale_generated_form_and_leaves_an_edited_one() {
    let site = Site::new();
    let saved = site.save(json!([
        { "id": "pr", "value": "Public Relations" },
        { "id": "maint", "value": "Maintenance",
          "shortForm": "My Maint", "shortFormOrigin": "edited" }
    ]));
    assert_eq!(saved.status, 200, "{:?}", saved.body);

    // An older snapshot stored "Public Rel." for Public Relations; the app update that
    // brought the current lists left the older revision behind.
    forge_stored_options(
        &site,
        json!([
            { "id": "pr", "value": "Public Relations",
              "shortForm": "Public Rel.", "shortFormOrigin": "generated" },
            { "id": "maint", "value": "Maintenance",
              "shortForm": "My Maint", "shortFormOrigin": "edited" }
        ]),
    );
    forge_lists_revision(&site, "sf04-seed");

    let saved = site.send(
        "PUT",
        "/api/attributes",
        Some(json!([
            { "id": "dept", "name": "Dept", "kind": "category", "options": [
                { "id": "pr", "value": "Public Relations",
                  "shortForm": "Public Rel.", "shortFormOrigin": "generated" },
                { "id": "maint", "value": "Maintenance",
                  "shortForm": "My Maint", "shortFormOrigin": "edited" }
            ] }
        ])),
    );
    assert_eq!(saved.status, 200, "{:?}", saved.body);
    assert_eq!(
        site.attribute_forms("dept"),
        [
            (
                "Public Relations".to_owned(),
                "PR".to_owned(),
                "generated".to_owned()
            ),
            (
                "Maintenance".to_owned(),
                "My Maint".to_owned(),
                "edited".to_owned()
            )
        ]
    );
    // The Save recorded the revision it resolved against.
    assert_eq!(stored_lists_revision(&site).as_deref(), Some(REVISION));
}

#[test]
fn a_preview_under_a_stale_revision_suggests_regenerated_forms_without_writing_them() {
    let site = Site::new();
    let saved = site.save(json!([{ "id": "pr", "value": "Public Relations" }]));
    assert_eq!(saved.status, 200, "{:?}", saved.body);
    forge_stored_options(
        &site,
        json!([
            { "id": "pr", "value": "Public Relations",
              "shortForm": "Public Rel.", "shortFormOrigin": "generated" }
        ]),
    );
    forge_lists_revision(&site, "sf04-seed");

    let reply = site.suggestions(
        None,
        json!([
            { "id": "pr", "value": "Public Relations",
              "shortForm": "Public Rel.", "shortFormOrigin": "generated" }
        ]),
    );
    assert_eq!(reply, [suggested("pr", "PR", "generated")]);
    // A preview writes nothing: the stale form and the stale revision both stay.
    assert_eq!(
        site.attribute_forms("dept"),
        [(
            "Public Relations".to_owned(),
            "Public Rel.".to_owned(),
            "generated".to_owned()
        )]
    );
    assert_eq!(stored_lists_revision(&site).as_deref(), Some("sf04-seed"));
}
