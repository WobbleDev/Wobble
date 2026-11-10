//! The route table: the exact (method, path) match that picks a handler, and the response
//! helpers every handler shares. The handlers live in `handlers/`, one module per resource.

use serde_json::{json, Value};

use crate::db::Db;
use crate::handle::{Request, Response};
use crate::handlers::{
    attributes, backup, configuration, data, datasets, drafts, runtime, settings, views,
    vocabulary, worker_merge, workers, worksite,
};
use crate::id::IdSource;
use crate::read_json_request::read_json_request;
use crate::Error;

/// Dispatches one request against an open database. Every (method, path) outside the
/// ported route table answers 501, and a database failure answers 500 with the error's
/// own message, exactly as an uncaught throw did in the TS handlers.
pub fn dispatch(db: &Db, request: &Request, id_source: &impl IdSource) -> Response {
    dispatch_keyed(db, request, id_source, None)
}

pub(crate) fn dispatch_keyed(
    db: &Db,
    request: &Request,
    id_source: &impl IdSource,
    secret: Option<&crate::key::Secret>,
) -> Response {
    // The data controls destroy the pre-image an Undo would restore, so they end it first.
    if matches!(
        (request.method.as_str(), request.path.as_str()),
        ("DELETE", "/api/worksite") | ("POST", "/api/restore") | ("POST", "/api/erase")
    ) {
        db.set_merge_snapshot(None);
    }
    let handled = match (request.method.as_str(), request.path.as_str()) {
        ("GET", "/api/worksite/counts") => worksite::get_worksite_counts(db),
        ("GET", "/api/worksite") => worksite::get_worksite(db, request),
        ("POST", "/api/worksite") => worksite::post_worksite(db, request, id_source),
        ("DELETE", "/api/worksite") => worksite::delete_worksite_route(db, request),
        ("PUT", "/api/worksite") => worksite::put_worksite(db, request),
        ("PUT", "/api/worksite/active") => worksite::put_active_worksite(db, request),
        ("PUT", "/api/attributes") => attributes::put_attributes(db, request, id_source),
        ("POST", "/api/configuration/preview") => {
            configuration::post_configuration_preview(db, request)
        }
        ("POST", "/api/configuration/short-forms") => {
            configuration::post_configuration_short_forms(db, request)
        }
        ("GET", "/api/agitations") => vocabulary::get_agitations_route(db, request),
        ("POST", "/api/agitations") => vocabulary::post_agitation(db, request, id_source),
        ("PUT", "/api/agitations") => vocabulary::put_agitations(db, request, id_source),
        ("GET", "/api/languages") => vocabulary::get_languages_route(db, request),
        ("POST", "/api/languages") => vocabulary::post_language(db, request, id_source),
        ("PUT", "/api/languages") => vocabulary::put_languages(db, request, id_source),
        ("POST", "/api/worker-merge/preview") => worker_merge::post_preview(db, request),
        ("POST", "/api/worker-merge") => worker_merge::post_merge(db, request, id_source),
        ("POST", "/api/worker-merge/undo") => worker_merge::post_undo(db, request),
        ("POST", "/api/worker-merge/dismiss") => worker_merge::post_dismiss(db, request),
        ("POST", "/api/workers") => workers::post_worker(db, request, id_source),
        ("GET", "/api/dataset") => datasets::get_dataset(db, request),
        ("GET", "/api/views") => views::get_views(db, request),
        ("POST", "/api/views") => views::post_view(db, request, id_source),
        ("GET", "/api/runtime") => runtime::get_runtime(db),
        ("GET", "/api/settings") => settings::get_settings(db),
        ("PUT", "/api/settings") => settings::put_settings(db, request),
        ("DELETE", "/api/settings") => settings::delete_settings(db),
        ("POST", "/api/backup") => backup::post_backup_keyed(db, request, secret),
        ("GET", "/api/data-file") => data::get_data_file(db),
        ("POST", "/api/restore") if secret.is_some() => Err(Error::coded(
            "database_recovery_required",
            "Restore must run through the database lifecycle owner.",
        )),
        ("POST", "/api/restore") => data::post_restore(db, request),
        ("POST", "/api/erase") => data::post_erase_keyed(db, request, secret),
        (method, path) => {
            // The dynamic routes, both keyed by a Worker id.
            if let Some(worker_id) = path
                .strip_prefix("/api/worker-drafts/")
                .filter(|worker_id| !worker_id.is_empty())
            {
                match method {
                    "GET" => drafts::get_worker_draft_route(db, request, worker_id),
                    "PUT" => drafts::put_worker_draft_route(db, request, worker_id),
                    "DELETE" => drafts::delete_worker_draft_route(db, request, worker_id),
                    _ => return json_response(501, json!({ "message": "Not implemented." })),
                }
            } else if let Some(view_id) = path
                .strip_prefix("/api/views/")
                .filter(|view_id| !view_id.is_empty())
            {
                match method {
                    "PUT" => views::put_view(db, request, view_id),
                    "DELETE" => views::delete_view_route(db, request, view_id),
                    _ => return json_response(501, json!({ "message": "Not implemented." })),
                }
            } else {
                match path
                    .strip_prefix("/api/workers/")
                    .filter(|worker_id| !worker_id.is_empty())
                {
                    Some(worker_id) => match method {
                        "PUT" => workers::put_worker(db, request, worker_id),
                        "PATCH" => workers::patch_worker(db, request, worker_id, id_source),
                        "DELETE" => workers::delete_worker_route(db, request, worker_id),
                        _ => return json_response(501, json!({ "message": "Not implemented." })),
                    },
                    None => return json_response(501, json!({ "message": "Not implemented." })),
                }
            }
        }
    };

    handled.unwrap_or_else(|error: Error| error_response(&error))
}

/// A status plus a canonical JSON body, with no headers.
pub(crate) fn json_response(status: u16, body: Value) -> Response {
    Response {
        status,
        headers: Vec::new(),
        body,
    }
}

/// The `{message}` error body the handlers share.
pub(crate) fn message_response(status: u16, message: &str) -> Response {
    json_response(status, json!({ "message": message }))
}

/// The coded error body the Worker edit flow routes answer (ADR-0024): the code is the
/// stable handle the UI maps to copy, and message stays for the Show details disclosure.
pub(crate) fn coded_message_response(status: u16, code: &str, message: &str) -> Response {
    json_response(status, json!({ "message": message, "code": code }))
}

/// The 500 for a route that reached the error enum: coded when the error has one (a
/// SQLite failure, stored data that fails decoding, vocabulary from another Worksite).
pub(crate) fn error_response(error: &Error) -> Response {
    match error.code() {
        Some(code) => coded_message_response(500, code, &error.to_string()),
        None => message_response(500, &error.to_string()),
    }
}

/// `Cache-Control: no-store`, which both settings handlers set.
pub(crate) fn no_store_headers() -> Vec<(String, String)> {
    vec![("Cache-Control".to_owned(), "no-store".to_owned())]
}

/// `readJsonRequest` plus its 400: a malformed body is every route's first check.
/// An absent body is the empty string, which fails to parse exactly as JS did.
pub(crate) fn read_payload(request: &Request) -> std::result::Result<Value, Response> {
    match read_json_request(request.body.as_deref().unwrap_or_default()) {
        Ok(payload) => Ok(payload),
        Err(Error::Message(message)) => Err(message_response(400, &message)),
        Err(error) => Err(message_response(500, &error.to_string())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::{first_worksite, request, seeded, HEADER};

    #[test]
    fn unported_routes_and_methods_stay_501() {
        let (db, ids) = seeded();

        for (method, path) in [
            ("GET", "/api/workers"),
            ("GET", "/api/attributes"),
            ("DELETE", "/api/worksite/active"),
            ("PATCH", "/api/settings"),
            ("GET", "/api/settings/extra"),
        ] {
            let response = dispatch(&db, &request(method, path, None), &ids);
            assert_eq!(response.status, 501, "{method} {path}");
            assert_eq!(response.body, json!({ "message": "Not implemented." }));
            assert!(response.headers.is_empty());
        }
    }

    #[test]
    fn an_empty_worksite_header_behaves_like_no_header() {
        let (db, ids) = seeded();
        let first = first_worksite(&db);
        dispatch(&db, &request("POST", "/api/worksite", None), &ids);

        let mut empty_header = request("GET", "/api/worksite", None);
        empty_header
            .headers
            .push((HEADER.to_owned(), String::new()));
        let response = dispatch(&db, &empty_header, &ids);
        assert_eq!(response.body["worksite"]["id"], json!(first));
    }
}
