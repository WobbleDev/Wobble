//! The Worker merge routes: preview, commit, Undo and dismissal of the one recent merge.

use serde_json::{json, Value};

use crate::db::Db;
use crate::error::Result;
use crate::handle::{Request, Response};
use crate::id::IdSource;
use crate::request_worksite::{no_active_worksite_response, resolve_request_worksite};
use crate::router::{coded_message_response, json_response, read_payload};
use crate::worker_merge::{commit_merge, preview_merge, undo_merge, MergeDecisions, MergeOutcome};

fn text<'a>(payload: &'a Value, key: &str) -> Option<&'a str> {
    payload
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
}

fn invalid(message: &str) -> Response {
    coded_message_response(400, "invalid_merge", message)
}

/// The answer each refusal shares between the routes.
fn refusal<T>(outcome: MergeOutcome<T>) -> std::result::Result<T, Response> {
    Err(match outcome {
        MergeOutcome::Done(value) => return Ok(value),
        MergeOutcome::NotFound => coded_message_response(
            404,
            "worker_not_found",
            "Both Workers must be different Workers of this Worksite.",
        ),
        MergeOutcome::DraftsUnresolved(worker_ids) => json_response(
            409,
            json!({
                "message": "A Worker has an unsaved draft.",
                "code": "merge_drafts_unresolved",
                "workerIds": worker_ids,
            }),
        ),
        MergeOutcome::Stale => {
            coded_message_response(409, "merge_stale", "The Workers changed after the preview.")
        }
        MergeOutcome::DecisionsRequired => coded_message_response(
            400,
            "merge_decisions_required",
            "Every conflict needs one decision.",
        ),
        MergeOutcome::UndoExpired => coded_message_response(
            409,
            "merge_undo_expired",
            "This merge can no longer be undone.",
        ),
    })
}

/// `POST /api/worker-merge/preview` with `{survivorId, absorbedId}`.
pub(crate) fn post_preview(db: &Db, request: &Request) -> Result<Response> {
    let Some(active) = resolve_request_worksite(db.conn(), request)? else {
        return Ok(no_active_worksite_response());
    };
    let payload = match read_payload(request) {
        Ok(payload) => payload,
        Err(response) => return Ok(response),
    };
    let (Some(survivor), Some(absorbed)) =
        (text(&payload, "survivorId"), text(&payload, "absorbedId"))
    else {
        return Ok(invalid("survivorId and absorbedId are required."));
    };
    Ok(
        match refusal(preview_merge(db.conn(), &active, survivor, absorbed)?) {
            Ok(preview) => json_response(200, serde_json::to_value(preview)?),
            Err(response) => response,
        },
    )
}

/// `POST /api/worker-merge` with `{survivorId, absorbedId, readSet, decisions}`.
pub(crate) fn post_merge(
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
    let (Some(survivor), Some(absorbed), Some(read_set), Some(decisions)) = (
        text(&payload, "survivorId"),
        text(&payload, "absorbedId"),
        text(&payload, "readSet"),
        payload.get("decisions").and_then(MergeDecisions::parse),
    ) else {
        return Ok(invalid(
            "survivorId, absorbedId, readSet and decisions are required.",
        ));
    };
    let (outcome, snapshot) = commit_merge(
        db.conn(),
        &active,
        survivor,
        absorbed,
        read_set,
        &decisions,
        id_source,
    )?;
    Ok(match refusal(outcome) {
        Ok(committed) => {
            // The next merge replaces this one; nothing is written to disk.
            db.set_merge_snapshot(snapshot);
            json_response(200, serde_json::to_value(committed)?)
        }
        Err(response) => response,
    })
}

/// `POST /api/worker-merge/undo` with `{token}`. The remembered merge ends with this call
/// whatever it answers.
pub(crate) fn post_undo(db: &Db, request: &Request) -> Result<Response> {
    let active = resolve_request_worksite(db.conn(), request)?;
    let payload = match read_payload(request) {
        Ok(payload) => payload,
        Err(response) => return Ok(response),
    };
    let Some(token) = text(&payload, "token") else {
        return Ok(invalid("token is required."));
    };
    let snapshot = db.merge_snapshot();
    let outcome = undo_merge(db.conn(), active.as_ref(), snapshot.as_ref(), token)?;
    if snapshot
        .as_ref()
        .is_some_and(|snapshot| snapshot.token() == token)
    {
        db.set_merge_snapshot(None);
    }
    Ok(match refusal(outcome) {
        Ok(undone) => json_response(200, serde_json::to_value(undone)?),
        Err(response) => response,
    })
}

/// `POST /api/worker-merge/dismiss` with `{token}`: forgets the merge, idempotently.
pub(crate) fn post_dismiss(db: &Db, request: &Request) -> Result<Response> {
    let payload = match read_payload(request) {
        Ok(payload) => payload,
        Err(response) => return Ok(response),
    };
    let Some(token) = text(&payload, "token") else {
        return Ok(invalid("token is required."));
    };
    if db
        .merge_snapshot()
        .is_some_and(|snapshot| snapshot.token() == token)
    {
        db.set_merge_snapshot(None);
    }
    Ok(json_response(200, json!({})))
}
