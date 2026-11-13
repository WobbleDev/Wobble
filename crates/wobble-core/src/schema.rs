//! Database schema: DDL, the current schema version (`CURRENT_SCHEMA_VERSION`), upgrades from
//! each version in `UPGRADABLE_SCHEMA_VERSIONS`, and default worksite seeding.

use std::collections::HashMap;

use rusqlite::{params, Connection};
use serde::Serialize;
use serde_json::Value;

use crate::attribute_migration::{
    answers_from_json, answers_to_json, ids_by_text, map_answer_value, StoredAnswer,
};
use crate::error::{Error, Result};
use crate::id::{random_id, IdSource};
use crate::phone::normalize_phone;

pub const CURRENT_SCHEMA_VERSION: i64 = 25;
/// The versions this app upgrades from. v12 to v13 adds drafts, v13 to v14 assigns answer ids,
/// v14 to v15 adds lookup indexes, v15 to v16 reformats stored clean phone numbers, v16
/// to v17 replaces the single settings row with the typed key/value registry, v17 to v18
/// adds scoped Attribute metadata, v18 to v19 adds Work Assignment storage, v19 to v20
/// adds Work Assignment drafts, v20 to v21 converts the bounded legacy Worker questions
/// to Work Assignment scope and draft state, and v21 to v22 flattens every saved assignment
/// answer into ordinary Worker Attribute values and removes the obsolete schema, and v22 to
/// v23 gives every Attribute value a generated Short form (ADR 0046), and v23 to v24 adds the
/// Worksite's saved views, and v24 to v25 adds the committee goal column beside the committee target.
const UPGRADABLE_SCHEMA_VERSIONS: [i64; 13] = [12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24];

/// Whether an existing database at this version is upgraded in place. The upgrade entry point
/// backs a file-backed database up before handing it to `apply_migrations`; adding a version
/// here also brings it under that backup.
pub(crate) fn is_upgradable_source(version: i64) -> bool {
    UPGRADABLE_SCHEMA_VERSIONS.contains(&version)
}

pub const DEFAULT_WORKSITE_NAME: &str = "My Worksite";
const DEFAULT_COMMITTEE_GOAL: i64 = 5;

/// Stock attributes ship with no options: the names and kinds are defaults, the values belong
/// to each organizer.
const DEFAULT_WORKER_ATTRIBUTES: &[(&str, &str, &[&str])] = &[
    ("Department", "category", &[]),
    ("Role", "category", &[]),
    ("Shifts", "tag", &[]),
];

/// The Spanish creation template. Only the editable default labels differ; kinds, empty
/// answers, target and identity generation are shared with English.
const DEFAULT_SPANISH_WORKSITE_NAME: &str = "Mi lugar de trabajo";
const DEFAULT_SPANISH_WORKER_ATTRIBUTES: &[(&str, &str, &[&str])] = &[
    ("Departamento", "category", &[]),
    ("Puesto", "category", &[]),
    ("Turnos", "tag", &[]),
];

/// The creation-time template locale a caller may request. It affects only the new
/// Worksite's editable default labels; it is not stored on the Worksite.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WorksiteTemplateLocale {
    En,
    Es419,
}

impl WorksiteTemplateLocale {
    /// The one accepted wire value for each template.
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "en" => Some(Self::En),
            "es-419" => Some(Self::Es419),
            _ => None,
        }
    }

    pub(crate) fn default_name(self) -> &'static str {
        match self {
            Self::En => DEFAULT_WORKSITE_NAME,
            Self::Es419 => DEFAULT_SPANISH_WORKSITE_NAME,
        }
    }

    fn default_worker_attributes(
        self,
    ) -> &'static [(&'static str, &'static str, &'static [&'static str])] {
        match self {
            Self::En => DEFAULT_WORKER_ATTRIBUTES,
            Self::Es419 => DEFAULT_SPANISH_WORKER_ATTRIBUTES,
        }
    }
}

/// A Worksite as the handlers surface it. Serializes as the TS shape
/// (`{id, name, committeeGoal, committeeTarget}`) so route bodies match byte-for-byte.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
pub struct Worksite {
    pub id: String,
    pub name: String,
    #[cfg_attr(feature = "ts", ts(type = "number"))]
    pub committee_goal: i64,
    /// The old wire name for `committee_goal`. It always equals the goal and is answered beside
    /// it until the contract step removes it; build a Worksite through `Worksite::new`.
    #[cfg_attr(feature = "ts", ts(type = "number"))]
    pub committee_target: i64,
}

impl Worksite {
    pub fn new(id: String, name: String, committee_goal: i64) -> Self {
        Self {
            id,
            name,
            committee_goal,
            committee_target: committee_goal,
        }
    }
}

const DDL: &str = r#"
CREATE TABLE worksites (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  committee_target INTEGER NOT NULL DEFAULT 5,
  committee_goal INTEGER NOT NULL DEFAULT 5
);
CREATE TABLE workers (
  id TEXT PRIMARY KEY NOT NULL,
  worksite_id TEXT NOT NULL REFERENCES worksites(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  phone TEXT NOT NULL,
  assessment TEXT NOT NULL,
  notes TEXT NOT NULL CHECK (json_valid(notes))
);
CREATE INDEX IF NOT EXISTS idx_workers_worksite_id ON workers(worksite_id);
CREATE TABLE worker_relationships (
  worker_a_id TEXT NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
  worker_b_id TEXT NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
  CHECK (worker_a_id <> worker_b_id),
  PRIMARY KEY (worker_a_id, worker_b_id)
);
CREATE INDEX IF NOT EXISTS idx_worker_relationships_worker_b_id ON worker_relationships(worker_b_id, worker_a_id);
CREATE TABLE worker_attributes (
  id TEXT PRIMARY KEY NOT NULL,
  worksite_id TEXT NOT NULL REFERENCES worksites(id) ON DELETE CASCADE,
  name TEXT NOT NULL COLLATE NOCASE,
  kind TEXT NOT NULL CHECK (kind IN ('category', 'tag')),
  options TEXT NOT NULL CHECK (json_valid(options)),
  position INTEGER NOT NULL,
  UNIQUE (worksite_id, name)
);
CREATE TABLE worker_attribute_values (
  worker_id TEXT NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
  attribute_id TEXT NOT NULL REFERENCES worker_attributes(id) ON DELETE CASCADE,
  value TEXT NOT NULL CHECK (json_valid(value)),
  PRIMARY KEY (worker_id, attribute_id)
);
CREATE TABLE agitations (
  id TEXT PRIMARY KEY NOT NULL,
  worksite_id TEXT NOT NULL REFERENCES worksites(id) ON DELETE CASCADE,
  text TEXT NOT NULL COLLATE NOCASE,
  UNIQUE (worksite_id, text)
);
CREATE TABLE worker_agitations (
  worker_id TEXT NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
  agitation_id TEXT NOT NULL REFERENCES agitations(id) ON DELETE CASCADE,
  PRIMARY KEY (worker_id, agitation_id)
);
CREATE TABLE languages (
  id TEXT PRIMARY KEY NOT NULL,
  worksite_id TEXT NOT NULL REFERENCES worksites(id) ON DELETE CASCADE,
  name TEXT NOT NULL COLLATE NOCASE,
  UNIQUE (worksite_id, name)
);
CREATE TABLE worker_languages (
  worker_id TEXT NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
  language_id TEXT NOT NULL REFERENCES languages(id) ON DELETE CASCADE,
  PRIMARY KEY (worker_id, language_id)
);
CREATE TABLE schema_migrations (
  version INTEGER PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TRIGGER worker_relationships_same_worksite
BEFORE INSERT ON worker_relationships
WHEN (SELECT worksite_id FROM workers WHERE id = NEW.worker_a_id)
  <> (SELECT worksite_id FROM workers WHERE id = NEW.worker_b_id)
BEGIN
  SELECT RAISE(ABORT, 'Relationships must connect workers in the same worksite.');
END;
"#;

/// The v17 settings table: one typed key/value row per setting (the registry in
/// `app_settings.rs` owns the types, allowed values and defaults). Kept apart from the
/// main DDL so a fresh bootstrap and the v16 to v17 migration create the same table.
const APP_SETTINGS_DDL: &str = r#"
CREATE TABLE app_settings (
  key TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL
);
"#;

/// The v15-era single-row settings table. Tests use it to build databases that predate
/// the registry, so changing the registry never changes what an old database looks like.
#[cfg(test)]
const LEGACY_APP_SETTINGS_DDL: &str = r#"
CREATE TABLE app_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  theme TEXT NOT NULL CHECK (theme IN ('system', 'light', 'dark')),
  density TEXT NOT NULL CHECK (density IN ('compact', 'standard', 'comfortable'))
);
INSERT INTO app_settings (id, theme, density) VALUES (1, 'system', 'standard');
"#;

/// The v13 addition: one Worker draft per (Worksite, worker id), where the sentinel
/// worker id 'new' holds the not-yet-created Worker's draft (ADR-0023). Kept apart from
/// the main DDL so a fresh bootstrap and the v12 to v13 migration create the same table.
const DRAFT_DDL: &str = r#"
CREATE TABLE worker_drafts (
  worksite_id TEXT NOT NULL REFERENCES worksites(id) ON DELETE CASCADE,
  worker_id TEXT NOT NULL,
  payload TEXT NOT NULL CHECK (json_valid(payload)),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (worksite_id, worker_id)
);
CREATE TRIGGER worker_drafts_cascade_worker
AFTER DELETE ON workers
BEGIN
  DELETE FROM worker_drafts WHERE worker_id = OLD.id;
END;
"#;

/// The v24 addition: a Worksite's named, versioned saved views. The name is unique per
/// Worksite regardless of case; the snapshot is validated JSON that the core decodes strictly
/// on every read. Kept apart from the main DDL so a fresh bootstrap and the v23 to v24
/// migration create the same table.
const SAVED_VIEW_DDL: &str = r#"
CREATE TABLE saved_views (
  id TEXT PRIMARY KEY NOT NULL,
  worksite_id TEXT NOT NULL REFERENCES worksites(id) ON DELETE CASCADE,
  name TEXT NOT NULL COLLATE NOCASE,
  kind TEXT NOT NULL CHECK (kind IN ('workers', 'mapping')),
  snapshot TEXT NOT NULL CHECK (json_valid(snapshot)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (worksite_id, name)
);
"#;

/// The historical v19 addition: each saved Work Assignment belongs to one Worker, holds its
/// configured position in that Worker's list, and keeps at most one answer per
/// assignment-scoped Attribute. Only the v18 to v19 migration and the v21/v22 historical
/// steps use it; the current schema has no assignment tables.
const WORK_ASSIGNMENT_DDL: &str = r#"
CREATE TABLE work_assignments (
  id TEXT PRIMARY KEY NOT NULL,
  worker_id TEXT NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
  position INTEGER NOT NULL CHECK (position >= 0)
);
CREATE INDEX idx_work_assignments_worker_id ON work_assignments(worker_id, position);
CREATE TABLE work_assignment_answers (
  assignment_id TEXT NOT NULL REFERENCES work_assignments(id) ON DELETE CASCADE,
  attribute_id TEXT NOT NULL REFERENCES worker_attributes(id) ON DELETE CASCADE,
  answer_id TEXT NOT NULL,
  PRIMARY KEY (assignment_id, attribute_id)
);
"#;

/// The historical v20 addition: one recoverable draft per (Worksite, Worker, assignment
/// identity), where the identity is a saved assignment's id or the stable creation id of one
/// not yet saved. The payload holds the editor's answers and the saved base it was opened on.
/// Only the v19 to v20 migration and the v21/v22 historical steps use it.
const WORK_ASSIGNMENT_DRAFT_DDL: &str = r#"
CREATE TABLE work_assignment_drafts (
  worksite_id TEXT NOT NULL REFERENCES worksites(id) ON DELETE CASCADE,
  worker_id TEXT NOT NULL,
  assignment_id TEXT NOT NULL,
  payload TEXT NOT NULL CHECK (json_valid(payload)),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (worksite_id, worker_id, assignment_id)
);
CREATE TRIGGER work_assignment_drafts_cascade_worker
AFTER DELETE ON workers
BEGIN
  DELETE FROM work_assignment_drafts WHERE worker_id = OLD.id;
END;
CREATE TRIGGER work_assignment_drafts_cascade_assignment
AFTER DELETE ON work_assignments
BEGIN
  DELETE FROM work_assignment_drafts WHERE assignment_id = OLD.id;
END;
"#;

const LOOKUP_INDEX_DDL: &str = "CREATE INDEX IF NOT EXISTS idx_workers_worksite_id ON workers(worksite_id);\nCREATE INDEX IF NOT EXISTS idx_worker_relationships_worker_b_id ON worker_relationships(worker_b_id, worker_a_id);";

fn has_table(conn: &Connection, name: &str) -> bool {
    conn.query_row(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1",
        params![name],
        |_| Ok(()),
    )
    .is_ok()
}

pub(crate) fn read_schema_version(conn: &Connection) -> Result<Option<i64>> {
    if !has_table(conn, "schema_migrations") {
        return Ok(None);
    }
    let version = conn.query_row("SELECT MAX(version) FROM schema_migrations", [], |row| {
        row.get(0)
    })?;
    Ok(version)
}

fn record_migration(conn: &Connection, version: i64, name: &str) -> Result<()> {
    conn.execute(
        "INSERT INTO schema_migrations (version, name) VALUES (?1, ?2)",
        params![version, name],
    )?;
    Ok(())
}

fn bootstrap(conn: &Connection) -> Result<()> {
    conn.execute_batch(DDL)?;
    conn.execute_batch(APP_SETTINGS_DDL)?;
    conn.execute_batch(DRAFT_DDL)?;
    conn.execute_batch(SAVED_VIEW_DDL)?;
    crate::app_settings::seed_default_settings(conn)?;
    record_migration(conn, CURRENT_SCHEMA_VERSION, "current-schema-bootstrap")?;
    Ok(())
}

/// The historical v18 step: adds the scope and inference metadata columns. The v21 step
/// consumes them and the v22 step removes them again from the final schema.
fn upgrade_attribute_contract(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "ALTER TABLE worker_attributes ADD COLUMN scope TEXT NOT NULL DEFAULT 'worker' CHECK (scope IN ('worker', 'workAssignment'));
         ALTER TABLE worker_attributes ADD COLUMN inference_eligible INTEGER NOT NULL DEFAULT 1 CHECK (inference_eligible IN (0, 1));",
    )?;
    Ok(())
}

/// Whether the existing app_settings table is already the v17 key/value registry. A v16
/// database written by an earlier commit of the registry branch has the new shape but not
/// the version row, so the shape decides, not the version.
fn app_settings_is_registry(conn: &Connection) -> Result<bool> {
    let mut statement = conn.prepare("PRAGMA table_info(app_settings)")?;
    let columns = statement.query_map([], |row| row.get::<_, String>(1))?;
    for column in columns {
        if column? == "key" {
            return Ok(true);
        }
    }
    Ok(false)
}

/// Replaces the v16 single-row settings table with the v17 key/value registry, carrying
/// the stored Theme and Density values across. An earlier registry-branch commit could
/// leave the table already converted under version 16, so that shape is kept as it is and
/// only the version is recorded. Runs inside the caller's transaction.
fn upgrade_app_settings(conn: &Connection) -> Result<()> {
    if app_settings_is_registry(conn)? {
        return Ok(());
    }

    let (theme, density): (String, String) = conn.query_row(
        "SELECT theme, density FROM app_settings WHERE id = 1",
        [],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )?;

    conn.execute_batch("DROP TABLE app_settings;")?;
    conn.execute_batch(APP_SETTINGS_DDL)?;
    for (key, value) in [("theme", theme), ("density", density)] {
        conn.execute(
            "INSERT INTO app_settings (key, value) VALUES (?1, ?2)",
            params![key, value],
        )?;
    }
    Ok(())
}

/// Gives every stored Attribute answer an id and rewrites each Worker answer from its text to
/// that id. Runs inside the caller's transaction. Answers are ids from here on, so every
/// stored text must match one answer of its Attribute or the upgrade stops.
fn upgrade_answers_to_ids(conn: &Connection) -> Result<()> {
    let attributes: Vec<(String, String)> = {
        let mut statement = conn.prepare("SELECT id, options FROM worker_attributes")?;
        let rows = statement.query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?;
        rows.collect::<rusqlite::Result<Vec<_>>>()?
    };

    let mut answers_by_attribute: HashMap<String, Vec<StoredAnswer>> = HashMap::new();
    for (attribute_id, options) in attributes {
        let texts: Vec<String> = serde_json::from_str::<Vec<String>>(&options).map_err(|_| {
            Error::Message(format!(
                "Invalid options JSON for worker attribute {attribute_id}."
            ))
        })?;
        let answers: Vec<StoredAnswer> = texts
            .into_iter()
            .map(|value| StoredAnswer {
                id: random_id(),
                value,
                parent_id: None,
                mode: None,
                short_form: None,
                short_form_origin: None,
                merged_into: None,
            })
            .collect();
        conn.execute(
            "UPDATE worker_attributes SET options = ?1 WHERE id = ?2",
            params![answers_to_json(&answers).to_string(), attribute_id],
        )?;
        answers_by_attribute.insert(attribute_id, answers);
    }

    let values: Vec<(String, String, String)> = {
        let mut statement =
            conn.prepare("SELECT worker_id, attribute_id, value FROM worker_attribute_values")?;
        let rows = statement.query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))?;
        rows.collect::<rusqlite::Result<Vec<_>>>()?
    };
    for (worker_id, attribute_id, raw) in values {
        let answers = answers_by_attribute
            .get(&attribute_id)
            .map_or(&[][..], Vec::as_slice);
        let value: Value = serde_json::from_str(&raw)?;
        let mapped = map_answer_value(&value, &ids_by_text(answers)).ok_or_else(|| {
            Error::Message(format!(
                "Invalid value stored for worker {worker_id}, attribute {attribute_id}."
            ))
        })?;
        conn.execute(
            "UPDATE worker_attribute_values SET value = ?1 WHERE worker_id = ?2 AND attribute_id = ?3",
            params![mapped.to_string(), worker_id, attribute_id],
        )?;
    }

    Ok(())
}

/// Rewrites every stored clean phone number into `(AAA) EEE-NNNN`, leaving every other
/// value exactly as it was. Only rows whose value changes are written. Runs inside the
/// caller's transaction, so a failure leaves the phones and the version row untouched.
fn reformat_stored_phones(conn: &Connection) -> Result<()> {
    let workers: Vec<(String, String)> = {
        let mut statement = conn.prepare("SELECT id, phone FROM workers")?;
        let rows = statement.query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?;
        rows.collect::<rusqlite::Result<Vec<_>>>()?
    };
    for (worker_id, phone) in workers {
        if let Some(formatted) = normalize_phone(&phone) {
            if formatted != phone {
                conn.execute(
                    "UPDATE workers SET phone = ?1 WHERE id = ?2",
                    params![formatted, worker_id],
                )?;
            }
        }
    }
    Ok(())
}

/// Gives every stored answer of every Attribute a generated Short form (ADR 0046). An answer
/// that already carries one keeps it, so the step is safe to run over a partly upgraded
/// file. Runs inside the caller's transaction.
fn backfill_short_forms(conn: &Connection) -> Result<()> {
    let attributes: Vec<(String, String)> = {
        let mut statement = conn.prepare("SELECT id, options FROM worker_attributes")?;
        let rows = statement.query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?;
        rows.collect::<rusqlite::Result<Vec<_>>>()?
    };
    for (attribute_id, options) in attributes {
        let invalid = || {
            Error::Message(format!(
                "Invalid options JSON for worker attribute {attribute_id}."
            ))
        };
        let parsed: Value = serde_json::from_str(&options).map_err(|_| invalid())?;
        let mut answers = answers_from_json(&parsed).ok_or_else(invalid)?;
        for answer in &mut answers {
            let (form, origin) = crate::short_form::resolve(
                "en",
                &answer.value,
                answer.short_form.as_deref(),
                answer.short_form_origin.as_deref(),
                &[],
                &[],
            );
            answer.short_form = Some(form);
            answer.short_form_origin = Some(origin);
        }
        conn.execute(
            "UPDATE worker_attributes SET options = ?1 WHERE id = ?2",
            params![answers_to_json(&answers).to_string(), attribute_id],
        )?;
    }
    Ok(())
}

/// The v25 step: adds `committee_goal` beside `committee_target`, copies every value across, and
/// fails (rolling the whole upgrade back) if any row still disagrees afterwards. A file that
/// already has the column keeps its values when they agree and is refused when they do not.
fn add_committee_goal(conn: &Connection) -> Result<()> {
    let has_goal_column = conn
        .prepare("SELECT 1 FROM pragma_table_info('worksites') WHERE name = 'committee_goal'")?
        .exists([])?;
    if !has_goal_column {
        conn.execute_batch(
            "ALTER TABLE worksites ADD COLUMN committee_goal INTEGER NOT NULL DEFAULT 5;
             UPDATE worksites SET committee_goal = committee_target;",
        )?;
    }
    let disagreeing: i64 = conn.query_row(
        "SELECT COUNT(*) FROM worksites WHERE committee_goal IS NOT committee_target",
        [],
        |row| row.get(0),
    )?;
    if disagreeing > 0 {
        return Err(Error::Message(format!(
            "The committee goal and committee target disagree on {disagreeing} Worksite(s); the upgrade was not applied."
        )));
    }
    Ok(())
}

/// Bootstraps an empty database, keeps an already-current one, upgrades any version listed in
/// `UPGRADABLE_SCHEMA_VERSIONS` to `CURRENT_SCHEMA_VERSION` in one transaction, and refuses the
/// rest. Each step runs only for the versions that still need
/// it, so a v16 database does not redo the v15 to v16 phone step.
pub fn apply_migrations(conn: &Connection) -> Result<()> {
    let version = read_schema_version(conn)?;
    if version == Some(CURRENT_SCHEMA_VERSION) {
        return Ok(());
    }

    if let Some(version) = version.filter(|version| is_upgradable_source(*version)) {
        let tx = conn.unchecked_transaction()?;
        // v12 to v13: the Worker drafts table, and nothing else about v12 changes.
        if version == 12 {
            tx.execute_batch(DRAFT_DDL)?;
            record_migration(&tx, 13, "worker-drafts")?;
        }
        if version == 12 || version == 13 {
            upgrade_answers_to_ids(&tx)?;
            record_migration(&tx, 14, "answer-ids")?;
        }
        if version <= 14 {
            tx.execute_batch(LOOKUP_INDEX_DDL)?;
            record_migration(&tx, 15, "lookup-indexes")?;
        }
        if version <= 15 {
            reformat_stored_phones(&tx)?;
            record_migration(&tx, 16, "phone-format")?;
        }
        if version <= 16 {
            upgrade_app_settings(&tx)?;
            record_migration(&tx, 17, "app-settings-registry")?;
        }
        if version <= 17 {
            upgrade_attribute_contract(&tx)?;
            record_migration(&tx, 18, "workplace-attribute-contract")?;
        }
        if version <= 18 {
            tx.execute_batch(WORK_ASSIGNMENT_DDL)?;
            record_migration(&tx, 19, "work-assignments")?;
        }
        // v20 is now an upgradable source, so its DDL must not run twice.
        if version <= 19 {
            tx.execute_batch(WORK_ASSIGNMENT_DRAFT_DDL)?;
            record_migration(&tx, 20, "work-assignment-drafts")?;
        }
        // v21 is data-only: the bounded legacy conversion and its draft fan-out, in this same
        // transaction as every earlier step.
        if version <= 20 {
            crate::work_assignment_migration::convert_legacy_work_assignments(&tx)?;
            record_migration(&tx, 21, "legacy-work-assignments")?;
        }
        // v22 is data and schema: flatten every committed assignment answer into ordinary
        // Worker values, then remove the assignment tables and obsolete scope columns.
        if version <= 21 {
            crate::work_assignment_flattening::flatten_work_assignments(&tx)?;
            record_migration(&tx, 22, "flatten-work-assignments")?;
        }
        // v23 is data-only: the stored answers gain a generated Short form and its origin.
        if version <= 22 {
            backfill_short_forms(&tx)?;
            record_migration(&tx, 23, "short-forms")?;
        }
        // v24 is schema-only: the saved views table, with no rows to convert.
        if version <= 23 {
            tx.execute_batch(SAVED_VIEW_DDL)?;
            record_migration(&tx, 24, "saved-views")?;
        }
        // v25 expands the committee target: the goal column sits beside it with the same
        // values. The old column is dropped in the contract step.
        if version <= 24 {
            add_committee_goal(&tx)?;
            record_migration(&tx, 25, "committee-goal")?;
        }
        tx.commit()?;
        return Ok(());
    }

    let worker_tables_exist = has_table(conn, "workers")
        || has_table(conn, "worker_relationships")
        || has_table(conn, "worker_attributes");
    if worker_tables_exist || version.is_some() {
        let version_text = version
            .map(|v| v.to_string())
            .unwrap_or_else(|| "unknown".to_owned());
        return Err(Error::UnsupportedSchema(format!(
            "Worker database schema version {version_text} is unsupported. This app supports schema version {CURRENT_SCHEMA_VERSION} and upgrades version 12, version 13, version 14, version 15, version 16, version 17, version 18, version 19, version 20, version 21, version 22, version 23 and version 24 databases; migrate older versions before starting the app."
        )));
    }

    bootstrap(conn)
}

/// Inserts a Worksite with the default committee goal and returns it.
pub fn insert_worksite(
    conn: &Connection,
    name: &str,
    id_source: &impl IdSource,
) -> Result<Worksite> {
    let worksite = Worksite::new(id_source.next_id(), name.to_owned(), DEFAULT_COMMITTEE_GOAL);
    conn.execute(
        "INSERT INTO worksites (id, name, committee_target, committee_goal) VALUES (?1, ?2, ?3, ?3)",
        params![worksite.id, worksite.name, worksite.committee_goal],
    )?;
    Ok(worksite)
}

/// Seeds the three stock Worker-scoped attributes for an English Worksite. This is the
/// fixture seeding `db::open_seeded` keeps for tests; new Worksites use
/// `seed_default_worker_attributes_for`.
pub fn seed_default_worker_attributes(
    conn: &Connection,
    worksite_id: &str,
    id_source: &impl IdSource,
) -> Result<()> {
    seed_default_worker_attributes_for(conn, worksite_id, id_source, WorksiteTemplateLocale::En)
}

/// Seeds the starter questions a new Worksite gets: the creation template's localized labels
/// and the original template cardinalities (Department and Role Single-Select, Shifts
/// Multi-Select). The v21 assignment scope has left the current product, so a fresh Worksite
/// keeps no scope metadata; the v22 cardinality inference applies only to upgraded Attributes.
pub fn seed_default_worker_attributes_for(
    conn: &Connection,
    worksite_id: &str,
    id_source: &impl IdSource,
    locale: WorksiteTemplateLocale,
) -> Result<()> {
    for (position, attribute) in locale.default_worker_attributes().iter().enumerate() {
        conn.execute(
            "INSERT INTO worker_attributes (id, worksite_id, name, kind, options, position) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                id_source.next_id(),
                worksite_id,
                attribute.0,
                attribute.1,
                serde_json::to_string(attribute.2)?,
                position as i64,
            ],
        )?;
    }
    // Stock attributes ship with no options, so there is nothing to resolve: record the
    // bundled lists revision now and a first save takes the steady-state path.
    crate::short_form_revision::mark_lists_current(conn, worksite_id)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::worker_persistence::insert_bare_worker;

    use serde_json::json;

    use crate::assembly::read_workers;
    use crate::attribute_persistence::get_worker_attributes;

    const WORKSITE_ID: &str = "ws-1";

    /// A populated database at `version`, written with the answer text the pre-14 schema
    /// stored: two workers, a category `dept` and a tag `shifts`.
    fn seed_populated(conn: &Connection, version: i64, department_value: &str) {
        let legacy_ddl = DDL
            .replace("CREATE INDEX IF NOT EXISTS idx_workers_worksite_id ON workers(worksite_id);\n", "")
            .replace("CREATE INDEX IF NOT EXISTS idx_worker_relationships_worker_b_id ON worker_relationships(worker_b_id, worker_a_id);\n", "");
        conn.execute_batch(&legacy_ddl).unwrap();
        conn.execute_batch(LEGACY_APP_SETTINGS_DDL).unwrap();
        if version == 13 {
            conn.execute_batch(DRAFT_DDL).unwrap();
        }
        record_migration(conn, version, "seeded").unwrap();
        conn.execute(
            "INSERT INTO worksites (id, name, committee_target) VALUES (?1, 'Kitchen', 5)",
            [WORKSITE_ID],
        )
        .unwrap();
        for (id, name) in [("w1", "Ana"), ("w2", "Ben")] {
            insert_bare_worker(conn, WORKSITE_ID, id, name, "a@example.com");
        }
        conn.execute(
            "INSERT INTO worker_attributes (id, worksite_id, name, kind, options, position) \
             VALUES ('dept', ?1, 'Department', 'category', '[\"Front of House\",\"Back of House\"]', 0)",
            [WORKSITE_ID],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO worker_attributes (id, worksite_id, name, kind, options, position) \
             VALUES ('shifts', ?1, 'Shifts', 'tag', '[\"Early\",\"Late\"]', 1)",
            [WORKSITE_ID],
        )
        .unwrap();
        for (worker_id, attribute_id, value) in [
            ("w1", "dept", department_value),
            ("w1", "shifts", "[\"Early\",\"Late\"]"),
            ("w2", "dept", "\"\""),
            ("w2", "shifts", "[]"),
        ] {
            conn.execute(
                "INSERT INTO worker_attribute_values (worker_id, attribute_id, value) VALUES (?1, ?2, ?3)",
                params![worker_id, attribute_id, value],
            )
            .unwrap();
        }
    }

    fn stored_options(conn: &Connection, attribute_id: &str) -> String {
        conn.query_row(
            "SELECT options FROM worker_attributes WHERE id = ?1",
            [attribute_id],
            |row| row.get(0),
        )
        .unwrap()
    }

    fn worksite() -> Option<Worksite> {
        Some(Worksite {
            id: WORKSITE_ID.to_owned(),
            name: "Kitchen".to_owned(),
            committee_goal: 5,
            committee_target: 5,
        })
    }

    fn assert_index_columns(conn: &Connection, index: &str, expected: &[&str]) {
        let columns: Vec<String> = conn
            .prepare(&format!("PRAGMA index_info('{index}')"))
            .unwrap()
            .query_map([], |row| row.get(2))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap();
        assert_eq!(columns, expected, "{index} columns and order");
    }

    fn answer_id(options: &str, text: &str) -> String {
        let answers: Vec<StoredAnswer> = serde_json::from_str(options).unwrap();
        answers
            .into_iter()
            .find(|answer| answer.value == text)
            .unwrap_or_else(|| panic!("{text} is configured"))
            .id
    }

    fn assert_no_assignment_schema(conn: &Connection) {
        for table in [
            "work_assignments",
            "work_assignment_answers",
            "work_assignment_drafts",
        ] {
            assert!(!has_table(conn, table), "{table} is gone");
        }
        let columns: Vec<String> = conn
            .prepare("PRAGMA table_info(worker_attributes)")
            .unwrap()
            .query_map([], |row| row.get(1))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap();
        assert!(!columns.contains(&"scope".to_owned()));
        assert!(!columns.contains(&"inference_eligible".to_owned()));
    }

    /// The bounded legacy questions' answers survived as ordinary Worker values, with the
    /// cardinality judged from the committed answers, and every Worker has a row per
    /// converted Attribute.
    fn assert_upgraded_with_answers_intact(conn: &Connection) {
        assert_eq!(
            read_schema_version(conn).unwrap(),
            Some(CURRENT_SCHEMA_VERSION)
        );

        let definitions = get_worker_attributes(conn, &worksite()).unwrap();
        let kinds: Vec<(&str, &str)> = definitions
            .iter()
            .map(|attribute| (attribute.name.as_str(), attribute.kind.as_str()))
            .collect();
        assert_eq!(
            kinds,
            [("Department", "category"), ("Shifts", "tag")],
            "single committed answers stay Single-Select; several become Multi-Select"
        );

        let department = answer_id(&stored_options(conn, "dept"), "Back of House");
        let early = answer_id(&stored_options(conn, "shifts"), "Early");
        let late = answer_id(&stored_options(conn, "shifts"), "Late");
        let workers = read_workers(conn, &worksite()).unwrap();
        assert_eq!(
            workers[0].attributes,
            json!({ "dept": department, "shifts": [early.clone(), late.clone()] })
        );
        assert_eq!(
            workers[1].attributes,
            json!({ "dept": "", "shifts": [] }),
            "every Worker gets a row for every converted Attribute"
        );

        let values: i64 = conn
            .query_row("SELECT COUNT(*) FROM worker_attribute_values", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(values, 4);
        assert_no_assignment_schema(conn);
    }

    #[test]
    fn upgrades_a_populated_v13_database_and_keeps_every_answer() {
        let conn = Connection::open_in_memory().unwrap();
        seed_populated(&conn, 13, "\"Back of House\"");

        apply_migrations(&conn).unwrap();

        assert_upgraded_with_answers_intact(&conn);
    }

    #[test]
    fn upgrades_a_populated_v12_database_through_every_retained_step_to_v25() {
        let conn = Connection::open_in_memory().unwrap();
        seed_populated(&conn, 12, "\"Back of House\"");

        apply_migrations(&conn).unwrap();

        assert_upgraded_with_answers_intact(&conn);
        let drafts: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'worker_drafts'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(drafts, 1);
        let migrations: Vec<i64> = conn
            .prepare("SELECT version FROM schema_migrations ORDER BY version")
            .unwrap()
            .query_map([], |row| row.get(0))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap();
        assert_eq!(
            migrations,
            [12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25],
            "a v12 source runs every step once"
        );
    }

    #[test]
    fn upgrades_a_populated_v14_database_adding_the_indexes_and_preserving_its_data() {
        let conn = Connection::open_in_memory().unwrap();
        // Version 14 already has drafts and answer ids, but predates the lookup indexes.
        let v14_ddl = DDL
            .replace("CREATE INDEX IF NOT EXISTS idx_workers_worksite_id ON workers(worksite_id);\n", "")
            .replace("CREATE INDEX IF NOT EXISTS idx_worker_relationships_worker_b_id ON worker_relationships(worker_b_id, worker_a_id);\n", "");
        conn.execute_batch(&v14_ddl).unwrap();
        conn.execute_batch(LEGACY_APP_SETTINGS_DDL).unwrap();
        conn.execute_batch(DRAFT_DDL).unwrap();
        record_migration(&conn, 14, "seeded-v14").unwrap();
        conn.execute(
            "INSERT INTO worksites (id, name, committee_target) VALUES (?1, 'Kitchen', 5)",
            [WORKSITE_ID],
        )
        .unwrap();
        for (id, name) in [("w1", "Ana"), ("w2", "Ben")] {
            insert_bare_worker(&conn, WORKSITE_ID, id, name, "a@example.com");
        }
        conn.execute(
            "INSERT INTO worker_relationships (worker_a_id, worker_b_id) VALUES ('w1', 'w2')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO worker_attributes (id, worksite_id, name, kind, options, position) \
             VALUES ('dept', ?1, 'Department', 'category', \
             '[{\"id\":\"dept-front\",\"value\":\"Front\",\"mergedInto\":null}]', 0)",
            [WORKSITE_ID],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO worker_attributes (id, worksite_id, name, kind, options, position) \
             VALUES ('shifts', ?1, 'Shifts', 'tag', \
             '[{\"id\":\"shift-early\",\"value\":\"Early\",\"mergedInto\":null}]', 1)",
            [WORKSITE_ID],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO worker_attribute_values (worker_id, attribute_id, value) \
             VALUES ('w1', 'dept', '\"dept-front\"')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO worker_attribute_values (worker_id, attribute_id, value) \
             VALUES ('w1', 'shifts', '[\"shift-early\"]')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO agitations (id, worksite_id, text) VALUES ('ag-1', ?1, 'Unpaid overtime')",
            [WORKSITE_ID],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO worker_agitations (worker_id, agitation_id) VALUES ('w1', 'ag-1')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO languages (id, worksite_id, name) VALUES ('lang-1', ?1, 'Polish')",
            [WORKSITE_ID],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO worker_languages (worker_id, language_id) VALUES ('w2', 'lang-1')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO worker_drafts (worksite_id, worker_id, payload, updated_at) \
             VALUES (?1, 'new', '{}', '2026-01-01T00:00:00Z')",
            [WORKSITE_ID],
        )
        .unwrap();

        apply_migrations(&conn).unwrap();

        assert_eq!(
            read_schema_version(&conn).unwrap(),
            Some(CURRENT_SCHEMA_VERSION)
        );
        let workers = read_workers(&conn, &worksite()).unwrap();
        assert_eq!(
            workers[0].attributes,
            json!({ "dept": "dept-front", "shifts": "shift-early" }),
            "single answers keep their values and ids"
        );
        assert_eq!(
            workers[1].attributes,
            json!({ "dept": "", "shifts": "" }),
            "the other Worker gets the empty values"
        );
        let migrations: Vec<i64> = conn
            .prepare("SELECT version FROM schema_migrations ORDER BY version")
            .unwrap()
            .query_map([], |row| row.get(0))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap();
        assert_eq!(migrations, [14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25]);
        let settings: Vec<(String, String)> = conn
            .prepare("SELECT key, value FROM app_settings ORDER BY rowid")
            .unwrap()
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap();
        assert_eq!(
            settings,
            [
                ("theme".to_owned(), "system".to_owned()),
                ("density".to_owned(), "standard".to_owned())
            ],
            "the v14 settings row moves onto the registry"
        );
        for index in [
            "idx_workers_worksite_id",
            "idx_worker_relationships_worker_b_id",
        ] {
            let found: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_master WHERE type = 'index' AND name = ?1",
                    [index],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(found, 1, "{index} exists after upgrading v14");
        }
        assert_index_columns(&conn, "idx_workers_worksite_id", &["worksite_id"]);
        assert_index_columns(
            &conn,
            "idx_worker_relationships_worker_b_id",
            &["worker_b_id", "worker_a_id"],
        );
        let relationship: (String, String) = conn
            .query_row(
                "SELECT worker_a_id, worker_b_id FROM worker_relationships",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(relationship, ("w1".to_owned(), "w2".to_owned()));
        let agitations: Vec<String> = conn
            .prepare("SELECT text FROM agitations")
            .unwrap()
            .query_map([], |row| row.get(0))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap();
        assert_eq!(agitations, ["Unpaid overtime"]);
        let languages: Vec<String> = conn
            .prepare("SELECT name FROM languages")
            .unwrap()
            .query_map([], |row| row.get(0))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap();
        assert_eq!(languages, ["Polish"]);
        let draft: String = conn
            .query_row(
                "SELECT payload FROM worker_drafts WHERE worksite_id = ?1 AND worker_id = 'new'",
                [WORKSITE_ID],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(draft, "{}", "a malformed draft stays byte-identical");
        assert_no_assignment_schema(&conn);
    }

    #[test]
    fn fresh_database_has_lookup_indexes() {
        let conn = Connection::open_in_memory().unwrap();

        apply_migrations(&conn).unwrap();

        for index in [
            "idx_workers_worksite_id",
            "idx_worker_relationships_worker_b_id",
        ] {
            let found: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_master WHERE type = 'index' AND name = ?1",
                    [index],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(found, 1, "{index} exists on a fresh database");
        }
        assert_index_columns(&conn, "idx_workers_worksite_id", &["worksite_id"]);
        assert_index_columns(
            &conn,
            "idx_worker_relationships_worker_b_id",
            &["worker_b_id", "worker_a_id"],
        );
    }

    #[test]
    fn lookup_queries_use_their_indexes() {
        let conn = Connection::open_in_memory().unwrap();
        apply_migrations(&conn).unwrap();

        let plan = |query: &str| -> Vec<String> {
            conn.prepare(query)
                .unwrap()
                .query_map(["ws-1"], |row| row.get(3))
                .unwrap()
                .collect::<rusqlite::Result<_>>()
                .unwrap()
        };
        let workers =
            plan("EXPLAIN QUERY PLAN SELECT id FROM workers WHERE worksite_id = ?1 ORDER BY rowid");
        assert!(
            workers.iter().any(|line| line.contains("SEARCH")
                && line.contains("idx_workers_worksite_id")
                && line.contains("worksite_id=?")),
            "{workers:?}"
        );
        let relationships = plan(
            "EXPLAIN QUERY PLAN SELECT worker_a_id FROM worker_relationships WHERE worker_b_id = ?1",
        );
        assert!(
            relationships.iter().any(|line| line.contains("SEARCH")
                && line.contains("idx_worker_relationships_worker_b_id")
                && line.contains("worker_b_id=?")),
            "{relationships:?}"
        );
    }

    #[test]
    fn a_failed_upgrade_rolls_back_the_definitions_and_the_answers_together() {
        let conn = Connection::open_in_memory().unwrap();
        seed_populated(&conn, 13, "\"Not an answer\"");

        assert!(apply_migrations(&conn).is_err());

        assert_eq!(read_schema_version(&conn).unwrap(), Some(13));
        assert_eq!(
            stored_options(&conn, "dept"),
            "[\"Front of House\",\"Back of House\"]"
        );
        for index in [
            "idx_workers_worksite_id",
            "idx_worker_relationships_worker_b_id",
        ] {
            let found: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_master WHERE type = 'index' AND name = ?1",
                    [index],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(found, 0, "{index} is rolled back with the failed upgrade");
        }
    }

    #[test]
    fn a_failed_v14_index_upgrade_rolls_back_the_first_index() {
        let conn = Connection::open_in_memory().unwrap();
        let v14_ddl = DDL
            .replace("CREATE INDEX IF NOT EXISTS idx_workers_worksite_id ON workers(worksite_id);\n", "")
            .replace("CREATE INDEX IF NOT EXISTS idx_worker_relationships_worker_b_id ON worker_relationships(worker_b_id, worker_a_id);\n", "");
        conn.execute_batch(&v14_ddl).unwrap();
        conn.execute_batch(LEGACY_APP_SETTINGS_DDL).unwrap();
        conn.execute_batch(DRAFT_DDL).unwrap();
        record_migration(&conn, 14, "seeded-v14").unwrap();
        conn.execute_batch("CREATE TABLE idx_worker_relationships_worker_b_id (id INTEGER);")
            .unwrap();

        assert!(apply_migrations(&conn).is_err());

        assert_eq!(read_schema_version(&conn).unwrap(), Some(14));
        let later_versions: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM schema_migrations WHERE version >= 15",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(later_versions, 0);
        let first_index: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'index' AND name = 'idx_workers_worksite_id'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(first_index, 0);
    }

    #[test]
    fn upgrades_a_v15_database_to_the_key_value_registry_and_keeps_its_values() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(DDL).unwrap();
        conn.execute_batch(LEGACY_APP_SETTINGS_DDL).unwrap();
        conn.execute_batch(DRAFT_DDL).unwrap();
        record_migration(&conn, 15, "seeded-v15").unwrap();
        conn.execute(
            "INSERT INTO worksites (id, name, committee_target) VALUES (?1, 'Kitchen', 5)",
            [WORKSITE_ID],
        )
        .unwrap();
        insert_bare_worker(&conn, WORKSITE_ID, "w1", "Ana", "a@example.com");
        conn.execute(
            "UPDATE app_settings SET theme = 'dark', density = 'compact' WHERE id = 1",
            [],
        )
        .unwrap();

        apply_migrations(&conn).unwrap();

        assert_eq!(read_schema_version(&conn).unwrap(), Some(25));
        let migrations: Vec<(i64, String)> = conn
            .prepare("SELECT version, name FROM schema_migrations ORDER BY version")
            .unwrap()
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap();
        assert_eq!(
            migrations,
            [
                (15, "seeded-v15".to_owned()),
                (16, "phone-format".to_owned()),
                (17, "app-settings-registry".to_owned()),
                (18, "workplace-attribute-contract".to_owned()),
                (19, "work-assignments".to_owned()),
                (20, "work-assignment-drafts".to_owned()),
                (21, "legacy-work-assignments".to_owned()),
                (22, "flatten-work-assignments".to_owned()),
                (23, "short-forms".to_owned()),
                (24, "saved-views".to_owned()),
                (25, "committee-goal".to_owned()),
            ]
        );

        let rows: Vec<(String, String)> = conn
            .prepare("SELECT key, value FROM app_settings ORDER BY rowid")
            .unwrap()
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap();
        assert_eq!(
            rows,
            [
                ("theme".to_owned(), "dark".to_owned()),
                ("density".to_owned(), "compact".to_owned())
            ],
            "the single row's values move onto the registry"
        );

        let settings = crate::app_settings::get_app_settings(&conn).unwrap();
        assert_eq!(settings.theme, "dark");
        assert_eq!(settings.density, "compact");
        assert_eq!(settings.reduce_motion, "system", "a new key defaults");

        let worker: String = conn
            .query_row("SELECT name FROM workers WHERE id = 'w1'", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(worker, "Ana", "the upgrade keeps the data");
        let worksite: String = conn
            .query_row(
                "SELECT name FROM worksites WHERE id = ?1",
                [WORKSITE_ID],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(worksite, "Kitchen");
    }

    #[test]
    fn a_v16_database_already_written_as_the_registry_keeps_its_rows() {
        // An earlier commit of this branch wrote the v17 table under version 16. Opening
        // that database must record 17 without running the single-row conversion.
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(DDL).unwrap();
        conn.execute_batch(APP_SETTINGS_DDL).unwrap();
        conn.execute_batch(DRAFT_DDL).unwrap();
        record_migration(&conn, 16, "seeded-v16").unwrap();
        conn.execute(
            "INSERT INTO app_settings (key, value) VALUES ('theme', 'dark')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO app_settings (key, value) VALUES ('rememberWindow', 'false')",
            [],
        )
        .unwrap();

        apply_migrations(&conn).unwrap();

        assert_eq!(read_schema_version(&conn).unwrap(), Some(25));
        let migrations: Vec<(i64, String)> = conn
            .prepare("SELECT version, name FROM schema_migrations ORDER BY version")
            .unwrap()
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap();
        assert_eq!(
            migrations,
            [
                (16, "seeded-v16".to_owned()),
                (17, "app-settings-registry".to_owned()),
                (18, "workplace-attribute-contract".to_owned()),
                (19, "work-assignments".to_owned()),
                (20, "work-assignment-drafts".to_owned()),
                (21, "legacy-work-assignments".to_owned()),
                (22, "flatten-work-assignments".to_owned()),
                (23, "short-forms".to_owned()),
                (24, "saved-views".to_owned()),
                (25, "committee-goal".to_owned()),
            ]
        );
        let rows: Vec<(String, String)> = conn
            .prepare("SELECT key, value FROM app_settings ORDER BY rowid")
            .unwrap()
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap();
        assert_eq!(
            rows,
            [
                ("theme".to_owned(), "dark".to_owned()),
                ("rememberWindow".to_owned(), "false".to_owned())
            ],
            "the registry rows are kept, not converted from a single row"
        );
    }

    #[test]
    fn refuses_a_version_it_does_not_upgrade_and_names_it() {
        let conn = Connection::open_in_memory().unwrap();
        seed_populated(&conn, 11, "\"Back of House\"");

        let error = apply_migrations(&conn).unwrap_err();

        let message = error.to_string();
        assert!(
            message.contains("schema version 11 is unsupported"),
            "{message}"
        );
        assert!(message.contains("schema version 25"), "{message}");
        assert!(
            message.contains(
                "version 12, version 13, version 14, version 15, version 16, version 17, version 18, version 19, version 20, version 21, version 22, version 23 and version 24"
            ),
            "{message}"
        );
    }

    #[test]
    fn upgrades_a_v18_database_and_keeps_its_data_without_the_assignment_schema() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(DDL).unwrap();
        upgrade_attribute_contract(&conn).unwrap();
        conn.execute_batch(APP_SETTINGS_DDL).unwrap();
        conn.execute_batch(DRAFT_DDL).unwrap();
        record_migration(&conn, 18, "seeded-v18").unwrap();
        conn.execute(
            "INSERT INTO worksites (id, name, committee_target) VALUES (?1, 'Kitchen', 5)",
            [WORKSITE_ID],
        )
        .unwrap();
        insert_bare_worker(&conn, WORKSITE_ID, "w1", "Ana", "a@example.com");
        conn.execute(
            "INSERT INTO worker_attributes                (id, worksite_id, name, kind, scope, inference_eligible, options, position)              VALUES ('location', ?1, 'Location', 'category', 'workAssignment', 0,                '[{\"id\":\"store-b\",\"value\":\"Store B\"}]', 0)",
            [WORKSITE_ID],
        )
        .unwrap();

        apply_migrations(&conn).unwrap();

        assert_eq!(read_schema_version(&conn).unwrap(), Some(25));
        assert_no_assignment_schema(&conn);
        let migrations: Vec<(i64, String)> = conn
            .prepare("SELECT version, name FROM schema_migrations ORDER BY version")
            .unwrap()
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap();
        assert_eq!(
            migrations,
            [
                (18, "seeded-v18".to_owned()),
                (19, "work-assignments".to_owned()),
                (20, "work-assignment-drafts".to_owned()),
                (21, "legacy-work-assignments".to_owned()),
                (22, "flatten-work-assignments".to_owned()),
                (23, "short-forms".to_owned()),
                (24, "saved-views".to_owned()),
                (25, "committee-goal".to_owned()),
            ]
        );
        let worker: String = conn
            .query_row("SELECT name FROM workers WHERE id = 'w1'", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(worker, "Ana", "the v18 data is kept");
        let location: String = conn
            .query_row(
                "SELECT kind FROM worker_attributes WHERE id = 'location'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(
            location, "category",
            "an unused former assignment Attribute is Single-Select"
        );
        let value: String = conn
            .query_row(
                "SELECT value FROM worker_attribute_values WHERE attribute_id = 'location'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(value, "\"\"");
    }

    #[test]
    fn upgrades_a_v19_database_flattening_its_assignment_and_keeping_its_data() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(DDL).unwrap();
        upgrade_attribute_contract(&conn).unwrap();
        conn.execute_batch(APP_SETTINGS_DDL).unwrap();
        conn.execute_batch(DRAFT_DDL).unwrap();
        conn.execute_batch(WORK_ASSIGNMENT_DDL).unwrap();
        record_migration(&conn, 19, "seeded-v19").unwrap();
        conn.execute(
            "INSERT INTO worksites (id, name, committee_target) VALUES (?1, 'Kitchen', 5)",
            [WORKSITE_ID],
        )
        .unwrap();
        insert_bare_worker(&conn, WORKSITE_ID, "w1", "Ana", "a@example.com");
        conn.execute(
            "INSERT INTO worker_attributes (id, worksite_id, name, kind, scope, inference_eligible, options, position)              VALUES ('location', ?1, 'Location', 'category', 'workAssignment', 0,              '[{\"id\":\"store-b\",\"value\":\"Store B\"}]', 0)",
            [WORKSITE_ID],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO work_assignments (id, worker_id, position) VALUES ('a1', 'w1', 0)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO work_assignment_answers (assignment_id, attribute_id, answer_id)              VALUES ('a1', 'location', 'store-b')",
            [],
        )
        .unwrap();

        apply_migrations(&conn).unwrap();

        assert_eq!(read_schema_version(&conn).unwrap(), Some(25));
        assert_no_assignment_schema(&conn);
        let migrations: Vec<(i64, String)> = conn
            .prepare("SELECT version, name FROM schema_migrations ORDER BY version")
            .unwrap()
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap();
        assert_eq!(
            migrations,
            [
                (19, "seeded-v19".to_owned()),
                (20, "work-assignment-drafts".to_owned()),
                (21, "legacy-work-assignments".to_owned()),
                (22, "flatten-work-assignments".to_owned()),
                (23, "short-forms".to_owned()),
                (24, "saved-views".to_owned()),
                (25, "committee-goal".to_owned()),
            ]
        );
        let workers = read_workers(&conn, &worksite()).unwrap();
        assert_eq!(workers[0].attributes, json!({ "location": "store-b" }));
    }

    #[test]
    fn a_fresh_database_bootstraps_at_v25_with_the_final_schema() {
        let conn = Connection::open_in_memory().unwrap();

        apply_migrations(&conn).unwrap();

        assert_eq!(read_schema_version(&conn).unwrap(), Some(25));
        assert_no_assignment_schema(&conn);
        let bootstrap: (i64, String) = conn
            .query_row("SELECT version, name FROM schema_migrations", [], |row| {
                Ok((row.get(0)?, row.get(1)?))
            })
            .unwrap();
        assert_eq!(bootstrap, (25, "current-schema-bootstrap".to_owned()));
    }

    /// A fresh bootstrap and an upgraded source end with the same schema: the same objects,
    /// the same columns, and the same indexes and triggers. `ALTER TABLE … DROP COLUMN` need
    /// not preserve the literal CREATE TABLE text, so the comparison uses PRAGMA metadata.
    #[test]
    fn a_fresh_bootstrap_and_an_upgraded_database_have_the_same_schema() {
        fn fingerprint(conn: &Connection) -> Vec<String> {
            let mut objects = Vec::new();
            let tables: Vec<String> = conn
                .prepare(
                    "SELECT name FROM sqlite_master WHERE type = 'table' \
                     AND name NOT LIKE 'sqlite_%' ORDER BY name",
                )
                .unwrap()
                .query_map([], |row| row.get(0))
                .unwrap()
                .collect::<rusqlite::Result<_>>()
                .unwrap();
            for table in &tables {
                let columns: Vec<String> = conn
                    .prepare(&format!("PRAGMA table_info('{table}')"))
                    .unwrap()
                    .query_map([], |row| {
                        Ok(format!(
                            "{}:{}:{}:{}:{}",
                            row.get::<_, String>(1)?,
                            row.get::<_, String>(2)?,
                            row.get::<_, i64>(3)?,
                            row.get::<_, Option<String>>(4)?.unwrap_or_default(),
                            row.get::<_, i64>(5)?
                        ))
                    })
                    .unwrap()
                    .collect::<rusqlite::Result<_>>()
                    .unwrap();
                objects.push(format!("table {table} [{}]", columns.join(",")));
                let foreign_keys: Vec<String> = conn
                    .prepare(&format!("PRAGMA foreign_key_list('{table}')"))
                    .unwrap()
                    .query_map([], |row| {
                        Ok(format!(
                            "{}->{}.{}:{}:{}",
                            row.get::<_, String>(3)?,
                            row.get::<_, String>(2)?,
                            row.get::<_, String>(4)?,
                            row.get::<_, String>(5)?,
                            row.get::<_, String>(6)?
                        ))
                    })
                    .unwrap()
                    .collect::<rusqlite::Result<_>>()
                    .unwrap();
                objects.push(format!("foreign-keys {table} [{}]", foreign_keys.join(",")));
            }
            let indexes: Vec<String> = conn
                .prepare(
                    "SELECT name, tbl_name FROM sqlite_master WHERE type = 'index' \
                     ORDER BY name",
                )
                .unwrap()
                .query_map([], |row| {
                    Ok(format!(
                        "{}:{}",
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?
                    ))
                })
                .unwrap()
                .collect::<rusqlite::Result<_>>()
                .unwrap();
            for index in indexes {
                objects.push(format!("index {index}"));
            }
            let triggers: Vec<String> = conn
                .prepare(
                    "SELECT name, tbl_name FROM sqlite_master WHERE type = 'trigger' ORDER BY name",
                )
                .unwrap()
                .query_map([], |row| {
                    Ok(format!(
                        "{}:{}",
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?
                    ))
                })
                .unwrap()
                .collect::<rusqlite::Result<_>>()
                .unwrap();
            for trigger in triggers {
                objects.push(format!("trigger {trigger}"));
            }
            objects
        }

        let fresh = Connection::open_in_memory().unwrap();
        apply_migrations(&fresh).unwrap();

        let upgraded = Connection::open_in_memory().unwrap();
        upgraded.execute_batch(DDL).unwrap();
        upgrade_attribute_contract(&upgraded).unwrap();
        upgraded.execute_batch(APP_SETTINGS_DDL).unwrap();
        upgraded.execute_batch(DRAFT_DDL).unwrap();
        upgraded.execute_batch(WORK_ASSIGNMENT_DDL).unwrap();
        upgraded.execute_batch(WORK_ASSIGNMENT_DRAFT_DDL).unwrap();
        crate::app_settings::seed_default_settings(&upgraded).unwrap();
        record_migration(&upgraded, 21, "seeded-v21").unwrap();
        apply_migrations(&upgraded).unwrap();

        assert_eq!(fingerprint(&fresh), fingerprint(&upgraded));
        assert_no_assignment_schema(&fresh);
        assert_no_assignment_schema(&upgraded);
    }
}
