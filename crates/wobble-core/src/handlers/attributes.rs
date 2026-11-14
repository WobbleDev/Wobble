//! The attributes route: save a Worksite's whole Worker Attribute configuration.

use serde::Serialize;
use serde_json::Value;

use crate::attribute_migration::{StoredAnswer, WorkerAttributeDefinition};
use crate::attribute_persistence::replace_worker_attributes_in;
use crate::configuration_resolution::{
    decode_configuration_resolutions, save_attributes_with_resolutions, ResolutionSaveOutcome,
};
use crate::db::Db;
use crate::error::Result;
use crate::handle::{Request, Response};
use crate::handlers::configuration::coded_configuration_refusal;
use crate::id::IdSource;
use crate::request_worksite::{
    no_active_worksite_response, request_locale, resolve_request_worksite,
};
use crate::router::{json_response, message_response, read_payload};
use crate::serialization::{diagnose_attribute_hierarchy, is_worker_attribute_configuration};

const INVALID_ATTRIBUTE_DEFINITIONS_MESSAGE: &str =
    "Request must contain valid attribute definitions.";

/// `PUT /api/attributes` success body: the stored Attribute configuration.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
struct AttributesReply {
    attributes: Vec<WorkerAttributeDefinition>,
}

/// `PUT /api/attributes` (src/routes/api/attributes/+server.ts:7-31). The Active
/// Worksite is resolved *before* the body is read, unlike the worksite and settings
/// PUTs; a failed replace is an uncaught throw, so `dispatch` answers 500.
pub(crate) fn put_attributes(
    db: &Db,
    request: &Request,
    id_source: &impl IdSource,
) -> Result<Response> {
    let Some(active) = resolve_request_worksite(db.conn(), request)? else {
        return Ok(no_active_worksite_response());
    };

    let payload = match read_payload(request) {
        Ok(payload) => payload,
        Err(response) => return Ok(response),
    };

    // Two Save shapes share this route. The definitions array alone is the current path
    // for ordinary Configuration edits (a rename, reorder or added answer) and cannot
    // resolve a lossy change, so it keeps every refusal. A change that needs explicit
    // resolutions instead sends the preview base and one resolution per affected holder;
    // that Save is atomic and rechecks the base before writing. Removing the array shape
    // would force every ordinary edit through a preview first, so ticket 28 retains it.
    if payload.is_array() {
        if !is_worker_attribute_configuration(&payload) {
            // The legacy array Save keeps its recorded generic refusal for a repeated name
            // (frozen replay fixture); the preview and resolution Save name it with a code.
            if diagnose_attribute_hierarchy(&payload)
                .is_some_and(|diagnosis| diagnosis.code == "configuration_attribute_name_exists")
            {
                return Ok(message_response(400, INVALID_ATTRIBUTE_DEFINITIONS_MESSAGE));
            }
            return Ok(hierarchy_refusal(&payload));
        }

        let definitions = decode_attribute_definitions(&payload);

        let attributes = match replace_worker_attributes_in(
            request_locale(request),
            db.conn(),
            &active,
            &definitions,
            id_source,
        ) {
            Ok(attributes) => attributes,
            Err(error) => match coded_configuration_refusal(&error) {
                Some(response) => return Ok(response),
                None => return Err(error),
            },
        };

        return Ok(json_response(
            200,
            serde_json::to_value(AttributesReply { attributes })?,
        ));
    }

    let Some(object) = payload.as_object() else {
        return Ok(message_response(400, INVALID_ATTRIBUTE_DEFINITIONS_MESSAGE));
    };
    if object
        .keys()
        .any(|key| !matches!(key.as_str(), "attributes" | "base" | "resolutions"))
    {
        return Ok(message_response(400, INVALID_ATTRIBUTE_DEFINITIONS_MESSAGE));
    }
    let (Some(attributes), Some(base), Some(resolutions)) = (
        object.get("attributes"),
        object.get("base").and_then(Value::as_str),
        object.get("resolutions"),
    ) else {
        return Ok(message_response(400, INVALID_ATTRIBUTE_DEFINITIONS_MESSAGE));
    };
    if !is_worker_attribute_configuration(attributes) {
        return Ok(hierarchy_refusal(attributes));
    }
    if base.trim().is_empty() || decode_configuration_resolutions(resolutions).is_none() {
        return Ok(message_response(400, INVALID_ATTRIBUTE_DEFINITIONS_MESSAGE));
    }

    let definitions = decode_attribute_definitions(attributes);
    let resolutions = decode_configuration_resolutions(resolutions)
        .expect("the resolutions body was just proved decodable");
    match save_attributes_with_resolutions(
        request_locale(request),
        db.conn(),
        &active,
        &definitions,
        &resolutions,
        base,
        id_source,
    )? {
        ResolutionSaveOutcome::Saved { attributes } => Ok(json_response(
            200,
            serde_json::to_value(AttributesReply { attributes })?,
        )),
        ResolutionSaveOutcome::Refused(refusal) => Ok(crate::router::coded_message_response(
            refusal.status,
            refusal.code,
            &refusal.message,
        )),
    }
}

/// A refused definition list: a diagnosable hierarchy problem answers its own stable
/// code, so the client can tell a sibling clash from malformed JSON; every other shape
/// problem keeps the shared generic 400.
fn hierarchy_refusal(payload: &Value) -> Response {
    match diagnose_attribute_hierarchy(payload) {
        Some(diagnosis) => {
            crate::router::coded_message_response(400, diagnosis.code, &diagnosis.message)
        }
        None => message_response(400, INVALID_ATTRIBUTE_DEFINITIONS_MESSAGE),
    }
}

/// The Save body's definitions as the core takes them. The caller has already proved the
/// shape with `is_worker_attribute_configuration`, so the fallbacks only keep the
/// extraction total. The preview reads its request through this same decode.
pub(crate) fn decode_attribute_definitions(payload: &Value) -> Vec<WorkerAttributeDefinition> {
    payload
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or_default()
        .iter()
        .map(|definition| WorkerAttributeDefinition {
            id: definition
                .get("id")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned(),
            name: definition
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .trim()
                .to_owned(),
            kind: definition
                .get("kind")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned(),
            options: definition
                .get("options")
                .and_then(Value::as_array)
                .map(Vec::as_slice)
                .unwrap_or_default()
                .iter()
                .filter_map(wire_answer)
                .collect(),
        })
        .collect()
}

/// One answer of a Save request as the typed definition takes it: `{id, value}` with the
/// value trimmed, plus the `mergedInto` marker when present. The guard has already proved
/// the shape, so a missing field reads as `None` and the answer is dropped.
fn wire_answer(answer: &Value) -> Option<StoredAnswer> {
    let text = |key: &str| answer.get(key).and_then(Value::as_str).map(str::to_owned);
    let mut stored = StoredAnswer {
        id: answer.get("id")?.as_str()?.to_owned(),
        value: answer.get("value")?.as_str()?.trim().to_owned(),
        parent_id: text("parentId"),
        mode: text("mode"),
        short_form: text("shortForm"),
        short_form_origin: text("shortFormOrigin"),
        abbreviation: text("abbreviation"),
        abbreviation_origin: text("abbreviationOrigin"),
        merged_into: text("mergedInto"),
    };
    // Either wire name is accepted while both exist; both together must agree.
    stored.sync_abbreviation().then_some(stored)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::assembly::read_workers;
    use crate::attribute_persistence::get_worker_attributes;
    use crate::id::CounterId;
    use crate::router::dispatch;
    use crate::test_support::{first_worksite, request, seeded};
    use crate::worksite_persistence::{delete_worksite, resolve_active_worksite};
    use serde_json::json;

    #[test]
    fn put_attributes_resolves_the_active_worksite_before_it_reads_the_body() {
        let (db, ids) = seeded();
        let id = first_worksite(&db);
        delete_worksite(db.conn(), &id).unwrap();

        let mut malformed = Request {
            method: "PUT".to_owned(),
            path: "/api/attributes".to_owned(),
            query: String::new(),
            headers: vec![("content-type".to_owned(), "application/json".to_owned())],
            body: Some("{not json".to_owned()),
        };

        // No Active Worksite wins over the malformed body: the resolve comes first.
        let response = dispatch(&db, &malformed, &ids);
        assert_eq!(response.status, 409);
        assert_eq!(
            response.body,
            json!({ "message": "There is no Active Worksite." })
        );

        // The worksite PUT reads its body first, so the same body is a 400 there.
        malformed.path = "/api/worksite".to_owned();
        let response = dispatch(&db, &malformed, &ids);
        assert_eq!(response.status, 400);
        assert_eq!(
            response.body,
            json!({ "message": "Request body must contain valid JSON." })
        );
    }

    #[test]
    fn put_attributes_trims_names_and_options_and_answers_the_stored_configuration() {
        let (db, ids) = seeded();

        let response = dispatch(
            &db,
            &request(
                "PUT",
                "/api/attributes",
                Some(json!([
                    {
                        "id": "dept",
                        "name": "  Department  ",
                        "kind": "tag",
                        "options": [
                            { "id": "dinner", "value": "  Dinner  " },
                            { "id": "prep", "value": " Prep " }
                        ]
                    }
                ])),
            ),
            &ids,
        );

        assert_eq!(response.status, 200);
        assert_eq!(
            response.body,
            json!({ "attributes": [
                { "id": "dept", "name": "Department", "kind": "tag", "options": [
                    { "id": "dinner", "value": "Dinner", "shortForm": "Dinner", "shortFormOrigin": "generated", "abbreviation": "Dinner", "abbreviationOrigin": "generated" },
                    { "id": "prep", "value": "Prep", "shortForm": "Prep", "shortFormOrigin": "generated", "abbreviation": "Prep", "abbreviationOrigin": "generated" }
                ] }
            ] })
        );
    }

    fn configuration(departments: Value, shifts: Value) -> Value {
        json!([
            { "id": "dept", "name": "Department", "kind": "category", "options": departments },
            { "id": "shifts", "name": "Shifts", "kind": "tag", "options": shifts }
        ])
    }

    fn save_configuration(db: &Db, ids: &CounterId, departments: Value, shifts: Value) -> Response {
        dispatch(
            db,
            &request(
                "PUT",
                "/api/attributes",
                Some(configuration(departments, shifts)),
            ),
            ids,
        )
    }

    /// Adds a Worker holding the given answer ids through the create route.
    fn add_worker(db: &Db, ids: &CounterId, name: &str, department: &str, shifts: Value) {
        let response = dispatch(
            db,
            &request(
                "POST",
                "/api/workers",
                Some(json!({
                    "name": name,
                    "email": "",
                    "phone": "",
                    "assessment": "Unassessed",
                    "attributes": { "dept": department, "shifts": shifts },
                    "agitations": [],
                    "languages": [],
                    "relationships": [],
                    "notes": []
                })),
            ),
            ids,
        );
        assert_eq!(response.status, 201, "{:?}", response.body);
    }

    /// One Worker's stored answer ids, read back through the assembly.
    fn held_by(db: &Db, name: &str) -> Value {
        let worksite = resolve_active_worksite(db.conn(), None).unwrap();
        read_workers(db.conn(), &worksite)
            .unwrap()
            .into_iter()
            .find(|worker| worker.name == name)
            .expect("the Worker")
            .attributes
    }

    #[test]
    fn a_renamed_answer_keeps_every_holder_because_the_id_stays() {
        let (db, ids) = seeded();
        let before = save_configuration(
            &db,
            &ids,
            json!([{ "id": "d1", "value": "Front" }, { "id": "d2", "value": "Back" }]),
            json!([{ "id": "s1", "value": "Dinner" }, { "id": "s2", "value": "Brunch" }]),
        );
        assert_eq!(before.status, 200);
        add_worker(&db, &ids, "Ann", "d2", json!(["s1", "s2"]));
        add_worker(&db, &ids, "Bo", "", json!(["s2"]));

        let renamed = save_configuration(
            &db,
            &ids,
            json!([{ "id": "d1", "value": "Front" }, { "id": "d2", "value": "Rear" }]),
            json!([{ "id": "s1", "value": "Supper" }, { "id": "s2", "value": "Brunch" }]),
        );
        assert_eq!(renamed.status, 200);

        // A second rename, chained onto the first, still resolves by id.
        let chained = save_configuration(
            &db,
            &ids,
            json!([{ "id": "d1", "value": "Front" }, { "id": "d2", "value": "Behind" }]),
            json!([{ "id": "s1", "value": "Late" }, { "id": "s2", "value": "Brunch" }]),
        );
        assert_eq!(chained.status, 200);

        assert_eq!(
            held_by(&db, "Ann"),
            json!({ "dept": "d2", "shifts": ["s1", "s2"] })
        );
        assert_eq!(held_by(&db, "Bo"), json!({ "dept": "", "shifts": ["s2"] }));
        assert_eq!(
            chained.body["attributes"][0]["options"][1]["value"],
            "Behind"
        );
    }

    #[test]
    fn a_removed_answer_is_pruned_from_every_worker_who_holds_it() {
        let (db, ids) = seeded();
        save_configuration(
            &db,
            &ids,
            json!([{ "id": "d1", "value": "Front" }, { "id": "d2", "value": "Back" }]),
            json!([{ "id": "s1", "value": "Dinner" }, { "id": "s2", "value": "Brunch" }]),
        );
        add_worker(&db, &ids, "Ann", "d2", json!(["s1", "s2"]));
        add_worker(&db, &ids, "Bo", "", json!(["s2"]));

        let removed = save_configuration(
            &db,
            &ids,
            json!([{ "id": "d1", "value": "Front" }]),
            json!([{ "id": "s1", "value": "Dinner" }]),
        );
        assert_eq!(removed.status, 200);

        assert_eq!(held_by(&db, "Ann"), json!({ "dept": "", "shifts": ["s1"] }));
        assert_eq!(held_by(&db, "Bo"), json!({ "dept": "", "shifts": [] }));
    }

    #[test]
    fn a_category_merge_moves_every_holder_of_the_folded_answer_to_the_survivor() {
        let (db, ids) = seeded();
        save_configuration(
            &db,
            &ids,
            json!([{ "id": "d1", "value": "Front" }, { "id": "d2", "value": "Back" }]),
            json!([]),
        );
        add_worker(&db, &ids, "Ann", "d2", json!([]));
        add_worker(&db, &ids, "Bo", "d1", json!([]));

        let merged = save_configuration(
            &db,
            &ids,
            json!([
                { "id": "d1", "value": "Front" },
                { "id": "d2", "value": "Back", "mergedInto": "d1" }
            ]),
            json!([]),
        );
        assert_eq!(merged.status, 200, "{:?}", merged.body);
        assert_eq!(
            merged.body["attributes"][0]["options"],
            json!([{ "id": "d1", "value": "Front", "shortForm": "Front", "shortFormOrigin": "generated", "abbreviation": "Front", "abbreviationOrigin": "generated" }])
        );

        assert_eq!(held_by(&db, "Ann"), json!({ "dept": "d1", "shifts": [] }));
        assert_eq!(held_by(&db, "Bo"), json!({ "dept": "d1", "shifts": [] }));
    }

    #[test]
    fn a_tag_merge_ends_a_worker_who_held_both_with_the_survivor_once() {
        let (db, ids) = seeded();
        save_configuration(
            &db,
            &ids,
            json!([]),
            json!([{ "id": "s1", "value": "Dinner" }, { "id": "s2", "value": "Brunch" }]),
        );
        add_worker(&db, &ids, "Ann", "", json!(["s1", "s2"]));
        add_worker(&db, &ids, "Bo", "", json!(["s2"]));

        let merged = save_configuration(
            &db,
            &ids,
            json!([]),
            json!([
                { "id": "s1", "value": "Dinner" },
                { "id": "s2", "value": "Brunch", "mergedInto": "s1" }
            ]),
        );
        assert_eq!(merged.status, 200, "{:?}", merged.body);

        assert_eq!(held_by(&db, "Ann"), json!({ "dept": "", "shifts": ["s1"] }));
        assert_eq!(held_by(&db, "Bo"), json!({ "dept": "", "shifts": ["s1"] }));
    }

    #[test]
    fn swapping_two_answers_texts_by_id_moves_no_worker() {
        let (db, ids) = seeded();
        save_configuration(
            &db,
            &ids,
            json!([{ "id": "d1", "value": "Front" }, { "id": "d2", "value": "Back" }]),
            json!([]),
        );
        add_worker(&db, &ids, "Ann", "d1", json!([]));
        add_worker(&db, &ids, "Bo", "d2", json!([]));

        let swapped = save_configuration(
            &db,
            &ids,
            json!([{ "id": "d1", "value": "Back" }, { "id": "d2", "value": "Front" }]),
            json!([]),
        );
        assert_eq!(swapped.status, 200, "{:?}", swapped.body);

        // Ann still holds d1, which now reads "Back": identity followed the id, not the text.
        assert_eq!(held_by(&db, "Ann"), json!({ "dept": "d1", "shifts": [] }));
        assert_eq!(held_by(&db, "Bo"), json!({ "dept": "d2", "shifts": [] }));
        assert_eq!(swapped.body["attributes"][0]["options"][0]["value"], "Back");
    }

    #[test]
    fn a_failed_save_rolls_back_the_definitions_and_the_worker_rewrites_together() {
        let (db, ids) = seeded();
        save_configuration(
            &db,
            &ids,
            json!([{ "id": "d1", "value": "Front" }, { "id": "d2", "value": "Back" }]),
            json!([{ "id": "s1", "value": "Dinner" }, { "id": "s2", "value": "Brunch" }]),
        );
        add_worker(&db, &ids, "Ann", "d2", json!(["s1", "s2"]));
        let worksite = resolve_active_worksite(db.conn(), None).unwrap();
        let definitions_before = get_worker_attributes(db.conn(), &worksite).unwrap();
        let held_before = held_by(&db, "Ann");

        // Refuse every worker answer rewrite, so the Save fails after the definitions moved.
        db.conn()
            .execute_batch(
                "CREATE TRIGGER refuse_answer_insert BEFORE INSERT ON worker_attribute_values \
                 BEGIN SELECT RAISE(ABORT, 'refused'); END; \
                 CREATE TRIGGER refuse_answer_update BEFORE UPDATE ON worker_attribute_values \
                 BEGIN SELECT RAISE(ABORT, 'refused'); END;",
            )
            .unwrap();

        // A rename, a merge into d1 that Ann must follow, and a removal of s2 that Ann holds.
        let failed = save_configuration(
            &db,
            &ids,
            json!([
                { "id": "d1", "value": "Front" },
                { "id": "d2", "value": "Rear", "mergedInto": "d1" }
            ]),
            json!([{ "id": "s1", "value": "Supper" }]),
        );
        assert_eq!(failed.status, 500);

        assert_eq!(
            get_worker_attributes(db.conn(), &worksite).unwrap(),
            definitions_before
        );
        assert_eq!(held_by(&db, "Ann"), held_before);
    }

    /// Two ordinary Attributes, each with a Central parent and a Store A child. The extra
    /// Role answer is appended for a hierarchy edit.
    fn hierarchy_configuration(extra_role: Value) -> Value {
        let mut role = vec![
            json!({ "id": "r-central", "value": "Central" }),
            json!({ "id": "r-store-a", "value": "Store A", "parentId": "r-central" }),
        ];
        if !extra_role.is_null() {
            role.push(extra_role);
        }
        json!([
            { "id": "role", "name": "Role", "kind": "category", "options": role },
            { "id": "location", "name": "Location", "kind": "category", "options": [
                { "id": "l-central", "value": "Central" },
                { "id": "l-store-a", "value": "Store A", "parentId": "l-central" }
            ] }
        ])
    }

    #[test]
    fn hierarchy_saves_parents_and_preserves_ids_order_holders_and_drafts() {
        let (db, ids) = seeded();
        let first = dispatch(
            &db,
            &request(
                "PUT",
                "/api/attributes",
                Some(hierarchy_configuration(Value::Null)),
            ),
            &ids,
        );
        assert_eq!(first.status, 200, "{:?}", first.body);

        let created = dispatch(
            &db,
            &request(
                "POST",
                "/api/workers",
                Some(json!({
                    "name": "Ann", "email": "", "phone": "", "assessment": "Unassessed",
                    "attributes": { "role": "r-central", "location": "l-central" },
                    "agitations": [], "languages": [], "relationships": [], "notes": []
                })),
            ),
            &ids,
        );
        assert_eq!(created.status, 201, "{:?}", created.body);

        let draft = dispatch(
            &db,
            &request(
                "PUT",
                "/api/worker-drafts/new",
                Some(json!({
                    "update": {
                        "name": "Draft Worker", "email": "", "phone": "", "assessment": "Unassessed",
                        "attributes": { "role": "r-store-a", "location": "" },
                        "agitations": [], "languages": [], "relationships": [], "notes": []
                    },
                    "base": null,
                    "pendingNote": { "text": "keep this note" }
                })),
            ),
            &ids,
        );
        assert_eq!(draft.status, 200, "{:?}", draft.body);

        // Rename the parent, add a child beneath Store A, and keep every id and position.
        let edited = dispatch(
            &db,
            &request(
                "PUT",
                "/api/attributes",
                Some(json!([
                    { "id": "role", "name": "Role", "kind": "category", "options": [
                        { "id": "r-central", "value": "Downtown" },
                        { "id": "r-store-a", "value": "Store A", "parentId": "r-central" },
                        { "id": "r-dock", "value": "Loading dock", "parentId": "r-store-a" }
                    ] },
                    { "id": "location", "name": "Location", "kind": "category", "options": [
                        { "id": "l-central", "value": "Downtown" },
                        { "id": "l-store-a", "value": "Store A", "parentId": "l-central" }
                    ] }
                ])),
            ),
            &ids,
        );
        assert_eq!(edited.status, 200, "{:?}", edited.body);
        assert_eq!(
            edited.body["attributes"][0]["options"],
            json!([
                { "id": "r-central", "value": "Downtown", "shortForm": "Downtown", "shortFormOrigin": "generated", "abbreviation": "Downtown", "abbreviationOrigin": "generated" },
                { "id": "r-store-a", "value": "Store A", "parentId": "r-central", "shortForm": "Store A", "shortFormOrigin": "generated", "abbreviation": "Store A", "abbreviationOrigin": "generated" },
                { "id": "r-dock", "value": "Loading dock", "parentId": "r-store-a", "shortForm": "Loading d…", "shortFormOrigin": "generated", "abbreviation": "Loading d…", "abbreviationOrigin": "generated" }
            ])
        );

        let dataset = dispatch(&db, &request("GET", "/api/dataset", None), &ids);
        assert_eq!(dataset.status, 200, "{:?}", dataset.body);
        let worker = &dataset.body["workers"][0];
        assert_eq!(
            worker["attributes"],
            json!({ "role": "r-central", "location": "l-central" })
        );

        let restored = dispatch(&db, &request("GET", "/api/worker-drafts/new", None), &ids);
        assert_eq!(
            restored.body["draft"]["update"]["attributes"],
            json!({ "role": "r-store-a", "location": "" })
        );
        assert_eq!(
            restored.body["draft"]["pendingNote"]["text"],
            "keep this note"
        );
    }

    #[test]
    fn a_direct_parent_selection_saves_the_parent_without_inventing_a_child() {
        let (db, ids) = seeded();
        assert_eq!(
            dispatch(
                &db,
                &request(
                    "PUT",
                    "/api/attributes",
                    Some(hierarchy_configuration(Value::Null))
                ),
                &ids
            )
            .status,
            200
        );
        let created = dispatch(
            &db,
            &request(
                "POST",
                "/api/workers",
                Some(json!({
                    "name": "Casey", "email": "", "phone": "", "assessment": "Unassessed",
                    "attributes": { "role": "r-central", "location": "l-central" },
                    "agitations": [], "languages": [], "relationships": [], "notes": []
                })),
            ),
            &ids,
        );
        assert_eq!(created.status, 201, "{:?}", created.body);

        let dataset = dispatch(&db, &request("GET", "/api/dataset", None), &ids);
        let worker = &dataset.body["workers"][0];
        assert_eq!(
            worker["attributes"],
            json!({ "role": "r-central", "location": "l-central" })
        );
        // Selecting the parent created no child answer.
        assert_eq!(
            dataset.body["attributes"][1]["options"],
            json!([
                { "id": "l-central", "value": "Central", "shortForm": "Central", "shortFormOrigin": "generated", "abbreviation": "Central", "abbreviationOrigin": "generated" },
                { "id": "l-store-a", "value": "Store A", "parentId": "l-central", "shortForm": "Store A", "shortFormOrigin": "generated", "abbreviation": "Store A", "abbreviationOrigin": "generated" }
            ])
        );
        assert_eq!(
            dataset.body["attributes"][0]["options"]
                .as_array()
                .unwrap()
                .len(),
            2
        );
    }

    #[test]
    fn a_legacy_save_cannot_remove_a_branch_that_still_has_children() {
        let (db, ids) = seeded();
        assert_eq!(
            dispatch(
                &db,
                &request(
                    "PUT",
                    "/api/attributes",
                    Some(hierarchy_configuration(Value::Null))
                ),
                &ids
            )
            .status,
            200
        );
        let created = dispatch(
            &db,
            &request(
                "POST",
                "/api/workers",
                Some(json!({
                    "name": "Dana", "email": "", "phone": "", "assessment": "Unassessed",
                    "attributes": { "role": "", "location": "l-store-a" }, "agitations": [], "languages": [], "relationships": [], "notes": []
                })),
            ),
            &ids,
        );
        assert_eq!(created.status, 201, "{:?}", created.body);
        let _worker_id = created.body["worker"]["id"].as_str().unwrap().to_owned();
        let before = dispatch(&db, &request("GET", "/api/dataset", None), &ids).body;

        // Removing the parent and its child in one array Save is a branch removal the
        // legacy shape cannot prove, so it is refused and nothing moves.
        let mut without_branch = hierarchy_configuration(Value::Null);
        without_branch[1]["options"] = json!([]);
        let refused = dispatch(
            &db,
            &request("PUT", "/api/attributes", Some(without_branch)),
            &ids,
        );
        assert_eq!(refused.status, 400, "{:?}", refused.body);
        assert_eq!(refused.body["code"], "configuration_answer_has_children");
        assert_eq!(
            dispatch(&db, &request("GET", "/api/dataset", None), &ids).body,
            before
        );
    }

    #[test]
    fn invalid_hierarchies_are_refused_through_the_request_boundary_without_writes() {
        let (db, ids) = seeded();
        assert_eq!(
            dispatch(
                &db,
                &request(
                    "PUT",
                    "/api/attributes",
                    Some(hierarchy_configuration(Value::Null))
                ),
                &ids
            )
            .status,
            200
        );
        let before = dispatch(&db, &request("GET", "/api/dataset", None), &ids).body;

        let mut cross_attribute = hierarchy_configuration(Value::Null);
        cross_attribute[0]["options"][1]["parentId"] = json!("l-central");
        let invalid = [
            // Two answers parent each other.
            json!([
                { "id": "role", "name": "Role", "kind": "category", "options": [
                    { "id": "a", "value": "A", "parentId": "b" },
                    { "id": "b", "value": "B", "parentId": "a" }
                ] }
            ]),
            // A longer loop back to its own start.
            json!([
                { "id": "role", "name": "Role", "kind": "category", "options": [
                    { "id": "a", "value": "A", "parentId": "b" },
                    { "id": "b", "value": "B", "parentId": "c" },
                    { "id": "c", "value": "C", "parentId": "a" }
                ] }
            ]),
            // An answer as its own parent.
            json!([
                { "id": "role", "name": "Role", "kind": "category", "options": [
                    { "id": "a", "value": "A", "parentId": "a" }
                ] }
            ]),
            // A parent in another Attribute.
            cross_attribute,
            // A parent that does not exist.
            json!([
                { "id": "role", "name": "Role", "kind": "category", "options": [
                    { "id": "a", "value": "A", "parentId": "nope" }
                ] }
            ]),
            // Two siblings under Central with the same label.
            json!([
                { "id": "role", "name": "Role", "kind": "category", "options": [
                    { "id": "central", "value": "Central" },
                    { "id": "a", "value": "Packing", "parentId": "central" },
                    { "id": "b", "value": " packing ", "parentId": "central" }
                ] }
            ]),
            // A merge that folds a parent away while a child still points at it.
            json!([
                { "id": "role", "name": "Role", "kind": "category", "options": [
                    { "id": "central", "value": "Central", "mergedInto": "other" },
                    { "id": "other", "value": "Other" },
                    { "id": "store-a", "value": "Store A", "parentId": "central" }
                ] }
            ]),
        ];
        for body in invalid {
            let refused = dispatch(
                &db,
                &request("PUT", "/api/attributes", Some(body.clone())),
                &ids,
            );
            assert_eq!(refused.status, 400, "{body} => {:?}", refused.body);
            assert_eq!(
                dispatch(&db, &request("GET", "/api/dataset", None), &ids).body,
                before,
                "{body} changed the dataset"
            );
        }
    }

    #[test]
    fn a_save_refuses_text_on_the_wire_duplicate_ids_and_dangling_merges() {
        let (db, ids) = seeded();
        let refused = [
            // The pre-v14 contract: answers as plain text.
            configuration(json!(["Front"]), json!([])),
            // An answer id repeated across the Worksite.
            configuration(
                json!([{ "id": "x", "value": "Front" }]),
                json!([{ "id": "x", "value": "Dinner" }]),
            ),
            // Two answers whose texts differ only by case.
            configuration(
                json!([{ "id": "d1", "value": "Front" }, { "id": "d2", "value": "front" }]),
                json!([]),
            ),
            // A merge into an answer the Attribute does not keep.
            configuration(
                json!([
                    { "id": "d1", "value": "Front", "mergedInto": "nope" },
                    { "id": "d2", "value": "Back" }
                ]),
                json!([]),
            ),
            // A merge into an answer that is itself being folded.
            configuration(
                json!([
                    { "id": "d1", "value": "Front", "mergedInto": "d2" },
                    { "id": "d2", "value": "Back", "mergedInto": "d1" }
                ]),
                json!([]),
            ),
        ];
        for body in refused {
            let response = dispatch(
                &db,
                &request("PUT", "/api/attributes", Some(body.clone())),
                &ids,
            );
            assert_eq!(response.status, 400, "{body}");
        }
    }
}
