//! The saved view routes: list, create ("Save as"), update (the explicit Update and Rename)
//! and delete a Worksite's named views. Every snapshot is validated strictly on the way in.

use serde::Serialize;
use serde_json::Value;

use crate::db::Db;
use crate::error::Result;
use crate::handle::{Request, Response};
use crate::id::IdSource;
use crate::request_worksite::{no_active_worksite_response, resolve_request_worksite};
use crate::router::{coded_message_response, json_response, read_payload};
use crate::saved_view_persistence::{
    create_view, delete_view, list_views, parse_snapshot, update_view, Refusal, Snapshot,
    StoredView,
};

/// `{views}` for the Worksite's saved views, by name.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
struct ViewsReply {
    views: Vec<StoredView>,
}

/// `{view}` for a view that was just written.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
struct ViewReply {
    view: StoredView,
}

/// `{viewId}` for a view that was just deleted.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
struct ViewDeletedReply {
    view_id: String,
}

fn refusal_response(refusal: Refusal) -> Response {
    match refusal {
        Refusal::InvalidName => coded_message_response(
            400,
            "invalid_view_name",
            "A view name must be 1 to 80 characters.",
        ),
        Refusal::NameTaken => coded_message_response(
            409,
            "view_name_taken",
            "Another view in this Worksite has that name.",
        ),
        Refusal::InvalidSnapshot(message) => coded_message_response(400, "invalid_view", &message),
        Refusal::KindChanged => coded_message_response(
            400,
            "invalid_view",
            "A saved view cannot change between Workers and Mapping.",
        ),
        Refusal::NotFound => coded_message_response(404, "view_not_found", "View not found."),
    }
}

fn snapshot_of(payload: &Value) -> std::result::Result<Snapshot, Refusal> {
    let snapshot = payload
        .get("snapshot")
        .ok_or_else(|| Refusal::InvalidSnapshot("A saved view needs a snapshot.".to_owned()))?;
    parse_snapshot(snapshot).map_err(Refusal::InvalidSnapshot)
}

/// `GET /api/views` — the Active Worksite's saved views (empty with no Active Worksite).
pub(crate) fn get_views(db: &Db, request: &Request) -> Result<Response> {
    let views = match resolve_request_worksite(db.conn(), request)? {
        Some(worksite) => list_views(db.conn(), &worksite.id)?,
        None => Vec::new(),
    };
    Ok(json_response(
        200,
        serde_json::to_value(ViewsReply { views })?,
    ))
}

/// `POST /api/views` — `{name, snapshot}` saves a new view.
pub(crate) fn post_view(db: &Db, request: &Request, id_source: &impl IdSource) -> Result<Response> {
    let payload = match read_payload(request) {
        Ok(payload) => payload,
        Err(response) => return Ok(response),
    };
    let Some(worksite) = resolve_request_worksite(db.conn(), request)? else {
        return Ok(no_active_worksite_response());
    };
    let snapshot = match snapshot_of(&payload) {
        Ok(snapshot) => snapshot,
        Err(refusal) => return Ok(refusal_response(refusal)),
    };
    let name = payload.get("name").and_then(Value::as_str).unwrap_or("");
    match create_view(db.conn(), &worksite.id, name, &snapshot, id_source)? {
        Ok(view) => Ok(json_response(
            201,
            serde_json::to_value(ViewReply { view })?,
        )),
        Err(refusal) => Ok(refusal_response(refusal)),
    }
}

/// `PUT /api/views/{id}` — `{snapshot}` is the explicit Update, `{name}` is Rename; either or both.
pub(crate) fn put_view(db: &Db, request: &Request, id: &str) -> Result<Response> {
    let payload = match read_payload(request) {
        Ok(payload) => payload,
        Err(response) => return Ok(response),
    };
    let Some(worksite) = resolve_request_worksite(db.conn(), request)? else {
        return Ok(no_active_worksite_response());
    };
    let name = match payload.get("name") {
        None => None,
        Some(Value::String(name)) => Some(name.as_str()),
        Some(_) => return Ok(refusal_response(Refusal::InvalidName)),
    };
    let snapshot = if payload.get("snapshot").is_some() {
        match snapshot_of(&payload) {
            Ok(snapshot) => Some(snapshot),
            Err(refusal) => return Ok(refusal_response(refusal)),
        }
    } else {
        None
    };
    if name.is_none() && snapshot.is_none() {
        return Ok(refusal_response(Refusal::InvalidSnapshot(
            "Send a name, a snapshot, or both.".to_owned(),
        )));
    }
    match update_view(db.conn(), &worksite.id, id, name, snapshot.as_ref())? {
        Ok(view) => Ok(json_response(
            200,
            serde_json::to_value(ViewReply { view })?,
        )),
        Err(refusal) => Ok(refusal_response(refusal)),
    }
}

/// `DELETE /api/views/{id}` — deletes the view; 404 when it is not in the Worksite.
pub(crate) fn delete_view_route(db: &Db, request: &Request, id: &str) -> Result<Response> {
    let Some(worksite) = resolve_request_worksite(db.conn(), request)? else {
        return Ok(no_active_worksite_response());
    };
    if !delete_view(db.conn(), &worksite.id, id)? {
        return Ok(refusal_response(Refusal::NotFound));
    }
    Ok(json_response(
        200,
        serde_json::to_value(ViewDeletedReply {
            view_id: id.to_owned(),
        })?,
    ))
}

#[cfg(test)]
mod tests {
    use crate::router::dispatch;
    use crate::test_support::{first_worksite, request_for, seeded};
    use serde_json::{json, Value};

    fn workers_snapshot() -> Value {
        json!({
            "version": 1,
            "kind": "workers",
            "workers": {
                "filters": {
                    "population": { "answers": {}, "exactAnswers": {}, "missing": [] },
                    "agitations": [],
                    "languages": [],
                    "assessments": []
                },
                "sort": [{ "column": "name", "descending": true }],
                "hiddenColumns": ["email"],
                "order": []
            }
        })
    }

    #[test]
    fn saves_lists_renames_updates_and_deletes_a_view() {
        let (db, ids) = seeded();
        let worksite = first_worksite(&db);

        let created = dispatch(
            &db,
            &request_for(
                "POST",
                "/api/views",
                &worksite,
                Some(json!({ "name": "Worker 07's shift", "snapshot": workers_snapshot() })),
            ),
            &ids,
        );
        assert_eq!(created.status, 201);
        let id = created.body["view"]["id"].as_str().unwrap().to_owned();
        assert_eq!(created.body["view"]["kind"], "workers");

        let listed = dispatch(
            &db,
            &request_for("GET", "/api/views", &worksite, None),
            &ids,
        );
        assert_eq!(listed.body["views"].as_array().unwrap().len(), 1);

        let renamed = dispatch(
            &db,
            &request_for(
                "PUT",
                &format!("/api/views/{id}"),
                &worksite,
                Some(json!({ "name": "Renamed" })),
            ),
            &ids,
        );
        assert_eq!(renamed.status, 200);
        assert_eq!(renamed.body["view"]["name"], "Renamed");
        assert_eq!(renamed.body["view"]["id"], id.as_str());

        let mut changed = workers_snapshot();
        changed["workers"]["hiddenColumns"] = json!(["email", "phone"]);
        let updated = dispatch(
            &db,
            &request_for(
                "PUT",
                &format!("/api/views/{id}"),
                &worksite,
                Some(json!({ "snapshot": changed })),
            ),
            &ids,
        );
        assert_eq!(updated.status, 200);
        assert_eq!(
            updated.body["view"]["snapshot"]["workers"]["hiddenColumns"],
            json!(["email", "phone"])
        );

        let deleted = dispatch(
            &db,
            &request_for("DELETE", &format!("/api/views/{id}"), &worksite, None),
            &ids,
        );
        assert_eq!(deleted.status, 200);
        let again = dispatch(
            &db,
            &request_for("DELETE", &format!("/api/views/{id}"), &worksite, None),
            &ids,
        );
        assert_eq!(again.status, 404);
        assert_eq!(again.body["code"], "view_not_found");
    }

    #[test]
    fn refuses_bad_names_duplicates_and_every_invalid_snapshot_without_writing() {
        let (db, ids) = seeded();
        let worksite = first_worksite(&db);
        let post = |body: Value| {
            dispatch(
                &db,
                &request_for("POST", "/api/views", &worksite, Some(body)),
                &ids,
            )
        };

        assert_eq!(
            post(json!({ "name": "", "snapshot": workers_snapshot() })).body["code"],
            "invalid_view_name"
        );
        assert_eq!(post(json!({ "name": "A" })).body["code"], "invalid_view");

        let mut bad_version = workers_snapshot();
        bad_version["version"] = json!(9);
        let mut unknown_kind = workers_snapshot();
        unknown_kind["kind"] = json!("overview");
        let mut unknown_field = workers_snapshot();
        unknown_field["workers"]["query"] = json!("ada");
        let mut person_state = workers_snapshot();
        person_state["selectedId"] = json!("w1");
        for snapshot in [bad_version, unknown_kind, unknown_field, person_state] {
            let response = post(json!({ "name": "Bad", "snapshot": snapshot }));
            assert_eq!(response.status, 400);
            assert_eq!(response.body["code"], "invalid_view");
        }

        assert_eq!(
            post(json!({ "name": "Same", "snapshot": workers_snapshot() })).status,
            201
        );
        let duplicate = post(json!({ "name": "same", "snapshot": workers_snapshot() }));
        assert_eq!(duplicate.status, 409);
        assert_eq!(duplicate.body["code"], "view_name_taken");

        let listed = dispatch(
            &db,
            &request_for("GET", "/api/views", &worksite, None),
            &ids,
        );
        assert_eq!(listed.body["views"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn views_belong_to_their_worksite() {
        let (db, ids) = seeded();
        let first = first_worksite(&db);
        let created = dispatch(
            &db,
            &crate::test_support::request("POST", "/api/worksite", None),
            &ids,
        );
        let second = created.body["worksite"]["id"].as_str().unwrap().to_owned();

        let saved = dispatch(
            &db,
            &request_for(
                "POST",
                "/api/views",
                &first,
                Some(json!({ "name": "Mine", "snapshot": workers_snapshot() })),
            ),
            &ids,
        );
        let id = saved.body["view"]["id"].as_str().unwrap().to_owned();

        let other = dispatch(&db, &request_for("GET", "/api/views", &second, None), &ids);
        assert!(other.body["views"].as_array().unwrap().is_empty());
        let foreign = dispatch(
            &db,
            &request_for("DELETE", &format!("/api/views/{id}"), &second, None),
            &ids,
        );
        assert_eq!(foreign.status, 404);

        let removed = dispatch(
            &db,
            &request_for("DELETE", "/api/worksite", &first, None),
            &ids,
        );
        assert_eq!(removed.status, 200);
        let rows: i64 = db
            .conn()
            .query_row("SELECT COUNT(*) FROM saved_views", [], |row| row.get(0))
            .unwrap();
        assert_eq!(rows, 0, "deleting the Worksite takes its views with it");
    }
}
