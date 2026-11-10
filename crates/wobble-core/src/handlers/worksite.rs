//! The worksite routes: read, create, delete, rename or retarget the Active Worksite, and
//! switch which Worksite is active.

use serde::Serialize;
use serde_json::Value;

use crate::db::Db;
use crate::error::{Error, Result};
use crate::handle::Request;
use crate::handle::Response;
use crate::id::IdSource;
use crate::read_json_request::read_json_request;
use crate::request_worksite::{no_active_worksite_response, resolve_request_worksite};
use crate::router::{json_response, message_response, read_payload};
use crate::schema::{Worksite, WorksiteTemplateLocale};
use crate::serialization::is_committee_target;
use crate::worksite_persistence::{
    count_worksite_workers, create_worksite_with_template, delete_worksite,
    resolve_active_worksite, save_worksite_committee_target, save_worksite_name, select_worksite,
};

const PROVIDE_WORKSITE_FIELD_MESSAGE: &str =
    "Provide a worksite name or a committee coverage target.";
const WORKSITE_NAME_REQUIRED_MESSAGE: &str = "Worksite name is required.";
const COMMITTEE_TARGET_MESSAGE: &str =
    "Committee coverage target must be a whole number from 1 to 100.";
const WORKSITE_ID_REQUIRED_MESSAGE: &str = "Worksite ID is required.";

/// Success body for `GET` and `DELETE /api/worksite`: the surviving Worksite, or null.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
struct WorksiteReply {
    worksite: Option<Worksite>,
}

/// Success body for `POST`, `PUT` and `PUT /api/worksite/active`: the saved Worksite.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
struct SavedWorksiteReply {
    worksite: Worksite,
}

/// One Worksite's Worker count.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
struct WorksiteCount {
    worksite_id: String,
    workers: i64,
}

/// Success body for `GET /api/worksite/counts`: one entry per Worksite, in list order.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
struct WorksiteCountsReply {
    counts: Vec<WorksiteCount>,
}

/// `GET /api/worksite/counts`: every Worksite's Worker count from one grouped query.
pub(crate) fn get_worksite_counts(db: &Db) -> Result<Response> {
    let counts = count_worksite_workers(db.conn())?
        .into_iter()
        .map(|count| WorksiteCount {
            worksite_id: count.worksite_id,
            workers: count.workers,
        })
        .collect();

    Ok(json_response(
        200,
        serde_json::to_value(WorksiteCountsReply { counts })?,
    ))
}

/// `GET /api/worksite` (src/routes/api/worksite/+server.ts:14-15).
pub(crate) fn get_worksite(db: &Db, request: &Request) -> Result<Response> {
    let worksite = resolve_request_worksite(db.conn(), request)?;

    Ok(json_response(
        200,
        serde_json::to_value(WorksiteReply { worksite })?,
    ))
}

/// The creation template a POST may request. A bodyless or empty-object request keeps
/// the legacy English template; malformed JSON, a non-object body, an unsupported value
/// or an unknown member is a 400 that creates nothing.
fn creation_template(request: &Request) -> std::result::Result<WorksiteTemplateLocale, Response> {
    let Some(body) = request.body.as_deref() else {
        return Ok(WorksiteTemplateLocale::En);
    };
    if body.trim().is_empty() {
        return Ok(WorksiteTemplateLocale::En);
    }

    let payload = match read_json_request(body) {
        Ok(payload) => payload,
        Err(Error::Message(message)) => return Err(message_response(400, &message)),
        Err(error) => return Err(message_response(500, &error.to_string())),
    };
    let Value::Object(fields) = &payload else {
        return Err(message_response(
            400,
            "The worksite request body must be an object.",
        ));
    };

    let mut locale = WorksiteTemplateLocale::En;
    for (key, value) in fields {
        if key != "templateLocale" {
            return Err(message_response(
                400,
                &format!("Unknown worksite creation field \"{key}\"."),
            ));
        }
        locale = value
            .as_str()
            .and_then(WorksiteTemplateLocale::parse)
            .ok_or_else(|| message_response(400, "templateLocale must be \"en\" or \"es-419\"."))?;
    }

    Ok(locale)
}

/// `POST /api/worksite` (src/routes/api/worksite/+server.ts:17), now with the optional
/// creation template. Validation happens before the transaction, so a bad payload cannot
/// leave a partial Worksite.
pub(crate) fn post_worksite(
    db: &Db,
    request: &Request,
    id_source: &impl IdSource,
) -> Result<Response> {
    let locale = match creation_template(request) {
        Ok(locale) => locale,
        Err(response) => return Ok(response),
    };
    let worksite = create_worksite_with_template(db.conn(), id_source, locale)?;

    Ok(json_response(
        201,
        serde_json::to_value(SavedWorksiteReply { worksite })?,
    ))
}

/// `DELETE /api/worksite` (src/routes/api/worksite/+server.ts:19-26). The reply
/// carries the surviving Worksite, or null when the last one went away.
pub(crate) fn delete_worksite_route(db: &Db, request: &Request) -> Result<Response> {
    let Some(active) = resolve_request_worksite(db.conn(), request)? else {
        return Ok(no_active_worksite_response());
    };
    if !delete_worksite(db.conn(), &active.id)? {
        return Ok(no_active_worksite_response());
    }

    let survivor = resolve_active_worksite(db.conn(), None)?;
    Ok(json_response(
        200,
        serde_json::to_value(WorksiteReply { worksite: survivor })?,
    ))
}

/// `PUT /api/worksite` (src/routes/api/worksite/+server.ts:28-73).
pub(crate) fn put_worksite(db: &Db, request: &Request) -> Result<Response> {
    let payload = match read_payload(request) {
        Ok(payload) => payload,
        Err(response) => return Ok(response),
    };

    let Some(active) = resolve_request_worksite(db.conn(), request)? else {
        return Ok(no_active_worksite_response());
    };

    // JS `typeof payload === 'object' && payload !== null` lets an array through;
    // the field checks below then find no keys and reject it the same way.
    if !payload.is_object() && !payload.is_array() {
        return Ok(message_response(400, PROVIDE_WORKSITE_FIELD_MESSAGE));
    }

    let has_name = payload.get("name").is_some();
    let committee_target = payload.get("committeeTarget");
    if !has_name && committee_target.is_none() {
        return Ok(message_response(400, PROVIDE_WORKSITE_FIELD_MESSAGE));
    }

    // A missing or non-string name counts as empty, so one message covers all three.
    let name = if has_name {
        payload
            .get("name")
            .and_then(Value::as_str)
            .map(str::trim)
            .unwrap_or_default()
    } else {
        ""
    };
    if has_name && name.is_empty() {
        return Ok(message_response(400, WORKSITE_NAME_REQUIRED_MESSAGE));
    }

    // Both fields are validated before either is written, exactly as the TS does.
    let target = match committee_target {
        Some(target) => {
            if !is_committee_target(target) {
                return Ok(message_response(400, COMMITTEE_TARGET_MESSAGE));
            }
            // D-g: an integer binds directly; an integer-valued float such as 5.0
            // converts to 5, which SQLite's INTEGER affinity then stores as 5.
            match target
                .as_i64()
                .or_else(|| target.as_f64().map(|number| number as i64))
            {
                Some(target) => Some(target),
                None => return Ok(message_response(400, COMMITTEE_TARGET_MESSAGE)),
            }
        }
        None => None,
    };

    let mut updated = active;
    if has_name {
        updated = save_worksite_name(db.conn(), &updated, name)?;
    }
    if let Some(target) = target {
        updated = save_worksite_committee_target(db.conn(), &updated, target)?;
    }

    Ok(json_response(
        200,
        serde_json::to_value(SavedWorksiteReply { worksite: updated })?,
    ))
}

/// `PUT /api/worksite/active` (src/routes/api/worksite/active/+server.ts:7-24).
pub(crate) fn put_active_worksite(db: &Db, request: &Request) -> Result<Response> {
    let payload = match read_payload(request) {
        Ok(payload) => payload,
        Err(response) => return Ok(response),
    };

    let requested = payload
        .get("id")
        .and_then(Value::as_str)
        .filter(|id| !id.trim().is_empty());
    let Some(id) = requested else {
        return Ok(message_response(400, WORKSITE_ID_REQUIRED_MESSAGE));
    };

    let Some(worksite) = select_worksite(db.conn(), id)? else {
        return Ok(message_response(
            404,
            &format!("Worksite \"{id}\" does not exist."),
        ));
    };

    // Switching Worksites ends the remembered merge; naming the current one does not.
    if db
        .merge_snapshot()
        .is_some_and(|snapshot| snapshot.worksite_id() != worksite.id)
    {
        db.set_merge_snapshot(None);
    }

    Ok(json_response(
        200,
        serde_json::to_value(SavedWorksiteReply { worksite })?,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::router::dispatch;
    use crate::test_support::{first_worksite, request, request_for, seeded};
    use crate::worksite_persistence::{find_worksite, list_worksites};
    use serde_json::json;

    #[test]
    fn counts_agree_with_each_worksites_workers() {
        let (db, ids) = seeded();
        let first = first_worksite(&db);
        let second = create_worksite_with_template(db.conn(), &ids, WorksiteTemplateLocale::En)
            .unwrap()
            .id;
        let empty = create_worksite_with_template(db.conn(), &ids, WorksiteTemplateLocale::En)
            .unwrap()
            .id;
        for (worksite, names) in [
            (&first, vec!["Worker 01"]),
            (&second, vec!["Worker 02", "Worker 03", "Worker 04"]),
        ] {
            for name in names {
                let response = dispatch(
                    &db,
                    &request_for(
                        "POST",
                        "/api/workers",
                        worksite,
                        Some(json!({ "name": name })),
                    ),
                    &ids,
                );
                assert_eq!(response.status, 201);
            }
        }

        let response = dispatch(&db, &request("GET", "/api/worksite/counts", None), &ids);
        assert_eq!(response.status, 200);
        let counts = response.body["counts"].as_array().unwrap();
        let listed: Vec<String> = list_worksites(db.conn())
            .unwrap()
            .into_iter()
            .map(|worksite| worksite.id)
            .collect();
        assert_eq!(counts.len(), 3);
        for (count, id) in counts.iter().zip(&listed) {
            assert_eq!(count["worksiteId"], json!(id));
            let dataset = dispatch(&db, &request_for("GET", "/api/dataset", id, None), &ids);
            let workers = dataset.body["workers"].as_array().unwrap().len();
            assert_eq!(count["workers"], json!(workers), "worksite {id}");
        }
        assert_eq!(counts[0]["workers"], json!(1));
        assert_eq!(counts[1]["workers"], json!(3));
        assert_eq!(counts[2]["workers"], json!(0));
        assert_eq!(counts[2]["worksiteId"], json!(empty));
    }

    #[test]
    fn get_worksite_answers_the_active_or_null_worksite() {
        let (db, ids) = seeded();
        let id = first_worksite(&db);

        let response = dispatch(&db, &request("GET", "/api/worksite", None), &ids);
        assert_eq!(response.status, 200);
        assert_eq!(response.body["worksite"]["id"], json!(id));

        delete_worksite(db.conn(), &id).unwrap();
        let response = dispatch(&db, &request("GET", "/api/worksite", None), &ids);
        assert_eq!(response.status, 200);
        assert_eq!(response.body, json!({ "worksite": null }));
    }

    fn attribute_names(db: &Db, worksite_id: &str) -> Vec<String> {
        let mut statement = db
            .conn()
            .prepare("SELECT name FROM worker_attributes WHERE worksite_id = ?1 ORDER BY position")
            .unwrap();
        statement
            .query_map([worksite_id], |row| row.get::<_, String>(0))
            .unwrap()
            .collect::<rusqlite::Result<Vec<String>>>()
            .unwrap()
    }

    #[test]
    fn post_worksite_keeps_the_english_template_for_legacy_and_empty_bodies() {
        let (db, ids) = seeded();

        for (body, expected_name) in [(None, "My Worksite 2"), (Some(json!({})), "My Worksite 3")] {
            let response = dispatch(&db, &request("POST", "/api/worksite", body), &ids);
            assert_eq!(response.status, 201);
            assert_eq!(response.body["worksite"]["name"], json!(expected_name));
            let id = response.body["worksite"]["id"].as_str().unwrap();
            assert_eq!(
                attribute_names(&db, id),
                vec!["Department", "Role", "Shifts"]
            );
        }
    }

    #[test]
    fn post_worksite_uses_the_spanish_template_and_its_unique_name_suffix() {
        let (db, ids) = seeded();

        let first = dispatch(
            &db,
            &request(
                "POST",
                "/api/worksite",
                Some(json!({ "templateLocale": "es-419" })),
            ),
            &ids,
        );
        assert_eq!(first.status, 201);
        assert_eq!(first.body["worksite"]["name"], json!("Mi lugar de trabajo"));
        assert_eq!(first.body["worksite"]["committeeTarget"], json!(5));
        let id = first.body["worksite"]["id"].as_str().unwrap();
        assert_eq!(
            attribute_names(&db, id),
            vec!["Departamento", "Puesto", "Turnos"]
        );

        let second = dispatch(
            &db,
            &request(
                "POST",
                "/api/worksite",
                Some(json!({ "templateLocale": "es-419" })),
            ),
            &ids,
        );
        assert_eq!(second.status, 201);
        assert_eq!(
            second.body["worksite"]["name"],
            json!("Mi lugar de trabajo 2")
        );
    }

    #[test]
    fn post_worksite_rejects_bad_template_payloads_without_creating_a_worksite() {
        let (db, ids) = seeded();
        let before = list_worksites(db.conn()).unwrap().len();

        for body in [
            Some(json!({ "templateLocale": "es" })),
            Some(json!({ "templateLocale": "en-US" })),
            Some(json!({ "templateLocale": 1 })),
            Some(json!({ "templateLocale": null })),
            Some(json!({ "templateLocale": "en", "name": "Extra" })),
            Some(json!([])),
            Some(json!("es-419")),
            Some(json!(null)),
            Some(json!(42)),
        ] {
            let response = dispatch(&db, &request("POST", "/api/worksite", body.clone()), &ids);
            assert_eq!(response.status, 400, "{body:?}");
        }

        let mut malformed = request("POST", "/api/worksite", None);
        malformed.body = Some("{".to_owned());
        let response = dispatch(&db, &malformed, &ids);
        assert_eq!(response.status, 400);
        assert_eq!(
            response.body,
            json!({ "message": "Request body must contain valid JSON." })
        );

        assert_eq!(list_worksites(db.conn()).unwrap().len(), before);
    }

    #[test]
    fn post_worksite_mints_the_next_name_and_seeds_its_attributes() {
        let (db, ids) = seeded();

        let response = dispatch(&db, &request("POST", "/api/worksite", None), &ids);
        assert_eq!(response.status, 201);
        assert_eq!(response.body["worksite"]["name"], json!("My Worksite 2"));
        assert_eq!(response.body["worksite"]["committeeTarget"], json!(5));
        assert_eq!(
            response.body["worksite"]["id"],
            json!("00000000-0000-4000-8000-000000000005")
        );
    }

    #[test]
    fn delete_worksite_answers_the_survivor_then_409_once_none_remain() {
        let (db, ids) = seeded();
        let first = first_worksite(&db);
        dispatch(&db, &request("POST", "/api/worksite", None), &ids);
        let second = list_worksites(db.conn()).unwrap().remove(1).id;

        let response = dispatch(
            &db,
            &request_for("DELETE", "/api/worksite", &second, None),
            &ids,
        );
        assert_eq!(response.status, 200);
        assert_eq!(response.body["worksite"]["id"], json!(first));

        let response = dispatch(
            &db,
            &request_for("DELETE", "/api/worksite", &first, None),
            &ids,
        );
        assert_eq!(response.status, 200);
        assert_eq!(response.body, json!({ "worksite": null }));

        let response = dispatch(&db, &request("DELETE", "/api/worksite", None), &ids);
        assert_eq!(response.status, 409);
        assert_eq!(
            response.body,
            json!({ "message": "There is no Active Worksite." })
        );
    }

    #[test]
    fn put_worksite_renames_and_retargets_and_keeps_both() {
        let (db, ids) = seeded();
        let id = first_worksite(&db);

        let response = dispatch(
            &db,
            &request_for(
                "PUT",
                "/api/worksite",
                &id,
                Some(json!({ "name": "  Renamed  ", "committeeTarget": 12 })),
            ),
            &ids,
        );
        assert_eq!(response.status, 200);
        assert_eq!(response.body["worksite"]["name"], json!("Renamed"));
        assert_eq!(response.body["worksite"]["committeeTarget"], json!(12));
        assert_eq!(
            find_worksite(db.conn(), &id).unwrap().unwrap().name,
            "Renamed"
        );
    }

    #[test]
    fn put_worksite_validates_every_field_before_writing_any_of_them() {
        let (db, ids) = seeded();
        let id = first_worksite(&db);

        // The name is valid but the target is not: nothing may be written.
        let response = dispatch(
            &db,
            &request_for(
                "PUT",
                "/api/worksite",
                &id,
                Some(json!({ "name": "Renamed", "committeeTarget": 0 })),
            ),
            &ids,
        );
        assert_eq!(response.status, 400);
        assert_eq!(
            response.body,
            json!({ "message": "Committee coverage target must be a whole number from 1 to 100." })
        );
        assert_eq!(
            find_worksite(db.conn(), &id).unwrap().unwrap().name,
            "My Worksite"
        );
    }

    #[test]
    fn put_worksite_rejects_a_blank_name_before_the_target_and_accepts_arrays_into_the_field_checks(
    ) {
        let (db, ids) = seeded();
        let id = first_worksite(&db);

        let response = dispatch(
            &db,
            &request_for(
                "PUT",
                "/api/worksite",
                &id,
                Some(json!({ "name": "   ", "committeeTarget": 0 })),
            ),
            &ids,
        );
        assert_eq!(response.status, 400);
        assert_eq!(
            response.body,
            json!({ "message": "Worksite name is required." })
        );

        // An array passes the worksite object check but carries no keys, so it gets
        // the "provide a name or target" message — not a dedicated array error.
        let response = dispatch(
            &db,
            &request_for("PUT", "/api/worksite", &id, Some(json!([]))),
            &ids,
        );
        assert_eq!(response.status, 400);
        assert_eq!(
            response.body,
            json!({ "message": "Provide a worksite name or a committee coverage target." })
        );
    }

    #[test]
    fn put_worksite_reports_a_missing_body_primitive_or_missing_fields() {
        let (db, ids) = seeded();
        let id = first_worksite(&db);

        let response = dispatch(&db, &request_for("PUT", "/api/worksite", &id, None), &ids);
        assert_eq!(response.status, 400);
        assert_eq!(
            response.body,
            json!({ "message": "Request body must contain valid JSON." })
        );

        for body in [json!(42), json!(null), json!({}), json!([])] {
            let response = dispatch(
                &db,
                &request_for("PUT", "/api/worksite", &id, Some(body)),
                &ids,
            );
            assert_eq!(response.status, 400);
            assert_eq!(
                response.body,
                json!({ "message": "Provide a worksite name or a committee coverage target." })
            );
        }
    }

    #[test]
    fn put_worksite_without_an_active_worksite_is_409() {
        let (db, ids) = seeded();
        let id = first_worksite(&db);
        delete_worksite(db.conn(), &id).unwrap();

        let response = dispatch(
            &db,
            &request_for("PUT", "/api/worksite", &id, Some(json!({ "name": "X" }))),
            &ids,
        );
        assert_eq!(response.status, 409);
        assert_eq!(
            response.body,
            json!({ "message": "There is no Active Worksite." })
        );
    }

    #[test]
    fn active_put_validates_and_looks_up_the_requested_id() {
        let (db, ids) = seeded();
        let first = first_worksite(&db);
        dispatch(&db, &request("POST", "/api/worksite", None), &ids);
        let second = list_worksites(db.conn()).unwrap().remove(1).id;

        let response = dispatch(
            &db,
            &request(
                "PUT",
                "/api/worksite/active",
                Some(json!({ "id": second.clone() })),
            ),
            &ids,
        );
        assert_eq!(response.status, 200);
        assert_eq!(response.body["worksite"]["id"], json!(second));

        for body in [
            json!({}),
            json!({ "id": "   " }),
            json!({ "id": 42 }),
            json!([]),
            json!("ghost"),
        ] {
            let response = dispatch(
                &db,
                &request("PUT", "/api/worksite/active", Some(body)),
                &ids,
            );
            assert_eq!(response.status, 400);
            assert_eq!(
                response.body,
                json!({ "message": "Worksite ID is required." })
            );
        }

        let response = dispatch(
            &db,
            &request(
                "PUT",
                "/api/worksite/active",
                Some(json!({ "id": "ghost" })),
            ),
            &ids,
        );
        assert_eq!(response.status, 404);
        assert_eq!(
            response.body,
            json!({ "message": "Worksite \"ghost\" does not exist." })
        );
        assert!(find_worksite(db.conn(), &first).unwrap().is_some());
    }
}
