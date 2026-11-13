//! The Worker draft routes: read, write and forget the draft a Worker form is holding
//! (ADR-0023).

use serde::Serialize;
use serde_json::Value;

use crate::db::Db;
use crate::error::Result;
use crate::handle::{Request, Response};
use crate::request_worksite::{no_active_worksite_response, resolve_request_worksite};
use crate::router::{coded_message_response, json_response, read_payload};
use crate::serialization::is_worker_update;
use crate::worker_draft_persistence::{
    delete_worker_draft, get_worker_draft, save_worker_draft, WorkerDraft, WorkerDraftInput,
};

/// `{draft}` for the stored Worker draft, or null when there is none.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
struct DraftReply {
    draft: Option<WorkerDraft>,
}

/// `{draft}` for the Worker draft that was just stored.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
struct SavedDraftReply {
    draft: WorkerDraft,
}

/// `{workerId}` for the Worker draft that was just forgotten.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
struct DraftDeletedReply {
    worker_id: String,
}

/// `GET /api/worker-drafts/{workerId}` — the Worksite's stored draft for that Worker, or
/// null (ADR-0023).
pub(crate) fn get_worker_draft_route(
    db: &Db,
    request: &Request,
    worker_id: &str,
) -> Result<Response> {
    let worksite = resolve_request_worksite(db.conn(), request)?;
    let draft = match &worksite {
        Some(worksite) => get_worker_draft(db.conn(), &worksite.id, worker_id)?,
        None => None,
    };

    Ok(json_response(
        200,
        serde_json::to_value(DraftReply { draft })?,
    ))
}

/// `PUT /api/worker-drafts/{workerId}` — writes the draft the form is holding.
pub(crate) fn put_worker_draft_route(
    db: &Db,
    request: &Request,
    worker_id: &str,
) -> Result<Response> {
    let payload = match read_payload(request) {
        Ok(payload) => payload,
        Err(response) => return Ok(response),
    };

    let Some(worksite) = resolve_request_worksite(db.conn(), request)? else {
        return Ok(no_active_worksite_response());
    };

    let attributes =
        crate::attribute_persistence::get_worker_attributes(db.conn(), &Some(worksite.clone()))?
            .iter()
            .map(serde_json::to_value)
            .collect::<serde_json::Result<Vec<serde_json::Value>>>()?;
    let valid_update = payload
        .get("update")
        .is_some_and(|update| is_worker_update(update, &attributes));
    let valid_base = payload.get("base").is_none_or(Value::is_null)
        || payload
            .get("base")
            .is_some_and(|base| is_worker_update(base, &attributes));
    if !valid_update || !valid_base {
        return Ok(coded_message_response(
            400,
            "invalid_worker",
            "Request must contain a valid Worker draft.",
        ));
    }

    let input: WorkerDraftInput = match serde_json::from_value(payload) {
        Ok(input) => input,
        Err(_) => {
            return Ok(coded_message_response(
                400,
                "invalid_worker",
                "Request must contain a valid Worker draft.",
            ))
        }
    };

    let draft = save_worker_draft(db.conn(), &worksite.id, worker_id, &input)?;
    Ok(json_response(
        200,
        serde_json::to_value(SavedDraftReply { draft })?,
    ))
}

/// `DELETE /api/worker-drafts/{workerId}` — forgets the draft; idempotent.
pub(crate) fn delete_worker_draft_route(
    db: &Db,
    request: &Request,
    worker_id: &str,
) -> Result<Response> {
    let worksite = resolve_request_worksite(db.conn(), request)?;
    if let Some(worksite) = &worksite {
        delete_worker_draft(db.conn(), &worksite.id, worker_id)?;
    }

    Ok(json_response(
        200,
        serde_json::to_value(DraftDeletedReply {
            worker_id: worker_id.to_owned(),
        })?,
    ))
}

#[cfg(test)]
mod tests {
    use crate::router::dispatch;
    use crate::test_support::{first_worksite, request_for, seeded};
    use serde_json::{json, Value};

    fn valid_update(db: &crate::db::Db, worksite_id: &str) -> serde_json::Value {
        let worksite = crate::schema::Worksite {
            id: worksite_id.to_owned(),
            name: String::new(),
            committee_goal: 5,
        };
        let definitions =
            crate::attribute_persistence::get_worker_attributes(db.conn(), &Some(worksite))
                .unwrap();
        let attributes = crate::attribute_persistence::default_attribute_values(&definitions);
        json!({
            "name": "Ada",
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

    fn draft(update: serde_json::Value) -> serde_json::Value {
        json!({ "update": update, "pendingNote": { "text": "half a note" }, "base": null })
    }

    #[test]
    fn put_rejects_assessment_outside_the_scale_with_existing_error() {
        let (db, ids) = seeded();
        let worksite = first_worksite(&db);
        let mut update = valid_update(&db, &worksite);
        update["assessment"] = json!("Nonsense");

        let response = dispatch(
            &db,
            &request_for(
                "PUT",
                "/api/worker-drafts/new",
                &worksite,
                Some(draft(update)),
            ),
            &ids,
        );

        assert_eq!(response.status, 400);
        assert_eq!(
            response.body,
            json!({
                "message": "Request must contain a valid Worker draft.",
                "code": "invalid_worker"
            })
        );
    }

    #[test]
    fn put_rejects_invalid_attribute_values_empty_notes_unknown_keys_and_missing_update() {
        let (db, ids) = seeded();
        let worksite = first_worksite(&db);
        let configured = dispatch(
            &db,
            &request_for(
                "PUT",
                "/api/attributes",
                &worksite,
                Some(json!([{
                    "id": "attr-role",
                    "name": "Role",
                    "kind": "category",
                    "options": [{ "id": "answer-organizer", "value": "Organizer" }]
                }])),
            ),
            &ids,
        );
        assert_eq!(configured.status, 200);

        let mut invalid_attribute = valid_update(&db, &worksite);
        invalid_attribute["attributes"] = json!({ "attr-role": "missing-answer" });
        let mut malformed_note = valid_update(&db, &worksite);
        malformed_note["notes"] = json!([{
            "id": "note-1",
            "text": "",
            "timestamp": "2026-10-20T00:00:00Z"
        }]);
        let mut unknown_key = valid_update(&db, &worksite);
        unknown_key["unexpected"] = json!(true);
        let mut missing_update = draft(valid_update(&db, &worksite));
        missing_update.as_object_mut().unwrap().remove("update");

        for body in [
            draft(invalid_attribute),
            draft(malformed_note),
            draft(unknown_key),
            missing_update,
        ] {
            let response = dispatch(
                &db,
                &request_for("PUT", "/api/worker-drafts/new", &worksite, Some(body)),
                &ids,
            );
            assert_eq!(response.status, 400);
            assert_eq!(
                response.body,
                json!({
                    "message": "Request must contain a valid Worker draft.",
                    "code": "invalid_worker"
                })
            );
        }
    }

    #[test]
    fn put_accepts_half_typed_text_preserves_it_on_get_and_rejects_bad_base_without_overwrite() {
        let (db, ids) = seeded();
        let worksite = first_worksite(&db);
        let mut update = valid_update(&db, &worksite);
        update["name"] = json!("");
        update["email"] = json!("half@typ");
        update["phone"] = json!(" 12 ");
        let mut body = draft(update.clone());
        body["pendingNote"]["text"] = json!(" half a note ");

        let response = dispatch(
            &db,
            &request_for("PUT", "/api/worker-drafts/new", &worksite, Some(body)),
            &ids,
        );
        assert_eq!(response.status, 200);

        let read = dispatch(
            &db,
            &request_for("GET", "/api/worker-drafts/new", &worksite, None),
            &ids,
        );
        assert_eq!(read.status, 200);
        assert_eq!(read.body["draft"]["update"], update);
        assert_eq!(read.body["draft"]["pendingNote"]["text"], " half a note ");

        let mut invalid_base = valid_update(&db, &worksite);
        invalid_base["assessment"] = json!("Nonsense");
        let mut bad_body = draft(valid_update(&db, &worksite));
        bad_body["base"] = invalid_base;
        let rejected = dispatch(
            &db,
            &request_for("PUT", "/api/worker-drafts/new", &worksite, Some(bad_body)),
            &ids,
        );
        assert_eq!(rejected.status, 400);
        assert_eq!(
            rejected.body,
            json!({
                "message": "Request must contain a valid Worker draft.",
                "code": "invalid_worker"
            })
        );

        let after = dispatch(
            &db,
            &request_for("GET", "/api/worker-drafts/new", &worksite, None),
            &ids,
        );
        assert_eq!(after.body["draft"]["update"], update);
    }

    #[test]
    fn put_accepts_a_valid_base_and_null_base_and_rejects_malformed_pending_note() {
        let (db, ids) = seeded();
        let worksite = first_worksite(&db);
        for base in [Value::Null, valid_update(&db, &worksite)] {
            let mut body = draft(valid_update(&db, &worksite));
            body["base"] = base;
            let response = dispatch(
                &db,
                &request_for("PUT", "/api/worker-drafts/new", &worksite, Some(body)),
                &ids,
            );
            assert_eq!(response.status, 200);
        }

        let mut malformed_pending_note = draft(valid_update(&db, &worksite));
        malformed_pending_note["pendingNote"] = json!({});
        let response = dispatch(
            &db,
            &request_for(
                "PUT",
                "/api/worker-drafts/new",
                &worksite,
                Some(malformed_pending_note),
            ),
            &ids,
        );
        assert_eq!(response.status, 400);
        assert_eq!(
            response.body,
            json!({
                "message": "Request must contain a valid Worker draft.",
                "code": "invalid_worker"
            })
        );
    }
}
