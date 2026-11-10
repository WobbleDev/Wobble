//! The settings routes: read the typed registry, change one setting at a time, and reset.

use serde_json::{json, Value};

use crate::app_settings::{
    get_app_settings, reset_app_settings, save_app_settings, AppSettings, AppSettingsUpdate,
};
use crate::db::Db;
use crate::error::Result;
use crate::handle::{Request, Response};
use crate::router::{message_response, no_store_headers, read_payload};

const SETTING_VALUE_REQUIRED_MESSAGE: &str = "A setting value is required.";
const ONE_SETTING_AT_A_TIME_MESSAGE: &str = "Update one setting at a time.";
const INVALID_SETTING_MESSAGE: &str = "The setting value is invalid.";

fn settings_response(settings: AppSettings) -> Response {
    Response {
        status: 200,
        headers: no_store_headers(),
        body: json!({ "settings": settings }),
    }
}

/// `GET /api/settings`: every registered setting, with defaults for anything not stored.
pub(crate) fn get_settings(db: &Db) -> Result<Response> {
    Ok(settings_response(get_app_settings(db.conn())?))
}

/// `PUT /api/settings`. One setting per request: an array or a scalar is a missing
/// value, two keys is its own error, and an unknown key or a value of the wrong type is
/// the shared invalid-setting 400.
pub(crate) fn put_settings(db: &Db, request: &Request) -> Result<Response> {
    let payload = match read_payload(request) {
        Ok(payload) => payload,
        Err(response) => return Ok(response),
    };

    let Value::Object(fields) = &payload else {
        return Ok(message_response(400, SETTING_VALUE_REQUIRED_MESSAGE));
    };
    if fields.len() != 1 {
        return Ok(message_response(400, ONE_SETTING_AT_A_TIME_MESSAGE));
    }

    let Some((key, value)) = fields.iter().next() else {
        return Ok(message_response(400, SETTING_VALUE_REQUIRED_MESSAGE));
    };
    let update = AppSettingsUpdate {
        key: key.clone(),
        value: value.clone(),
    };
    if update.encode().is_none() {
        return Ok(message_response(400, INVALID_SETTING_MESSAGE));
    }

    Ok(settings_response(save_app_settings(db.conn(), &update)?))
}

/// `DELETE /api/settings`: deletes every settings row and returns the fresh defaults.
/// Worksites, Workers and the Active Worksite are untouched.
pub(crate) fn delete_settings(db: &Db) -> Result<Response> {
    Ok(settings_response(reset_app_settings(db.conn())?))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app_settings::AppSettings;
    use crate::router::dispatch;
    use crate::test_support::{request, seeded};

    fn default_body() -> Value {
        json!({ "settings": AppSettings::default() })
    }

    fn stored_rows(db: &Db) -> i64 {
        db.conn()
            .query_row("SELECT COUNT(*) FROM app_settings", [], |row| row.get(0))
            .unwrap()
    }

    #[test]
    fn settings_get_and_put_carry_no_store_and_one_setting_only() {
        let (db, ids) = seeded();

        let response = dispatch(&db, &request("GET", "/api/settings", None), &ids);
        assert_eq!(response.status, 200);
        assert_eq!(response.body, default_body());
        assert_eq!(
            response.headers,
            vec![("Cache-Control".to_owned(), "no-store".to_owned())]
        );

        let response = dispatch(
            &db,
            &request("PUT", "/api/settings", Some(json!({ "theme": "dark" }))),
            &ids,
        );
        assert_eq!(response.status, 200);
        assert_eq!(response.body["settings"]["theme"], json!("dark"));
        assert_eq!(response.body["settings"]["density"], json!("standard"));
        assert_eq!(
            response.headers,
            vec![("Cache-Control".to_owned(), "no-store".to_owned())]
        );
    }

    #[test]
    fn settings_put_accepts_every_registered_key_at_its_own_typed_value() {
        let (db, ids) = seeded();

        for (key, value) in [
            ("theme", json!("light")),
            ("density", json!("comfortable")),
            ("reduceMotion", json!("reduce")),
            ("increaseContrast", json!(true)),
            ("colorBlindAssessments", json!(true)),
            ("textSize", json!("125")),
            ("rememberWindow", json!(false)),
            ("dateFormat", json!("iso")),
            ("timeFormat", json!("24")),
            ("language", json!("es-419")),
        ] {
            let response = dispatch(
                &db,
                &request("PUT", "/api/settings", Some(json!({ key: value }))),
                &ids,
            );
            assert_eq!(response.status, 200, "{key}");
            assert_eq!(response.body["settings"][key], value, "{key}");
        }
    }

    #[test]
    fn settings_put_rejects_arrays_scalars_two_keys_and_unknown_values() {
        let (db, ids) = seeded();

        for body in [json!([]), json!(42), json!(null), json!("theme")] {
            let response = dispatch(&db, &request("PUT", "/api/settings", Some(body)), &ids);
            assert_eq!(response.status, 400);
            assert_eq!(
                response.body,
                json!({ "message": "A setting value is required." })
            );
        }

        for body in [json!({ "theme": "dark", "density": "compact" }), json!({})] {
            let response = dispatch(&db, &request("PUT", "/api/settings", Some(body)), &ids);
            assert_eq!(response.status, 400);
            assert_eq!(
                response.body,
                json!({ "message": "Update one setting at a time." })
            );
        }

        for body in [
            json!({ "theme": "sepia" }),
            json!({ "density": "cozy" }),
            json!({ "volume": 1 }),
            json!({ "language": "fr" }),
            json!({ "language": "es" }),
            json!({ "language": "en-US" }),
            json!({ "increaseContrast": "true" }),
            json!({ "increaseContrast": 1 }),
            json!({ "textSize": 125 }),
        ] {
            let response = dispatch(&db, &request("PUT", "/api/settings", Some(body)), &ids);
            assert_eq!(response.status, 400);
            assert_eq!(
                response.body,
                json!({ "message": "The setting value is invalid." })
            );
        }

        let response = dispatch(&db, &request("GET", "/api/settings", None), &ids);
        assert_eq!(response.body, default_body());
    }

    #[test]
    fn settings_delete_resets_the_registry_and_keeps_the_data() {
        let (db, ids) = seeded();
        let worksites: i64 = db
            .conn()
            .query_row("SELECT COUNT(*) FROM worksites", [], |row| row.get(0))
            .unwrap();

        for body in [
            json!({ "theme": "dark" }),
            json!({ "density": "compact" }),
            json!({ "increaseContrast": true }),
        ] {
            dispatch(&db, &request("PUT", "/api/settings", Some(body)), &ids);
        }
        assert!(stored_rows(&db) >= 2);

        let response = dispatch(&db, &request("DELETE", "/api/settings", None), &ids);
        assert_eq!(response.status, 200);
        assert_eq!(response.body, default_body());
        assert_eq!(
            response.headers,
            vec![("Cache-Control".to_owned(), "no-store".to_owned())]
        );
        assert_eq!(stored_rows(&db), 0);
        assert_eq!(
            db.conn()
                .query_row("SELECT COUNT(*) FROM worksites", [], |row| {
                    row.get::<_, i64>(0)
                })
                .unwrap(),
            worksites
        );

        let response = dispatch(&db, &request("GET", "/api/settings", None), &ids);
        assert_eq!(response.body, default_body());
    }
}
