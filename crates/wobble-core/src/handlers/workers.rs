//! The Worker routes: create (one, named, or an imported batch), replace, patch and delete.
//! Each handler reads the body, hands it to the service, and maps the outcome to a response.

use serde::Serialize;
use serde_json::Value;

use crate::assembly::Worker;
use crate::db::Db;
use crate::error::Result;
use crate::handle::{Request, Response};
use crate::id::IdSource;
use crate::request_worksite::{no_active_worksite_response, resolve_request_worksite};
use crate::router::{coded_message_response, json_response, read_payload};
use crate::schema::Worksite;
use crate::service::{
    create_named_worker, create_worker_from_payload, delete_worker, import_workers_from_payload,
    patch_worker_from_payload, update_worker_from_payload, ImportOutcome, PayloadOutcome,
    WorkerCreateResult, WorkerPatchOutcome, WorkerUpdateResult,
};

const CONTACT_NAME_REQUIRED_MESSAGE: &str = "Contact name is required.";
/// `POST /api/workers` (src/routes/api/workers/+server.ts:30-35).
const INVALID_RELATIONSHIPS_MESSAGE: &str =
    "Relationships must reference existing workers and cannot include this worker.";
/// `PUT /api/workers/{id}` (src/routes/api/workers/[id]/+server.ts:91-99) — the two
/// routes' messages differ by this "other", and the fixtures pin both.
const INVALID_UPDATED_RELATIONSHIPS_MESSAGE: &str =
    "Relationships must reference other existing workers and cannot include this worker.";
/// `PATCH /api/workers/{id}` with `field: "relationships"` — the per-pair add and remove
/// actions. The route's error copy belongs to the UI (ADR-0024), so these are diagnostic.
const RELATIONSHIP_EXISTS_MESSAGE: &str = "These workers are already related.";
const RELATIONSHIP_NOT_FOUND_MESSAGE: &str = "These workers are not related.";
const WORKER_NOT_FOUND_MESSAGE: &str = "Worker not found.";

/// The 400 a refused Worker body answers.
fn invalid_worker_response(message: &str) -> Response {
    coded_message_response(400, "invalid_worker", message)
}

/// `{worker}` for a Worker that was just changed.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
struct WorkerReply {
    worker: Worker,
}

/// `{workerId}` for a Worker that was just deleted.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
struct WorkerDeletedReply {
    worker_id: String,
}

/// One created Worker of an import, against the CSV row it came from.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
struct ImportedRow {
    row: u32,
    id: String,
}

/// `{imported, created}` for a finished contact import: the count, and every created id
/// with its source row number, in request order.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
struct ImportReply {
    imported: usize,
    created: Vec<ImportedRow>,
}

/// `{worker}` for a Worker that was just changed.
fn worker_response(status: u16, worker: Worker) -> Result<Response> {
    Ok(json_response(
        status,
        serde_json::to_value(WorkerReply { worker })?,
    ))
}

fn worker_not_found_response() -> Response {
    coded_message_response(404, "worker_not_found", WORKER_NOT_FOUND_MESSAGE)
}

/// `POST /api/workers` (src/routes/api/workers/+server.ts:61-74). The Active Worksite is
/// resolved before the body is read; an array body is a contact import, anything else is
/// one worker.
pub(crate) fn post_worker(
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

    if payload.is_array() || is_reviewed_import(&payload) {
        return import_contact_batch(db, &active, &payload, id_source);
    }

    if is_name_only(&payload) {
        return create_named_worker_route(db, &active, &payload, id_source);
    }

    create_single_worker(db, &active, &payload, id_source)
}

/// True when the body is `{ "contacts": [...], ... }`: a reviewed import.
fn is_reviewed_import(payload: &Value) -> bool {
    payload.get("contacts").is_some_and(Value::is_array)
}

/// True when the body is exactly `{ "name": "…" }`: New Worker, which names a Worker and
/// nothing else.
fn is_name_only(payload: &Value) -> bool {
    let Some(object) = payload.as_object() else {
        return false;
    };

    object.len() == 1 && object.get("name").is_some_and(Value::is_string)
}

/// The create answers both create routes share.
fn create_result_response(result: WorkerCreateResult) -> Result<Response> {
    match result {
        WorkerCreateResult::Created { worker } => worker_response(201, *worker),
        // Unreachable through these routes (the Worksite was resolved above), and still
        // answered exactly as the TS branch does.
        WorkerCreateResult::NoActiveWorksite => Ok(no_active_worksite_response()),
        WorkerCreateResult::InvalidRelationships => Ok(coded_message_response(
            400,
            "relationship_unknown_worker",
            INVALID_RELATIONSHIPS_MESSAGE,
        )),
        WorkerCreateResult::InvalidAgitations { message }
        | WorkerCreateResult::InvalidLanguages { message } => Ok(coded_message_response(
            400,
            "vocabulary_other_worksite",
            &message,
        )),
    }
}

/// `POST /api/workers` with a name alone.
fn create_named_worker_route(
    db: &Db,
    active: &Worksite,
    payload: &Value,
    id_source: &impl IdSource,
) -> Result<Response> {
    let name = payload
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim();
    if name.is_empty() {
        return Ok(invalid_worker_response(CONTACT_NAME_REQUIRED_MESSAGE));
    }

    create_result_response(create_named_worker(db.conn(), active, name, id_source)?)
}

/// `createSingleWorker` (src/routes/api/workers/+server.ts:14-45).
fn create_single_worker(
    db: &Db,
    active: &Worksite,
    payload: &Value,
    id_source: &impl IdSource,
) -> Result<Response> {
    Ok(
        match create_worker_from_payload(db.conn(), active, payload, id_source)? {
            PayloadOutcome::Invalid { message } => invalid_worker_response(&message),
            PayloadOutcome::Done(result) => create_result_response(result)?,
        },
    )
}

/// `importContactBatch` (src/routes/api/workers/+server.ts:47-59).
fn import_contact_batch(
    db: &Db,
    active: &Worksite,
    payload: &Value,
    id_source: &impl IdSource,
) -> Result<Response> {
    Ok(
        match import_workers_from_payload(db.conn(), active, payload, id_source)? {
            PayloadOutcome::Invalid { message } => invalid_worker_response(&message),
            PayloadOutcome::Done(ImportOutcome::Created(created)) => json_response(
                200,
                serde_json::to_value(ImportReply {
                    imported: created.len(),
                    created: created
                        .into_iter()
                        .map(|(row, id)| ImportedRow { row, id })
                        .collect(),
                })?,
            ),
            PayloadOutcome::Done(ImportOutcome::StaleVocabulary) => coded_message_response(
                409,
                "import_stale_vocabulary",
                "The Attributes changed after the review.",
            ),
            PayloadOutcome::Done(ImportOutcome::NoWorksite) => no_active_worksite_response(),
        },
    )
}

/// `PUT /api/workers/{id}` (src/routes/api/workers/[id]/+server.ts:76-108). The body is
/// read before the Worksite is resolved, unlike the POST.
pub(crate) fn put_worker(db: &Db, request: &Request, worker_id: &str) -> Result<Response> {
    let payload = match read_payload(request) {
        Ok(payload) => payload,
        Err(response) => return Ok(response),
    };

    let worksite = resolve_request_worksite(db.conn(), request)?;

    Ok(
        match update_worker_from_payload(db.conn(), worksite.as_ref(), worker_id, &payload)? {
            PayloadOutcome::Invalid { message } => invalid_worker_response(&message),
            PayloadOutcome::Done(WorkerUpdateResult::Updated { worker }) => {
                worker_response(200, *worker)?
            }
            PayloadOutcome::Done(WorkerUpdateResult::NotFound) => worker_not_found_response(),
            PayloadOutcome::Done(WorkerUpdateResult::InvalidRelationships) => {
                coded_message_response(
                    400,
                    "relationship_unknown_worker",
                    INVALID_UPDATED_RELATIONSHIPS_MESSAGE,
                )
            }
            PayloadOutcome::Done(
                WorkerUpdateResult::InvalidAgitations { message }
                | WorkerUpdateResult::InvalidLanguages { message },
            ) => coded_message_response(400, "vocabulary_other_worksite", &message),
        },
    )
}

/// `PATCH /api/workers/{id}` (src/routes/api/workers/[id]/+server.ts:110-121), then
/// `dispatchWorkerPatch` (:22-66).
pub(crate) fn patch_worker(
    db: &Db,
    request: &Request,
    worker_id: &str,
    id_source: &impl IdSource,
) -> Result<Response> {
    let payload = match read_payload(request) {
        Ok(payload) => payload,
        Err(response) => return Ok(response),
    };

    let worksite = resolve_request_worksite(db.conn(), request)?;

    let outcome = match patch_worker_from_payload(
        db.conn(),
        worksite.as_ref(),
        worker_id,
        &payload,
        id_source,
    )? {
        PayloadOutcome::Invalid { message } => return Ok(invalid_worker_response(&message)),
        PayloadOutcome::Done(outcome) => outcome,
    };

    Ok(match outcome {
        WorkerPatchOutcome::Updated { worker } => worker_response(200, *worker)?,
        WorkerPatchOutcome::NotFound => worker_not_found_response(),
        WorkerPatchOutcome::InvalidVocabulary { message } => {
            coded_message_response(400, "vocabulary_other_worksite", &message)
        }
        WorkerPatchOutcome::InvalidOtherWorker => coded_message_response(
            400,
            "relationship_unknown_worker",
            INVALID_UPDATED_RELATIONSHIPS_MESSAGE,
        ),
        WorkerPatchOutcome::AlreadyRelated => coded_message_response(
            400,
            "relationship_already_exists",
            RELATIONSHIP_EXISTS_MESSAGE,
        ),
        WorkerPatchOutcome::NotRelated => coded_message_response(
            400,
            "relationship_not_found",
            RELATIONSHIP_NOT_FOUND_MESSAGE,
        ),
    })
}

/// `DELETE /api/workers/{id}` (src/routes/api/workers/[id]/+server.ts:68-74). No body is
/// read, and a missing Active Worksite is a 404 rather than a 409.
pub(crate) fn delete_worker_route(db: &Db, request: &Request, worker_id: &str) -> Result<Response> {
    let worksite = resolve_request_worksite(db.conn(), request)?;

    if !delete_worker(db.conn(), worksite.as_ref(), worker_id)? {
        return Ok(worker_not_found_response());
    }

    Ok(json_response(
        200,
        serde_json::to_value(WorkerDeletedReply {
            worker_id: worker_id.to_owned(),
        })?,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::router::dispatch;
    use crate::test_support::{first_worksite, request, request_for, seeded};
    use crate::worker_persistence::insert_bare_worker;
    use crate::worksite_persistence::{create_worksite, delete_worksite};
    use rusqlite::params;
    use serde_json::json;

    #[test]
    fn post_worker_resolves_the_active_worksite_before_it_reads_the_body() {
        let (db, ids) = seeded();
        let id = first_worksite(&db);

        let malformed = Request {
            method: "POST".to_owned(),
            path: "/api/workers".to_owned(),
            query: String::new(),
            headers: vec![("content-type".to_owned(), "application/json".to_owned())],
            body: Some("{not json".to_owned()),
        };
        let worker_body = json!({
            "name": "Rosalind",
            "email": "",
            "phone": "",
            "assessment": "Unassessed",
            "attributes": {},
            "agitations": [],
            "languages": [],
            "relationships": [],
            "notes": []
        });

        // With the Worksite, the malformed body is the 400 the read produces.
        let response = dispatch(&db, &malformed, &ids);
        assert_eq!(response.status, 400);
        assert_eq!(
            response.body,
            json!({ "message": "Request body must contain valid JSON." })
        );

        delete_worksite(db.conn(), &id).unwrap();

        // Without one, the resolve wins: a malformed body and a valid one both answer 409.
        for request in [
            malformed,
            request("POST", "/api/workers", Some(worker_body)),
        ] {
            let response = dispatch(&db, &request, &ids);
            assert_eq!(response.status, 409);
            assert_eq!(
                response.body,
                json!({ "message": "There is no Active Worksite." })
            );
        }
    }

    #[test]
    fn worker_update_patch_and_delete_read_and_resolve_in_their_own_order() {
        let (db, ids) = seeded();
        let id = first_worksite(&db);
        delete_worksite(db.conn(), &id).unwrap();

        // PUT and PATCH read the body first: a malformed body is a 400 even with no
        // Active Worksite, where only the update's `not-found` could have answered.
        for method in ["PUT", "PATCH"] {
            let malformed = Request {
                method: method.to_owned(),
                path: "/api/workers/ghost".to_owned(),
                query: String::new(),
                headers: vec![("content-type".to_owned(), "application/json".to_owned())],
                body: Some("{not json".to_owned()),
            };
            let response = dispatch(&db, &malformed, &ids);
            assert_eq!(response.status, 400, "{method}");
            assert_eq!(
                response.body,
                json!({ "message": "Request body must contain valid JSON." })
            );
        }

        // A well-formed update or patch for a worker that is not there is a 404, not a 409.
        let response = dispatch(
            &db,
            &request(
                "PUT",
                "/api/workers/ghost",
                Some(json!({
                    "name": "Ghost",
                    "email": "",
                    "phone": "",
                    "assessment": "Unassessed",
                    "attributes": {},
                    "agitations": [],
                    "languages": [],
                    "relationships": [],
                    "notes": []
                })),
            ),
            &ids,
        );
        assert_eq!(response.status, 404);
        assert_eq!(
            response.body,
            json!({ "message": "Worker not found.", "code": "worker_not_found" })
        );

        let response = dispatch(
            &db,
            &request(
                "PATCH",
                "/api/workers/ghost",
                Some(json!({ "field": "assessment", "value": "Leader" })),
            ),
            &ids,
        );
        assert_eq!(response.status, 404);

        // DELETE reads no body at all and resolves to the same 404.
        let response = dispatch(&db, &request("DELETE", "/api/workers/ghost", None), &ids);
        assert_eq!(response.status, 404);
        assert_eq!(
            response.body,
            json!({ "message": "Worker not found.", "code": "worker_not_found" })
        );
    }

    #[test]
    fn post_with_only_a_name_creates_an_unassessed_worker_with_empty_answers() {
        let (db, ids) = seeded();

        let response = dispatch(
            &db,
            &request(
                "POST",
                "/api/workers",
                Some(json!({ "name": "  Ada Test  " })),
            ),
            &ids,
        );
        assert_eq!(response.status, 201, "{}", response.body);
        let worker = &response.body["worker"];
        assert_eq!(worker["name"], json!("Ada Test"));
        assert_eq!(worker["assessment"], json!("Unassessed"));
        assert_eq!(worker["email"], json!(""));
        assert_eq!(worker["phone"], json!(""));

        let dataset = dispatch(&db, &request("GET", "/api/dataset", None), &ids);
        for attribute in dataset.body["attributes"]
            .as_array()
            .expect("the Worksite's attributes")
        {
            let id = attribute["id"].as_str().expect("an attribute id");
            let empty = if attribute["kind"].as_str() == Some("tag") {
                json!([])
            } else {
                json!("")
            };
            assert_eq!(worker["attributes"][id], empty, "the answer for {id}");
        }

        assert_eq!(worker["agitations"], json!([]));
        assert_eq!(worker["languages"], json!([]));
        assert_eq!(worker["relationships"], json!([]));
        assert_eq!(worker["notes"], json!([]));
    }

    #[test]
    fn post_with_a_blank_name_only_is_refused() {
        let (db, ids) = seeded();

        let response = dispatch(
            &db,
            &request("POST", "/api/workers", Some(json!({ "name": "   " }))),
            &ids,
        );

        assert_eq!(response.status, 400);
        assert_eq!(response.body["code"], json!("invalid_worker"));
    }

    /// Creates one Worker through the route and answers its minted id. Every
    /// configured Attribute has to answer, so each gets the empty value its kind takes.
    fn create_worker_id(db: &Db, ids: &impl IdSource, name: &str) -> String {
        let dataset = dispatch(db, &request("GET", "/api/dataset", None), ids);
        let mut attributes = serde_json::Map::new();
        for attribute in dataset.body["attributes"]
            .as_array()
            .expect("the Worksite's attributes")
        {
            let id = attribute["id"].as_str().expect("an attribute id");
            let empty = if attribute["kind"].as_str() == Some("tag") {
                json!([])
            } else {
                json!("")
            };
            attributes.insert(id.to_owned(), empty);
        }

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
                    "attributes": Value::Object(attributes),
                    "agitations": [],
                    "languages": [],
                    "relationships": [],
                    "notes": []
                })),
            ),
            ids,
        );
        assert_eq!(response.status, 201, "{}", response.body);

        response.body["worker"]["id"]
            .as_str()
            .expect("a minted worker id")
            .to_owned()
    }

    #[test]
    fn patch_worker_text_field_writes_that_field_alone_and_trims_it() {
        let (db, ids) = seeded();
        let worker_id = create_worker_id(&db, &ids, "Ada Lovelace");

        let response = dispatch(
            &db,
            &request(
                "PATCH",
                &format!("/api/workers/{worker_id}"),
                Some(json!({ "field": "email", "value": "  ada@example.test  " })),
            ),
            &ids,
        );
        assert_eq!(response.status, 200);
        assert_eq!(response.body["worker"]["email"], json!("ada@example.test"));
        assert_eq!(response.body["worker"]["name"], json!("Ada Lovelace"));
        assert_eq!(response.body["worker"]["phone"], json!(""));

        // Phone is stored in its one shape, from digits and punctuation alike.
        let response = dispatch(
            &db,
            &request(
                "PATCH",
                &format!("/api/workers/{worker_id}"),
                Some(json!({ "field": "phone", "value": " 555.010.0100 " })),
            ),
            &ids,
        );
        assert_eq!(response.status, 200);
        assert_eq!(response.body["worker"]["phone"], json!("(555) 010-0100"));
        assert_eq!(response.body["worker"]["email"], json!("ada@example.test"));

        let response = dispatch(
            &db,
            &request(
                "PATCH",
                &format!("/api/workers/{worker_id}"),
                Some(json!({ "field": "name", "value": "Ada King" })),
            ),
            &ids,
        );
        assert_eq!(response.status, 200);
        assert_eq!(response.body["worker"]["name"], json!("Ada King"));
        assert_eq!(response.body["worker"]["phone"], json!("(555) 010-0100"));

        // The dataset reads back what the three writes left, nothing else moving.
        let response = dispatch(&db, &request("GET", "/api/dataset", None), &ids);
        assert_eq!(response.body["workers"][0]["name"], json!("Ada King"));
        assert_eq!(
            response.body["workers"][0]["email"],
            json!("ada@example.test")
        );
        assert_eq!(
            response.body["workers"][0]["phone"],
            json!("(555) 010-0100")
        );
    }

    #[test]
    fn patch_worker_text_field_refuses_an_empty_name_and_a_malformed_email() {
        let (db, ids) = seeded();
        let worker_id = create_worker_id(&db, &ids, "Ada Lovelace");

        for (field, value, message) in [
            ("name", "   ", "Worker name cannot be empty."),
            (
                "email",
                "not-an-address",
                "Worker email must look like an email address.",
            ),
        ] {
            let response = dispatch(
                &db,
                &request(
                    "PATCH",
                    &format!("/api/workers/{worker_id}"),
                    Some(json!({ "field": field, "value": value })),
                ),
                &ids,
            );
            assert_eq!(response.status, 400, "{field}");
            assert_eq!(
                response.body,
                json!({ "message": message, "code": "invalid_worker" }),
                "{field}"
            );
        }

        // Neither refusal wrote anything.
        let response = dispatch(&db, &request("GET", "/api/dataset", None), &ids);
        assert_eq!(response.body["workers"][0]["name"], json!("Ada Lovelace"));
        assert_eq!(response.body["workers"][0]["email"], json!(""));
    }

    #[test]
    fn patch_worker_text_field_is_404_for_an_unknown_worker_and_one_from_another_worksite() {
        let (db, ids) = seeded();
        let worker_id = create_worker_id(&db, &ids, "Ada Lovelace");
        let other = dispatch(&db, &request("POST", "/api/worksite", None), &ids);
        let other_id = other.body["worksite"]["id"]
            .as_str()
            .expect("the second worksite's id")
            .to_owned();

        let ghost = dispatch(
            &db,
            &request(
                "PATCH",
                "/api/workers/ghost",
                Some(json!({ "field": "name", "value": "Ghost" })),
            ),
            &ids,
        );
        assert_eq!(ghost.status, 404);
        assert_eq!(
            ghost.body,
            json!({ "message": "Worker not found.", "code": "worker_not_found" })
        );

        let elsewhere = dispatch(
            &db,
            &request_for(
                "PATCH",
                &format!("/api/workers/{worker_id}"),
                &other_id,
                Some(json!({ "field": "name", "value": "Ada King" })),
            ),
            &ids,
        );
        assert_eq!(elsewhere.status, 404);
        assert_eq!(
            elsewhere.body,
            json!({ "message": "Worker not found.", "code": "worker_not_found" })
        );
    }

    /// The Notes a Worker holds, as the route's reply wrote them.
    fn notes_of(response: &Response) -> Vec<Value> {
        response.body["worker"]["notes"]
            .as_array()
            .cloned()
            .unwrap_or_default()
    }

    /// One note patch, so the three tests below name only what they care about.
    fn note_patch(worker_id: &str, action: &str, value: Value) -> Request {
        request(
            "PATCH",
            &format!("/api/workers/{worker_id}"),
            Some(json!({ "field": "notes", "action": action, "value": value })),
        )
    }

    /// One relationship patch: naming the other Worker by id.
    fn relationship_patch(worker_id: &str, action: &str, other_worker_id: &str) -> Request {
        request(
            "PATCH",
            &format!("/api/workers/{worker_id}"),
            Some(json!({
                "field": "relationships",
                "action": action,
                "value": { "id": other_worker_id }
            })),
        )
    }

    /// The Worker's Relationships as the route's reply wrote them.
    fn relationships_of(response: &Response) -> Vec<String> {
        response.body["worker"]["relationships"]
            .as_array()
            .map(|ids| {
                ids.iter()
                    .filter_map(Value::as_str)
                    .map(str::to_owned)
                    .collect()
            })
            .unwrap_or_default()
    }

    #[test]
    fn patch_worker_note_add_keeps_the_text_and_mints_the_rest() {
        let (db, ids) = seeded();
        let worker_id = create_worker_id(&db, &ids, "Ada Lovelace");

        let response = dispatch(
            &db,
            &note_patch(
                &worker_id,
                "add",
                json!({ "text": "  Upset about the rota.  " }),
            ),
            &ids,
        );
        assert_eq!(response.status, 200, "{}", response.body);

        let notes = notes_of(&response);
        assert_eq!(notes.len(), 1);
        assert_eq!(notes[0]["text"], json!("Upset about the rota."));
        assert!(
            !notes[0]["id"].as_str().unwrap_or_default().is_empty(),
            "the core mints the note id"
        );
        assert!(
            notes[0].get("editedAt").is_none(),
            "an added note is unedited"
        );
        let timestamp = notes[0]["timestamp"].as_str().expect("a timestamp");
        assert!(
            timestamp.ends_with('Z') && timestamp.len() >= 20,
            "{timestamp}"
        );

        // A second Note is appended after the first, not instead of it.
        let response = dispatch(
            &db,
            &note_patch(&worker_id, "add", json!({ "text": "Mentioned Priya." })),
            &ids,
        );
        assert_eq!(response.status, 200);
        let notes = notes_of(&response);
        assert_eq!(notes.len(), 2);
        assert_eq!(notes[1]["text"], json!("Mentioned Priya."));
        assert_ne!(notes[0]["id"], notes[1]["id"]);
    }

    #[test]
    fn patch_worker_note_add_refuses_empty_text_and_an_unknown_worker() {
        let (db, ids) = seeded();
        let worker_id = create_worker_id(&db, &ids, "Ada Lovelace");

        let message = "A note needs text.";
        let response = dispatch(
            &db,
            &note_patch(&worker_id, "add", json!({ "text": "   " })),
            &ids,
        );
        assert_eq!(response.status, 400, "{message}");
        assert_eq!(
            response.body,
            json!({ "message": message, "code": "invalid_worker" })
        );

        // Neither refusal wrote anything.
        let dataset = dispatch(&db, &request("GET", "/api/dataset", None), &ids);
        assert_eq!(dataset.body["workers"][0]["notes"], json!([]));

        let ghost = dispatch(
            &db,
            &note_patch("ghost", "add", json!({ "text": "Called back" })),
            &ids,
        );
        assert_eq!(ghost.status, 404);
        assert_eq!(
            ghost.body,
            json!({ "message": "Worker not found.", "code": "worker_not_found" })
        );
    }

    #[test]
    fn patch_worker_note_edit_keeps_the_written_time_and_marks_only_a_real_change() {
        let (db, ids) = seeded();
        let worker_id = create_worker_id(&db, &ids, "Ada Lovelace");
        let added = dispatch(
            &db,
            &note_patch(&worker_id, "add", json!({ "text": "First" })),
            &ids,
        );
        let note = notes_of(&added)[0].clone();
        let id = note["id"].as_str().expect("note id").to_owned();

        let same = dispatch(
            &db,
            &note_patch(&worker_id, "edit", json!({ "id": id, "text": "First" })),
            &ids,
        );
        assert_eq!(same.status, 200);
        assert!(notes_of(&same)[0].get("editedAt").is_none());

        let edited = dispatch(
            &db,
            &note_patch(&worker_id, "edit", json!({ "id": id, "text": "Fixed" })),
            &ids,
        );
        let after = notes_of(&edited)[0].clone();
        assert_eq!(after["text"], "Fixed");
        assert_eq!(after["timestamp"], note["timestamp"]);
        assert!(after["editedAt"].is_string());

        let undone = dispatch(
            &db,
            &note_patch(
                &worker_id,
                "edit",
                json!({ "id": id, "text": "First", "editedAt": null }),
            ),
            &ids,
        );
        let back = notes_of(&undone)[0].clone();
        assert_eq!(back["text"], "First");
        assert!(back.get("editedAt").is_none());
        assert_eq!(back["timestamp"], note["timestamp"]);
    }

    #[test]
    fn patch_worker_note_delete_takes_one_note_off_and_leaves_the_rest() {
        let (db, ids) = seeded();
        let worker_id = create_worker_id(&db, &ids, "Ada Lovelace");

        for text in ["First", "Second"] {
            let response = dispatch(
                &db,
                &note_patch(&worker_id, "add", json!({ "text": text })),
                &ids,
            );
            assert_eq!(response.status, 200);
        }

        let kept = dispatch(&db, &request("GET", "/api/dataset", None), &ids).body["workers"][0]
            ["notes"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        let first_id = kept[0]["id"]
            .as_str()
            .expect("the first note id")
            .to_owned();

        let response = dispatch(
            &db,
            &note_patch(&worker_id, "delete", json!({ "id": first_id })),
            &ids,
        );
        assert_eq!(response.status, 200);
        let notes = notes_of(&response);
        assert_eq!(notes.len(), 1);
        assert_eq!(notes[0]["text"], json!("Second"));

        // An id that is not there changes nothing, rather than failing an Undo
        // that has already done its work.
        let response = dispatch(
            &db,
            &note_patch(&worker_id, "delete", json!({ "id": "not-a-note" })),
            &ids,
        );
        assert_eq!(response.status, 200);
        assert_eq!(notes_of(&response).len(), 1);
    }

    #[test]
    fn patch_worker_note_restore_puts_the_deleted_note_back_exactly() {
        let (db, ids) = seeded();
        let worker_id = create_worker_id(&db, &ids, "Ada Lovelace");
        let added = dispatch(
            &db,
            &note_patch(&worker_id, "add", json!({ "text": "First" })),
            &ids,
        );
        let id = notes_of(&added)[0]["id"]
            .as_str()
            .expect("the added note id")
            .to_owned();

        // An edit gives the Note an `editedAt` to put back with it too.
        let edited = dispatch(
            &db,
            &note_patch(
                &worker_id,
                "edit",
                json!({ "id": id, "text": "First, corrected" }),
            ),
            &ids,
        );
        let note = notes_of(&edited)[0].clone();

        let deleted = dispatch(
            &db,
            &note_patch(&worker_id, "delete", json!({ "id": id })),
            &ids,
        );
        assert_eq!(notes_of(&deleted).len(), 0);

        let restored = dispatch(&db, &note_patch(&worker_id, "restore", note.clone()), &ids);
        assert_eq!(restored.status, 200, "{}", restored.body);
        // Every field the client held comes back byte-identical, written time included.
        assert_eq!(notes_of(&restored), vec![note.clone()]);

        // A second restore of a Note that is already there writes nothing.
        let again = dispatch(&db, &note_patch(&worker_id, "restore", note.clone()), &ids);
        assert_eq!(again.status, 200);
        assert_eq!(notes_of(&again), vec![note]);
    }

    #[test]
    fn patch_worker_note_restore_refuses_a_deleted_or_unknown_worker() {
        let (db, ids) = seeded();
        let worker_id = create_worker_id(&db, &ids, "Ada Lovelace");
        let note = json!({
            "id": "n1",
            "text": "First",
            "timestamp": "2026-10-07T09:15:00.000Z"
        });

        let deleted = dispatch(
            &db,
            &request("DELETE", &format!("/api/workers/{worker_id}"), None),
            &ids,
        );
        assert_eq!(deleted.status, 200);

        for target in [worker_id.as_str(), "ghost"] {
            let response = dispatch(&db, &note_patch(target, "restore", note.clone()), &ids);
            assert_eq!(response.status, 404, "{target}");
            assert_eq!(
                response.body,
                json!({ "message": "Worker not found.", "code": "worker_not_found" })
            );
        }
    }

    /// The Relationships one Worker reads, as `GET /api/dataset` wrote them.
    fn dataset_relationships(dataset: &Response, worker_id: &str) -> Vec<String> {
        dataset.body["workers"]
            .as_array()
            .and_then(|workers| {
                workers
                    .iter()
                    .find(|worker| worker["id"].as_str() == Some(worker_id))
            })
            .and_then(|worker| worker["relationships"].as_array())
            .map(|ids| {
                ids.iter()
                    .filter_map(Value::as_str)
                    .map(str::to_owned)
                    .collect()
            })
            .unwrap_or_default()
    }

    #[test]
    fn patch_worker_relationship_adds_and_removes_one_symmetric_pair() {
        let (db, ids) = seeded();
        let ada = create_worker_id(&db, &ids, "Ada Lovelace");
        let grace = create_worker_id(&db, &ids, "Grace Hopper");

        let added = dispatch(&db, &relationship_patch(&ada, "add", &grace), &ids);
        assert_eq!(added.status, 200, "{}", added.body);
        assert_eq!(relationships_of(&added), vec![grace.clone()]);

        // One row, so the other Worker reads the same relation.
        let dataset = dispatch(&db, &request("GET", "/api/dataset", None), &ids);
        assert_eq!(dataset_relationships(&dataset, &grace), vec![ada.clone()]);

        // The same pair, named the other way round, is already there.
        let duplicate = dispatch(&db, &relationship_patch(&grace, "add", &ada), &ids);
        assert_eq!(duplicate.status, 400);
        assert_eq!(
            duplicate.body,
            json!({
                "message": "These workers are already related.",
                "code": "relationship_already_exists"
            })
        );

        // Either order names the same pair to take off.
        let removed = dispatch(&db, &relationship_patch(&grace, "remove", &ada), &ids);
        assert_eq!(removed.status, 200, "{}", removed.body);
        assert_eq!(relationships_of(&removed), Vec::<String>::new());

        let again = dispatch(&db, &relationship_patch(&ada, "remove", &grace), &ids);
        assert_eq!(again.status, 400);
        assert_eq!(
            again.body,
            json!({
                "message": "These workers are not related.",
                "code": "relationship_not_found"
            })
        );
    }

    #[test]
    fn patch_worker_relationship_refuses_self_a_nobody_a_ghost_and_another_worksite() {
        let (db, ids) = seeded();
        let ada = create_worker_id(&db, &ids, "Ada Lovelace");

        for action in ["add", "remove"] {
            let itself = dispatch(&db, &relationship_patch(&ada, action, &ada), &ids);
            assert_eq!(itself.status, 400, "self, {action}");
            assert_eq!(itself.body["code"], json!("relationship_unknown_worker"));

            let nobody = dispatch(&db, &relationship_patch(&ada, action, "nobody"), &ids);
            assert_eq!(nobody.status, 400, "nobody, {action}");
            assert_eq!(nobody.body["code"], json!("relationship_unknown_worker"));

            let ghost = dispatch(&db, &relationship_patch("ghost", action, &ada), &ids);
            assert_eq!(ghost.status, 404, "ghost, {action}");
            assert_eq!(ghost.body["code"], json!("worker_not_found"));
        }

        // A Worker of another Worksite exists, but is not a valid relation here.
        let elsewhere =
            create_worksite(db.conn(), &ids).expect("a second Worksite for the refusal");
        insert_bare_worker(db.conn(), &elsewhere.id, "w-elsewhere", "Elsewhere", "");

        let foreign = dispatch(&db, &relationship_patch(&ada, "add", "w-elsewhere"), &ids);
        assert_eq!(foreign.status, 400);
        assert_eq!(foreign.body["code"], json!("relationship_unknown_worker"));
    }

    /// One Agitation patch: assign or unassign by id.
    fn agitation_patch(worker_id: &str, action: &str, agitation_id: &str) -> Request {
        request(
            "PATCH",
            &format!("/api/workers/{worker_id}"),
            Some(json!({
                "field": "agitations",
                "action": action,
                "value": { "id": agitation_id }
            })),
        )
    }

    /// The Agitation ids a patch reply's Worker carries.
    fn agitations_of(response: &Response) -> Vec<String> {
        response.body["worker"]["agitations"]
            .as_array()
            .map(|ids| {
                ids.iter()
                    .filter_map(Value::as_str)
                    .map(str::to_owned)
                    .collect()
            })
            .unwrap_or_default()
    }

    #[test]
    fn patch_worker_agitation_unassigns_one_worker_and_keeps_the_shared_agitation() {
        let (db, ids) = seeded();
        let ada = create_worker_id(&db, &ids, "Ada Lovelace");
        let grace = create_worker_id(&db, &ids, "Grace Hopper");
        let created = dispatch(
            &db,
            &request("POST", "/api/agitations", Some(json!({ "text": "Pay" }))),
            &ids,
        );
        let pay = created.body["agitation"]["id"]
            .as_str()
            .expect("an agitation id")
            .to_owned();

        for worker in [&ada, &grace] {
            let assigned = dispatch(&db, &agitation_patch(worker, "assign", &pay), &ids);
            assert_eq!(assigned.status, 200, "{}", assigned.body);
            assert_eq!(agitations_of(&assigned), vec![pay.clone()]);
        }
        // A repeat assignment changes nothing and does not fail.
        let again = dispatch(&db, &agitation_patch(&ada, "assign", &pay), &ids);
        assert_eq!(agitations_of(&again), vec![pay.clone()]);

        let removed = dispatch(&db, &agitation_patch(&ada, "unassign", &pay), &ids);
        assert_eq!(removed.status, 200, "{}", removed.body);
        assert_eq!(agitations_of(&removed), Vec::<String>::new());

        let dataset = dispatch(&db, &request("GET", "/api/dataset", None), &ids);
        assert_eq!(dataset.body["agitations"].as_array().map(Vec::len), Some(1));
        let grace_row = dataset.body["workers"]
            .as_array()
            .and_then(|workers| {
                workers
                    .iter()
                    .find(|worker| worker["id"].as_str() == Some(grace.as_str()))
            })
            .expect("Grace");
        assert_eq!(grace_row["agitations"], json!([pay]));
    }

    #[test]
    fn patch_worker_agitation_refuses_an_unknown_agitation_and_a_ghost_worker() {
        let (db, ids) = seeded();
        let ada = create_worker_id(&db, &ids, "Ada Lovelace");

        for action in ["assign", "unassign"] {
            let unknown = dispatch(&db, &agitation_patch(&ada, action, "nope"), &ids);
            assert_eq!(unknown.status, 400, "unknown, {action}");
            assert_eq!(unknown.body["code"], json!("vocabulary_other_worksite"));

            let ghost = dispatch(&db, &agitation_patch("ghost", action, "nope"), &ids);
            assert_eq!(ghost.status, 404, "ghost, {action}");
            assert_eq!(ghost.body["code"], json!("worker_not_found"));
        }

        // An Agitation of another Worksite is as unknown as a made-up id.
        let elsewhere = create_worksite(db.conn(), &ids).expect("a second Worksite");
        db.conn()
            .execute(
                "INSERT INTO agitations (id, worksite_id, text) VALUES ('g-elsewhere', ?1, 'Pay')",
                params![elsewhere.id],
            )
            .expect("an Agitation in the second Worksite");
        let foreign = dispatch(&db, &agitation_patch(&ada, "assign", "g-elsewhere"), &ids);
        assert_eq!(foreign.status, 400);
        assert_eq!(foreign.body["code"], json!("vocabulary_other_worksite"));
    }
}
