//! The data-control routes: where the database file is, restoring it from a backup, and
//! erasing every Worksite while keeping the settings and the schema.

use std::path::{Path, PathBuf};

use rusqlite::{Connection, OpenFlags};
use serde_json::{json, Value};

use crate::db::Db;
use crate::error::Result;
use crate::handle::{Request, Response};
use crate::router::{coded_message_response, json_response, read_payload};
use crate::schema::{self, CURRENT_SCHEMA_VERSION};

/// The oldest backup this app can upgrade: the lowest schema version
/// `schema::apply_migrations` accepts.
const OLDEST_RESTORABLE_SCHEMA_VERSION: i64 = 12;

// The stable codes the data controls answer with (ADR-0024). Settings maps each one to its
// own copy and keeps the core's message behind a Show details disclosure.
const DATA_FILE_NO_PATH_CODE: &str = "data_file_no_path";
const RESTORE_PATH_REQUIRED_CODE: &str = "restore_path_required";
const RESTORE_UNREADABLE_CODE: &str = "restore_unreadable";
const RESTORE_NOT_A_FILE_CODE: &str = "restore_not_a_file";
const RESTORE_CURRENT_FILE_CODE: &str = "restore_current_file";
const RESTORE_NOT_SQLITE_CODE: &str = "restore_not_sqlite";
const RESTORE_INTEGRITY_CODE: &str = "restore_integrity";
const RESTORE_NOT_WOBBLE_CODE: &str = "restore_not_wobble";
const RESTORE_UNSUPPORTED_SCHEMA_CODE: &str = "restore_unsupported_schema";
const RESTORE_ENCRYPTED_CODE: &str = "restore_encrypted";
const RESTORE_CORRUPT_CODE: &str = "restore_corrupt";
const RESTORE_FAILED_CODE: &str = "restore_failed";
const ERASE_CONFIRMATION_REQUIRED_CODE: &str = "erase_confirmation_required";
const ERASE_FAILED_CODE: &str = "erase_failed";

const DATA_FILE_PATH_MISSING_MESSAGE: &str = "The database has no file path.";
const RESTORE_PATH_REQUIRED_MESSAGE: &str = "A backup file path is required.";
const RESTORE_UNREADABLE_MESSAGE: &str = "The chosen backup file could not be read.";
const RESTORE_NOT_A_FILE_MESSAGE: &str = "The chosen backup is not a file.";
const RESTORE_SAME_FILE_MESSAGE: &str = "The chosen backup is the current database file.";
const RESTORE_NOT_SQLITE_MESSAGE: &str = "The chosen file is not a SQLite database.";
const RESTORE_INTEGRITY_MESSAGE: &str = "The chosen backup failed SQLite's integrity check.";
const RESTORE_NOT_WOBBLE_MESSAGE: &str = "The chosen file is not a Wobble database.";
const RESTORE_ENCRYPTED_MESSAGE: &str =
    "The chosen backup is encrypted. Enter its backup passphrase to restore it.";
const RESTORE_CORRUPT_MESSAGE: &str = "The chosen file is corrupt and cannot be restored.";
const RESTORE_UNKNOWN_TARGET_MESSAGE: &str = "The current database path could not be resolved.";
const ERASE_CONFIRMATION_MESSAGE: &str = "Type erase to confirm.";

/// `GET /api/data-file` — the path this installation's database was opened with, with the
/// main file's size and the latest write time across the main file and its WAL. It names no
/// Worksite, so it answers the same whichever Worksite a request carries (or none).
pub(crate) fn get_data_file(db: &Db) -> Result<Response> {
    match db.path() {
        Some(path) => {
            let (size_bytes, modified_at) = database_file_metadata(db.conn(), path);
            Ok(json_response(
                200,
                json!({
                    "path": path.to_string_lossy(),
                    "sizeBytes": size_bytes,
                    "modifiedAt": modified_at,
                }),
            ))
        }
        None => Ok(coded_message_response(
            400,
            DATA_FILE_NO_PATH_CODE,
            DATA_FILE_PATH_MISSING_MESSAGE,
        )),
    }
}

/// The live database file's size and latest write time across the main SQLite file and its
/// WAL, so recent writes are represented while SQLite uses WAL. A field is `None` when the
/// path or its metadata cannot be read; no plausible-looking default is invented.
fn database_file_metadata(conn: &Connection, path: &Path) -> (Option<u64>, Option<String>) {
    let main = std::fs::metadata(path).ok();
    let size_bytes = main.as_ref().map(std::fs::Metadata::len);

    let wal_path = PathBuf::from(format!("{}-wal", path.to_string_lossy()));
    let wal = std::fs::metadata(&wal_path).ok();

    let latest_write = [main.as_ref(), wal.as_ref()]
        .into_iter()
        .flatten()
        .filter_map(|metadata| metadata.modified().ok())
        .max();

    (
        size_bytes,
        latest_write.and_then(|time| iso_utc(conn, time)),
    )
}

/// The timestamp shape `toISOString()` writes. SQLite formats the instant, so this module
/// needs no date library; a failed conversion leaves the value unavailable.
fn iso_utc(conn: &Connection, time: std::time::SystemTime) -> Option<String> {
    let seconds = time
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?
        .as_secs_f64();
    conn.query_row(
        "SELECT strftime('%Y-%m-%dT%H:%M:%fZ', ?1, 'unixepoch')",
        [seconds],
        |row| row.get::<_, String>(0),
    )
    .ok()
}

/// `POST /api/restore` — validate the chosen backup, copy the current database beside it,
/// upgrade a staging copy of the backup, and swap that copy in only once the upgrade
/// succeeded. The reply names the safety copy so the person can go back; because the live
/// file is untouched by a failed conversion, that copy is a second recovery point rather
/// than the only one.
pub(crate) fn post_restore(db: &Db, request: &Request) -> Result<Response> {
    let payload = match read_payload(request) {
        Ok(payload) => payload,
        Err(response) => return Ok(response),
    };
    let Some(source) = payload.get("path").and_then(Value::as_str) else {
        return Ok(coded_message_response(
            400,
            RESTORE_PATH_REQUIRED_CODE,
            RESTORE_PATH_REQUIRED_MESSAGE,
        ));
    };
    if source.trim().is_empty() {
        return Ok(coded_message_response(
            400,
            RESTORE_PATH_REQUIRED_CODE,
            RESTORE_PATH_REQUIRED_MESSAGE,
        ));
    }
    let Some(target) = db.path() else {
        return Ok(coded_message_response(
            400,
            DATA_FILE_NO_PATH_CODE,
            DATA_FILE_PATH_MISSING_MESSAGE,
        ));
    };

    if let Err(response) = validate_source(target, Path::new(source)) {
        return Ok(response);
    }

    // The copy is made before anything is swapped, so a restore that fails still leaves
    // the person with the data they had.
    let safety_copy = match write_safety_copy(db, target, "pre-restore", RESTORE_FAILED_CODE, None)
    {
        Ok(path) => path,
        Err(response) => return Ok(response),
    };

    match restore_staged(db, target, Path::new(source)) {
        Ok(()) => Ok(json_response(
            200,
            json!({ "safetyCopyPath": safety_copy.to_string_lossy() }),
        )),
        Err(message) => Ok(coded_message_response(
            500,
            RESTORE_FAILED_CODE,
            &format!(
                "{message} The database as it was before the restore is saved at {}.",
                safety_copy.display()
            ),
        )),
    }
}

/// `POST /api/erase` — wipe every Worksite (foreign keys cascade every Worksite-scoped
/// row) after copying the database beside itself. Settings and schema stay; the caller
/// must spell out the confirmation.
pub(crate) fn post_erase_keyed(
    db: &Db,
    request: &Request,
    secret: Option<&crate::key::Secret>,
) -> Result<Response> {
    let payload = match read_payload(request) {
        Ok(payload) => payload,
        Err(response) => return Ok(response),
    };
    if payload.get("confirm").and_then(Value::as_str) != Some("erase") {
        return Ok(coded_message_response(
            400,
            ERASE_CONFIRMATION_REQUIRED_CODE,
            ERASE_CONFIRMATION_MESSAGE,
        ));
    }
    let Some(target) = db.path() else {
        return Ok(coded_message_response(
            400,
            DATA_FILE_NO_PATH_CODE,
            DATA_FILE_PATH_MISSING_MESSAGE,
        ));
    };

    let safety_copy = match write_safety_copy(db, target, "pre-erase", ERASE_FAILED_CODE, secret) {
        Ok(path) => path,
        Err(response) => return Ok(response),
    };
    if let Err(error) = db.conn().execute("DELETE FROM worksites", []) {
        return Ok(coded_message_response(
            500,
            ERASE_FAILED_CODE,
            &format!(
                "The data could not be erased: {error}. The data that was there is saved at {}.",
                safety_copy.display()
            ),
        ));
    }

    Ok(json_response(
        200,
        json!({ "safetyCopyPath": safety_copy.to_string_lossy() }),
    ))
}

/// Checks the chosen file is a readable, intact SQLite database this app can upgrade. It
/// is opened read-only, so a rejected file is never written to.
fn validate_source(target: &Path, source: &Path) -> std::result::Result<(), Response> {
    match std::fs::metadata(source) {
        Ok(metadata) if metadata.is_file() => {}
        Ok(_) => {
            return Err(coded_message_response(
                400,
                RESTORE_NOT_A_FILE_CODE,
                RESTORE_NOT_A_FILE_MESSAGE,
            ))
        }
        Err(_) => {
            return Err(coded_message_response(
                400,
                RESTORE_UNREADABLE_CODE,
                RESTORE_UNREADABLE_MESSAGE,
            ))
        }
    }

    let canonical_target = target.canonicalize().map_err(|_| {
        coded_message_response(500, RESTORE_FAILED_CODE, RESTORE_UNKNOWN_TARGET_MESSAGE)
    })?;
    let canonical_source = match source.canonicalize() {
        Ok(path) => path,
        Err(_) => {
            return Err(coded_message_response(
                400,
                RESTORE_UNREADABLE_CODE,
                RESTORE_UNREADABLE_MESSAGE,
            ))
        }
    };
    if canonical_source == canonical_target {
        return Err(coded_message_response(
            400,
            RESTORE_CURRENT_FILE_CODE,
            RESTORE_SAME_FILE_MESSAGE,
        ));
    }

    match crate::key::classify_source(source) {
        crate::key::SourceKind::EncryptedCandidate => {
            return Err(coded_message_response(
                400,
                RESTORE_ENCRYPTED_CODE,
                RESTORE_ENCRYPTED_MESSAGE,
            ));
        }
        crate::key::SourceKind::Corrupt => {
            if std::fs::read(source).map(|b| b.len()).unwrap_or(0) < 16 {
                return Err(coded_message_response(
                    400,
                    RESTORE_CORRUPT_CODE,
                    RESTORE_CORRUPT_MESSAGE,
                ));
            }
        }
        crate::key::SourceKind::PlaintextLegacy => {}
    }

    let conn = match Connection::open_with_flags(source, OpenFlags::SQLITE_OPEN_READ_ONLY) {
        Ok(conn) => conn,
        Err(_) => {
            return Err(coded_message_response(
                400,
                RESTORE_NOT_SQLITE_CODE,
                RESTORE_NOT_SQLITE_MESSAGE,
            ))
        }
    };
    match conn.query_row("PRAGMA integrity_check", [], |row| row.get::<_, String>(0)) {
        Ok(result) if result == "ok" => {}
        Ok(_) => {
            return Err(coded_message_response(
                400,
                RESTORE_INTEGRITY_CODE,
                RESTORE_INTEGRITY_MESSAGE,
            ))
        }
        Err(_) => {
            return Err(coded_message_response(
                400,
                RESTORE_NOT_SQLITE_CODE,
                RESTORE_NOT_SQLITE_MESSAGE,
            ))
        }
    }

    match schema::read_schema_version(&conn) {
        Ok(Some(version))
            if (OLDEST_RESTORABLE_SCHEMA_VERSION..=CURRENT_SCHEMA_VERSION).contains(&version) =>
        {
            Ok(())
        }
        Ok(Some(version)) => Err(coded_message_response(
            400,
            RESTORE_UNSUPPORTED_SCHEMA_CODE,
            &format!(
                "The backup's schema version {version} is unsupported. This app restores version \
                 {OLDEST_RESTORABLE_SCHEMA_VERSION} through version {CURRENT_SCHEMA_VERSION} backups."
            ),
        )),
        _ => Err(coded_message_response(
            400,
            RESTORE_NOT_WOBBLE_CODE,
            RESTORE_NOT_WOBBLE_MESSAGE,
        )),
    }
}

/// Writes the safety copy beside the database and returns its path, or the coded 500 when
/// the copy cannot be named or written. Both data controls copy first, so a failed swap or
/// erase still leaves the person with the data they had.
fn write_safety_copy(
    db: &Db,
    target: &Path,
    label: &str,
    failure_code: &str,
    secret: Option<&crate::key::Secret>,
) -> std::result::Result<PathBuf, Response> {
    let stamp = timestamp(db.conn()).map_err(|error| {
        coded_message_response(
            500,
            failure_code,
            &format!("The safety copy could not be named: {error}."),
        )
    })?;
    let path = safety_copy_path(target, label, &stamp);
    copy_open_to_path(db.conn(), &path, secret).map_err(|error| {
        coded_message_response(
            500,
            failure_code,
            &format!("The safety copy could not be written: {error}."),
        )
    })?;
    Ok(path)
}

/// Copies the backup into a temporary file beside the target, upgrades that copy to the
/// current schema, and only then swaps it into the live database. A conversion failure
/// therefore leaves the live file byte-for-byte as it was, and the safety copy is a second
/// recovery point rather than the only one. The temporary file never outlives a request.
fn restore_staged(db: &Db, target: &Path, source: &Path) -> std::result::Result<(), String> {
    let staging = staging_path(db, target)
        .map_err(|message| format!("{message} The live database was left unchanged."))?;
    let outcome = stage_and_swap(db, target, source, &staging);
    let cleanup = remove_staging(&staging);

    match outcome {
        Ok(()) => cleanup.map_err(|error| {
            format!(
                "The backup was restored, but the temporary copy {} could not be removed: {error}.",
                staging.display()
            )
        }),
        Err(message) => {
            // The conversion error is the one the person needs; cleanup is best effort.
            let _ = cleanup;
            Err(message)
        }
    }
}

/// The restore's three steps in order: copy the backup, upgrade the copy, swap it in.
fn stage_and_swap(
    db: &Db,
    target: &Path,
    source: &Path,
    staging: &Path,
) -> std::result::Result<(), String> {
    remove_staging(staging).map_err(|error| {
        format!(
            "The temporary restore copy could not be cleared: {error}. The live database was left unchanged."
        )
    })?;
    copy_into_staging(source, staging)?;
    upgrade_staging(staging)?;
    swap_database(db, target, staging)
}

/// Copies the chosen backup into the staging file through SQLite's backup API, so a source
/// that still has writes in its WAL is copied consistently and is never written to.
fn copy_open_to_path(
    src: &Connection,
    dst_path: &Path,
    secret: Option<&crate::key::Secret>,
) -> std::result::Result<(), rusqlite::Error> {
    crate::replacement::export_connection(src, dst_path, secret, false)
        .map_err(|e| rusqlite::Error::InvalidPath(e.to_string().into()))
}

fn copy_into_staging(source: &Path, staging: &Path) -> std::result::Result<(), String> {
    copy_into_staging_keyed(source, staging, None)
}

fn copy_into_staging_keyed(
    source: &Path,
    staging: &Path,
    secret: Option<&crate::key::Secret>,
) -> std::result::Result<(), String> {
    let conn = crate::key::open_keyed_readonly(source, secret).map_err(
        |error| {
            format!(
                "The backup could not be reopened for the upgrade: {error}. The live database was left unchanged."
            )
        },
    )?;
    copy_open_to_path(&conn, staging, secret)
        .map_err(|error| {
            format!(
                "The backup could not be copied for the upgrade: {error}. The live database was left unchanged."
            )
        })
}

/// Upgrades the staging copy to the current schema. The same `apply_migrations` that runs
/// on normal startup runs here, so there is one conversion, not a restore-only variant.
fn upgrade_staging(staging: &Path) -> std::result::Result<(), String> {
    upgrade_staging_keyed(staging, None)
}

fn upgrade_staging_keyed(
    staging: &Path,
    secret: Option<&crate::key::Secret>,
) -> std::result::Result<(), String> {
    let conn = crate::key::open_keyed(staging, secret).map_err(|error| {
        format!(
            "The temporary restore copy could not be opened: {error}. The live database was left unchanged."
        )
    })?;
    conn.execute_batch("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;")
        .map_err(|error| {
            format!(
                "The temporary restore copy could not be prepared: {error}. The live database was left unchanged."
            )
        })?;
    schema::apply_migrations(&conn).map_err(|error| {
        format!(
            "The restored database could not be upgraded: {error}. The live database was left unchanged."
        )
    })?;
    // A single file is simpler to swap and cannot leave a staging WAL behind.
    conn.execute_batch("PRAGMA journal_mode = DELETE;")
        .map_err(|error| {
            format!(
                "The upgraded restore copy could not be prepared for the swap: {error}. The live database was left unchanged."
            )
        })
}

/// Replaces the live database's content with the already-upgraded staging copy through
/// SQLite's restore. The restore runs on a second handle to the same file because
/// `Connection::restore` needs `&mut`; requests are serialized, so the open connection is
/// idle while it runs.
fn swap_database(db: &Db, target: &Path, staged: &Path) -> std::result::Result<(), String> {
    swap_database_keyed(db, target, staged, None)
}

fn swap_database_keyed(
    db: &Db,
    target: &Path,
    staged: &Path,
    secret: Option<&crate::key::Secret>,
) -> std::result::Result<(), String> {
    let staged_conn = crate::key::open_keyed_readonly(staged, secret)
        .map_err(|error| format!("The backup could not be reopened: {error}."))?;
    let mut conn = crate::key::open_keyed(target, secret)
        .map_err(|error| format!("The database could not be reopened: {error}."))?;
    rusqlite::backup::Backup::new(&staged_conn, &mut conn)
        .and_then(|backup| backup.run_to_completion(100, std::time::Duration::from_millis(0), None))
        .map_err(|error| format!("The backup could not be restored: {error}."))?;
    drop(conn);

    // The copied file carries the source's journal mode; the open connection still has to
    // run in WAL mode as every other launch does.
    db.conn()
        .execute_batch(
            "PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;",
        )
        .map_err(|error| format!("The restored database could not be opened for use: {error}."))
}

/// `<database>.restore-staging-<pid>-<yyyymmddThhmmss>.sqlite`, beside the database, so it
/// is on the same filesystem as the target and never collides with a safety copy.
fn staging_path(db: &Db, target: &Path) -> std::result::Result<PathBuf, String> {
    let stamp = timestamp(db.conn())
        .map_err(|error| format!("The temporary restore copy could not be named: {error}."))?;
    let mut path = target.as_os_str().to_owned();
    path.push(format!(
        ".restore-staging-{}-{stamp}.sqlite",
        std::process::id()
    ));
    Ok(PathBuf::from(path))
}

/// Removes the staging file and every journal SQLite may have written beside it. A missing
/// file is not a failure; a real one is reported, because a leftover temp file is not a
/// successful restore.
fn remove_staging(staging: &Path) -> std::io::Result<()> {
    let mut first_error = None;
    for suffix in ["", "-wal", "-shm", "-journal"] {
        let mut candidate = staging.as_os_str().to_owned();
        candidate.push(suffix);
        match std::fs::remove_file(PathBuf::from(candidate)) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                first_error.get_or_insert(error);
            }
        }
    }
    match first_error {
        Some(error) => Err(error),
        None => Ok(()),
    }
}

/// `<database>.pre-<label>-<yyyymmddThhmmss>.sqlite`, beside the database.
fn safety_copy_path(target: &Path, label: &str, stamp: &str) -> PathBuf {
    let mut path = target.as_os_str().to_owned();
    path.push(format!(".{label}-{stamp}.sqlite"));
    PathBuf::from(path)
}

/// The timestamp in the safety copy's name, in UTC, taken from SQLite so the core needs no
/// date library.
fn timestamp(conn: &Connection) -> Result<String> {
    Ok(
        conn.query_row("SELECT strftime('%Y%m%dT%H%M%S', 'now')", [], |row| {
            row.get(0)
        })?,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app_settings::get_app_settings;
    use crate::db::{open_seeded_keyed, open_seeded_legacy_fixture};
    use crate::id::CounterId;

    use crate::test_support::{request, seeded, temp_db_path};
    use crate::worksite_persistence::list_worksites;
    use std::time::{Duration, SystemTime};

    fn remove_database(path: &str) {
        for suffix in ["", "-wal", "-shm"] {
            let _ = std::fs::remove_file(format!("{path}{suffix}"));
        }
    }

    fn fixture_key() -> crate::key::Secret {
        crate::key::Secret::from_passphrase("current data-handler fixture").unwrap()
    }

    fn file_database(name: &str) -> (Db, CounterId, String) {
        let path = temp_db_path(name);
        remove_database(&path);
        let ids = CounterId::new();
        let db = open_seeded_keyed(&path, Some(&fixture_key()), &ids)
            .expect("a current encrypted database");
        (db, ids, path)
    }

    // LEGACY-PLAINTEXT-FIXTURE: the retired plaintext restore handler only.
    // Encrypted restore is covered through App in handle.rs and integration tests.
    fn legacy_file_database(name: &str) -> (Db, CounterId, String) {
        let path = temp_db_path(name);
        remove_database(&path);
        let ids = CounterId::new();
        let db = open_seeded_legacy_fixture(&path, &ids).expect("legacy restore fixture");
        (db, ids, path)
    }

    fn dispatch(db: &Db, request: &Request, ids: &CounterId) -> Response {
        let key = fixture_key();
        crate::router::dispatch_keyed(
            db,
            request,
            ids,
            if db.path().is_some() && request.path != "/api/restore" {
                Some(&key)
            } else {
                None
            },
        )
    }

    fn rust_v12_fixture() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../../contract/fixtures/rust-v12.sqlite")
    }

    fn schema_version(conn: &Connection) -> i64 {
        conn.query_row("SELECT MAX(version) FROM schema_migrations", [], |row| {
            row.get(0)
        })
        .unwrap()
    }

    fn row_count(db: &Db, table: &str) -> i64 {
        db.conn()
            .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
                row.get(0)
            })
            .unwrap()
    }

    fn has_table(db: &Db, table: &str) -> bool {
        db.conn()
            .query_row(
                "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1",
                [table],
                |_| Ok(()),
            )
            .is_ok()
    }

    fn insert_worker(db: &Db, worksite_id: &str, id: &str, name: &str) {
        db.conn()
            .execute(
                "INSERT INTO workers (id, worksite_id, name, email, phone, assessment, notes) \
                 VALUES (?1, ?2, ?3, '', '', 'Unassessed', '[]')",
                [id, worksite_id, name],
            )
            .unwrap();
    }

    #[test]
    fn data_file_answers_the_path_the_database_was_opened_with() {
        let (memory, ids) = seeded();
        let response = dispatch(&memory, &request("GET", "/api/data-file", None), &ids);
        assert_eq!(response.status, 400);
        assert_eq!(
            response.body,
            json!({
                "message": DATA_FILE_PATH_MISSING_MESSAGE,
                "code": DATA_FILE_NO_PATH_CODE
            })
        );

        let (db, ids, path) = file_database("wobble-data-file.sqlite");
        let response = dispatch(&db, &request("GET", "/api/data-file", None), &ids);
        assert_eq!(response.status, 200);
        // The core stores an absolute canonical path, so a relative WOBBLE_DB_PATH and a
        // symlinked temp directory both surface the file the person actually has.
        let canonical = std::fs::canonicalize(&path).unwrap();
        assert_eq!(response.body["path"], json!(canonical.to_string_lossy()));
        // The live file's details ride along; a value the core cannot read stays null.
        assert!(response.body["sizeBytes"].as_u64().unwrap() > 0);
        assert!(response.body["modifiedAt"].as_str().unwrap().ends_with('Z'));
        assert!(response.headers.is_empty());

        drop(db);
        remove_database(&path);
    }

    #[test]
    fn restore_requires_a_non_blank_string_path() {
        let (db, ids, target) = legacy_file_database("wobble-restore-path.sqlite");

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
                &request("POST", "/api/restore", Some(body.clone())),
                &ids,
            );
            assert_eq!(response.status, 400, "{body}");
            assert_eq!(
                response.body,
                json!({
                    "message": RESTORE_PATH_REQUIRED_MESSAGE,
                    "code": RESTORE_PATH_REQUIRED_CODE
                }),
                "{body}"
            );
        }

        let mut malformed = request("POST", "/api/restore", None);
        malformed.body = Some("{ not json".to_owned());
        let response = dispatch(&db, &malformed, &ids);
        assert_eq!(response.status, 400);
        assert_eq!(
            response.body,
            json!({ "message": "Request body must contain valid JSON." })
        );

        drop(db);
        remove_database(&target);
    }

    #[test]
    fn restore_rejects_non_files_garbage_and_databases_it_cannot_upgrade() {
        let (db, ids, target) = legacy_file_database("wobble-restore-validate.sqlite");

        let missing = temp_db_path("wobble-restore-missing.sqlite");
        remove_database(&missing);
        let response = dispatch(
            &db,
            &request("POST", "/api/restore", Some(json!({ "path": missing }))),
            &ids,
        );
        assert_eq!(response.status, 400);
        assert_eq!(
            response.body,
            json!({
                "message": RESTORE_UNREADABLE_MESSAGE,
                "code": RESTORE_UNREADABLE_CODE
            })
        );

        let directory = temp_db_path("wobble-restore-directory.sqlite");
        std::fs::create_dir_all(&directory).unwrap();
        let response = dispatch(
            &db,
            &request("POST", "/api/restore", Some(json!({ "path": directory }))),
            &ids,
        );
        assert_eq!(response.status, 400);
        assert_eq!(
            response.body,
            json!({
                "message": RESTORE_NOT_A_FILE_MESSAGE,
                "code": RESTORE_NOT_A_FILE_CODE
            })
        );

        let garbage = temp_db_path("wobble-restore-garbage.sqlite");
        std::fs::write(&garbage, b"this is not a sqlite database").unwrap();
        let response = dispatch(
            &db,
            &request("POST", "/api/restore", Some(json!({ "path": garbage }))),
            &ids,
        );
        assert_eq!(response.status, 400);
        assert_eq!(
            response.body,
            json!({
                "message": RESTORE_NOT_SQLITE_MESSAGE,
                "code": RESTORE_NOT_SQLITE_CODE
            })
        );

        // A healthy SQLite database that is not Wobble's.
        // LEGACY-PLAINTEXT-FIXTURE: negative fixture asserting rejection (never production).
        let stranger = temp_db_path("wobble-restore-stranger.sqlite");
        remove_database(&stranger);
        Connection::open(&stranger)
            .unwrap()
            .execute_batch("CREATE TABLE something (id INTEGER);")
            .unwrap();
        let response = dispatch(
            &db,
            &request("POST", "/api/restore", Some(json!({ "path": stranger }))),
            &ids,
        );
        assert_eq!(response.status, 400);
        assert_eq!(
            response.body,
            json!({
                "message": RESTORE_NOT_WOBBLE_MESSAGE,
                "code": RESTORE_NOT_WOBBLE_CODE
            })
        );

        // A Wobble database from a version this app cannot upgrade.
        // LEGACY-PLAINTEXT-FIXTURE: negative fixture asserting unsupported-schema rejection (never production).
        let old = temp_db_path("wobble-restore-old.sqlite");
        remove_database(&old);
        Connection::open(&old)
            .unwrap()
            .execute_batch(
                "CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY NOT NULL, \
                 name TEXT NOT NULL, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP); \
                 INSERT INTO schema_migrations (version, name) VALUES (11, 'old');",
            )
            .unwrap();
        let response = dispatch(
            &db,
            &request("POST", "/api/restore", Some(json!({ "path": old }))),
            &ids,
        );
        assert_eq!(response.status, 400);
        assert_eq!(
            response.body["code"],
            json!(RESTORE_UNSUPPORTED_SCHEMA_CODE)
        );
        let message = response.body["message"].as_str().unwrap_or_default();
        assert!(
            message.contains("schema version 11 is unsupported"),
            "{message}"
        );

        // The live database itself: restoring it over itself would corrupt it.
        let response = dispatch(
            &db,
            &request("POST", "/api/restore", Some(json!({ "path": target }))),
            &ids,
        );
        assert_eq!(response.status, 400);
        assert_eq!(
            response.body,
            json!({
                "message": RESTORE_SAME_FILE_MESSAGE,
                "code": RESTORE_CURRENT_FILE_CODE
            })
        );
        assert_eq!(
            row_count(&db, "worksites"),
            1,
            "the live database is intact"
        );
        assert_eq!(schema_version(db.conn()), CURRENT_SCHEMA_VERSION);

        drop(db);
        for path in [&target, &missing, &directory, &garbage, &stranger, &old] {
            remove_database(path);
        }
        let _ = std::fs::remove_dir(&directory);
    }

    #[test]
    fn restore_swaps_in_the_backup_and_writes_the_pre_restore_safety_copy() {
        let (db, ids, target) = legacy_file_database("wobble-restore-success.sqlite");
        let old_worksite = list_worksites(db.conn()).unwrap().remove(0);
        insert_worker(&db, &old_worksite.id, "old-worker", "Old Worker");
        let saved = dispatch(
            &db,
            &request("PUT", "/api/settings", Some(json!({ "theme": "dark" }))),
            &ids,
        );
        assert_eq!(saved.status, 200);

        let source = temp_db_path("wobble-restore-source.sqlite");
        remove_database(&source);
        std::fs::copy(rust_v12_fixture(), &source).unwrap();

        let response = dispatch(
            &db,
            &request("POST", "/api/restore", Some(json!({ "path": source }))),
            &ids,
        );
        assert_eq!(response.status, 200, "{}", response.body);
        let safety = response.body["safetyCopyPath"]
            .as_str()
            .expect("a safety copy path")
            .to_owned();
        let canonical_target = std::fs::canonicalize(&target).unwrap();
        assert!(
            safety.starts_with(&format!("{}.pre-restore-", canonical_target.display())),
            "{safety} is beside the database"
        );
        assert!(safety.ends_with(".sqlite"), "{safety}");
        assert!(Path::new(&safety).is_file(), "{safety} exists");

        // The safety copy is the database as it was, and opens on its own.
        let copy = Db::open_legacy_fixture(&safety).expect("the safety copy opens");
        assert_eq!(row_count(&copy, "worksites"), 1);
        let copy_worker: String = copy
            .conn()
            .query_row(
                "SELECT name FROM workers WHERE id = 'old-worker'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(copy_worker, "Old Worker");
        assert_eq!(get_app_settings(copy.conn()).unwrap().theme, "dark");
        drop(copy);

        // The live database is the backup's, upgraded to the current schema.
        let worksites = list_worksites(db.conn()).unwrap();
        assert_eq!(worksites.len(), 1);
        assert_eq!(worksites[0].id, "00000000-0000-4000-8000-000000000001");
        let names: Vec<String> = db
            .conn()
            .prepare("SELECT name FROM workers ORDER BY name")
            .unwrap()
            .query_map([], |row| row.get(0))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap();
        assert_eq!(names, ["Max Planck", "Rosalind Franklin"]);
        assert_eq!(schema_version(db.conn()), CURRENT_SCHEMA_VERSION);
        assert!(
            has_table(&db, "worker_drafts"),
            "the upgrade adds v13's table"
        );
        assert_eq!(get_app_settings(db.conn()).unwrap().theme, "system");

        drop(db);
        for path in [&target, &source, &safety] {
            remove_database(path);
        }
    }

    #[test]
    fn a_failed_erase_answers_erase_failed_and_names_the_safety_copy() {
        let (db, ids, target) = file_database("wobble-erase-failed.sqlite");
        db.conn()
            .execute_batch(
                "CREATE TRIGGER refuse_erase BEFORE DELETE ON worksites \
                 BEGIN SELECT RAISE(ABORT, 'no'); END;",
            )
            .unwrap();

        let response = dispatch(
            &db,
            &request("POST", "/api/erase", Some(json!({ "confirm": "erase" }))),
            &ids,
        );

        assert_eq!(response.status, 500);
        assert_eq!(response.body["code"], json!(ERASE_FAILED_CODE));
        assert_eq!(row_count(&db, "worksites"), 1, "nothing was erased");
        let message = response.body["message"].as_str().unwrap_or_default();
        assert!(message.contains("could not be erased"), "{message}");
        let safety = message
            .split("saved at ")
            .nth(1)
            .expect("the message names the safety copy")
            .trim_end_matches('.')
            .to_owned();
        assert!(Path::new(&safety).is_file(), "{safety} exists");

        drop(db);
        for path in [&target, &safety] {
            remove_database(path);
        }
    }

    #[test]
    fn erase_requires_the_exact_confirmation_and_a_file_path() {
        let (db, ids, target) = file_database("wobble-erase-confirm.sqlite");

        for body in [
            json!({}),
            json!({ "confirm": "" }),
            json!({ "confirm": "Erase" }),
            json!({ "confirm": "erase " }),
            json!({ "confirm": "erase everything" }),
            json!({ "confirm": true }),
            json!([]),
        ] {
            let response = dispatch(
                &db,
                &request("POST", "/api/erase", Some(body.clone())),
                &ids,
            );
            assert_eq!(response.status, 400, "{body}");
            assert_eq!(
                response.body,
                json!({
                    "message": ERASE_CONFIRMATION_MESSAGE,
                    "code": ERASE_CONFIRMATION_REQUIRED_CODE
                }),
                "{body}"
            );
        }
        assert_eq!(row_count(&db, "worksites"), 1, "nothing was erased");

        let (memory, ids) = seeded();
        let response = dispatch(
            &memory,
            &request("POST", "/api/erase", Some(json!({ "confirm": "erase" }))),
            &ids,
        );
        assert_eq!(response.status, 400);
        assert_eq!(
            response.body,
            json!({
                "message": DATA_FILE_PATH_MISSING_MESSAGE,
                "code": DATA_FILE_NO_PATH_CODE
            })
        );

        drop(db);
        remove_database(&target);
    }

    #[test]
    fn erase_wipes_the_data_keeps_the_settings_and_schema_and_copies_first() {
        let (db, ids, target) = file_database("wobble-erase-success.sqlite");
        let worksite = list_worksites(db.conn()).unwrap().remove(0);
        insert_worker(&db, &worksite.id, "wiped-worker", "Wiped Worker");
        let saved = dispatch(
            &db,
            &request("PUT", "/api/settings", Some(json!({ "theme": "dark" }))),
            &ids,
        );
        assert_eq!(saved.status, 200);

        let response = dispatch(
            &db,
            &request("POST", "/api/erase", Some(json!({ "confirm": "erase" }))),
            &ids,
        );
        assert_eq!(response.status, 200, "{}", response.body);
        let safety = response.body["safetyCopyPath"]
            .as_str()
            .expect("a safety copy path")
            .to_owned();
        let canonical_target = std::fs::canonicalize(&target).unwrap();
        assert!(
            safety.starts_with(&format!("{}.pre-erase-", canonical_target.display())),
            "{safety} is beside the database"
        );
        assert!(safety.ends_with(".sqlite"), "{safety}");
        assert!(Path::new(&safety).is_file(), "{safety} exists");

        // Every Worksite-scoped row is gone through the cascade.
        assert_eq!(row_count(&db, "worksites"), 0);
        assert_eq!(row_count(&db, "workers"), 0);
        assert_eq!(row_count(&db, "worker_attributes"), 0);
        assert_eq!(row_count(&db, "worker_drafts"), 0);
        let response = dispatch(&db, &request("GET", "/api/worksite", None), &ids);
        assert_eq!(response.status, 200);
        assert_eq!(response.body, json!({ "worksite": null }));

        // Settings and schema stay.
        assert_eq!(get_app_settings(db.conn()).unwrap().theme, "dark");
        assert_eq!(schema_version(db.conn()), CURRENT_SCHEMA_VERSION);
        assert!(has_table(&db, "app_settings"));
        assert!(has_table(&db, "schema_migrations"));

        // The safety copy opens with the data that was erased.
        let copy =
            Db::open_keyed(&safety, Some(&fixture_key())).expect("the encrypted safety copy opens");
        assert_eq!(row_count(&copy, "worksites"), 1);
        let copy_worker: String = copy
            .conn()
            .query_row(
                "SELECT name FROM workers WHERE id = 'wiped-worker'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(copy_worker, "Wiped Worker");
        assert_eq!(get_app_settings(copy.conn()).unwrap().theme, "dark");
        drop(copy);

        drop(db);
        for path in [&target, &safety] {
            remove_database(path);
        }
    }

    #[test]
    fn product_gap_16_reports_the_main_file_size_and_the_latest_main_or_wal_write() {
        let (db, ids, path) = file_database("data-gap16-metadata");
        // A write lands in the WAL, so the WAL carries the newest write time.
        db.conn()
            .execute(
                "INSERT INTO app_settings (key, value) VALUES ('gap16', 'written')",
                [],
            )
            .unwrap();

        let response = dispatch(&db, &request("GET", "/api/data-file", None), &ids);
        assert_eq!(response.status, 200);
        let body = &response.body;
        assert_eq!(body["path"], json!(std::fs::canonicalize(&path).unwrap()));

        let main_size = std::fs::metadata(&path).unwrap().len();
        assert_eq!(body["sizeBytes"], json!(main_size));

        let main_modified = std::fs::metadata(&path).unwrap().modified().unwrap();
        let wal_modified = std::fs::metadata(format!("{path}-wal"))
            .unwrap()
            .modified()
            .unwrap();
        let latest = main_modified.max(wal_modified);
        assert_eq!(
            body["modifiedAt"],
            json!(iso_utc(db.conn(), latest).unwrap())
        );
        assert!(body["modifiedAt"].as_str().unwrap().ends_with('Z'));

        drop(db);
        remove_database(&path);
    }

    #[test]
    fn product_gap_16_takes_the_later_write_time_when_the_wal_is_newer() {
        let scratch = std::env::temp_dir().join(format!("wobble-gap16-wal-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&scratch);
        std::fs::create_dir_all(&scratch).unwrap();
        let main_path = scratch.join("main.sqlite");
        let wal_path = scratch.join("main.sqlite-wal");
        std::fs::write(&main_path, b"main").unwrap();
        // The WAL is written after the main file, so it has the later modification.
        std::thread::sleep(Duration::from_millis(20));
        std::fs::write(&wal_path, b"wal").unwrap();

        let (db, _ids) = seeded();
        let (size, modified) = database_file_metadata(db.conn(), &main_path);
        assert_eq!(size, Some(4));

        let wal_modified = std::fs::metadata(&wal_path).unwrap().modified().unwrap();
        assert!(wal_modified >= SystemTime::now() - Duration::from_secs(60));
        assert_eq!(modified, iso_utc(db.conn(), wal_modified));

        drop(db);
        let _ = std::fs::remove_dir_all(&scratch);
    }

    #[test]
    fn product_gap_16_leaves_unreadable_metadata_unavailable() {
        let (db, _ids) = seeded();
        let missing = Path::new("/definitely/not/a/wobble/database.sqlite");

        assert_eq!(database_file_metadata(db.conn(), missing), (None, None));
    }
}
