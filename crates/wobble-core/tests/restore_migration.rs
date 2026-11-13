//! Ticket 26: supported old backups restore through the same retained v21/v22 conversion.
//!
//! These tests drive the public core lifecycle only: open an encrypted target with `App::open_keyed`, send
//! `POST /api/restore`, then read back through the normal routes and `Db::open_keyed`. They seed
//! synthetic old shapes; no real database is opened or written.

mod common;

use std::path::Path;

use common::legacy_db::{
    add_assignment_draft, add_attribute, add_saved_assignment, add_worker, add_worker_draft,
    add_worksite, count, finish_source, migration_rows, raw_version, set_value, start_source,
};
use common::{remove_database, temp_db_path};
use rusqlite::{params, Connection};
use serde_json::{json, Value};
use wobble_core::db::{open_seeded_keyed, Db};
use wobble_core::handle::{App, Request, Response};
use wobble_core::id::{CounterId, RandomId};
use wobble_core::replay::dump_state;

const INSTALLATION_PASSPHRASE: &str = "restore migration installation fixture";
fn installation_key() -> wobble_core::key::Secret {
    wobble_core::key::Secret::from_passphrase(INSTALLATION_PASSPHRASE).unwrap()
}
fn current_db(path: &str) -> wobble_core::Result<Db> {
    Db::open_keyed(path, Some(&installation_key()))
}
fn current_app(path: &str) -> App {
    App::open_keyed(path, Some(&installation_key()))
}

const RESTORE_FAILED_CODE: &str = "restore_failed";

fn request(worksite: &str, method: &str, path: &str, body: Option<Value>) -> Request {
    Request {
        method: method.to_owned(),
        path: path.to_owned(),
        query: String::new(),
        headers: vec![
            ("x-wobble-worksite".to_owned(), worksite.to_owned()),
            ("content-type".to_owned(), "application/json".to_owned()),
        ],
        body: body.map(|body| serde_json::to_string(&body).unwrap()),
    }
}

fn dispatch(app: &App, worksite: &str, method: &str, path: &str, body: Option<Value>) -> Response {
    app.handle(&request(worksite, method, path, body), &RandomId)
}

fn theme(conn: &Connection) -> String {
    conn.query_row(
        "SELECT value FROM app_settings WHERE key = 'theme'",
        [],
        |row| row.get(0),
    )
    .unwrap()
}

/// The pre-restore fixture every failure test starts from: one seeded Worksite, one Worker
/// that only exists in the live target, and a non-default setting.
fn populated_target(name: &str) -> String {
    let target = temp_db_path(&format!("restore-migration-target-{name}.sqlite"));
    remove_database(&target);
    let db = open_seeded_keyed(&target, Some(&installation_key()), &CounterId::new())
        .expect("a current target database");
    let worksite: String = db
        .conn()
        .query_row("SELECT id FROM worksites LIMIT 1", [], |row| row.get(0))
        .expect("the seeded Worksite");
    db.conn()
        .execute(
            "INSERT INTO workers (id, worksite_id, name, email, phone, assessment, notes) \
             VALUES ('old-worker', ?1, 'Old Worker', '', '', 'Unassessed', '[]')",
            [&worksite],
        )
        .expect("a pre-restore Worker");
    // A worker created outside the route still needs the stored no-answer value for every
    // Worker-scoped question, or the readback refuses the record as corrupt.
    let attributes: Vec<(String, String)> = db
        .conn()
        .prepare("SELECT id, kind FROM worker_attributes WHERE worksite_id = ?1")
        .expect("reads the seeded questions")
        .query_map([&worksite], |row| Ok((row.get(0)?, row.get(1)?)))
        .expect("the seeded questions")
        .collect::<rusqlite::Result<_>>()
        .expect("the seeded questions");
    for (attribute_id, kind) in attributes {
        let value = if kind == "tag" { "[]" } else { "\"\"" };
        db.conn()
            .execute(
                "INSERT INTO worker_attribute_values (worker_id, attribute_id, value) \
                 VALUES ('old-worker', ?1, ?2)",
                params![attribute_id, value],
            )
            .expect("a stored no-answer");
    }
    db.conn()
        .execute(
            "INSERT OR REPLACE INTO app_settings (key, value) VALUES ('theme', 'dark')",
            [],
        )
        .expect("a pre-restore setting");
    target
}

/// A v20 source whose conversion must fail: the second Worker stores an answer id the
/// definition does not offer, so v21 refuses rather than losing it.
fn corrupt_v20_source() -> String {
    let (source, conn) = start_source("restore-migration", "corrupt-v20");
    add_worksite(&conn, "ws-bad", "Broken Backup");
    add_attribute(
        &conn,
        "ws-bad",
        "dept",
        "Department",
        "category",
        "worker",
        true,
        &[("sales", "Sales")],
        0,
    );
    add_worker(&conn, "ws-bad", "w-bad", "Bad Worker");
    set_value(&conn, "w-bad", "dept", json!("not-an-answer"));
    finish_source(&source, conn, 20);
    source
}

fn staging_files_beside(target: &str) -> Vec<String> {
    let path = Path::new(target);
    let prefix = format!(
        "{}.wobble-",
        path.file_name().expect("a file name").to_string_lossy()
    );
    std::fs::read_dir(path.parent().expect("a parent directory"))
        .expect("reads the database's folder")
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .filter(|name| name.starts_with(&prefix) && name.ends_with(".stage"))
        .collect()
}

#[test]
fn a_conversion_failure_after_staging_leaves_the_live_database_untouched() {
    let target = populated_target("failure");
    let source = corrupt_v20_source();
    let source_bytes = std::fs::read(&source).expect("reads the source");

    let app = current_app(&target);
    let restored = dispatch(
        &app,
        "ws-bad",
        "POST",
        "/api/restore",
        Some(json!({ "path": source, "legacy": true })),
    );

    // The coded failure names the real conversion error and the safety copy.
    assert_eq!(restored.status, 500, "{}", restored.body);
    assert_eq!(restored.body["code"], json!(RESTORE_FAILED_CODE));
    let message = restored.body["message"].as_str().unwrap_or_default();
    assert!(
        message.contains("Invalid legacy answer stored for worker w-bad"),
        "{message}"
    );
    let safety = restored.body["recoveryPath"]
        .as_str()
        .expect("the failure identifies its verified recovery copy")
        .to_owned();
    assert!(Path::new(&safety).is_file(), "{safety} exists");

    // The staging copy is gone whether the restore worked or not.
    assert_eq!(staging_files_beside(&target), Vec::<String>::new());
    // The source was only read.
    assert_eq!(std::fs::read(&source).unwrap(), source_bytes);

    // The live database is exactly the pre-restore state, not the backup's partial content.
    let live = current_db(&target).expect("the live database still opens");
    assert_eq!(raw_version(live.conn()), Some(25));
    assert_eq!(count(live.conn(), "worksites"), 1);
    assert_eq!(count(live.conn(), "workers"), 1);
    let name: String = live
        .conn()
        .query_row(
            "SELECT name FROM workers WHERE id = 'old-worker'",
            [],
            |row| row.get(0),
        )
        .expect("the pre-restore Worker survives");
    assert_eq!(name, "Old Worker");
    assert_eq!(theme(live.conn()), "dark");
    drop(live);
    // The public route reads the same untouched file.
    let reopened = current_app(&target);
    let response = dispatch(&reopened, "ws-bad", "GET", "/api/dataset", None);
    assert_eq!(response.status, 200, "{}", response.body);
    assert_eq!(response.body["workers"].as_array().unwrap().len(), 1);
    drop(reopened);

    // The safety copy is the pre-restore database and opens on its own.
    let copy = current_db(&safety).expect("the safety copy opens");
    assert_eq!(raw_version(copy.conn()), Some(25));
    let copied: String = copy
        .conn()
        .query_row(
            "SELECT name FROM workers WHERE id = 'old-worker'",
            [],
            |row| row.get(0),
        )
        .expect("the safety copy holds the replaced data");
    assert_eq!(copied, "Old Worker");
    assert_eq!(theme(copy.conn()), "dark");

    drop(copy);
    drop(app);
    remove_database(&target);
    remove_database(&source);
    remove_database(&safety);
}

const WS_A: &str = "ws-alpha";
const WS_B: &str = "ws-beta";

fn worker_update(name: &str, attributes: Value, email: &str) -> Value {
    json!({
        "name": name,
        "email": email,
        "phone": "",
        "assessment": "Unassessed",
        "attributes": attributes,
        "agitations": [],
        "languages": [],
        "relationships": [],
        "notes": []
    })
}

fn draft_payload(update: Value, base: Option<Value>, note: &str) -> Value {
    json!({ "update": update, "pendingNote": { "text": note }, "base": base })
}

fn set_theme(conn: &Connection, value: &str) {
    conn.execute(
        "INSERT OR REPLACE INTO app_settings (key, value) VALUES ('theme', ?1)",
        [value],
    )
    .expect("a stored setting");
}

/// Two Worksites, converted Work Assignment data and draft state, written at the current
/// shape. `finish_source` then lowers it to the shape and version under test, exactly as a
/// real database of that version would look.
fn seed_rich_source(conn: &Connection, version: i64) {
    add_worksite(conn, WS_A, "Alpha");
    add_worksite(conn, WS_B, "Beta");

    // A v21 source already has the converted shape; earlier sources still hold the legacy
    // Worker-scoped questions and answers the v21 step converts.
    let alpha_scope = if version >= 21 {
        "workAssignment"
    } else {
        "worker"
    };
    add_attribute(
        conn,
        WS_A,
        "a-dept",
        "Department",
        "category",
        alpha_scope,
        version < 21,
        &[("sales", "Sales"), ("marketing", "Marketing")],
        0,
    );
    add_attribute(
        conn,
        WS_A,
        "a-role",
        "Role",
        "category",
        alpha_scope,
        version < 21,
        &[("cashier", "Cashier"), ("stocker", "Stocker")],
        1,
    );
    add_attribute(
        conn,
        WS_A,
        "a-shift",
        "Shifts",
        if version >= 21 { "category" } else { "tag" },
        alpha_scope,
        version < 21,
        &[("days", "Days"), ("nights", "Nights")],
        2,
    );
    // Beta already uses the new model, so upgrade must preserve it untouched.
    add_attribute(
        conn,
        WS_B,
        "b-location",
        "Location",
        "category",
        "workAssignment",
        false,
        &[("store-a", "Store A"), ("store-b", "Store B")],
        0,
    );
    add_worker(conn, WS_A, "w-alpha", "Rosalind Franklin");
    add_worker(conn, WS_B, "w-beta", "Max Planck");
    if version >= 21 {
        add_saved_assignment(
            conn,
            "w-alpha",
            "assignment-alpha",
            0,
            &[
                ("a-dept", "sales"),
                ("a-role", "cashier"),
                ("a-shift", "days"),
            ],
        );
    } else {
        set_value(conn, "w-alpha", "a-dept", json!("sales"));
        set_value(conn, "w-alpha", "a-role", json!("cashier"));
        set_value(conn, "w-alpha", "a-shift", json!(["days"]));
    }
    if version >= 19 {
        add_saved_assignment(
            conn,
            "w-beta",
            "assignment-beta",
            0,
            &[("b-location", "store-b")],
        );
    }
    if version >= 14 {
        add_worker_draft(
            conn,
            WS_A,
            "w-alpha",
            &draft_payload(
                worker_update(
                    "Rosalind Franklin",
                    json!({
                        "a-dept": "sales",
                        "a-role": "cashier",
                        "a-shift": ["days", "nights"]
                    }),
                    "rosalind@example.test",
                ),
                Some(worker_update(
                    "Rosalind Franklin",
                    json!({
                        "a-dept": "sales",
                        "a-role": "cashier",
                        "a-shift": ["days"]
                    }),
                    "",
                )),
                "half a note",
            ),
            "2026-09-01T10:00:00.000Z",
        );
    }
    if version >= 20 {
        add_assignment_draft(
            conn,
            WS_B,
            "w-beta",
            "assignment-beta",
            json!({ "b-location": "store-a" }),
            json!({ "b-location": "store-b" }),
            "2026-09-02T10:00:00.000Z",
        );
    }
    if version >= 17 {
        set_theme(conn, "dark");
    }
}

fn get_json(app: &App, worksite: &str, path: &str) -> Value {
    let response = dispatch(app, worksite, "GET", path, None);
    assert_eq!(response.status, 200, "GET {path}: {}", response.body);
    response.body
}

fn dataset(app: &App, worksite: &str) -> Value {
    get_json(app, worksite, "/api/dataset")
}

fn worker<'a>(dataset: &'a Value, id: &str) -> &'a Value {
    dataset["workers"]
        .as_array()
        .expect("the Worksite's workers")
        .iter()
        .find(|worker| worker["id"] == id)
        .unwrap_or_else(|| panic!("worker {id} is in the dataset"))
}

fn answer_id(definition: &Value, label: &str) -> String {
    definition["options"]
        .as_array()
        .expect("a definition's answers")
        .iter()
        .find(|option| option["value"] == label)
        .unwrap_or_else(|| panic!("answer {label} is on the definition"))["id"]
        .as_str()
        .expect("an answer id")
        .to_owned()
}

fn definition<'a>(dataset: &'a Value, id: &str) -> &'a Value {
    dataset["attributes"]
        .as_array()
        .expect("the Worksite's definitions")
        .iter()
        .find(|attribute| attribute["id"] == id)
        .unwrap_or_else(|| panic!("attribute {id} is in the dataset"))
}

#[test]
fn every_supported_source_version_restores_through_the_same_migration() {
    for version in 12..=21 {
        let target = populated_target(&format!("v{version}"));
        let (source, conn) = start_source("restore-migration", &format!("v{version}"));
        seed_rich_source(&conn, version);
        finish_source(&source, conn, version);
        let source_bytes = std::fs::read(&source).expect("reads the backup");

        let app = current_app(&target);
        let restored = dispatch(
            &app,
            WS_A,
            "POST",
            "/api/restore",
            Some(json!({ "path": source, "legacy": true })),
        );
        assert_eq!(restored.status, 200, "v{version}: {}", restored.body);
        let safety = restored.body["safetyCopyPath"]
            .as_str()
            .expect("a safety copy path")
            .to_owned();
        assert!(Path::new(&safety).is_file(), "v{version}: {safety} exists");
        assert_eq!(
            staging_files_beside(&target),
            Vec::<String>::new(),
            "v{version} leaves no staging file"
        );
        assert_eq!(
            std::fs::read(&source).expect("rereads the backup"),
            source_bytes,
            "v{version} only reads the backup"
        );

        // Both Worksites and both Workers survive the restore.
        let alpha = dataset(&app, WS_A);
        assert_eq!(
            alpha["worksites"].as_array().expect("worksites").len(),
            2,
            "v{version} keeps both Worksites"
        );
        assert_eq!(worker(&alpha, "w-alpha")["name"], "Rosalind Franklin");
        let beta = dataset(&app, WS_B);
        assert_eq!(worker(&beta, "w-beta")["name"], "Max Planck");

        // The retained conversion flattened Alpha's legacy questions and answers.
        assert_eq!(definition(&alpha, "a-dept")["kind"], "category");
        assert_eq!(definition(&alpha, "a-role")["kind"], "category");
        assert_eq!(
            definition(&alpha, "a-shift")["kind"],
            "category",
            "v{version}"
        );
        assert_eq!(
            worker(&alpha, "w-alpha")["attributes"],
            json!({
                "a-dept": answer_id(definition(&alpha, "a-dept"), "Sales"),
                "a-role": answer_id(definition(&alpha, "a-role"), "Cashier"),
                "a-shift": answer_id(definition(&alpha, "a-shift"), "Days"),
            }),
            "v{version} keeps every ordinary value"
        );
        assert!(
            worker(&alpha, "w-alpha").get("assignments").is_none(),
            "v{version} keeps no assignment shape"
        );

        // Beta's explicit Assignment-scoped Location is flattened too; before v19 it was
        // a legacy Worker question with no committed answer.
        assert_eq!(
            worker(&beta, "w-beta")["attributes"],
            json!({
                "b-location": if version >= 19 { json!("store-b") } else { json!("") },
            }),
            "v{version} flattens Beta's Location"
        );

        // Drafts restore with the same conversion; timestamps do not move.
        let worker_draft = get_json(&app, WS_A, "/api/worker-drafts/w-alpha")["draft"].clone();
        let no_assignment_drafts = dispatch(
            &app,
            WS_A,
            "GET",
            "/api/workers/w-alpha/assignment-drafts",
            None,
        );
        assert_eq!(no_assignment_drafts.status, 501);
        if version >= 14 {
            assert_eq!(worker_draft["update"]["email"], "rosalind@example.test");
            assert_eq!(worker_draft["pendingNote"]["text"], "half a note");
            assert_eq!(worker_draft["updatedAt"], "2026-09-01T10:00:00.000Z");
            assert_eq!(
                worker_draft["update"]["attributes"],
                json!({
                    "a-dept": answer_id(definition(&alpha, "a-dept"), "Sales"),
                    "a-role": answer_id(definition(&alpha, "a-role"), "Cashier"),
                    "a-shift": answer_id(definition(&alpha, "a-shift"), "Days"),
                }),
                "v{version} puts the migrated saved values into the draft update"
            );
            assert_eq!(
                worker_draft["base"]["attributes"],
                json!({
                    "a-dept": answer_id(definition(&alpha, "a-dept"), "Sales"),
                    "a-role": answer_id(definition(&alpha, "a-role"), "Cashier"),
                    "a-shift": answer_id(definition(&alpha, "a-shift"), "Days"),
                }),
                "v{version} puts them into the base too"
            );
        } else {
            assert!(worker_draft.is_null(), "v{version} has no draft table");
        }

        // Settings survive: dark from v17 on, the legacy default before it.
        let settings = get_json(&app, WS_A, "/api/settings");
        let expected_theme = if version >= 17 { "dark" } else { "system" };
        assert_eq!(
            settings["settings"]["theme"], expected_theme,
            "v{version} keeps its setting"
        );

        // The supplied safety copy is the pre-restore database.
        let copy = current_db(&safety).expect("the safety copy opens");
        assert_eq!(raw_version(copy.conn()), Some(25));
        assert_eq!(count(copy.conn(), "workers"), 1);
        assert_eq!(theme(copy.conn()), "dark");
        drop(copy);

        drop(app);

        // The chain ran exactly the steps this version still needed, once.
        let first = {
            let db = current_db(&target).expect("the restored target opens");
            let rows = migration_rows(db.conn());
            assert_eq!(
                rows.len() as i64,
                26 - version,
                "v{version} runs every remaining step once"
            );
            assert_eq!(rows[0].0, version);
            assert_eq!(rows.last().unwrap().0, 25);
            assert_eq!(
                db.path().map(Path::to_path_buf),
                Some(std::fs::canonicalize(&target).unwrap())
            );
            dump_state(db.conn()).expect("dumps the restored database")
        };

        // Reopening performs no conversion and changes no identity.
        let reopened = current_app(&target);
        assert_eq!(
            dataset(&reopened, WS_A),
            alpha,
            "v{version} reopens identically"
        );
        drop(reopened);
        let second = {
            let db = current_db(&target).expect("the database reopens");
            dump_state(db.conn()).expect("dumps the reopened database")
        };
        assert_eq!(second, first, "v{version} reopening writes nothing");
        assert_eq!(second["schema_migrations"].len() as i64, 26 - version);
        assert!(
            !second.contains_key("work_assignments"),
            "v{version} leaves no assignment table behind"
        );
        assert!(
            !second.contains_key("worker_attributes_scope"),
            "v{version} leaves no scope column behind"
        );

        remove_database(&target);
        remove_database(&source);
        remove_database(&safety);
    }
}

#[test]
fn backup_export_round_trips_populated_data_and_the_restore_names_its_safety_copy() {
    // A database that has already upgraded a v20 backup: the exact state Export runs on.
    let (v20, conn) = start_source("restore-migration", "round-trip-v20");
    seed_rich_source(&conn, 20);
    finish_source(&v20, conn, 20);
    let live = temp_db_path("restore-migration-round-trip-live.sqlite");
    remove_database(&live);
    std::fs::copy(&v20, &live).expect("copies the v20 source");
    remove_database(&v20);
    {
        wobble_core::open_database::OpenDatabase::convert(Path::new(&live), installation_key())
            .expect("converts and upgrades the explicit legacy fixture");
    }

    let app = current_app(&live);
    // A recent write stays in the WAL, so a bare file copy would miss it.
    let saved = dispatch(
        &app,
        WS_A,
        "PUT",
        "/api/settings",
        Some(json!({ "theme": "light" })),
    );
    assert_eq!(saved.status, 200, "{}", saved.body);
    // A saved view rides the same file: backup, restore and the safety copy carry it.
    let view = dispatch(
        &app,
        WS_A,
        "POST",
        "/api/views",
        Some(json!({
            "name": "Quiet shift",
            "snapshot": {
                "version": 1,
                "kind": "mapping",
                "mapping": {
                    "grouping": { "group": "", "subGroup": "" },
                    "detail": { "expanded": [], "expandedSub": [] },
                    "layout": "free",
                    "population": { "answers": {}, "exactAnswers": {}, "missing": [] },
                    "visibility": { "assessments": [], "values": {}, "languages": [] },
                    "highlight": { "query": "" }
                }
            }
        })),
    );
    assert_eq!(view.status, 201, "{}", view.body);

    let backup = temp_db_path("restore-migration-round-trip-backup.sqlite");
    remove_database(&backup);
    let before = std::fs::read(&live).expect("reads the live file");
    let exported = dispatch(
        &app,
        WS_A,
        "POST",
        "/api/backup",
        Some(json!({ "path": backup, "sourcePassphrase": INSTALLATION_PASSPHRASE })),
    );
    assert_eq!(exported.status, 200, "{}", exported.body);
    assert!(Path::new(&backup).is_file());
    // Export copies; it never writes or moves the source.
    assert_eq!(std::fs::read(&live).expect("rereads the live file"), before);
    assert_eq!(
        get_json(&app, WS_A, "/api/settings")["settings"]["theme"],
        "light",
        "the live database still answers"
    );

    // The copy is a standalone current database holding every exported kind of data.
    let live_state = {
        let db = current_db(&live).expect("the live database opens");
        dump_state(db.conn()).expect("dumps the live database")
    };
    let backup_state = {
        let db = current_db(&backup).expect("the backup opens on its own");
        dump_state(db.conn()).expect("dumps the backup")
    };
    assert_eq!(backup_state, live_state);
    assert_eq!(backup_state["worksites"].len(), 2);
    assert_eq!(backup_state["workers"].len(), 2);
    assert!(!backup_state.contains_key("work_assignments"));
    assert!(!backup_state.contains_key("work_assignment_answers"));
    assert!(!backup_state.contains_key("work_assignment_drafts"));
    // Worker drafts are not one of the eleven dumped tables, so the copy is checked
    // against the live rows directly.
    let worker_drafts = |path: &str| -> Vec<(String, String, String, String)> {
        let db = current_db(path).expect("the database opens");
        let mut statement = db
            .conn()
            .prepare(
                "SELECT worksite_id, worker_id, payload, updated_at FROM worker_drafts \
                 ORDER BY worker_id",
            )
            .expect("reads the stored drafts");
        statement
            .query_map([], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
            })
            .expect("the stored drafts")
            .collect::<rusqlite::Result<_>>()
            .expect("the stored drafts")
    };
    let live_drafts = worker_drafts(&live);
    assert_eq!(live_drafts.len(), 1);
    assert_eq!(worker_drafts(&backup), live_drafts);
    let saved_views = |path: &str| -> Vec<(String, String, String, String)> {
        let db = current_db(path).expect("the database opens");
        let mut statement = db
            .conn()
            .prepare("SELECT id, worksite_id, name, snapshot FROM saved_views ORDER BY id")
            .expect("reads the saved views");
        statement
            .query_map([], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
            })
            .expect("the saved views")
            .collect::<rusqlite::Result<_>>()
            .expect("the saved views")
    };
    let live_views = saved_views(&live);
    assert_eq!(live_views.len(), 1);
    assert_eq!(saved_views(&backup), live_views);

    // Restoring the exported backup passes through the same path: safety copy, staged
    // upgrade, swap, and readback that matches the exported database.
    let target = populated_target("round-trip");
    let restore_app = current_app(&target);
    let restored = dispatch(
        &restore_app,
        WS_A,
        "POST",
        "/api/restore",
        Some(json!({ "path": backup, "sourcePassphrase": INSTALLATION_PASSPHRASE })),
    );
    assert_eq!(restored.status, 200, "{}", restored.body);
    let safety = restored.body["safetyCopyPath"]
        .as_str()
        .expect("a safety copy path")
        .to_owned();
    assert!(Path::new(&safety).is_file());
    assert_eq!(staging_files_beside(&target), Vec::<String>::new());
    drop(restore_app);

    let restored_state = {
        let db = current_db(&target).expect("the restored target opens");
        dump_state(db.conn()).expect("dumps the restored target")
    };
    assert_eq!(restored_state, live_state);
    assert_eq!(worker_drafts(&target), live_drafts);
    assert_eq!(saved_views(&target), live_views);
    let reopened = current_app(&target);
    let listed = get_json(&reopened, WS_A, "/api/views");
    assert_eq!(listed["views"][0]["name"], "Quiet shift");
    drop(reopened);

    // The safety copy is the replaced database, not the restored one.
    let copy = current_db(&safety).expect("the safety copy opens");
    assert_eq!(count(copy.conn(), "workers"), 1);
    assert_eq!(theme(copy.conn()), "dark");
    drop(copy);

    remove_database(&live);
    remove_database(&backup);
    remove_database(&target);
    remove_database(&safety);
}

/// The committed v20 fixture the browser settings suite restores. One Worksite, two
/// Workers, converted answers, and one pending assignment draft for each Worker.
fn seed_browser_fixture(conn: &Connection) {
    const WS: &str = "worksite-fixture";
    add_worksite(conn, WS, "My Worksite");
    add_attribute(
        conn,
        WS,
        "dept",
        "Department",
        "category",
        "worker",
        true,
        &[("sales", "Sales"), ("marketing", "Marketing")],
        0,
    );
    add_attribute(
        conn,
        WS,
        "role",
        "Role",
        "category",
        "worker",
        true,
        &[("cashier", "Cashier"), ("stocker", "Stocker")],
        1,
    );
    add_attribute(
        conn,
        WS,
        "shift",
        "Shifts",
        "tag",
        "worker",
        true,
        &[("days", "Days"), ("nights", "Nights")],
        2,
    );
    add_worker(conn, WS, "worker-rosalind", "Rosalind Franklin");
    add_worker(conn, WS, "worker-bo", "Max Planck");
    set_value(conn, "worker-rosalind", "dept", json!("sales"));
    set_value(conn, "worker-rosalind", "role", json!("cashier"));
    set_value(conn, "worker-rosalind", "shift", json!(["days"]));
    add_worker_draft(
        conn,
        WS,
        "worker-rosalind",
        &draft_payload(
            worker_update(
                "Rosalind Franklin",
                json!({
                    "dept": "sales",
                    "role": "cashier",
                    "shift": ["days", "nights"]
                }),
                "rosalind@example.test",
            ),
            Some(worker_update(
                "Rosalind Franklin",
                json!({ "dept": "sales", "role": "cashier", "shift": ["days"] }),
                "",
            )),
            "half a note",
        ),
        "2026-09-01T10:00:00.000Z",
    );
    add_worker_draft(
        conn,
        WS,
        "worker-bo",
        &draft_payload(
            worker_update(
                "Max Planck",
                json!({
                    "dept": "marketing",
                    "role": "stocker",
                    "shift": ["nights"]
                }),
                "bo@example.com",
            ),
            None,
            "bo's note",
        ),
        "2026-09-03T09:30:00.000Z",
    );
    set_theme(conn, "system");
}

fn v20_fixture_path() -> String {
    format!(
        "{}/../../contract/fixtures/workplace-v20.sqlite",
        env!("CARGO_MANIFEST_DIR")
    )
}

/// Regenerates the committed v20 browser-restore fixture. Ignored by default, so the normal
/// suite only reads the committed file:
///
/// ```sh
/// cargo test -p wobble-core --test restore_migration -- --ignored regenerate_the_v20_fixture
/// ```
#[test]
#[ignore = "regenerates the committed contract/fixtures/workplace-v20.sqlite"]
fn regenerate_the_v20_fixture() {
    let fixture = v20_fixture_path();
    for suffix in ["", "-wal", "-shm", "-journal"] {
        let _ = std::fs::remove_file(format!("{fixture}{suffix}"));
    }

    let (source, conn) = start_source("restore-migration", "browser-fixture");
    seed_browser_fixture(&conn);
    finish_source(&source, conn, 20);
    std::fs::copy(&source, &fixture).expect("writes the committed fixture");
    remove_database(&source);

    // The fixture must stay one self-contained v20 file, like the other committed fixtures.
    // LEGACY-PLAINTEXT-FIXTURE: temp-constructed legacy-schema source for upgrade-read test (intentional plaintext, never production).
    let conn = Connection::open(&fixture).expect("opens the new fixture");
    assert_eq!(raw_version(&conn), Some(20));
    assert_eq!(count(&conn, "worksites"), 1);
    assert_eq!(count(&conn, "worker_drafts"), 2);
    drop(conn);
    for suffix in ["-wal", "-shm", "-journal"] {
        assert!(
            !Path::new(&format!("{fixture}{suffix}")).exists(),
            "the fixture has no {suffix} sidecar"
        );
    }
}

#[test]
fn restore_refuses_versions_outside_the_supported_chain_without_touching_the_live_database() {
    let target = populated_target("unsupported");
    let app = current_app(&target);

    for version in [11_i64, 26] {
        let path = temp_db_path(&format!("restore-migration-unsupported-{version}.sqlite"));
        remove_database(&path);
        // LEGACY-PLAINTEXT-FIXTURE: temp-constructed legacy-schema source for upgrade-read test (intentional plaintext, never production).
        Connection::open(&path)
            .expect("creates the unsupported source")
            .execute_batch(
                "CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY NOT NULL, \
                 name TEXT NOT NULL, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);",
            )
            .expect("creates the migration table");
        // LEGACY-PLAINTEXT-FIXTURE: temp-constructed legacy-schema source for upgrade-read test (intentional plaintext, never production).
        let conn = Connection::open(&path).expect("opens the unsupported source");
        conn.execute(
            "INSERT INTO schema_migrations (version, name) VALUES (?1, 'old')",
            [version],
        )
        .expect("records the unsupported version");
        drop(conn);

        // Explicit legacy label: the lifecycle owner requires a source
        // credential or an explicit legacy flag (fail-closed explicitness —
        // auto-detection must not guess). These fixtures are plaintext by
        // construction (see LEGACY-PLAINTEXT-FIXTURE above).
        let response = dispatch(
            &app,
            "ws-a",
            "POST",
            "/api/restore",
            Some(json!({ "path": path, "legacy": true })),
        );
        assert_eq!(response.status, 400, "version {version}");
        assert_eq!(
            response.body["code"],
            json!("restore_unsupported_schema"),
            "version {version}"
        );
        let message = response.body["message"].as_str().unwrap_or_default();
        assert!(
            message.contains(&format!("schema version {version} is unsupported")),
            "{message}"
        );
        assert_eq!(
            staging_files_beside(&target),
            Vec::<String>::new(),
            "version {version} never stages a rejected source"
        );
        remove_database(&path);
    }

    drop(app);
    let live = current_db(&target).expect("the live database still opens");
    assert_eq!(raw_version(live.conn()), Some(25));
    assert_eq!(count(live.conn(), "workers"), 1);
    assert_eq!(theme(live.conn()), "dark");
    drop(live);
    remove_database(&target);
}
