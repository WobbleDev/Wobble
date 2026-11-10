//! Ticket 01: an existing supported database is preserved in a verified sibling backup
//! before the upgrade entry point changes its schema or application data.

mod common;

use std::path::{Path, PathBuf};

use common::legacy_db::{
    add_assignment_draft, add_attribute, add_saved_assignment, add_worker, add_worksite, count,
    finish_source, raw_version, set_value, start_source, start_source_at,
};
use common::remove_database;
use rusqlite::{Connection, OpenFlags};
use serde_json::json;
use wobble_core::db::Db;
use wobble_core::handle::{App, Request};
use wobble_core::id::RandomId;
use wobble_core::schema::CURRENT_SCHEMA_VERSION;

fn installation_key() -> wobble_core::key::Secret {
    wobble_core::key::Secret::from_passphrase("upgrade backup installation fixture").unwrap()
}
fn current_db(path: &str) -> wobble_core::Result<Db> {
    Db::open_keyed(path, Some(&installation_key()))
}
fn current_app(path: &str) -> App {
    App::open_keyed(path, Some(&installation_key()))
}

const WS: &str = "ws-upgrade";

/// Every `pre-upgrade` sibling of the database, whatever version and stamp it names.
fn upgrade_backups_beside(path: &str) -> Vec<PathBuf> {
    let database = Path::new(path);
    let prefix = format!(
        "{}.pre-upgrade-",
        database
            .file_name()
            .expect("a database file name")
            .to_string_lossy()
    );
    let mut found: Vec<PathBuf> = std::fs::read_dir(database.parent().expect("a parent directory"))
        .expect("reads the database's folder")
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.path())
        .filter(|entry| {
            entry
                .file_name()
                .map(|name| name.to_string_lossy().starts_with(&prefix))
                .unwrap_or(false)
        })
        .collect();
    found.sort();
    found
}

fn remove_backups(paths: &[PathBuf]) {
    for path in paths {
        remove_database(&path.to_string_lossy());
    }
}

/// A v20 source with one saved assignment and one assignment draft, written at the v20
/// shape. The caller finishes it with `finish_source`.
fn v20_source(conn: &Connection) {
    add_worksite(conn, WS, "Upgrade Backup");
    add_attribute(
        conn,
        WS,
        "department",
        "Department",
        "category",
        "workAssignment",
        false,
        &[("sales", "Sales"), ("operations", "Operations")],
        0,
    );
    add_worker(conn, WS, "ada", "Ada");
    add_saved_assignment(conn, "ada", "a1", 0, &[("department", "sales")]);
    add_assignment_draft(
        conn,
        WS,
        "ada",
        "a1",
        json!({ "department": "sales" }),
        json!({ "department": "operations" }),
        "2026-10-01T12:00:00Z",
    );
}

#[test]
fn an_upgrade_writes_a_verified_backup_of_the_incoming_database() {
    let (path, conn) = start_source("upgrade-backup", "success");
    v20_source(&conn);
    finish_source(&path, conn, 20);

    // Keep the v20 source in WAL mode with a committed draft that is still only in its WAL,
    // so a file copy would miss what SQLite's consistent backup API must carry.
    // LEGACY-PLAINTEXT-FIXTURE: temp-constructed legacy-schema source for upgrade-read test (intentional plaintext, never production).
    let held = Connection::open(&path).expect("reopens the v20 source");
    held.execute_batch("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0;")
        .expect("keeps the source in WAL mode");
    add_assignment_draft(
        &held,
        WS,
        "ada",
        "a2",
        json!({ "department": "sales" }),
        json!({ "department": "sales" }),
        "2026-10-02T00:00:00Z",
    );

    let db = Db::open_legacy_fixture(&path).expect("the supported v20 database upgrades");
    drop(held);
    assert_eq!(raw_version(db.conn()), Some(CURRENT_SCHEMA_VERSION));

    let backups = upgrade_backups_beside(&path);
    assert_eq!(backups.len(), 1, "exactly one upgrade backup: {backups:?}");
    let backup = &backups[0];
    let database_name = Path::new(&path)
        .file_name()
        .expect("a database file name")
        .to_string_lossy()
        .into_owned();
    let backup_name = backup
        .file_name()
        .expect("a backup file name")
        .to_string_lossy()
        .into_owned();
    assert!(
        backup_name.starts_with(&format!("{database_name}.pre-upgrade-v20-")),
        "{backup_name} names the database, the incoming version and a stamp"
    );
    assert!(backup_name.ends_with(".sqlite"), "{backup_name}");

    // The backup opens read-only, is intact, and records the version that was incoming.
    // LEGACY-PLAINTEXT-FIXTURE: temp-constructed legacy-schema source for upgrade-read test (intentional plaintext, never production).
    let copy = Connection::open_with_flags(backup, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .expect("the backup opens read-only");
    let integrity: String = copy
        .query_row("PRAGMA integrity_check", [], |row| row.get(0))
        .expect("the backup checks its integrity");
    assert_eq!(integrity, "ok");
    assert_eq!(
        raw_version(&copy),
        Some(20),
        "the backup kept the v20 schema"
    );

    let assignments: Vec<(String, String, i64)> = copy
        .prepare("SELECT id, worker_id, position FROM work_assignments ORDER BY id")
        .expect("reads the saved assignments")
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
        .expect("the saved assignments")
        .collect::<rusqlite::Result<_>>()
        .expect("the saved assignments");
    assert_eq!(assignments, [("a1".to_owned(), "ada".to_owned(), 0)]);

    let pairings: Vec<(String, String, String)> = copy
        .prepare(
            "SELECT assignment_id, attribute_id, answer_id FROM work_assignment_answers \
             ORDER BY assignment_id, attribute_id",
        )
        .expect("reads the saved assignment answers")
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
        .expect("the saved assignment answers")
        .collect::<rusqlite::Result<_>>()
        .expect("the saved assignment answers");
    assert_eq!(
        pairings,
        [("a1".to_owned(), "department".to_owned(), "sales".to_owned())]
    );

    let drafts: Vec<(String, String)> = copy
        .prepare(
            "SELECT assignment_id, payload FROM work_assignment_drafts \
             ORDER BY assignment_id",
        )
        .expect("reads the assignment drafts")
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
        .expect("the assignment drafts")
        .collect::<rusqlite::Result<_>>()
        .expect("the assignment drafts");
    assert_eq!(drafts.len(), 2, "both drafts survive: {drafts:?}");
    let draft = |id: &str| {
        drafts
            .iter()
            .find(|(assignment_id, _)| assignment_id == id)
            .map(|(_, payload)| serde_json::from_str::<serde_json::Value>(payload).unwrap())
            .unwrap_or_else(|| panic!("draft {id} is in the backup"))
    };
    assert_eq!(draft("a1")["answers"]["department"], json!("operations"));
    assert_eq!(draft("a2")["base"]["department"], json!("sales"));

    drop(copy);
    drop(db);
    remove_backups(&backups);
    remove_database(&path);
}

#[test]
fn a_backup_name_that_is_taken_is_never_overwritten() {
    let database = PathBuf::from(common::temp_db_path("upgrade-backup-collision.sqlite"));
    let stamp = "20260102T030405";
    let first = wobble_core::upgrade_backup::reserve_backup_file(&database, 20, stamp)
        .expect("the bare name is free");
    std::fs::write(&first, b"an existing file").expect("fills the first name");

    let second = wobble_core::upgrade_backup::reserve_backup_file(&database, 20, stamp)
        .expect("a fresh name is chosen");

    assert_ne!(first, second);
    assert_eq!(
        first.file_name().unwrap().to_string_lossy(),
        "upgrade-backup-collision.sqlite.pre-upgrade-v20-20260102T030405.sqlite"
    );
    assert_eq!(
        second.file_name().unwrap().to_string_lossy(),
        "upgrade-backup-collision.sqlite.pre-upgrade-v20-20260102T030405-2.sqlite"
    );
    assert_eq!(
        std::fs::read(&first).expect("the taken name still exists"),
        b"an existing file",
        "the file already at the first name was not overwritten"
    );
    assert_eq!(
        std::fs::read(&second).expect("the reserved name exists"),
        b"",
        "the fresh name is reserved empty for the caller"
    );

    remove_database(&database.to_string_lossy());
    remove_database(&first.to_string_lossy());
    remove_database(&second.to_string_lossy());
}

#[test]
fn current_fresh_and_in_memory_databases_get_no_upgrade_backup() {
    let current = common::temp_db_path("upgrade-backup-current.sqlite");
    remove_database(&current);
    {
        wobble_core::db::open_seeded_keyed(
            &current,
            Some(&installation_key()),
            &wobble_core::id::CounterId::new(),
        )
        .expect("a current database");
    }
    assert_eq!(upgrade_backups_beside(&current), Vec::<PathBuf>::new());
    {
        let db = current_db(&current).expect("the current database opens");
        assert_eq!(raw_version(db.conn()), Some(CURRENT_SCHEMA_VERSION));
    }
    assert_eq!(
        upgrade_backups_beside(&current),
        Vec::<PathBuf>::new(),
        "reopening a current database writes no backup"
    );

    let fresh = common::temp_db_path("upgrade-backup-fresh.sqlite");
    remove_database(&fresh);
    {
        let db = current_db(&fresh).expect("a fresh database bootstraps");
        assert_eq!(raw_version(db.conn()), Some(CURRENT_SCHEMA_VERSION));
    }
    assert_eq!(
        upgrade_backups_beside(&fresh),
        Vec::<PathBuf>::new(),
        "bootstrapping a fresh database writes no backup"
    );

    let memory = Db::open(":memory:").expect("an in-memory database opens");
    assert!(memory.path().is_none());
    assert_eq!(raw_version(memory.conn()), Some(CURRENT_SCHEMA_VERSION));

    remove_database(&current);
    remove_database(&fresh);
}

/// A fresh folder of its own, so permissions and scans cannot disturb another test.
fn private_dir(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("wobble-core-test-{}-{name}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("a private test folder");
    dir
}

/// Puts the folder's permissions back even when an assertion panics first.
struct RestorePermissions {
    dir: PathBuf,
    permissions: std::fs::Permissions,
}

impl Drop for RestorePermissions {
    fn drop(&mut self) {
        let _ = std::fs::set_permissions(&self.dir, self.permissions.clone());
    }
}

#[test]
fn a_backup_that_cannot_be_written_stops_the_upgrade_and_leaves_the_database_alone() {
    let dir = private_dir("upgrade-backup-unwritable");
    let path = dir.join("workers.sqlite").to_string_lossy().into_owned();
    let conn = start_source_at(&path);
    v20_source(&conn);
    finish_source(&path, conn, 20);

    let permissions = std::fs::metadata(&dir)
        .expect("the test folder's permissions")
        .permissions();
    let restore = RestorePermissions {
        dir: dir.clone(),
        permissions: permissions.clone(),
    };
    let mut unwritable = permissions;
    unwritable.set_readonly(true);
    std::fs::set_permissions(&dir, unwritable).expect("the folder refuses new files");

    let error = match Db::open_legacy_fixture(&path) {
        Ok(_) => panic!("a failed backup must stop the open"),
        Err(error) => error,
    };
    let message = error.to_string();
    assert!(message.contains("pre-upgrade backup"), "{message}");
    assert!(message.contains("left unchanged"), "{message}");
    assert_eq!(
        upgrade_backups_beside(&path),
        Vec::<PathBuf>::new(),
        "a failed backup leaves no half-made pre-upgrade file"
    );

    drop(restore);

    // The database is still the incoming v20 database, with its rows and pairings intact.
    // LEGACY-PLAINTEXT-FIXTURE: temp-constructed legacy-schema source for upgrade-read test (intentional plaintext, never production).
    let live = Connection::open_with_flags(&path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .expect("the untouched database opens read-only");
    assert_eq!(raw_version(&live), Some(20));
    assert_eq!(count(&live, "work_assignments"), 1);
    assert_eq!(count(&live, "work_assignment_answers"), 1);
    assert_eq!(count(&live, "work_assignment_drafts"), 1);
    drop(live);

    // A later open that can write the backup proves nothing about the upgrade was half-done.
    let db = Db::open_legacy_fixture(&path)
        .expect("the untouched database upgrades once a backup can be made");
    assert_eq!(raw_version(db.conn()), Some(CURRENT_SCHEMA_VERSION));
    drop(db);
    let backups = upgrade_backups_beside(&path);
    assert_eq!(backups.len(), 1, "the retry writes exactly one backup");
    remove_backups(&backups);
    remove_database(&path);
    let _ = std::fs::remove_dir_all(&dir);
}

fn theme(conn: &Connection) -> String {
    conn.query_row(
        "SELECT value FROM app_settings WHERE key = 'theme'",
        [],
        |row| row.get(0),
    )
    .expect("a stored theme")
}

/// A v20 source whose v21 conversion must fail: its Worker stores an answer id the
/// definition does not offer, so the migration refuses instead of losing it.
fn corrupt_v20_source(name: &str) -> String {
    let (source, conn) = start_source("upgrade-backup", name);
    add_worksite(&conn, "ws-bad", "Broken Backup");
    add_attribute(
        &conn,
        "ws-bad",
        "department",
        "Department",
        "category",
        "worker",
        true,
        &[("sales", "Sales")],
        0,
    );
    add_worker(&conn, "ws-bad", "w-bad", "Bad Worker");
    set_value(&conn, "w-bad", "department", json!("not-an-answer"));
    finish_source(&source, conn, 20);
    source
}

// Explicit legacy label: the lifecycle owner requires a source credential or
// an explicit legacy flag. All sources restored through this helper are
// plaintext fixtures by construction (see LEGACY-PLAINTEXT-FIXTURE notes).
fn request_restore(source: &str) -> Request {
    Request {
        method: "POST".to_owned(),
        path: "/api/restore".to_owned(),
        query: String::new(),
        headers: vec![("content-type".to_owned(), "application/json".to_owned())],
        body: Some(json!({ "path": source, "legacy": true }).to_string()),
    }
}

#[test]
fn a_failed_restore_staging_conversion_leaves_live_and_source_alone_without_a_staging_backup() {
    let dir = private_dir("upgrade-backup-restore");
    let target = dir.join("workers.sqlite").to_string_lossy().into_owned();
    remove_database(&target);
    {
        let db = wobble_core::db::open_seeded_keyed(
            &target,
            Some(&installation_key()),
            &wobble_core::id::CounterId::new(),
        )
        .expect("a current target database");
        db.conn()
            .execute(
                "INSERT OR REPLACE INTO app_settings (key, value) VALUES ('theme', 'dark')",
                [],
            )
            .expect("a pre-restore setting");
    }
    let source = corrupt_v20_source("restore-staging");
    let source_bytes = std::fs::read(&source).expect("reads the selected source");

    let app = current_app(&target);
    let response = app.handle(&request_restore(&source), &RandomId);

    assert_eq!(response.status, 500, "{}", response.body);
    assert_eq!(response.body["code"], json!("restore_failed"));
    let message = response.body["message"].as_str().unwrap_or_default();
    assert!(
        message.contains("Invalid legacy answer stored for worker w-bad"),
        "{message}"
    );

    // The source is only read, and its bytes are exactly what was selected.
    assert_eq!(
        std::fs::read(&source).expect("re-reads the selected source"),
        source_bytes
    );
    // LEGACY-PLAINTEXT-FIXTURE: temp-constructed legacy-schema source for upgrade-read test (intentional plaintext, never production).
    let source_view = Connection::open_with_flags(&source, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .expect("the source still opens read-only");
    assert_eq!(raw_version(&source_view), Some(20));

    // The staging copy is gone, and no persistent upgrade backup of it was left beside the
    // live database: a staging backup would be named after the staging file.
    let leftovers: Vec<String> = std::fs::read_dir(&dir)
        .expect("reads the target's folder")
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .filter(|name| name.contains(".restore-staging-") || name.contains(".pre-upgrade-"))
        .collect();
    assert_eq!(leftovers, Vec::<String>::new());

    // The live database is exactly the pre-restore database.
    let live = current_db(&target).expect("the live database still opens");
    assert_eq!(raw_version(live.conn()), Some(CURRENT_SCHEMA_VERSION));
    assert_eq!(count(live.conn(), "worksites"), 1);
    assert_eq!(theme(live.conn()), "dark");
    drop(live);
    assert_eq!(
        upgrade_backups_beside(&target),
        Vec::<PathBuf>::new(),
        "the current live database gets no upgrade backup"
    );

    // Restore kept its existing live safety copy.
    let safety: Vec<PathBuf> = std::fs::read_dir(&dir)
        .expect("reads the target's folder")
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.path())
        .filter(|entry| {
            entry
                .file_name()
                .map(|name| name.to_string_lossy().contains(".pre-restore-"))
                .unwrap_or(false)
        })
        .collect();
    assert_eq!(safety.len(), 1, "one pre-restore safety copy: {safety:?}");

    drop(source_view);
    drop(app);
    remove_backups(&safety);
    remove_database(&target);
    remove_database(&source);
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn reopening_an_upgraded_database_creates_no_second_backup() {
    let (path, conn) = start_source("upgrade-backup", "reopen");
    v20_source(&conn);
    finish_source(&path, conn, 20);

    {
        let db = Db::open_legacy_fixture(&path).expect("the v20 database upgrades");
        assert_eq!(raw_version(db.conn()), Some(CURRENT_SCHEMA_VERSION));
    }
    let first_open = upgrade_backups_beside(&path);
    assert_eq!(first_open.len(), 1, "{first_open:?}");

    {
        let db = Db::open_legacy_fixture(&path).expect("the upgraded database reopens");
        assert_eq!(raw_version(db.conn()), Some(CURRENT_SCHEMA_VERSION));
    }
    assert_eq!(
        upgrade_backups_beside(&path),
        first_open,
        "an already-current database is not backed up again"
    );

    remove_backups(&first_open);
    remove_database(&path);
}

#[test]
fn a_successful_restore_keeps_its_sequence_and_writes_no_staging_backup() {
    let dir = private_dir("upgrade-backup-restore-success");
    let target = dir.join("workers.sqlite").to_string_lossy().into_owned();
    remove_database(&target);
    {
        let db = wobble_core::db::open_seeded_keyed(
            &target,
            Some(&installation_key()),
            &wobble_core::id::CounterId::new(),
        )
        .expect("a current target database");
        assert_eq!(count(db.conn(), "worksites"), 1);
    }

    let (source, conn) = start_source("upgrade-backup", "restore-success");
    v20_source(&conn);
    finish_source(&source, conn, 20);
    let source_bytes = std::fs::read(&source).expect("reads the selected source");

    let app = current_app(&target);
    let response = app.handle(&request_restore(&source), &RandomId);

    assert_eq!(response.status, 200, "{}", response.body);
    let safety = response.body["safetyCopyPath"]
        .as_str()
        .expect("the reply names the safety copy")
        .to_owned();
    assert!(Path::new(&safety).is_file(), "{safety} exists");

    // Selected source untouched; staging gone; no persistent upgrade backup of staging.
    assert_eq!(
        std::fs::read(&source).expect("re-reads the selected source"),
        source_bytes
    );
    let leftovers: Vec<String> = std::fs::read_dir(&dir)
        .expect("reads the target's folder")
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .filter(|name| name.contains(".restore-staging-") || name.contains(".pre-upgrade-"))
        .collect();
    assert_eq!(leftovers, Vec::<String>::new());

    // The live database is the source's content, upgraded to the current schema.
    let live = current_db(&target).expect("the restored database opens");
    assert_eq!(raw_version(live.conn()), Some(CURRENT_SCHEMA_VERSION));
    assert_eq!(count(live.conn(), "worksites"), 1);
    let name: String = live
        .conn()
        .query_row("SELECT name FROM worksites", [], |row| row.get(0))
        .expect("the restored Worksite");
    assert_eq!(name, "Upgrade Backup");

    // The safety copy is the pre-restore live database and opens on its own.
    let copy = current_db(&safety).expect("the safety copy opens");
    assert_eq!(raw_version(copy.conn()), Some(CURRENT_SCHEMA_VERSION));
    assert_eq!(count(copy.conn(), "worksites"), 1);

    drop(copy);
    drop(live);
    drop(app);
    remove_database(&safety);
    remove_database(&target);
    remove_database(&source);
    let _ = std::fs::remove_dir_all(&dir);
}
