//! The core's saved views: named, versioned Workers or Mapping questions kept per Worksite.
//! A snapshot holds only what the view shows (filters, sort, columns, grouping, visibility,
//! highlight); person state (search, selection, Isolate, camera, manual positions) never
//! enters one. The snapshot is validated strictly on the way in and again on the way out,
//! because a stored row is read back as untrusted: an unsupported version, an unknown kind or
//! field, or a malformed value is refused rather than guessed at.

use std::collections::BTreeMap;

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::error::{Error, Result};
use crate::id::IdSource;

/// The only snapshot version this core reads and writes.
pub const SNAPSHOT_VERSION: u32 = 1;
/// The longest a view name may be, in characters.
pub const MAX_NAME_CHARS: usize = 80;

/// Which view a snapshot belongs to.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(
    feature = "ts",
    derive(ts_rs::TS),
    ts(export, rename = "SavedViewKind")
)]
pub enum ViewKind {
    Workers,
    Mapping,
}

impl ViewKind {
    fn as_str(self) -> &'static str {
        match self {
            ViewKind::Workers => "workers",
            ViewKind::Mapping => "mapping",
        }
    }
}

/// Answer and no-answer conditions that select a population, by stable id.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(
    feature = "ts",
    derive(ts_rs::TS),
    ts(export, rename = "SavedViewPopulation")
)]
pub struct Population {
    pub answers: BTreeMap<String, Vec<String>>,
    pub exact_answers: BTreeMap<String, Vec<String>>,
    pub missing: Vec<String>,
}

/// The Workers table's filters: the shared population plus its own column facets.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(
    feature = "ts",
    derive(ts_rs::TS),
    ts(export, rename = "SavedViewWorkersFilters")
)]
pub struct WorkersFilters {
    pub population: Population,
    pub agitations: Vec<String>,
    pub languages: Vec<String>,
    pub assessments: Vec<String>,
}

/// One sorted column.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(
    feature = "ts",
    derive(ts_rs::TS),
    ts(export, rename = "SavedViewSort")
)]
pub struct Sort {
    pub column: String,
    pub descending: bool,
}

/// The Workers view: filters, sort, hidden columns and column order.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(
    feature = "ts",
    derive(ts_rs::TS),
    ts(export, rename = "SavedViewWorkers")
)]
pub struct WorkersView {
    pub filters: WorkersFilters,
    pub sort: Vec<Sort>,
    pub hidden_columns: Vec<String>,
    pub order: Vec<String>,
}

/// The primary and paired Grouping, by Attribute id ("" is None).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(
    feature = "ts",
    derive(ts_rs::TS),
    ts(export, rename = "SavedViewGrouping")
)]
pub struct Grouping {
    pub group: String,
    pub sub_group: String,
}

/// The expanded branches of each Grouping, as answer ids.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(
    feature = "ts",
    derive(ts_rs::TS),
    ts(export, rename = "SavedViewDetail")
)]
pub struct Detail {
    pub expanded: Vec<String>,
    pub expanded_sub: Vec<String>,
}

/// How the map lays its groups out.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(
    feature = "ts",
    derive(ts_rs::TS),
    ts(export, rename = "SavedViewLayout")
)]
pub enum Layout {
    Grouped,
    Free,
}

/// What the map hides: Assessments, answers and Languages.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(
    feature = "ts",
    derive(ts_rs::TS),
    ts(export, rename = "SavedViewVisibility")
)]
pub struct Visibility {
    pub assessments: Vec<String>,
    pub values: BTreeMap<String, Vec<String>>,
    pub languages: Vec<String>,
}

/// The Highlight's query text, which is question state (not the toolbar search).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(
    feature = "ts",
    derive(ts_rs::TS),
    ts(export, rename = "SavedViewHighlight")
)]
pub struct Highlight {
    pub query: String,
}

/// The Mapping view.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(
    feature = "ts",
    derive(ts_rs::TS),
    ts(export, rename = "SavedViewMapping")
)]
pub struct MappingView {
    pub grouping: Grouping,
    pub detail: Detail,
    pub layout: Layout,
    pub population: Population,
    pub visibility: Visibility,
    pub highlight: Highlight,
}

/// The versioned snapshot: `kind` names which one of `workers` / `mapping` is present.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(
    feature = "ts",
    derive(ts_rs::TS),
    ts(export, rename = "SavedViewSnapshot")
)]
pub struct Snapshot {
    pub version: u32,
    pub kind: ViewKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub workers: Option<WorkersView>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub mapping: Option<MappingView>,
}

/// One stored view.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, rename = "SavedView"))]
pub struct StoredView {
    pub id: String,
    pub name: String,
    pub kind: ViewKind,
    pub snapshot: Snapshot,
    pub created_at: String,
    pub updated_at: String,
}

/// Why a request's snapshot or name was refused.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Refusal {
    InvalidName,
    NameTaken,
    InvalidSnapshot(String),
    KindChanged,
    NotFound,
}

/// Reads a snapshot from untrusted JSON: an unsupported version, an unknown kind or field,
/// a mismatched body or a malformed value is refused. Nothing is repaired or defaulted.
pub fn parse_snapshot(value: &Value) -> std::result::Result<Snapshot, String> {
    // The version is read first so an unsupported one is named as such.
    let version = value
        .get("version")
        .and_then(Value::as_u64)
        .ok_or_else(|| "A saved view needs a numeric version.".to_owned())?;
    if version != u64::from(SNAPSHOT_VERSION) {
        return Err(format!("Saved view version {version} is not supported."));
    }
    let snapshot: Snapshot = serde_json::from_value(value.clone())
        .map_err(|error| format!("The saved view is not valid: {error}"))?;
    let consistent = match snapshot.kind {
        ViewKind::Workers => snapshot.workers.is_some() && snapshot.mapping.is_none(),
        ViewKind::Mapping => snapshot.mapping.is_some() && snapshot.workers.is_none(),
    };
    if !consistent {
        return Err("The saved view body does not match its kind.".to_owned());
    }
    Ok(snapshot)
}

/// A name trimmed, or None when it is empty or too long.
pub fn clean_name(name: &str) -> Option<String> {
    let trimmed = name.trim();
    if trimmed.is_empty() || trimmed.chars().count() > MAX_NAME_CHARS {
        return None;
    }
    Some(trimmed.to_owned())
}

fn decode_row(
    id: String,
    name: String,
    kind: String,
    snapshot: String,
    created_at: String,
    updated_at: String,
) -> Result<StoredView> {
    let invalid = || Error::Message(format!("Invalid saved view stored for {id}."));
    let value: Value = serde_json::from_str(&snapshot).map_err(|_| invalid())?;
    let snapshot = parse_snapshot(&value).map_err(|_| invalid())?;
    // The kind column and the snapshot must agree, or the row is not believed.
    if snapshot.kind.as_str() != kind {
        return Err(invalid());
    }
    Ok(StoredView {
        id,
        name,
        kind: snapshot.kind,
        snapshot,
        created_at,
        updated_at,
    })
}

type Row = (String, String, String, String, String, String);

fn read_row(row: &rusqlite::Row) -> rusqlite::Result<Row> {
    Ok((
        row.get(0)?,
        row.get(1)?,
        row.get(2)?,
        row.get(3)?,
        row.get(4)?,
        row.get(5)?,
    ))
}

const COLUMNS: &str = "id, name, kind, snapshot, created_at, updated_at";

/// Every view of a Worksite, by name.
pub fn list_views(conn: &Connection, worksite_id: &str) -> Result<Vec<StoredView>> {
    let mut statement = conn.prepare(&format!(
        "SELECT {COLUMNS} FROM saved_views WHERE worksite_id = ?1 ORDER BY name COLLATE NOCASE, id"
    ))?;
    let rows = statement
        .query_map(params![worksite_id], read_row)?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    rows.into_iter()
        .map(|(id, name, kind, snapshot, created, updated)| {
            decode_row(id, name, kind, snapshot, created, updated)
        })
        .collect()
}

/// One view of a Worksite.
pub fn get_view(conn: &Connection, worksite_id: &str, id: &str) -> Result<Option<StoredView>> {
    let row = conn
        .query_row(
            &format!("SELECT {COLUMNS} FROM saved_views WHERE worksite_id = ?1 AND id = ?2"),
            params![worksite_id, id],
            read_row,
        )
        .optional()?;
    row.map(|(id, name, kind, snapshot, created, updated)| {
        decode_row(id, name, kind, snapshot, created, updated)
    })
    .transpose()
}

fn name_taken(conn: &Connection, worksite_id: &str, name: &str, except: &str) -> Result<bool> {
    let taken: Option<i64> = conn
        .query_row(
            "SELECT 1 FROM saved_views WHERE worksite_id = ?1 AND name = ?2 AND id <> ?3",
            params![worksite_id, name, except],
            |row| row.get(0),
        )
        .optional()?;
    Ok(taken.is_some())
}

/// Creates a view ("Save as"); the name is unique in the Worksite regardless of case.
pub fn create_view(
    conn: &Connection,
    worksite_id: &str,
    name: &str,
    snapshot: &Snapshot,
    id_source: &impl IdSource,
) -> Result<std::result::Result<StoredView, Refusal>> {
    let Some(name) = clean_name(name) else {
        return Ok(Err(Refusal::InvalidName));
    };
    if name_taken(conn, worksite_id, &name, "")? {
        return Ok(Err(Refusal::NameTaken));
    }
    let id = id_source.next_id();
    conn.execute(
        "INSERT INTO saved_views (id, worksite_id, name, kind, snapshot, created_at, updated_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, strftime('%Y-%m-%dT%H:%M:%fZ','now'), \
                 strftime('%Y-%m-%dT%H:%M:%fZ','now'))",
        params![
            id,
            worksite_id,
            name,
            snapshot.kind.as_str(),
            serde_json::to_string(snapshot)?
        ],
    )?;
    let view = get_view(conn, worksite_id, &id)?
        .ok_or_else(|| Error::Message("Saved view vanished after write.".to_owned()))?;
    Ok(Ok(view))
}

/// Updates a view: overwrites its snapshot (the explicit Update) and/or renames it. The
/// kind never changes, and a rename keeps the id, so references to the view survive.
pub fn update_view(
    conn: &Connection,
    worksite_id: &str,
    id: &str,
    name: Option<&str>,
    snapshot: Option<&Snapshot>,
) -> Result<std::result::Result<StoredView, Refusal>> {
    let Some(current) = get_view(conn, worksite_id, id)? else {
        return Ok(Err(Refusal::NotFound));
    };
    let name = match name {
        Some(name) => {
            let Some(name) = clean_name(name) else {
                return Ok(Err(Refusal::InvalidName));
            };
            if name_taken(conn, worksite_id, &name, id)? {
                return Ok(Err(Refusal::NameTaken));
            }
            name
        }
        None => current.name.clone(),
    };
    if snapshot.is_some_and(|snapshot| snapshot.kind != current.kind) {
        return Ok(Err(Refusal::KindChanged));
    }
    let payload = serde_json::to_string(snapshot.unwrap_or(&current.snapshot))?;
    conn.execute(
        "UPDATE saved_views SET name = ?1, snapshot = ?2, \
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') \
         WHERE worksite_id = ?3 AND id = ?4",
        params![name, payload, worksite_id, id],
    )?;
    let view = get_view(conn, worksite_id, id)?
        .ok_or_else(|| Error::Message("Saved view vanished after write.".to_owned()))?;
    Ok(Ok(view))
}

/// Deletes one view; returns whether one was there.
pub fn delete_view(conn: &Connection, worksite_id: &str, id: &str) -> Result<bool> {
    let removed = conn.execute(
        "DELETE FROM saved_views WHERE worksite_id = ?1 AND id = ?2",
        params![worksite_id, id],
    )?;
    Ok(removed > 0)
}

/// Reads every stored view of every Worksite through the canonical decoder; restore and
/// upgrade staging call it so an invalid row stops the swap.
pub(crate) fn validate_all(conn: &Connection) -> Result<()> {
    let mut statement = conn.prepare("SELECT DISTINCT worksite_id FROM saved_views")?;
    let worksites = statement
        .query_map([], |row| row.get::<_, String>(0))?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    for worksite in worksites {
        list_views(conn, &worksite)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::open_seeded;
    use crate::id::CounterId;
    use serde_json::json;

    pub(crate) fn workers_snapshot() -> Value {
        json!({
            "version": 1,
            "kind": "workers",
            "workers": {
                "filters": {
                    "population": { "answers": { "attr-a": ["ans-1"] }, "exactAnswers": {}, "missing": [] },
                    "agitations": [],
                    "languages": [],
                    "assessments": []
                },
                "sort": [{ "column": "name", "descending": false }],
                "hiddenColumns": [],
                "order": []
            }
        })
    }

    pub(crate) fn mapping_snapshot() -> Value {
        json!({
            "version": 1,
            "kind": "mapping",
            "mapping": {
                "grouping": { "group": "attr-a", "subGroup": "" },
                "detail": { "expanded": [], "expandedSub": [] },
                "layout": "grouped",
                "population": { "answers": {}, "exactAnswers": {}, "missing": [] },
                "visibility": { "assessments": [], "values": {}, "languages": [] },
                "highlight": { "query": "" }
            }
        })
    }

    fn seeded() -> crate::db::Db {
        open_seeded(":memory:", &CounterId::new()).unwrap()
    }

    fn worksite_id(conn: &Connection) -> String {
        conn.query_row("SELECT id FROM worksites LIMIT 1", [], |row| row.get(0))
            .unwrap()
    }

    #[test]
    fn accepts_both_kinds() {
        assert!(parse_snapshot(&workers_snapshot()).is_ok());
        assert!(parse_snapshot(&mapping_snapshot()).is_ok());
    }

    #[test]
    fn refuses_a_bad_version_unknown_kind_unknown_field_and_a_mismatched_body() {
        let mut bad_version = workers_snapshot();
        bad_version["version"] = json!(2);
        assert!(parse_snapshot(&bad_version)
            .unwrap_err()
            .contains("not supported"));
        let mut no_version = workers_snapshot();
        no_version.as_object_mut().unwrap().remove("version");
        assert!(parse_snapshot(&no_version).is_err());

        let mut unknown_kind = workers_snapshot();
        unknown_kind["kind"] = json!("overview");
        assert!(parse_snapshot(&unknown_kind).is_err());

        let mut unknown_field = workers_snapshot();
        unknown_field["workers"]["search"] = json!("ada");
        assert!(parse_snapshot(&unknown_field).is_err());
        let mut unknown_top = mapping_snapshot();
        unknown_top["selection"] = json!("w1");
        assert!(parse_snapshot(&unknown_top).is_err());
        let mut unknown_nested = mapping_snapshot();
        unknown_nested["mapping"]["highlight"]["camera"] = json!(1);
        assert!(parse_snapshot(&unknown_nested).is_err());

        let mut bad_enum = mapping_snapshot();
        bad_enum["mapping"]["layout"] = json!("isolated");
        assert!(parse_snapshot(&bad_enum).is_err());

        let mut mismatched = workers_snapshot();
        mismatched["kind"] = json!("mapping");
        assert!(parse_snapshot(&mismatched).is_err());
        let mut both = workers_snapshot();
        both["mapping"] = mapping_snapshot()["mapping"].clone();
        assert!(parse_snapshot(&both).is_err());
    }

    #[test]
    fn round_trips_renames_updates_and_deletes() {
        let db = seeded();
        let conn = db.conn();
        let worksite = worksite_id(conn);
        let ids = CounterId::new();
        let workers = parse_snapshot(&workers_snapshot()).unwrap();

        let created = create_view(conn, &worksite, "  Quiet shift  ", &workers, &ids)
            .unwrap()
            .unwrap();
        assert_eq!(created.name, "Quiet shift");
        assert_eq!(created.snapshot, workers);

        let duplicate = create_view(conn, &worksite, "quiet SHIFT", &workers, &ids).unwrap();
        assert_eq!(duplicate, Err(Refusal::NameTaken));
        assert_eq!(
            create_view(conn, &worksite, "   ", &workers, &ids).unwrap(),
            Err(Refusal::InvalidName)
        );

        let renamed = update_view(conn, &worksite, &created.id, Some("Late shift"), None)
            .unwrap()
            .unwrap();
        assert_eq!(renamed.id, created.id);
        assert_eq!(renamed.name, "Late shift");
        assert_eq!(renamed.snapshot, workers);

        let mut changed = workers.clone();
        changed.workers.as_mut().unwrap().order = vec!["name".to_owned()];
        let updated = update_view(conn, &worksite, &created.id, None, Some(&changed))
            .unwrap()
            .unwrap();
        assert_eq!(updated.snapshot, changed);

        let mapping = parse_snapshot(&mapping_snapshot()).unwrap();
        assert_eq!(
            update_view(conn, &worksite, &created.id, None, Some(&mapping)).unwrap(),
            Err(Refusal::KindChanged)
        );
        assert_eq!(
            update_view(conn, &worksite, "missing", Some("x"), None).unwrap(),
            Err(Refusal::NotFound)
        );

        assert_eq!(list_views(conn, &worksite).unwrap().len(), 1);
        assert!(delete_view(conn, &worksite, &created.id).unwrap());
        assert!(!delete_view(conn, &worksite, &created.id).unwrap());
        assert!(list_views(conn, &worksite).unwrap().is_empty());
    }

    #[test]
    fn cascades_with_its_worksite() {
        let db = seeded();
        let conn = db.conn();
        let worksite = worksite_id(conn);
        let ids = CounterId::new();
        let snapshot = parse_snapshot(&mapping_snapshot()).unwrap();
        create_view(conn, &worksite, "Map", &snapshot, &ids)
            .unwrap()
            .unwrap();
        conn.execute("DELETE FROM worksites WHERE id = ?1", params![worksite])
            .unwrap();
        let left: i64 = conn
            .query_row("SELECT COUNT(*) FROM saved_views", [], |row| row.get(0))
            .unwrap();
        assert_eq!(left, 0);
    }

    #[test]
    fn a_v23_database_gains_the_table_and_keeps_everything_else() {
        let db = seeded();
        let conn = db.conn();
        let worksite = worksite_id(conn);
        conn.execute_batch(
            "DROP TABLE saved_views; DELETE FROM schema_migrations; \
             INSERT INTO schema_migrations (version, name) VALUES (23, 'short-forms');",
        )
        .unwrap();
        assert_eq!(crate::schema::read_schema_version(conn).unwrap(), Some(23));

        crate::schema::apply_migrations(conn).unwrap();

        assert_eq!(
            crate::schema::read_schema_version(conn).unwrap(),
            Some(crate::schema::CURRENT_SCHEMA_VERSION)
        );
        let name: String = conn
            .query_row(
                "SELECT name FROM schema_migrations WHERE version = 24",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(name, "saved-views");
        assert!(list_views(conn, &worksite).unwrap().is_empty());
        let snapshot = parse_snapshot(&workers_snapshot()).unwrap();
        create_view(
            conn,
            &worksite,
            "After upgrade",
            &snapshot,
            &CounterId::new(),
        )
        .unwrap()
        .unwrap();
    }

    #[test]
    fn staged_validation_stops_a_restore_over_an_invalid_stored_view() {
        let db = seeded();
        let conn = db.conn();
        let worksite = worksite_id(conn);
        let snapshot = parse_snapshot(&mapping_snapshot()).unwrap();
        create_view(conn, &worksite, "Fine", &snapshot, &CounterId::new())
            .unwrap()
            .unwrap();
        assert!(crate::store_validation::validate(conn).is_ok());

        let mut crafted = mapping_snapshot();
        crafted["mapping"]["layout"] = json!("isolated");
        conn.execute(
            "UPDATE saved_views SET snapshot = ?1",
            params![crafted.to_string()],
        )
        .unwrap();
        assert!(crate::store_validation::validate(conn).is_err());
    }

    #[test]
    fn refuses_stored_rows_that_do_not_validate() {
        let db = seeded();
        let conn = db.conn();
        let worksite = worksite_id(conn);
        let mut future = workers_snapshot();
        future["version"] = json!(2);
        for (name, kind, payload) in [
            ("future", "workers", future.to_string()),
            ("wrong kind", "mapping", workers_snapshot().to_string()),
            ("not an object", "workers", "[]".to_owned()),
        ] {
            conn.execute("DELETE FROM saved_views", []).unwrap();
            conn.execute(
                "INSERT INTO saved_views (id, worksite_id, name, kind, snapshot, created_at, updated_at) \
                 VALUES ('v1', ?1, ?2, ?3, ?4, '2026-11-09T00:00:00.000Z', '2026-11-09T00:00:00.000Z')",
                params![worksite, name, kind, payload],
            )
            .unwrap();
            let error = list_views(conn, &worksite).unwrap_err();
            assert!(
                error
                    .to_string()
                    .contains("Invalid saved view stored for v1."),
                "{name}: {error}"
            );
            assert!(validate_all(conn).is_err(), "{name}");
        }
    }
}
