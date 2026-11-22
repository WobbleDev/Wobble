//! Automatic backup: a scheduled safety copy of the database, written beside it.
//!
//! The person turns it on and picks daily or weekly. While the app is open the page asks
//! `POST /api/auto-backup/run` now and then; the core decides whether a copy is due, so a
//! second window or a restart never doubles up. Each copy is `<database>.pre-auto-<stamp>.sqlite`,
//! made the same way the manual export and the safety copies are (a verified, keyed copy), and
//! the newest [`crate::safety_copies::KEEP_PER_KIND`] survive. A failed copy is remembered and
//! reported with fixed copy: no path, no operating-system text. The failure clears on the next
//! copy that works.

use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};

use crate::db::Db;
use crate::error::Result;
use crate::handle::{Request, Response};
use crate::router::{json_response, message_response, read_payload};
use crate::safety_copies::{self, AUTO_KIND};

const ENABLED_KEY: &str = "autoBackup";
const FREQUENCY_KEY: &str = "autoBackupFrequency";
/// The epoch second of the last failed copy. Not part of the settings registry: it is
/// internal state, never accepted from `PUT /api/settings` and never put on its wire.
const FAILED_AT_KEY: &str = "autoBackupFailedAt";

const FREQUENCIES: [&str; 2] = ["daily", "weekly"];
const DEFAULT_FREQUENCY: &str = "daily";
/// After a failure the copy is not retried on its own for this long, so a full disk or a
/// missing folder does not make the app write and fail every minute. "Back up now" ignores it.
const RETRY_AFTER_FAILURE_SECS: i64 = 3600;

const FAILURE_CODE: &str = "auto_backup_failed";
const FAILURE_MESSAGE: &str = "The automatic backup could not be written.";
const INVALID_MESSAGE: &str =
    "Send enabled (true or false) and/or frequency (daily or weekly) to change the automatic backup.";

fn interval_secs(frequency: &str) -> i64 {
    match frequency {
        "weekly" => 7 * 24 * 60 * 60,
        _ => 24 * 60 * 60,
    }
}

fn read_key(conn: &Connection, key: &str) -> Result<Option<String>> {
    Ok(conn
        .query_row(
            "SELECT value FROM app_settings WHERE key = ?1",
            [key],
            |row| row.get(0),
        )
        .optional()?)
}

fn write_key(conn: &Connection, key: &str, value: &str) -> Result<()> {
    conn.execute(
        "INSERT INTO app_settings (key, value) VALUES (?1, ?2) \
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value],
    )?;
    Ok(())
}

fn enabled(conn: &Connection) -> Result<bool> {
    Ok(read_key(conn, ENABLED_KEY)?.as_deref() == Some("true"))
}

fn frequency(conn: &Connection) -> Result<String> {
    Ok(read_key(conn, FREQUENCY_KEY)?
        .filter(|value| FREQUENCIES.contains(&value.as_str()))
        .unwrap_or_else(|| DEFAULT_FREQUENCY.to_owned()))
}

/// The stamp of the newest automatic copy beside `path`. A second copy in the same second is
/// named `<stamp>-2`, `<stamp>-3`, so only the first 15 characters are the instant.
fn newest_copy_stamp(path: &std::path::Path) -> Option<String> {
    let tail = safety_copies::newest_stamp(path, AUTO_KIND)?;
    tail.get(..15).map(str::to_owned)
}

/// A name for a copy made at `stamp` that nothing already uses: `<stamp>`, then `<stamp>-2`
/// and on. "Back up now" twice in one second must not read as a failure.
fn free_stamp(path: &std::path::Path, stamp: &str) -> String {
    let taken =
        |candidate: &str| super::data::safety_copy_path(path, "pre-auto", candidate).exists();
    if !taken(stamp) {
        return stamp.to_owned();
    }
    (2..100)
        .map(|attempt| format!("{stamp}-{attempt}"))
        .find(|candidate| !taken(candidate))
        .unwrap_or_else(|| stamp.to_owned())
}

/// `20261122T160014` as `2026-11-22T16:00:14Z`, or `None` for anything else.
fn stamp_to_iso(stamp: &str) -> Option<String> {
    let bytes = stamp.as_bytes();
    let shaped = bytes.len() == 15
        && bytes[8] == b'T'
        && bytes
            .iter()
            .enumerate()
            .all(|(index, byte)| index == 8 || byte.is_ascii_digit());
    shaped.then(|| {
        format!(
            "{}-{}-{}T{}:{}:{}Z",
            &stamp[0..4],
            &stamp[4..6],
            &stamp[6..8],
            &stamp[9..11],
            &stamp[11..13],
            &stamp[13..15]
        )
    })
}

/// Seconds between a copy's stamp and now, by SQLite's own clock, or `None` for a stamp
/// that does not parse.
fn age_secs(conn: &Connection, stamp: &str) -> Result<Option<i64>> {
    let Some(iso) = stamp_to_iso(stamp) else {
        return Ok(None);
    };
    Ok(conn.query_row(
        "SELECT CAST(strftime('%s', 'now') AS INTEGER) - CAST(strftime('%s', ?1) AS INTEGER)",
        [iso.replace('T', " ").trim_end_matches('Z')],
        |row| row.get(0),
    )?)
}

fn failed_at(conn: &Connection) -> Result<Option<i64>> {
    Ok(read_key(conn, FAILED_AT_KEY)?.and_then(|value| value.parse().ok()))
}

fn epoch_to_iso(conn: &Connection, epoch: i64) -> Result<Option<String>> {
    Ok(conn.query_row(
        "SELECT strftime('%Y-%m-%dT%H:%M:%SZ', ?1, 'unixepoch')",
        [epoch],
        |row| row.get(0),
    )?)
}

fn now_epoch(conn: &Connection) -> Result<i64> {
    Ok(
        conn.query_row("SELECT CAST(strftime('%s', 'now') AS INTEGER)", [], |row| {
            row.get(0)
        })?,
    )
}

/// The status the page shows. `available` is false for a database with no file, which has
/// nowhere to put a copy.
fn status(db: &Db) -> Result<Value> {
    let conn = db.conn();
    let newest = db.path().and_then(newest_copy_stamp);
    let failure = match failed_at(conn)? {
        Some(epoch) => json!({
            "at": epoch_to_iso(conn, epoch)?,
            "code": FAILURE_CODE,
            "message": FAILURE_MESSAGE,
        }),
        None => Value::Null,
    };
    Ok(json!({
        "available": db.path().is_some(),
        "enabled": enabled(conn)?,
        "frequency": frequency(conn)?,
        "lastBackupAt": newest.as_deref().and_then(stamp_to_iso),
        "failure": failure,
    }))
}

fn status_response(db: &Db, ran: Option<bool>) -> Result<Response> {
    let mut body = json!({ "autoBackup": status(db)? });
    if let Some(ran) = ran {
        body["ran"] = json!(ran);
    }
    Ok(Response {
        status: 200,
        headers: crate::router::no_store_headers(),
        body,
    })
}

/// `GET /api/auto-backup`.
pub(crate) fn get_status(db: &Db) -> Result<Response> {
    status_response(db, None)
}

/// `PUT /api/auto-backup` with `enabled` and/or `frequency`. Anything else is a 400.
pub(crate) fn put_auto_backup(db: &Db, request: &Request) -> Result<Response> {
    let payload = match read_payload(request) {
        Ok(payload) => payload,
        Err(response) => return Ok(response),
    };
    let Value::Object(fields) = &payload else {
        return Ok(message_response(400, INVALID_MESSAGE));
    };
    let enabled_value = fields.get("enabled");
    let frequency_value = fields.get("frequency");
    let known = usize::from(enabled_value.is_some()) + usize::from(frequency_value.is_some());
    if known == 0 || known != fields.len() {
        return Ok(message_response(400, INVALID_MESSAGE));
    }
    let enabled_text = match enabled_value {
        None => None,
        Some(Value::Bool(value)) => Some(value.to_string()),
        Some(_) => return Ok(message_response(400, INVALID_MESSAGE)),
    };
    let frequency_text = match frequency_value {
        None => None,
        Some(Value::String(value)) if FREQUENCIES.contains(&value.as_str()) => Some(value.clone()),
        Some(_) => return Ok(message_response(400, INVALID_MESSAGE)),
    };
    if let Some(value) = enabled_text {
        write_key(db.conn(), ENABLED_KEY, &value)?;
    }
    if let Some(value) = frequency_text {
        write_key(db.conn(), FREQUENCY_KEY, &value)?;
    }
    status_response(db, None)
}

/// Whether a copy is due now: enabled, nothing newer than the interval, and not just failed.
fn due(db: &Db, path: &std::path::Path) -> Result<bool> {
    let conn = db.conn();
    if !enabled(conn)? {
        return Ok(false);
    }
    if let Some(epoch) = failed_at(conn)? {
        if now_epoch(conn)? - epoch < RETRY_AFTER_FAILURE_SECS {
            return Ok(false);
        }
    }
    let Some(stamp) = newest_copy_stamp(path) else {
        return Ok(true);
    };
    Ok(match age_secs(conn, &stamp)? {
        Some(age) => age >= interval_secs(&frequency(conn)?),
        None => true,
    })
}

/// Writes one copy named by `stamp`, prunes, and records the outcome. A failure is stored and
/// answered as a 200 status carrying it: the page shows it, the route did its job.
fn write_copy(
    db: &Db,
    path: &std::path::Path,
    stamp: &str,
    secret: Option<&crate::key::Secret>,
) -> Result<()> {
    let destination = super::data::safety_copy_path(path, "pre-auto", &free_stamp(path, stamp));
    match crate::replacement::export_connection(db.conn(), &destination, secret, false) {
        Ok(()) => {
            db.conn()
                .execute("DELETE FROM app_settings WHERE key = ?1", [FAILED_AT_KEY])?;
            safety_copies::prune(path);
        }
        Err(_) => {
            write_key(db.conn(), FAILED_AT_KEY, &now_epoch(db.conn())?.to_string())?;
        }
    }
    Ok(())
}

fn run_at(
    db: &Db,
    force: bool,
    secret: Option<&crate::key::Secret>,
    stamp: Option<&str>,
) -> Result<Response> {
    let Some(path) = db.path() else {
        return status_response(db, Some(false));
    };
    if !force && !due(db, path)? {
        return status_response(db, Some(false));
    }
    let stamp = match stamp {
        Some(stamp) => stamp.to_owned(),
        None => super::data::timestamp(db.conn())?,
    };
    write_copy(db, path, &stamp, secret)?;
    status_response(db, Some(true))
}

/// `POST /api/auto-backup/run`, with `{force: true}` for "Back up now". Without it, a copy is
/// written only when one is due.
pub(crate) fn post_run(
    db: &Db,
    request: &Request,
    secret: Option<&crate::key::Secret>,
) -> Result<Response> {
    let force = if request
        .body
        .as_deref()
        .is_none_or(|body| body.trim().is_empty())
    {
        false
    } else {
        let payload = match read_payload(request) {
            Ok(payload) => payload,
            Err(response) => return Ok(response),
        };
        match payload.get("force") {
            None => false,
            Some(Value::Bool(force)) => *force,
            Some(_) => return Ok(json_response(400, json!({ "message": INVALID_MESSAGE }))),
        }
    };
    run_at(db, force, secret, None)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::open_seeded_keyed;
    use crate::id::CounterId;
    use crate::router::dispatch_keyed;
    use crate::test_support::{request, seeded, temp_db_path};

    fn key() -> crate::key::Secret {
        crate::key::Secret::from_passphrase("auto backup fixture").unwrap()
    }

    fn file_db(name: &str) -> (Db, CounterId, String) {
        let path = temp_db_path(name);
        for suffix in ["", "-wal", "-shm"] {
            let _ = std::fs::remove_file(format!("{path}{suffix}"));
        }
        let ids = CounterId::new();
        let db = open_seeded_keyed(&path, Some(&key()), &ids).expect("an encrypted database");
        (db, ids, path)
    }

    fn call(db: &Db, ids: &CounterId, method: &str, path: &str, body: Option<Value>) -> Response {
        let key = key();
        dispatch_keyed(db, &request(method, path, body), ids, Some(&key))
    }

    fn copies(path: &str) -> Vec<String> {
        let name = std::path::Path::new(path)
            .file_name()
            .unwrap()
            .to_string_lossy()
            .into_owned();
        let mut found: Vec<String> =
            std::fs::read_dir(std::path::Path::new(path).parent().unwrap())
                .unwrap()
                .flatten()
                .map(|entry| entry.file_name().to_string_lossy().into_owned())
                .filter(|file| file.starts_with(&format!("{name}.pre-auto-")))
                .collect();
        found.sort();
        found
    }

    #[test]
    fn it_is_off_by_default_and_a_run_does_nothing_until_it_is_turned_on() {
        let (db, ids, path) = file_db("auto-off.sqlite");

        let status = call(&db, &ids, "GET", "/api/auto-backup", None);
        assert_eq!(status.status, 200);
        assert_eq!(status.body["autoBackup"]["enabled"], json!(false));
        assert_eq!(status.body["autoBackup"]["frequency"], json!("daily"));
        assert_eq!(status.body["autoBackup"]["lastBackupAt"], Value::Null);

        let run = call(&db, &ids, "POST", "/api/auto-backup/run", None);
        assert_eq!(run.body["ran"], json!(false));
        assert!(copies(&path).is_empty());
    }

    #[test]
    fn turning_it_on_writes_one_copy_that_opens_and_is_not_repeated_within_the_interval() {
        let (db, ids, path) = file_db("auto-on.sqlite");
        let on = call(
            &db,
            &ids,
            "PUT",
            "/api/auto-backup",
            Some(json!({ "enabled": true })),
        );
        assert_eq!(on.body["autoBackup"]["enabled"], json!(true));

        let first = call(&db, &ids, "POST", "/api/auto-backup/run", None);
        assert_eq!(first.body["ran"], json!(true));
        assert_eq!(first.body["autoBackup"]["failure"], Value::Null);
        assert!(first.body["autoBackup"]["lastBackupAt"].is_string());
        let written = copies(&path);
        assert_eq!(written.len(), 1);

        // The copy is a real, keyed database holding the same Worksite.
        let copy = std::path::Path::new(&path).with_file_name(&written[0]);
        let conn = crate::key::open_keyed_readonly(&copy, Some(&key())).expect("copy opens");
        let rows: i64 = conn
            .query_row("SELECT COUNT(*) FROM worksites", [], |row| row.get(0))
            .unwrap();
        assert!(rows >= 1);

        let again = call(&db, &ids, "POST", "/api/auto-backup/run", None);
        assert_eq!(again.body["ran"], json!(false));
        assert_eq!(copies(&path).len(), 1);
    }

    #[test]
    fn a_copy_older_than_the_interval_is_due_and_a_weekly_one_waits_longer() {
        let (db, ids, path) = file_db("auto-due.sqlite");
        call(
            &db,
            &ids,
            "PUT",
            "/api/auto-backup",
            Some(json!({ "enabled": true })),
        );
        // Two days old: due when daily, not when weekly.
        let stamp: String = db
            .conn()
            .query_row(
                "SELECT strftime('%Y%m%dT%H%M%S', 'now', '-2 days')",
                [],
                |row| row.get(0),
            )
            .unwrap();
        std::fs::write(format!("{path}.pre-auto-{stamp}.sqlite"), b"old").unwrap();

        call(
            &db,
            &ids,
            "PUT",
            "/api/auto-backup",
            Some(json!({ "frequency": "weekly" })),
        );
        let weekly = call(&db, &ids, "POST", "/api/auto-backup/run", None);
        assert_eq!(weekly.body["ran"], json!(false));

        call(
            &db,
            &ids,
            "PUT",
            "/api/auto-backup",
            Some(json!({ "frequency": "daily" })),
        );
        let daily = call(&db, &ids, "POST", "/api/auto-backup/run", None);
        assert_eq!(daily.body["ran"], json!(true));
        assert_eq!(copies(&path).len(), 2);
    }

    #[test]
    fn back_up_now_ignores_the_schedule_and_only_the_newest_three_copies_stay() {
        let (db, ids, path) = file_db("auto-keep.sqlite");
        for day in 1..=4 {
            std::fs::write(
                format!("{path}.pre-auto-2026010{day}T000000.sqlite"),
                b"old",
            )
            .unwrap();
        }
        // Off, but "Back up now" still copies.
        let run = call(
            &db,
            &ids,
            "POST",
            "/api/auto-backup/run",
            Some(json!({ "force": true })),
        );
        assert_eq!(run.body["ran"], json!(true));
        let left = copies(&path);
        assert_eq!(left.len(), 3, "{left:?}");
        assert!(!left.iter().any(|name| name.contains("20260101")));
        assert!(!left.iter().any(|name| name.contains("20260102")));
    }

    #[test]
    fn two_copies_in_the_same_second_both_succeed_and_read_back_as_one_instant() {
        let (db, _ids, path) = file_db("auto-twice.sqlite");
        let first = run_at(&db, true, Some(&key()), Some("20990101T000000")).unwrap();
        let second = run_at(&db, true, Some(&key()), Some("20990101T000000")).unwrap();
        assert_eq!(first.body["autoBackup"]["failure"], Value::Null);
        assert_eq!(second.body["autoBackup"]["failure"], Value::Null);
        assert_eq!(copies(&path).len(), 2);
        assert_eq!(
            second.body["autoBackup"]["lastBackupAt"],
            json!("2099-01-01T00:00:00Z")
        );
    }

    #[test]
    fn a_failed_copy_is_reported_with_fixed_copy_and_is_not_retried_at_once() {
        let (db, ids, path) = file_db("auto-fail.sqlite");
        call(
            &db,
            &ids,
            "PUT",
            "/api/auto-backup",
            Some(json!({ "enabled": true })),
        );
        // A stamp that names a folder that does not exist makes the copy impossible to write,
        // whatever the platform's permissions.
        let failed = run_at(&db, true, Some(&key()), Some("no-such-folder/stamp")).unwrap();
        let failure = &failed.body["autoBackup"]["failure"];
        assert_eq!(failure["code"], json!(FAILURE_CODE));
        assert_eq!(failure["message"], json!(FAILURE_MESSAGE));
        assert!(failure["at"].is_string());
        // No path and no OS text anywhere in the answer.
        let text = failed.body.to_string();
        assert!(!text.contains("pre-auto"), "{text}");
        assert!(!text.contains("auto-fail"), "{text}");
        assert!(!text.contains("no-such-folder"), "{text}");
        assert!(copies(&path).is_empty());

        // Not due again straight away.
        let soon = call(&db, &ids, "POST", "/api/auto-backup/run", None);
        assert_eq!(soon.body["ran"], json!(false));
        assert!(soon.body["autoBackup"]["failure"].is_object());

        // A forced copy that works clears the failure.
        let ok = call(
            &db,
            &ids,
            "POST",
            "/api/auto-backup/run",
            Some(json!({ "force": true })),
        );
        assert_eq!(ok.body["ran"], json!(true));
        assert_eq!(ok.body["autoBackup"]["failure"], Value::Null);
    }

    #[test]
    fn invalid_changes_are_refused_and_a_memory_database_has_nowhere_to_copy() {
        let (db, ids) = seeded();
        for body in [
            json!({}),
            json!({ "enabled": "yes" }),
            json!({ "frequency": "hourly" }),
            json!({ "enabled": true, "extra": 1 }),
            json!([]),
        ] {
            let response = dispatch_keyed(
                &db,
                &request("PUT", "/api/auto-backup", Some(body.clone())),
                &ids,
                None,
            );
            assert_eq!(response.status, 400, "{body}");
        }
        let status = dispatch_keyed(&db, &request("GET", "/api/auto-backup", None), &ids, None);
        assert_eq!(status.body["autoBackup"]["available"], json!(false));
        let run = dispatch_keyed(
            &db,
            &request(
                "POST",
                "/api/auto-backup/run",
                Some(json!({ "force": true })),
            ),
            &ids,
            None,
        );
        assert_eq!(run.status, 200);
        assert_eq!(run.body["ran"], json!(false));
    }

    #[test]
    fn the_settings_wire_never_carries_the_backup_keys() {
        let (db, ids, _path) = file_db("auto-wire.sqlite");
        call(
            &db,
            &ids,
            "PUT",
            "/api/auto-backup",
            Some(json!({ "enabled": true })),
        );
        let settings = call(&db, &ids, "GET", "/api/settings", None);
        let text = settings.body.to_string();
        assert!(!text.contains("autoBackup"), "{text}");
    }

    #[test]
    fn stamps_read_back_as_utc_timestamps_and_only_exact_stamps() {
        assert_eq!(
            stamp_to_iso("20261122T160014").as_deref(),
            Some("2026-11-22T16:00:14Z")
        );
        assert_eq!(stamp_to_iso("v3-20261122T160014"), None);
        assert_eq!(stamp_to_iso("2026112T1600140"), None);
    }
}
