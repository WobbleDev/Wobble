//! The Agitation and Language routes: list, add one, and save the whole list with its
//! renames and merges.

use serde::Serialize;
use serde_json::Value;

use crate::agitation_persistence::{
    create_agitation, get_agitations, replace_agitations_with_merges, Agitation, AgitationMerge,
};
use crate::db::Db;
use crate::error::Result;
use crate::handle::{Request, Response};
use crate::id::IdSource;
use crate::language_persistence::{
    create_language, get_languages, replace_languages_with_merges, Language, LanguageMerge,
};
use crate::request_worksite::{no_active_worksite_response, resolve_request_worksite};
use crate::router::{json_response, message_response, read_payload};
use crate::serialization::{
    is_agitation_list, is_agitation_text, is_language_list, is_language_name,
};

const NON_EMPTY_AGITATION_MESSAGE: &str = "Request must contain a non-empty agitation.";
const INVALID_AGITATION_LIST_MESSAGE: &str =
    "Request must contain valid agitations with unique text.";
const NON_EMPTY_LANGUAGE_MESSAGE: &str = "Request must contain a non-empty language.";
const INVALID_LANGUAGE_LIST_MESSAGE: &str =
    "Request must contain valid languages with unique names.";

/// Success body for `GET` and `PUT /api/agitations`: the Worksite's agitations.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
struct AgitationsReply {
    agitations: Vec<Agitation>,
}

/// Success body for `POST /api/agitations`.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
struct AgitationCreatedReply {
    agitation: Agitation,
    created: bool,
}

/// Success body for `GET` and `PUT /api/languages`: the Worksite's languages.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
struct LanguagesReply {
    languages: Vec<Language>,
}

/// Success body for `POST /api/languages`.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
struct LanguageCreatedReply {
    language: Language,
    created: bool,
}

/// `GET /api/agitations` (src/routes/api/agitations/+server.ts:60-61). No 409: a
/// missing Active Worksite simply reads an empty list.
pub(crate) fn get_agitations_route(db: &Db, request: &Request) -> Result<Response> {
    let worksite = resolve_request_worksite(db.conn(), request)?;

    Ok(json_response(
        200,
        serde_json::to_value(AgitationsReply {
            agitations: get_agitations(db.conn(), &worksite)?,
        })?,
    ))
}

/// `POST /api/agitations` (src/routes/api/agitations/+server.ts:14-33). The Active
/// Worksite is resolved before the body is read, and a text the Worksite already
/// lists is a 200 with `created: false` rather than a conflict.
pub(crate) fn post_agitation(
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

    // `typeof payload === 'object' && payload !== null && 'text' in payload ? payload.text : null`
    // — `Value::get` is that test for objects, arrays and scalars alike.
    let Some(text) = payload
        .get("text")
        .filter(|text| is_agitation_text(text))
        .and_then(Value::as_str)
    else {
        return Ok(message_response(400, NON_EMPTY_AGITATION_MESSAGE));
    };

    let result = create_agitation(db.conn(), &active, text.trim(), id_source)?;

    Ok(json_response(
        200,
        serde_json::to_value(AgitationCreatedReply {
            agitation: result.agitation,
            created: result.created,
        })?,
    ))
}

/// `PUT /api/agitations` (src/routes/api/agitations/+server.ts:35-58).
pub(crate) fn put_agitations(
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

    if !is_agitation_list(&payload) {
        return Ok(message_response(400, INVALID_AGITATION_LIST_MESSAGE));
    }

    // The guard proved every field's shape; the fallbacks only keep this total. An entry
    // with `mergedInto` is folded into that kept survivor rather than kept itself.
    let mut agitations: Vec<Agitation> = Vec::new();
    let mut merges: Vec<AgitationMerge> = Vec::new();
    for agitation in payload.as_array().map(Vec::as_slice).unwrap_or_default() {
        let id = agitation
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned();
        match agitation.get("mergedInto").and_then(Value::as_str) {
            Some(survivor_id) => merges.push(AgitationMerge {
                folded_id: id,
                survivor_id: survivor_id.to_owned(),
            }),
            None => agitations.push(Agitation {
                id,
                text: agitation
                    .get("text")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .trim()
                    .to_owned(),
            }),
        }
    }

    let saved =
        replace_agitations_with_merges(db.conn(), &active, &agitations, &merges, id_source)?;

    Ok(json_response(
        200,
        serde_json::to_value(AgitationsReply { agitations: saved })?,
    ))
}

/// `GET /api/languages` (src/routes/api/languages/+server.ts:60-61). As with
/// agitations, no Active Worksite reads an empty list rather than 409.
pub(crate) fn get_languages_route(db: &Db, request: &Request) -> Result<Response> {
    let worksite = resolve_request_worksite(db.conn(), request)?;

    Ok(json_response(
        200,
        serde_json::to_value(LanguagesReply {
            languages: get_languages(db.conn(), &worksite)?,
        })?,
    ))
}

/// `POST /api/languages` (src/routes/api/languages/+server.ts:14-33).
pub(crate) fn post_language(
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

    let Some(name) = payload
        .get("name")
        .filter(|name| is_language_name(name))
        .and_then(Value::as_str)
    else {
        return Ok(message_response(400, NON_EMPTY_LANGUAGE_MESSAGE));
    };

    let result = create_language(db.conn(), &active, name.trim(), id_source)?;

    Ok(json_response(
        200,
        serde_json::to_value(LanguageCreatedReply {
            language: result.language,
            created: result.created,
        })?,
    ))
}

/// `PUT /api/languages` (src/routes/api/languages/+server.ts:35-58).
pub(crate) fn put_languages(
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

    if !is_language_list(&payload) {
        return Ok(message_response(400, INVALID_LANGUAGE_LIST_MESSAGE));
    }

    // As for agitations: an entry with `mergedInto` folds into that kept survivor.
    let mut languages: Vec<Language> = Vec::new();
    let mut merges: Vec<LanguageMerge> = Vec::new();
    for language in payload.as_array().map(Vec::as_slice).unwrap_or_default() {
        let id = language
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned();
        match language.get("mergedInto").and_then(Value::as_str) {
            Some(survivor_id) => merges.push(LanguageMerge {
                folded_id: id,
                survivor_id: survivor_id.to_owned(),
            }),
            None => languages.push(Language {
                id,
                name: language
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .trim()
                    .to_owned(),
            }),
        }
    }

    let saved = replace_languages_with_merges(db.conn(), &active, &languages, &merges, id_source)?;

    Ok(json_response(
        200,
        serde_json::to_value(LanguagesReply { languages: saved })?,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::id::CounterId;
    use crate::router::dispatch;
    use crate::test_support::{first_worksite, request, seeded};
    use crate::worker_persistence::insert_bare_worker;
    use crate::worksite_persistence::delete_worksite;
    use rusqlite::params;
    use serde_json::json;

    #[test]
    fn agitation_and_language_posts_resolve_the_active_worksite_before_the_body() {
        let (db, ids) = seeded();
        let id = first_worksite(&db);
        delete_worksite(db.conn(), &id).unwrap();

        for path in ["/api/agitations", "/api/languages"] {
            let malformed = Request {
                method: "POST".to_owned(),
                path: path.to_owned(),
                query: String::new(),
                headers: vec![("content-type".to_owned(), "application/json".to_owned())],
                body: Some("{not json".to_owned()),
            };

            // No Active Worksite wins over the malformed body: the resolve comes first.
            let response = dispatch(&db, &malformed, &ids);
            assert_eq!(response.status, 409, "{path}");
            assert_eq!(
                response.body,
                json!({ "message": "There is no Active Worksite." })
            );
        }
    }

    #[test]
    fn agitation_and_language_writes_trim_and_match_case_insensitively() {
        let (db, ids) = seeded();

        let response = dispatch(
            &db,
            &request(
                "POST",
                "/api/agitations",
                Some(json!({ "text": "  Pay  " })),
            ),
            &ids,
        );
        assert_eq!(response.status, 200);
        assert_eq!(response.body["created"], json!(true));
        assert_eq!(response.body["agitation"]["text"], json!("Pay"));

        // The next create matches on the trimmed, case-folded text and keeps the
        // stored spelling, reporting `created: false` — still a 200.
        let response = dispatch(
            &db,
            &request("POST", "/api/agitations", Some(json!({ "text": "PAY" }))),
            &ids,
        );
        assert_eq!(response.status, 200);
        assert_eq!(response.body["created"], json!(false));
        assert_eq!(response.body["agitation"]["text"], json!("Pay"));

        let response = dispatch(
            &db,
            &request(
                "PUT",
                "/api/languages",
                Some(json!([{ "id": "l", "name": "  Polish  " }])),
            ),
            &ids,
        );
        assert_eq!(response.status, 200);
        assert_eq!(
            response.body["languages"],
            json!([{ "id": "l", "name": "Polish" }])
        );
    }

    /// The ids a Worker holds in one assignment table, sorted, for the edit tests.
    fn held(db: &Db, table: &str, column: &str, worker: &str) -> Vec<String> {
        let mut statement = db
            .conn()
            .prepare(&format!(
                "SELECT {column} FROM {table} WHERE worker_id = ?1 ORDER BY {column}"
            ))
            .unwrap();
        statement
            .query_map([worker], |row| row.get::<_, String>(0))
            .unwrap()
            .collect::<rusqlite::Result<Vec<String>>>()
            .unwrap()
    }

    fn seed_worker(db: &Db, worksite: &str, worker: &str) {
        insert_bare_worker(db.conn(), worksite, worker, "Test Worker", "");
    }

    fn assign(db: &Db, table: &str, column: &str, worker: &str, value: &str) {
        db.conn()
            .execute(
                &format!("INSERT INTO {table} (worker_id, {column}) VALUES (?1, ?2)"),
                params![worker, value],
            )
            .unwrap();
    }

    fn create_value(db: &Db, ids: &CounterId, path: &str, key: &str, text: &str) -> String {
        let response = dispatch(db, &request("POST", path, Some(json!({ key: text }))), ids);
        assert_eq!(response.status, 200);
        let value = if path.ends_with("agitations") {
            &response.body["agitation"]
        } else {
            &response.body["language"]
        };
        value["id"].as_str().unwrap().to_owned()
    }

    fn put_list(db: &Db, ids: &CounterId, path: &str, body: Value) -> Response {
        dispatch(db, &request("PUT", path, Some(body)), ids)
    }

    #[test]
    fn agitation_rename_keeps_its_id_and_holders() {
        let (db, ids) = seeded();
        let worksite = first_worksite(&db);
        let pay = create_value(&db, &ids, "/api/agitations", "text", "Unpaid overtime");
        seed_worker(&db, &worksite, "w1");
        assign(&db, "worker_agitations", "agitation_id", "w1", &pay);

        let response = put_list(
            &db,
            &ids,
            "/api/agitations",
            json!([{ "id": pay, "text": "Overtime is unpaid" }]),
        );

        assert_eq!(response.status, 200);
        assert_eq!(
            response.body["agitations"],
            json!([{ "id": pay, "text": "Overtime is unpaid" }])
        );
        assert_eq!(held(&db, "worker_agitations", "agitation_id", "w1"), [pay]);
    }

    #[test]
    fn agitation_merge_remaps_holders_and_holds_a_shared_worker_once() {
        let (db, ids) = seeded();
        let worksite = first_worksite(&db);
        let pay = create_value(&db, &ids, "/api/agitations", "text", "Pay");
        let wages = create_value(&db, &ids, "/api/agitations", "text", "Wages");
        for worker in ["w1", "w2", "w3"] {
            seed_worker(&db, &worksite, worker);
        }
        assign(&db, "worker_agitations", "agitation_id", "w1", &wages);
        assign(&db, "worker_agitations", "agitation_id", "w2", &wages);
        assign(&db, "worker_agitations", "agitation_id", "w2", &pay);
        assign(&db, "worker_agitations", "agitation_id", "w3", &pay);

        let response = put_list(
            &db,
            &ids,
            "/api/agitations",
            json!([
                { "id": pay, "text": "Pay" },
                { "id": wages, "text": "Wages", "mergedInto": pay }
            ]),
        );

        assert_eq!(response.status, 200);
        assert_eq!(
            response.body["agitations"],
            json!([{ "id": pay, "text": "Pay" }])
        );
        assert_eq!(
            held(&db, "worker_agitations", "agitation_id", "w1"),
            std::slice::from_ref(&pay)
        );
        assert_eq!(
            held(&db, "worker_agitations", "agitation_id", "w2"),
            std::slice::from_ref(&pay)
        );
        assert_eq!(held(&db, "worker_agitations", "agitation_id", "w3"), [pay]);
    }

    #[test]
    fn agitation_swap_and_chained_rename_resolve_by_id() {
        let (db, ids) = seeded();
        let worksite = first_worksite(&db);
        let alpha = create_value(&db, &ids, "/api/agitations", "text", "Alpha");
        let beta = create_value(&db, &ids, "/api/agitations", "text", "Beta");
        seed_worker(&db, &worksite, "w1");
        assign(&db, "worker_agitations", "agitation_id", "w1", &alpha);

        let swapped = put_list(
            &db,
            &ids,
            "/api/agitations",
            json!([
                { "id": alpha, "text": "Beta" },
                { "id": beta, "text": "Alpha" }
            ]),
        );
        assert_eq!(swapped.status, 200);
        assert_eq!(
            held(&db, "worker_agitations", "agitation_id", "w1"),
            std::slice::from_ref(&alpha)
        );
        let listed = dispatch(&db, &request("GET", "/api/agitations", None), &ids);
        assert_eq!(
            listed.body["agitations"],
            json!([
                { "id": beta, "text": "Alpha" },
                { "id": alpha, "text": "Beta" }
            ])
        );

        let chained = put_list(
            &db,
            &ids,
            "/api/agitations",
            json!([
                { "id": alpha, "text": "Gamma" },
                { "id": beta, "text": "Alpha" }
            ]),
        );
        assert_eq!(chained.status, 200);
        assert_eq!(chained.body["agitations"].as_array().unwrap().len(), 2);
    }

    #[test]
    fn agitation_merge_into_a_missing_survivor_is_refused_and_changes_nothing() {
        let (db, ids) = seeded();
        let worksite = first_worksite(&db);
        let pay = create_value(&db, &ids, "/api/agitations", "text", "Pay");
        let wages = create_value(&db, &ids, "/api/agitations", "text", "Wages");
        seed_worker(&db, &worksite, "w1");
        assign(&db, "worker_agitations", "agitation_id", "w1", &wages);

        let response = put_list(
            &db,
            &ids,
            "/api/agitations",
            json!([
                { "id": pay, "text": "Pay" },
                { "id": wages, "text": "Wages", "mergedInto": "ghost" }
            ]),
        );

        assert_eq!(response.status, 400);
        assert_eq!(
            held(&db, "worker_agitations", "agitation_id", "w1"),
            [wages]
        );
    }

    #[test]
    fn agitation_merge_with_a_foreign_folded_row_rolls_back_the_whole_save() {
        let (db, ids) = seeded();
        let worksite = first_worksite(&db);
        let pay = create_value(&db, &ids, "/api/agitations", "text", "Pay");
        let wages = create_value(&db, &ids, "/api/agitations", "text", "Wages");
        seed_worker(&db, &worksite, "w1");
        assign(&db, "worker_agitations", "agitation_id", "w1", &wages);
        db.conn()
            .execute(
                "INSERT INTO worksites (id, name, committee_target) VALUES ('other', 'Other', 5)",
                [],
            )
            .unwrap();
        db.conn()
            .execute(
                "INSERT INTO agitations (id, worksite_id, text) VALUES ('foreign', 'other', 'Foreign')",
                [],
            )
            .unwrap();

        let response = put_list(
            &db,
            &ids,
            "/api/agitations",
            json!([
                { "id": pay, "text": "Renamed pay" },
                { "id": wages, "text": "Wages", "mergedInto": pay },
                { "id": "foreign", "text": "Foreign", "mergedInto": pay }
            ]),
        );

        assert_eq!(response.status, 500);
        assert_eq!(
            held(&db, "worker_agitations", "agitation_id", "w1"),
            std::slice::from_ref(&wages)
        );
        assert_eq!(
            create_value(&db, &ids, "/api/agitations", "text", "Pay"),
            pay
        );
        let stored: i64 = db
            .conn()
            .query_row(
                "SELECT COUNT(*) FROM agitations WHERE worksite_id = ?1 AND id = ?2",
                params![worksite, wages],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(stored, 1);
    }

    #[test]
    fn language_rename_swap_and_merge_follow_the_same_rules() {
        let (db, ids) = seeded();
        let worksite = first_worksite(&db);
        let polish = create_value(&db, &ids, "/api/languages", "name", "Polish");
        let urdu = create_value(&db, &ids, "/api/languages", "name", "Urdu");
        seed_worker(&db, &worksite, "w1");
        seed_worker(&db, &worksite, "w2");
        assign(&db, "worker_languages", "language_id", "w1", &urdu);
        assign(&db, "worker_languages", "language_id", "w2", &urdu);
        assign(&db, "worker_languages", "language_id", "w2", &polish);

        let merged = put_list(
            &db,
            &ids,
            "/api/languages",
            json!([
                { "id": polish, "name": "Polski" },
                { "id": urdu, "name": "polski", "mergedInto": polish }
            ]),
        );

        assert_eq!(merged.status, 200);
        assert_eq!(
            merged.body["languages"],
            json!([{ "id": polish, "name": "Polski" }])
        );
        assert_eq!(
            held(&db, "worker_languages", "language_id", "w1"),
            std::slice::from_ref(&polish)
        );
        assert_eq!(held(&db, "worker_languages", "language_id", "w2"), [polish]);
    }
}
