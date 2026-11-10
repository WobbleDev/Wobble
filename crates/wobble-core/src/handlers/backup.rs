//! The backup route: copy the open database to a path the caller chose.

use serde_json::{json, Value};

use crate::db::Db;
use crate::error::Result;
use crate::handle::{Request, Response};
use crate::router::{json_response, message_response, read_payload};

/// `POST /api/backup` — the only route with no Node handler to port (F01).
const BACKUP_PATH_REQUIRED_MESSAGE: &str = "A backup path is required.";

/// `POST /api/backup` — F01's Export backup, and the one route with no Node handler to
/// port. Handle-to-handle copy streams from the open connection into an open handle,
/// so the source is never moved, renamed or deleted; a copy that fails (an unwritable
/// path, a full disk) bubbles up as the 500 `dispatch` builds from the error.
/// Path-based backup() is forbidden for encrypted generations (review F1): the
/// destination is opened first, keyed when the generation is encrypted, and the
/// copy runs handle-to-handle. This route serves the plaintext legacy generation
/// (None key) behind the 03-05 barrier; 04 threads the installation credential.
pub(crate) fn post_backup_keyed(
    db: &Db,
    request: &Request,
    secret: Option<&crate::key::Secret>,
) -> Result<Response> {
    let payload = match read_payload(request) {
        Ok(payload) => payload,
        Err(response) => return Ok(response),
    };

    // A missing, empty, blank or non-string path is the same complaint; `get` on a
    // non-object payload is `None`, so an array or scalar lands here too.
    match payload.get("path").and_then(Value::as_str) {
        Some(path) if !path.trim().is_empty() => {
            crate::replacement::export_connection(
                db.conn(),
                std::path::Path::new(path),
                secret,
                true,
            )?;

            Ok(json_response(200, json!({})))
        }
        _ => Ok(message_response(400, BACKUP_PATH_REQUIRED_MESSAGE)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::router::dispatch;
    use crate::test_support::{request, seeded};
    use crate::worksite_persistence::list_worksites;

    /// The source is `:memory:`, so this also pins that `backup()` needs no source path:
    /// it streams whatever the open connection holds into a standalone v12 file.
    #[test]
    fn post_backup_copies_the_database_and_never_moves_it() {
        let (db, ids) = seeded();
        let target = std::path::PathBuf::from(crate::test_support::temp_db_path(
            "wobble-backup-test.sqlite",
        ));
        let remove_target = || {
            for suffix in ["", "-wal", "-shm"] {
                let _ = std::fs::remove_file(format!("{}{suffix}", target.display()));
            }
        };
        remove_target();

        let response = dispatch(
            &db,
            &request(
                "POST",
                "/api/backup",
                Some(json!({ "path": target.to_str().unwrap_or_default() })),
            ),
            &ids,
        );
        assert_eq!(response.status, 200);
        assert_eq!(response.body, json!({}));

        // The copy opens on its own and holds the seeded Worksite.
        let source_worksites = list_worksites(db.conn()).unwrap();
        let copy = Db::open_legacy_fixture(target.to_str().unwrap_or_default())
            .expect("the copy opens as v12");
        let copied = list_worksites(copy.conn()).unwrap();
        assert_eq!(copied.len(), source_worksites.len());
        assert_eq!(copied[0].id, source_worksites[0].id);
        assert_eq!(copied[0].name, source_worksites[0].name);

        // The original still answers, unmoved.
        let source = dispatch(&db, &request("GET", "/api/worksite", None), &ids);
        assert_eq!(source.status, 200);
        assert_eq!(source.body["worksite"]["id"], json!(source_worksites[0].id));

        remove_target();
    }

    #[test]
    fn post_backup_requires_a_non_empty_path() {
        let (db, ids) = seeded();

        for body in [
            json!({}),
            json!({ "path": "" }),
            json!({ "path": "   " }),
            json!({ "path": 42 }),
            json!({ "path": null }),
            json!([]),
        ] {
            let response = dispatch(
                &db,
                &request("POST", "/api/backup", Some(body.clone())),
                &ids,
            );
            assert_eq!(response.status, 400, "{body}");
            assert_eq!(
                response.body,
                json!({ "message": "A backup path is required." }),
                "{body}"
            );
        }

        let mut malformed = request("POST", "/api/backup", None);
        malformed.body = Some("{ not json".to_owned());
        let response = dispatch(&db, &malformed, &ids);
        assert_eq!(response.status, 400);
        assert_eq!(
            response.body,
            json!({ "message": "Request body must contain valid JSON." })
        );
    }

    /// A copy that cannot be made is the 500 every unwrapped handler error becomes — the
    /// route never answers 200 for a backup that did not happen.
    #[test]
    fn post_backup_answers_500_when_the_copy_fails() {
        let (db, ids) = seeded();

        // The destination's parent directory does not exist, so `backup()` cannot open it.
        let response = dispatch(
            &db,
            &request(
                "POST",
                "/api/backup",
                Some(json!({ "path": "/wobble-no-such-directory/backup.sqlite" })),
            ),
            &ids,
        );

        assert_eq!(response.status, 500);
        assert!(
            response
                .body
                .get("message")
                .and_then(Value::as_str)
                .is_some_and(|message| !message.is_empty()),
            "{}",
            response.body
        );
    }
}
