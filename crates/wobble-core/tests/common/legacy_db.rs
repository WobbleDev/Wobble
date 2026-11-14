//! Builders for legacy-shaped source databases. The starting point is always the current
//! v22 shape; `finish_source` lowers it to a genuinely older shape by adding the v18 scope
//! columns and the v19/v20 assignment tables when the target version had them, then stamps
//! that version. Nothing is manufactured by assuming the current schema still carries the
//! assignment surface.
#![allow(dead_code)]

use std::collections::HashMap;

use rusqlite::{params, Connection};
use serde_json::{json, Value};
use wobble_core::db::open_seeded_legacy_fixture;
use wobble_core::id::CounterId;

use super::{remove_database, temp_db_path};

/// The v18 Attribute metadata columns, as the additive contract created them.
const LEGACY_SCOPE_COLUMNS: &str = "
ALTER TABLE worker_attributes ADD COLUMN scope TEXT NOT NULL DEFAULT 'worker'
  CHECK (scope IN ('worker', 'workAssignment'));
ALTER TABLE worker_attributes ADD COLUMN inference_eligible INTEGER NOT NULL DEFAULT 1
  CHECK (inference_eligible IN (0, 1));
";

/// The v19 Work Assignment storage, exactly as that migration created it.
const LEGACY_ASSIGNMENT_DDL: &str = r#"
CREATE TABLE IF NOT EXISTS work_assignments (
  id TEXT PRIMARY KEY NOT NULL,
  worker_id TEXT NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
  position INTEGER NOT NULL CHECK (position >= 0)
);
CREATE INDEX IF NOT EXISTS idx_work_assignments_worker_id ON work_assignments(worker_id, position);
CREATE TABLE IF NOT EXISTS work_assignment_answers (
  assignment_id TEXT NOT NULL REFERENCES work_assignments(id) ON DELETE CASCADE,
  attribute_id TEXT NOT NULL REFERENCES worker_attributes(id) ON DELETE CASCADE,
  answer_id TEXT NOT NULL,
  PRIMARY KEY (assignment_id, attribute_id)
);
"#;

/// The v20 Work Assignment drafts, exactly as that migration created them.
const LEGACY_ASSIGNMENT_DRAFT_DDL: &str = r#"
CREATE TABLE IF NOT EXISTS work_assignment_drafts (
  worksite_id TEXT NOT NULL REFERENCES worksites(id) ON DELETE CASCADE,
  worker_id TEXT NOT NULL,
  assignment_id TEXT NOT NULL,
  payload TEXT NOT NULL CHECK (json_valid(payload)),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (worksite_id, worker_id, assignment_id)
);
CREATE TRIGGER IF NOT EXISTS work_assignment_drafts_cascade_worker
AFTER DELETE ON workers
BEGIN
  DELETE FROM work_assignment_drafts WHERE worker_id = OLD.id;
END;
CREATE TRIGGER IF NOT EXISTS work_assignment_drafts_cascade_assignment
AFTER DELETE ON work_assignments
BEGIN
  DELETE FROM work_assignment_drafts WHERE assignment_id = OLD.id;
END;
"#;

/// Where `add_attribute` parks the scope a source at v18–v21 should end up with. The v22
/// shape has no scope columns, so the values are staged here until `finish_source` adds the
/// columns; a v22 or pre-v18 target simply drops the staging table.
const ATTRIBUTE_SCOPE_STAGING_DDL: &str = "
CREATE TABLE IF NOT EXISTS legacy_attribute_scopes (
  id TEXT PRIMARY KEY NOT NULL,
  scope TEXT NOT NULL,
  inference_eligible INTEGER NOT NULL
);
";

/// Opens a current, seeded database, clears its starter Worksite, and hands back a connection
/// at the current shape. Tests write the data they need, then lower the shape and version in
/// `finish_source`. `prefix` names the suite so parallel suites keep their own files.
pub fn start_source(prefix: &str, name: &str) -> (String, Connection) {
    let path = temp_db_path(&format!("{prefix}-{name}.sqlite"));
    let conn = start_source_at(&path);
    (path, conn)
}

/// `start_source` at a caller-chosen path, for a source that needs its own folder (for
/// example one whose sibling files must not be writable).
pub fn start_source_at(path: &str) -> Connection {
    remove_database(path);
    {
        open_seeded_legacy_fixture(path, &CounterId::new()).expect("a seeded source database");
    }
    let conn = Connection::open(path).expect("opens the source database");
    conn.execute_batch("PRAGMA foreign_keys = ON;")
        .expect("foreign keys on the source");
    conn.execute("DELETE FROM worksites", [])
        .expect("clears the seeded Worksite");
    conn
}

/// Lowers the written database to the shape and version a real source of that version had.
pub fn finish_source(path: &str, conn: Connection, version: i64) {
    // v18 added the Attribute metadata columns. The current shape has neither, so add them
    // only when the target version had them, then carry the staged values across.
    if version >= 18 {
        conn.execute_batch(LEGACY_SCOPE_COLUMNS)
            .expect("restores the v18 Attribute shape");
        // A source without Attributes never created the staging table.
        conn.execute_batch(ATTRIBUTE_SCOPE_STAGING_DDL)
            .expect("ensures the scope staging table");
        let staged: Vec<(String, String, i64)> = {
            let mut statement = conn
                .prepare(
                    "SELECT id, scope, inference_eligible FROM legacy_attribute_scopes ORDER BY rowid",
                )
                .expect("reads the staged scopes");
            statement
                .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
                .expect("the staged scopes")
                .collect::<rusqlite::Result<_>>()
                .expect("the staged scopes")
        };
        for (id, scope, inference_eligible) in staged {
            conn.execute(
                "UPDATE worker_attributes SET scope = ?1, inference_eligible = ?2 WHERE id = ?3",
                params![scope, inference_eligible, id],
            )
            .expect("restores an Attribute's scope");
        }
    }

    // v19 added saved assignment storage, v20 its drafts. Add the tables an older target
    // had; a lower target must not keep anywhere the test inserted through the helpers.
    if version >= 19 {
        conn.execute_batch(LEGACY_ASSIGNMENT_DDL)
            .expect("restores the v19 Work Assignment shape");
    } else {
        conn.execute_batch(
            "DROP TRIGGER IF EXISTS work_assignment_drafts_cascade_worker; \
             DROP TRIGGER IF EXISTS work_assignment_drafts_cascade_assignment; \
             DROP TABLE IF EXISTS work_assignment_drafts; \
             DROP TABLE IF EXISTS work_assignment_answers; \
             DROP TABLE IF EXISTS work_assignments;",
        )
        .expect("removes assignment storage from a pre-v19 target");
    }
    if version >= 20 {
        conn.execute_batch(LEGACY_ASSIGNMENT_DRAFT_DDL)
            .expect("restores the v20 assignment draft shape");
    } else {
        conn.execute_batch(
            "DROP TRIGGER IF EXISTS work_assignment_drafts_cascade_worker; \
             DROP TRIGGER IF EXISTS work_assignment_drafts_cascade_assignment; \
             DROP TABLE IF EXISTS work_assignment_drafts;",
        )
        .expect("removes assignment drafts from a pre-v20 target");
    }

    conn.execute_batch("DROP TABLE IF EXISTS legacy_attribute_scopes;")
        .expect("drops the scope staging table");

    // v24 added saved views, so every supported older source predates the table.
    if version < 24 {
        conn.execute_batch("DROP TABLE IF EXISTS saved_views;")
            .expect("removes saved views from a pre-v24 target");
    }

    // v25 added the committee goal column beside the committee target.
    if version < 25 {
        conn.execute_batch("ALTER TABLE worksites DROP COLUMN committee_goal;")
            .expect("removes the committee goal from a pre-v25 target");
    }

    if version < 13 {
        conn.execute_batch(
            "DROP TRIGGER IF EXISTS worker_drafts_cascade_worker; DROP TABLE worker_drafts;",
        )
        .expect("restores the pre-v13 draft shape");
    }
    if version <= 13 {
        downgrade_answers_to_text(&conn);
    }
    if version < 17 {
        conn.execute_batch(
            "DROP TABLE app_settings;
             CREATE TABLE app_settings (
               id INTEGER PRIMARY KEY CHECK (id = 1),
               theme TEXT NOT NULL CHECK (theme IN ('system', 'light', 'dark')),
               density TEXT NOT NULL CHECK (density IN ('standard', 'compact', 'comfortable'))
             );
             INSERT INTO app_settings (id, theme, density) VALUES (1, 'system', 'standard');",
        )
        .expect("restores the legacy settings table");
    }
    conn.execute("DELETE FROM schema_migrations", [])
        .expect("clears the bootstrap row");
    conn.execute(
        "INSERT INTO schema_migrations (version, name, applied_at) \
         VALUES (?1, 'current-schema-bootstrap', '2026-09-30 12:00:00')",
        [version],
    )
    .expect("records the source version");
    conn.execute_batch("PRAGMA journal_mode = DELETE;")
        .expect("checkpoints the source into one file");
    drop(conn);
    let _ = path;
}

/// Rewrites answer ids back to the answer text a v12 or v13 database stored.
pub fn downgrade_answers_to_text(conn: &Connection) {
    let attributes: Vec<(String, String)> = {
        let mut statement = conn
            .prepare("SELECT id, kind FROM worker_attributes ORDER BY position, rowid")
            .expect("reads the definitions");
        statement
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
            .expect("the definitions")
            .collect::<rusqlite::Result<_>>()
            .expect("the definitions")
    };
    let mut ids_by_text: HashMap<String, (String, HashMap<String, String>)> = HashMap::new();
    for (attribute_id, kind) in attributes {
        let raw: String = conn
            .query_row(
                "SELECT options FROM worker_attributes WHERE id = ?1",
                [&attribute_id],
                |row| row.get(0),
            )
            .expect("the stored options");
        let options: Vec<Value> = serde_json::from_str(&raw).expect("the options JSON");
        let mut text_by_id = HashMap::new();
        let mut texts = Vec::new();
        for option in options {
            let id = option["id"].as_str().expect("an answer id").to_owned();
            let value = option["value"]
                .as_str()
                .expect("an answer label")
                .to_owned();
            text_by_id.insert(id, value.clone());
            texts.push(Value::String(value));
        }
        conn.execute(
            "UPDATE worker_attributes SET options = ?1 WHERE id = ?2",
            params![serde_json::to_string(&texts).unwrap(), attribute_id],
        )
        .expect("rewrites the options as text");
        ids_by_text.insert(attribute_id, (kind, text_by_id));
    }

    let values: Vec<(String, String, String)> = {
        let mut statement = conn
            .prepare("SELECT worker_id, attribute_id, value FROM worker_attribute_values")
            .expect("reads the stored answers");
        statement
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
            .expect("the stored answers")
            .collect::<rusqlite::Result<_>>()
            .expect("the stored answers")
    };
    for (worker_id, attribute_id, raw) in values {
        let Some((kind, text_by_id)) = ids_by_text.get(&attribute_id) else {
            continue;
        };
        let value: Value = serde_json::from_str(&raw).expect("the stored value JSON");
        let to_text = |id: &str| -> String {
            if id.is_empty() {
                String::new()
            } else {
                text_by_id
                    .get(id)
                    .unwrap_or_else(|| panic!("answer {id} is stored on the definition"))
                    .clone()
            }
        };
        let rewritten = if kind == "tag" {
            Value::Array(
                value
                    .as_array()
                    .expect("a tag stores an array")
                    .iter()
                    .map(|item| Value::String(to_text(item.as_str().expect("an answer id"))))
                    .collect(),
            )
        } else {
            Value::String(to_text(value.as_str().expect("a category stores a string")))
        };
        conn.execute(
            "UPDATE worker_attribute_values SET value = ?1 WHERE worker_id = ?2 AND attribute_id = ?3",
            params![serde_json::to_string(&rewritten).unwrap(), worker_id, attribute_id],
        )
        .expect("rewrites the stored answer as text");
    }
}

pub fn add_worksite(conn: &Connection, id: &str, name: &str) {
    conn.execute(
        "INSERT INTO worksites (id, name, committee_target) VALUES (?1, ?2, 5)",
        params![id, name],
    )
    .expect("a Worksite");
}

#[allow(clippy::too_many_arguments)]
pub fn add_attribute(
    conn: &Connection,
    worksite: &str,
    id: &str,
    name: &str,
    kind: &str,
    scope: &str,
    inference_eligible: bool,
    answers: &[(&str, &str)],
    position: i64,
) {
    let options: Vec<Value> = answers
        .iter()
        .map(|(answer_id, value)| json!({ "id": answer_id, "value": value }))
        .collect();
    conn.execute(
        "INSERT INTO worker_attributes \
           (id, worksite_id, name, kind, options, position) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![
            id,
            worksite,
            name,
            kind,
            serde_json::to_string(&options).unwrap(),
            position
        ],
    )
    .expect("an Attribute");
    conn.execute_batch(ATTRIBUTE_SCOPE_STAGING_DDL)
        .expect("the scope staging table");
    conn.execute(
        "INSERT OR REPLACE INTO legacy_attribute_scopes (id, scope, inference_eligible) \
         VALUES (?1, ?2, ?3)",
        params![id, scope, i64::from(inference_eligible)],
    )
    .expect("a staged Attribute scope");
}

pub fn add_worker(conn: &Connection, worksite: &str, id: &str, name: &str) {
    conn.execute(
        "INSERT INTO workers (id, worksite_id, name, email, phone, assessment, notes) \
         VALUES (?1, ?2, ?3, '', '', 'Unassessed', '[]')",
        params![id, worksite, name],
    )
    .expect("a Worker");
}

pub fn set_value(conn: &Connection, worker_id: &str, attribute_id: &str, value: Value) {
    conn.execute(
        "INSERT INTO worker_attribute_values (worker_id, attribute_id, value) VALUES (?1, ?2, ?3)",
        params![
            worker_id,
            attribute_id,
            serde_json::to_string(&value).unwrap()
        ],
    )
    .expect("a stored Worker answer");
}

/// Ensures the v19 storage exists before a test writes an assignment into it.
fn ensure_assignment_tables(conn: &Connection) {
    conn.execute_batch(LEGACY_ASSIGNMENT_DDL)
        .expect("the legacy assignment tables");
}

pub fn add_saved_assignment(
    conn: &Connection,
    worker_id: &str,
    id: &str,
    position: i64,
    answers: &[(&str, &str)],
) {
    ensure_assignment_tables(conn);
    conn.execute(
        "INSERT INTO work_assignments (id, worker_id, position) VALUES (?1, ?2, ?3)",
        params![id, worker_id, position],
    )
    .expect("a saved assignment");
    for (attribute_id, answer_id) in answers {
        conn.execute(
            "INSERT INTO work_assignment_answers (assignment_id, attribute_id, answer_id) \
             VALUES (?1, ?2, ?3)",
            params![id, attribute_id, answer_id],
        )
        .expect("a saved assignment answer");
    }
}

pub fn add_assignment_draft(
    conn: &Connection,
    worksite: &str,
    worker_id: &str,
    assignment_id: &str,
    base: Value,
    answers: Value,
    updated_at: &str,
) {
    ensure_assignment_tables(conn);
    conn.execute_batch(LEGACY_ASSIGNMENT_DRAFT_DDL)
        .expect("the legacy assignment draft table");
    conn.execute(
        "INSERT INTO work_assignment_drafts \
           (worksite_id, worker_id, assignment_id, payload, updated_at) \
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![
            worksite,
            worker_id,
            assignment_id,
            json!({ "base": base, "answers": answers }).to_string(),
            updated_at
        ],
    )
    .expect("a stored assignment draft");
}

pub fn add_worker_draft(
    conn: &Connection,
    worksite: &str,
    worker_id: &str,
    input: &Value,
    updated_at: &str,
) {
    conn.execute(
        "INSERT INTO worker_drafts (worksite_id, worker_id, payload, updated_at) VALUES (?1, ?2, ?3, ?4)",
        params![
            worksite,
            worker_id,
            serde_json::to_string(input).unwrap(),
            updated_at
        ],
    )
    .expect("a stored Worker draft");
}

pub fn raw_version(conn: &Connection) -> Option<i64> {
    conn.query_row("SELECT MAX(version) FROM schema_migrations", [], |row| {
        row.get(0)
    })
    .ok()
}

pub fn migration_rows(conn: &Connection) -> Vec<(i64, String)> {
    let mut statement = conn
        .prepare("SELECT version, name FROM schema_migrations ORDER BY version")
        .expect("reads the migration rows");
    statement
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
        .expect("the migration rows")
        .collect::<rusqlite::Result<_>>()
        .expect("the migration rows")
}

pub fn count(conn: &Connection, table: &str) -> i64 {
    conn.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
        row.get(0)
    })
    .unwrap()
}
