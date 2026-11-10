//! Active Worksite for a request: reads the x-wobble-worksite header and provides the no-worksite reply.

use rusqlite::Connection;
use serde_json::json;

use crate::error::Result;
use crate::handle::{Request, Response};
use crate::schema::Worksite;
use crate::worksite_persistence::resolve_active_worksite;

/// `activeWorksiteHeaderName`: the request header that names the Active Worksite.
pub const ACTIVE_WORKSITE_HEADER_NAME: &str = "x-wobble-worksite";

/// The request header that carries the app locale the organizer is writing in.
pub const LOCALE_HEADER_NAME: &str = "x-wobble-locale";

/// The app locale a request carries, "en" when it carries none. It selects the word lists a
/// generated Short form uses; nothing is stored from it.
pub fn request_locale(request: &Request) -> &str {
    request
        .headers
        .iter()
        .find(|(name, _)| name.eq_ignore_ascii_case(LOCALE_HEADER_NAME))
        .map(|(_, value)| value.trim())
        .filter(|value| !value.is_empty())
        .unwrap_or("en")
}

/// The one reply for a request that needs an Active Worksite and has none.
pub fn no_active_worksite_response() -> Response {
    Response {
        status: 409,
        body: json!({ "message": "There is no Active Worksite." }),
        headers: Vec::new(),
    }
}

/// The Active Worksite a request names, read from its explicit header. A request
/// with no header — or one naming a Worksite that is gone — falls back to the first
/// Worksite, exactly as an absent or stale cookie used to. Header names are matched
/// case-insensitively, as HTTP requires.
pub fn resolve_request_worksite(conn: &Connection, request: &Request) -> Result<Option<Worksite>> {
    let preferred = request
        .headers
        .iter()
        .find(|(name, _)| name.eq_ignore_ascii_case(ACTIVE_WORKSITE_HEADER_NAME))
        .map(|(_, value)| value.as_str());

    resolve_active_worksite(conn, preferred)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::open_seeded;
    use crate::id::CounterId;
    use crate::worksite_persistence::{create_worksite, list_worksites};

    fn seeded() -> (crate::db::Db, CounterId) {
        let id_source = CounterId::new();
        let db = open_seeded(":memory:", &id_source).expect("a seeded database");
        (db, id_source)
    }

    fn request_with(headers: &[(&str, &str)]) -> Request {
        Request {
            method: "GET".to_owned(),
            path: "/api/worksite".to_owned(),
            query: String::new(),
            headers: headers
                .iter()
                .map(|(name, value)| ((*name).to_owned(), (*value).to_owned()))
                .collect(),
            body: None,
        }
    }

    #[test]
    fn the_locale_header_is_read_case_insensitively_and_defaults_to_english() {
        assert_eq!(request_locale(&request_with(&[])), "en");
        assert_eq!(
            request_locale(&request_with(&[("X-Wobble-Locale", "")])),
            "en"
        );
        assert_eq!(
            request_locale(&request_with(&[("x-wobble-locale", "  ")])),
            "en"
        );
        assert_eq!(
            request_locale(&request_with(&[("X-Wobble-Locale", " es-419 ")])),
            "es-419"
        );
    }

    #[test]
    fn an_absent_empty_or_unknown_header_falls_back_to_the_first_worksite() {
        let (db, _ids) = seeded();
        let first = list_worksites(db.conn()).unwrap().remove(0);

        for headers in [
            vec![],
            vec![(ACTIVE_WORKSITE_HEADER_NAME, "")],
            vec![(ACTIVE_WORKSITE_HEADER_NAME, "unknown-id")],
        ] {
            assert_eq!(
                resolve_request_worksite(db.conn(), &request_with(&headers)).unwrap(),
                Some(first.clone())
            );
        }
    }

    #[test]
    fn a_named_header_selects_that_worksite_and_matches_case_insensitively() {
        let (db, ids) = seeded();
        let second = create_worksite(db.conn(), &ids).unwrap();

        assert_eq!(
            resolve_request_worksite(
                db.conn(),
                &request_with(&[(ACTIVE_WORKSITE_HEADER_NAME, &second.id)])
            )
            .unwrap(),
            Some(second.clone())
        );
        assert_eq!(
            resolve_request_worksite(
                db.conn(),
                &request_with(&[("X-Wobble-Worksite", &second.id)])
            )
            .unwrap(),
            Some(second)
        );
    }

    #[test]
    fn the_no_active_worksite_reply_is_the_shared_409() {
        let response = no_active_worksite_response();

        assert_eq!(response.status, 409);
        assert_eq!(
            response.body,
            json!({ "message": "There is no Active Worksite." })
        );
        assert!(response.headers.is_empty());
    }
}
