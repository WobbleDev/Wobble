//! The Configuration preview route: the read-only impact of a proposed Save all.

use serde::Serialize;
use serde_json::Value;

use crate::configuration_preview::{
    preview_configuration, suggest_short_forms, ConfigurationPreviewProposal, ProposedSharedValue,
    SuggestedShortForm,
};
use crate::db::Db;
use crate::error::Result;
use crate::handle::{Request, Response};
use crate::request_worksite::{
    no_active_worksite_response, request_locale, resolve_request_worksite,
};
use crate::router::{coded_message_response, json_response, read_payload};
use crate::schema::Worksite;
use crate::serialization::{
    diagnose_attribute_hierarchy, is_agitation_list, is_language_list,
    is_worker_attribute_configuration,
};

/// Every refused body answers this one structured validation error. The code is the
/// stable handle the client maps to its own copy (ADR-0024); the message is diagnostic.
const INVALID_PREVIEW_CODE: &str = "invalid_configuration_preview";
const INVALID_PREVIEW_MESSAGE: &str =
    "Request must contain valid proposed attributes, agitations, and languages.";

/// `POST /api/configuration/preview`. Scoped by the normal Active Worksite header, it
/// validates all three proposed sets, reconciles the Attributes through the same planner
/// and the shared sets through the same assignment rules the save uses, and writes
/// nothing. A missing set is a validation error rather than an instruction to delete that
/// set.
pub(crate) fn post_configuration_preview(db: &Db, request: &Request) -> Result<Response> {
    let (active, proposal) = match read_proposal(db, request)? {
        Ok(read) => read,
        Err(response) => return Ok(response),
    };

    let preview =
        match preview_configuration(request_locale(request), db.conn(), &active, &proposal) {
            Ok(preview) => preview,
            Err(error) => match coded_configuration_refusal(&error) {
                Some(response) => return Ok(response),
                None => return Err(error),
            },
        };

    Ok(json_response(200, serde_json::to_value(preview)?))
}

/// The `POST /api/configuration/short-forms` success body: the Short form each surviving
/// proposed value would be stored with.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
struct ShortFormsReply {
    short_forms: Vec<SuggestedShortForm>,
}

/// `POST /api/configuration/short-forms`: the same proposed Save as the preview, answered
/// with only the Short form each surviving value would be stored with (ADR 0046). It is the
/// light read behind the Short form fields, so editing never computes impacts. Writes nothing.
pub(crate) fn post_configuration_short_forms(db: &Db, request: &Request) -> Result<Response> {
    let (active, proposal) = match read_proposal(db, request)? {
        Ok(read) => read,
        Err(response) => return Ok(response),
    };

    let short_forms = suggest_short_forms(request_locale(request), db.conn(), &active, &proposal)?;
    Ok(json_response(
        200,
        serde_json::to_value(ShortFormsReply { short_forms })?,
    ))
}

/// The Active Worksite and the proposed sets of a preview-shaped request, or the response
/// that refuses it. The Worksite resolves before the body is read.
fn read_proposal(
    db: &Db,
    request: &Request,
) -> Result<std::result::Result<(Worksite, ConfigurationPreviewProposal), Response>> {
    let Some(active) = resolve_request_worksite(db.conn(), request)? else {
        return Ok(Err(no_active_worksite_response()));
    };

    // The existing request boundary reads the body; a malformed one is its usual 400.
    let payload = match read_payload(request) {
        Ok(payload) => payload,
        Err(response) => return Ok(Err(response)),
    };

    let Some(object) = payload.as_object() else {
        return Ok(Err(invalid_preview()));
    };
    let (Some(attributes), Some(agitations), Some(languages)) = (
        object.get("attributes"),
        object.get("agitations"),
        object.get("languages"),
    ) else {
        return Ok(Err(invalid_preview()));
    };
    if !is_worker_attribute_configuration(attributes) {
        return Ok(Err(match diagnose_attribute_hierarchy(attributes) {
            Some(diagnosis) => coded_message_response(400, diagnosis.code, &diagnosis.message),
            None => invalid_preview(),
        }));
    }
    if !is_agitation_list(agitations) || !is_language_list(languages) {
        return Ok(Err(invalid_preview()));
    }

    let proposal = ConfigurationPreviewProposal {
        attributes: crate::handlers::attributes::decode_attribute_definitions(attributes),
        agitations: proposed_shared_values(agitations, "text"),
        languages: proposed_shared_values(languages, "name"),
    };
    Ok(Ok((active, proposal)))
}

/// A Configuration change the request boundary can explain to the organizer answers a
/// coded 400 instead of a generic failure. This is the one mapping both the preview and
/// the Save use; an uncoded error is a real failure and stays one.
pub(crate) fn coded_configuration_refusal(error: &crate::Error) -> Option<Response> {
    let code = error.code()?;
    let status = match code {
        "configuration_answer_has_children" | "configuration_merge_invalid" => 400,
        // A definition change the envelope cannot prove needs explicit resolutions; the
        // legacy array Save answers the same stable code as the resolution-aware Save.
        "configuration_resolution_required" => 409,
        _ => return None,
    };
    Some(crate::router::coded_message_response(
        status,
        code,
        &error.to_string(),
    ))
}

fn invalid_preview() -> Response {
    coded_message_response(400, INVALID_PREVIEW_CODE, INVALID_PREVIEW_MESSAGE)
}

/// The proposed shared values with their merge markers. The shape guard already proved
/// every field; the fallbacks only keep this total.
fn proposed_shared_values(payload: &Value, label_key: &str) -> Vec<ProposedSharedValue> {
    payload
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or_default()
        .iter()
        .map(|entry| ProposedSharedValue {
            id: entry
                .get("id")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned(),
            label: entry
                .get(label_key)
                .and_then(Value::as_str)
                .unwrap_or_default()
                .trim()
                .to_owned(),
            merged_into: entry
                .get("mergedInto")
                .and_then(Value::as_str)
                .map(str::to_owned),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::attribute_persistence::get_worker_attributes;
    use crate::router::dispatch;
    use crate::test_support::{first_worksite, request, seeded};
    use crate::worksite_persistence::delete_worksite;
    use serde_json::json;

    #[test]
    fn a_preview_resolves_the_active_worksite_before_it_reads_the_body() {
        let (db, ids) = seeded();
        delete_worksite(db.conn(), &first_worksite(&db)).unwrap();

        let malformed = Request {
            method: "POST".to_owned(),
            path: "/api/configuration/preview".to_owned(),
            query: String::new(),
            headers: vec![("content-type".to_owned(), "application/json".to_owned())],
            body: Some("{not json".to_owned()),
        };

        let response = dispatch(&db, &malformed, &ids);
        assert_eq!(response.status, 409);
        assert_eq!(
            response.body,
            json!({ "message": "There is no Active Worksite." })
        );
    }

    #[test]
    fn a_malformed_body_keeps_the_shared_json_400() {
        let (db, ids) = seeded();
        let malformed = Request {
            method: "POST".to_owned(),
            path: "/api/configuration/preview".to_owned(),
            query: String::new(),
            headers: vec![("content-type".to_owned(), "application/json".to_owned())],
            body: Some("{not json".to_owned()),
        };

        let response = dispatch(&db, &malformed, &ids);
        assert_eq!(response.status, 400);
        assert_eq!(
            response.body,
            json!({ "message": "Request body must contain valid JSON." })
        );
    }

    #[test]
    fn the_preview_route_writes_nothing_for_an_unchanged_proposal() {
        let (db, ids) = seeded();
        let attributes = get_worker_attributes(
            db.conn(),
            &crate::worksite_persistence::resolve_active_worksite(db.conn(), None).unwrap(),
        )
        .unwrap();

        let response = dispatch(
            &db,
            &request(
                "POST",
                "/api/configuration/preview",
                Some(json!({
                    "attributes": serde_json::to_value(&attributes).unwrap(),
                    "agitations": [],
                    "languages": []
                })),
            ),
            &ids,
        );

        assert_eq!(response.status, 200, "{:?}", response.body);
        assert_eq!(response.body["changes"], json!([]));
        assert_eq!(response.body["totals"]["affectedWorkers"], json!(0));
    }

    #[test]
    fn a_preview_never_consumes_an_id() {
        struct PanicIds;
        impl crate::id::IdSource for PanicIds {
            fn next_id(&self) -> String {
                panic!("the preview consumed an id");
            }
        }

        let (db, _ids) = seeded();
        let worksite =
            crate::worksite_persistence::resolve_active_worksite(db.conn(), None).unwrap();
        let attributes = get_worker_attributes(db.conn(), &worksite).unwrap();

        let response = dispatch(
            &db,
            &request(
                "POST",
                "/api/configuration/preview",
                Some(json!({
                    "attributes": serde_json::to_value(&attributes).unwrap(),
                    "agitations": [],
                    "languages": []
                })),
            ),
            &PanicIds,
        );

        assert_eq!(response.status, 200, "{:?}", response.body);
    }
}
