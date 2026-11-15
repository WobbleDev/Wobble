//! The backup route: copy the open database to a path the caller chose.

use serde_json::{json, Value};

use crate::db::Db;
use crate::error::{Error, Result};
use crate::handle::{Request, Response};
use crate::router::{coded_message_response, json_response, message_response, read_payload};

/// `POST /api/backup` — the only route with no Node handler to port (F01).
const BACKUP_PATH_REQUIRED_MESSAGE: &str = "A backup path is required.";

const BACKUP_DESTINATION_INVALID_CODE: &str = "backup_destination_invalid";
const BACKUP_DESTINATION_INVALID_MESSAGE: &str =
    "The backup cannot be written there. Choose a different folder.";
const BACKUP_SAME_FILE_CODE: &str = "backup_same_file";
const BACKUP_SAME_FILE_MESSAGE: &str = "The backup must use a different destination.";
const BACKUP_FAILED_CODE: &str = "backup_failed";
const BACKUP_FAILED_MESSAGE: &str = "The backup could not be written.";

/// The 400 for a destination that can never work: a folder that is missing or unwritable, a
/// symlink or a file with SQLite sidecars beside it, or the live database itself. Checked
/// before any write, with copy that carries no path and no OS text.
fn refuse_destination(
    conn: &rusqlite::Connection,
    destination: &std::path::Path,
) -> Option<Response> {
    let invalid = || {
        Some(coded_message_response(
            400,
            BACKUP_DESTINATION_INVALID_CODE,
            BACKUP_DESTINATION_INVALID_MESSAGE,
        ))
    };
    let parent = destination
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or(std::path::Path::new("."));
    let Ok(parent) = std::fs::canonicalize(parent) else {
        return invalid();
    };
    let Some(name) = destination.file_name() else {
        return invalid();
    };
    let target = parent.join(name);
    if target
        .symlink_metadata()
        .is_ok_and(|metadata| metadata.file_type().is_symlink())
        || crate::key::sidecars_present(&target)
    {
        return invalid();
    }
    let live: String = conn
        .query_row(
            "SELECT file FROM pragma_database_list WHERE name = 'main'",
            [],
            |row| row.get(0),
        )
        .unwrap_or_default();
    if !live.is_empty()
        && target.exists()
        && same_file::is_same_file(std::path::Path::new(&live), &target).unwrap_or(false)
    {
        return Some(coded_message_response(
            400,
            BACKUP_SAME_FILE_CODE,
            BACKUP_SAME_FILE_MESSAGE,
        ));
    }
    None
}

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
            let destination = std::path::Path::new(path);
            if let Some(refusal) = refuse_destination(db.conn(), destination) {
                return Ok(refusal);
            }
            match crate::replacement::export_connection(db.conn(), destination, secret, true) {
                Ok(()) => Ok(json_response(200, json!({}))),
                // A plain message here is raw OS or SQLite text, paths included: the page gets
                // fixed copy and a code instead.
                Err(Error::Message(_)) => Ok(coded_message_response(
                    500,
                    BACKUP_FAILED_CODE,
                    BACKUP_FAILED_MESSAGE,
                )),
                Err(error) => Err(error),
            }
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

    /// A destination that can never work is a coded 400 with fixed copy: no path, no OS text.
    #[test]
    fn post_backup_refuses_a_missing_folder_with_a_coded_400() {
        let (db, ids) = seeded();

        let response = dispatch(
            &db,
            &request(
                "POST",
                "/api/backup",
                Some(json!({ "path": "/wobble-no-such-directory/backup.sqlite" })),
            ),
            &ids,
        );

        assert_eq!(response.status, 400);
        assert_eq!(
            response.body,
            json!({
                "message": "The backup cannot be written there. Choose a different folder.",
                "code": "backup_destination_invalid"
            })
        );
    }

    #[cfg(unix)]
    #[test]
    fn post_backup_refuses_a_symlink_destination() {
        let (db, ids) = seeded();
        let target = std::path::PathBuf::from(crate::test_support::temp_db_path(
            "wobble-backup-link-target.sqlite",
        ));
        let link = std::path::PathBuf::from(crate::test_support::temp_db_path(
            "wobble-backup-link.sqlite",
        ));
        let _ = std::fs::remove_file(&link);
        std::fs::write(&target, b"x").unwrap();
        std::os::unix::fs::symlink(&target, &link).unwrap();

        let response = dispatch(
            &db,
            &request(
                "POST",
                "/api/backup",
                Some(json!({ "path": link.to_str().unwrap_or_default() })),
            ),
            &ids,
        );

        let _ = std::fs::remove_file(&link);
        let _ = std::fs::remove_file(&target);
        assert_eq!(response.status, 400);
        assert_eq!(response.body["code"], json!("backup_destination_invalid"));
    }
}
