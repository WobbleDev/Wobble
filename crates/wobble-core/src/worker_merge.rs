//! The reviewed merge of two Workers in one Worksite, and its session Undo.
//!
//! A merge is one transaction. Inside it the whole read-set is read again and compared with
//! the digest the preview carried (both Worker rows and their children, their drafts, every
//! incident Relationship, the third-party endpoints of surviving Relationships, the
//! vocabulary the merged values reference, and the Worksite row); any difference refuses the
//! merge before it writes. The core keeps one recent-merge snapshot in process memory
//! behind an opaque token. Undo restores the pre-image only when every affected row still
//! equals what the merge left; nothing is journaled, so process exit clears it.

use std::collections::{BTreeMap, BTreeSet};

use rusqlite::{params, Connection, OptionalExtension, Transaction, TransactionBehavior};
use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::attribute_migration::WorkerAttributeDefinition;
use crate::attribute_persistence::get_worker_attributes;
use crate::error::{Error, Result};
use crate::id::IdSource;
use crate::schema::Worksite;
use crate::select_mode::{held_ids, resolve_ids, shape_value};

/// The scalar fields a merge may have to decide, in display order.
const SCALAR_FIELDS: [&str; 4] = ["name", "email", "phone", "assessment"];
const SURVIVOR: &str = "survivor";
const ABSORBED: &str = "absorbed";

/// One Worker's stored rows exactly as SQLite holds them: raw JSON text stays raw, so a
/// restored row is byte-identical to the one that was merged away.
#[derive(Debug, Clone, PartialEq, Serialize)]
struct WorkerRows {
    worksite_id: String,
    name: String,
    email: String,
    phone: String,
    assessment: String,
    notes: String,
    values: BTreeMap<String, String>,
    agitations: BTreeSet<String>,
    languages: BTreeSet<String>,
}

/// Everything a merge reads or writes. Preview digests it, commit re-reads and compares it,
/// and the Undo snapshot holds the pre-image and the post-state as two of these.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub(crate) struct AffectedState {
    worksite: Option<String>,
    workers: BTreeMap<String, Option<WorkerRows>>,
    drafts: BTreeMap<String, Option<(String, String)>>,
    edges: BTreeSet<(String, String)>,
    /// Endpoints of the edges that are not one of the merged Workers: id to its Worksite.
    third: BTreeMap<String, Option<String>>,
    attributes: Vec<(String, String, String, String)>,
    agitations: BTreeMap<String, String>,
    languages: BTreeMap<String, String>,
}

impl AffectedState {
    fn digest(&self) -> Result<String> {
        let mut hash = Sha256::new();
        hash.update(serde_json::to_string(self)?.as_bytes());
        Ok(hash
            .finalize()
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect())
    }
}

/// The one recent merge the core remembers.
#[derive(Debug, Clone)]
pub(crate) struct MergeSnapshot {
    token: String,
    worksite_id: String,
    survivor_id: String,
    absorbed_id: String,
    pre: AffectedState,
    post: AffectedState,
}

impl MergeSnapshot {
    pub(crate) fn worksite_id(&self) -> &str {
        &self.worksite_id
    }

    pub(crate) fn token(&self) -> &str {
        &self.token
    }
}

fn column_set(conn: &Connection, sql: &str, id: &str) -> Result<BTreeSet<String>> {
    let mut statement = conn.prepare(sql)?;
    let mut set = BTreeSet::new();
    for item in statement.query_map(params![id], |row| row.get::<_, String>(0))? {
        set.insert(item?);
    }
    Ok(set)
}

fn vocabulary_rows(
    conn: &Connection,
    table: &str,
    column: &str,
    ids: &BTreeSet<String>,
) -> Result<BTreeMap<String, String>> {
    let mut rows = BTreeMap::new();
    for id in ids {
        let text: Option<String> = conn
            .query_row(
                &format!("SELECT {column} FROM {table} WHERE id = ?1"),
                params![id],
                |row| row.get(0),
            )
            .optional()?;
        rows.insert(id.clone(), text.unwrap_or_default());
    }
    Ok(rows)
}

fn read_rows(conn: &Connection, id: &str) -> Result<Option<WorkerRows>> {
    let row: Option<(String, String, String, String, String, String)> = conn
        .query_row(
            "SELECT worksite_id, name, email, phone, assessment, notes FROM workers WHERE id = ?1",
            params![id],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                ))
            },
        )
        .optional()?;
    let Some((worksite_id, name, email, phone, assessment, notes)) = row else {
        return Ok(None);
    };
    let mut values = BTreeMap::new();
    let mut statement = conn
        .prepare("SELECT attribute_id, value FROM worker_attribute_values WHERE worker_id = ?1")?;
    for pair in statement.query_map(params![id], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    })? {
        let (attribute_id, value) = pair?;
        values.insert(attribute_id, value);
    }
    Ok(Some(WorkerRows {
        worksite_id,
        name,
        email,
        phone,
        assessment,
        notes,
        values,
        agitations: column_set(
            conn,
            "SELECT agitation_id FROM worker_agitations WHERE worker_id = ?1",
            id,
        )?,
        languages: column_set(
            conn,
            "SELECT language_id FROM worker_languages WHERE worker_id = ?1",
            id,
        )?,
    }))
}

fn capture(conn: &Connection, worksite: &Worksite, ids: [&str; 2]) -> Result<AffectedState> {
    let worksite_row: Option<String> = conn
        .query_row(
            "SELECT id FROM worksites WHERE id = ?1",
            params![worksite.id],
            |row| row.get(0),
        )
        .optional()?;

    let mut workers = BTreeMap::new();
    let mut drafts = BTreeMap::new();
    let mut agitation_ids = BTreeSet::new();
    let mut language_ids = BTreeSet::new();
    for id in ids {
        let rows = read_rows(conn, id)?;
        if let Some(rows) = &rows {
            agitation_ids.extend(rows.agitations.iter().cloned());
            language_ids.extend(rows.languages.iter().cloned());
        }
        workers.insert(id.to_owned(), rows);
        let draft: Option<(String, String)> = conn
            .query_row(
                "SELECT payload, updated_at FROM worker_drafts WHERE worker_id = ?1",
                params![id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        drafts.insert(id.to_owned(), draft);
    }

    let mut edges = BTreeSet::new();
    let mut statement = conn.prepare(
        "SELECT worker_a_id, worker_b_id FROM worker_relationships \
         WHERE worker_a_id IN (?1, ?2) OR worker_b_id IN (?1, ?2)",
    )?;
    for pair in statement.query_map(params![ids[0], ids[1]], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    })? {
        edges.insert(pair?);
    }

    let mut third = BTreeMap::new();
    for (a, b) in &edges {
        for endpoint in [a, b] {
            if ids.contains(&endpoint.as_str()) {
                continue;
            }
            let found: Option<String> = conn
                .query_row(
                    "SELECT worksite_id FROM workers WHERE id = ?1",
                    params![endpoint],
                    |row| row.get(0),
                )
                .optional()?;
            third.insert(endpoint.clone(), found);
        }
    }

    let mut attributes = Vec::new();
    for attribute in get_worker_attributes(conn, &Some(worksite.clone()))? {
        attributes.push((
            attribute.id,
            attribute.name,
            attribute.kind,
            serde_json::to_string(&attribute.options)?,
        ));
    }
    attributes.sort();

    Ok(AffectedState {
        worksite: worksite_row,
        workers,
        drafts,
        edges,
        third,
        attributes,
        agitations: vocabulary_rows(conn, "agitations", "text", &agitation_ids)?,
        languages: vocabulary_rows(conn, "languages", "name", &language_ids)?,
    })
}

/// A scalar both Workers hold with different content.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
pub struct ScalarConflict {
    pub field: String,
    pub survivor: String,
    pub absorbed: String,
}

/// An Attribute whose two values cannot be held together.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
pub struct AttributeConflict {
    pub attribute_id: String,
    #[cfg_attr(feature = "ts", ts(type = "string | Array<string>"))]
    pub survivor: Value,
    #[cfg_attr(feature = "ts", ts(type = "string | Array<string>"))]
    pub absorbed: Value,
}

/// What the preview shows: the conflicts that need a decision and what will be unioned.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
pub struct MergePreview {
    /// Opaque digest of the read-set; commit refuses when it no longer matches.
    pub read_set: String,
    /// Workers holding a draft, which blocks the merge.
    pub blocked_drafts: Vec<String>,
    pub scalar_conflicts: Vec<ScalarConflict>,
    pub attribute_conflicts: Vec<AttributeConflict>,
    pub agitation_ids: Vec<String>,
    pub language_ids: Vec<String>,
    pub relationship_ids: Vec<String>,
    #[cfg_attr(feature = "ts", ts(type = "number"))]
    pub note_count: usize,
    /// Absorbed Notes whose id the survivor already uses; they are re-identified.
    #[cfg_attr(feature = "ts", ts(type = "number"))]
    pub note_collisions: usize,
}

/// The decision for each conflict: true keeps the surviving Worker's value, false the
/// absorbed Worker's.
#[derive(Debug, Clone, Default)]
pub struct MergeDecisions {
    pub scalars: BTreeMap<String, bool>,
    pub attributes: BTreeMap<String, bool>,
}

impl MergeDecisions {
    /// Parses `{scalars: {field: "survivor"|"absorbed"}, attributes: {id: ...}}`.
    pub fn parse(value: &Value) -> Option<Self> {
        fn side(value: &Value) -> Option<BTreeMap<String, bool>> {
            let mut map = BTreeMap::new();
            for (key, choice) in value.as_object()? {
                map.insert(
                    key.clone(),
                    match choice.as_str()? {
                        SURVIVOR => true,
                        ABSORBED => false,
                        _ => return None,
                    },
                );
            }
            Some(map)
        }
        let object = value.as_object()?;
        Some(Self {
            scalars: side(object.get("scalars")?)?,
            attributes: side(object.get("attributes")?)?,
        })
    }
}

/// How a merge or an Undo ended.
#[derive(Debug, Clone, PartialEq)]
pub enum MergeOutcome<T> {
    Done(T),
    /// Not the same Worksite, not two different Workers, or a Worker that is not there.
    NotFound,
    /// A Worker holds an unresolved draft.
    DraftsUnresolved(Vec<String>),
    /// The read-set changed since the preview.
    Stale,
    /// A conflict has no decision, or a decision names no conflict.
    DecisionsRequired,
    /// The Undo token is unknown, replaced, killed, or a fingerprinted row changed.
    UndoExpired,
}

/// The committed merge's reply.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
pub struct MergeCommitted {
    pub survivor_id: String,
    pub absorbed_id: String,
    pub undo_token: String,
    #[cfg_attr(feature = "ts", ts(type = "number"))]
    pub remapped_notes: usize,
}

/// The restored Workers.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
pub struct MergeUndone {
    pub survivor_id: String,
    pub absorbed_id: String,
}

struct Plan {
    survivor: WorkerRows,
    neighbours: BTreeSet<String>,
    scalar_conflicts: Vec<ScalarConflict>,
    attribute_conflicts: Vec<AttributeConflict>,
    note_count: usize,
    note_collisions: usize,
}

fn scalar<'a>(rows: &'a WorkerRows, field: &str) -> &'a str {
    match field {
        "name" => &rows.name,
        "email" => &rows.email,
        "phone" => &rows.phone,
        _ => &rows.assessment,
    }
}

fn blank(field: &str, value: &str) -> bool {
    let value = value.trim();
    value.is_empty() || (field == "assessment" && value == "Unassessed")
}

fn same_scalar(field: &str, a: &str, b: &str) -> bool {
    if field == "email" {
        a.trim().eq_ignore_ascii_case(b.trim())
    } else {
        a.trim() == b.trim()
    }
}

fn parse_value(raw: &str) -> Value {
    serde_json::from_str(raw).unwrap_or(Value::Null)
}

fn parse_notes(raw: &str) -> Vec<Value> {
    parse_value(raw).as_array().cloned().unwrap_or_default()
}

/// Works out the merged survivor from the read state. Without `decisions` only the
/// conflicts are collected; with them, every conflict must be decided and no decision may
/// name anything else, or the plan is `None`.
fn plan(
    state: &AffectedState,
    ids: [&str; 2],
    attributes: &[WorkerAttributeDefinition],
    decisions: Option<&MergeDecisions>,
    mint: Option<&dyn IdSource>,
) -> Result<Option<Plan>> {
    let (Some(Some(survivor)), Some(Some(absorbed))) =
        (state.workers.get(ids[0]), state.workers.get(ids[1]))
    else {
        return Err(Error::Message("Merge Workers are missing.".to_owned()));
    };
    let mut merged = survivor.clone();
    let mut scalar_conflicts = Vec::new();
    let mut attribute_conflicts = Vec::new();
    let mut undecided = false;

    for field in SCALAR_FIELDS {
        let (mine, theirs) = (scalar(survivor, field), scalar(absorbed, field));
        let value = if blank(field, mine) {
            theirs.to_owned()
        } else if blank(field, theirs) || same_scalar(field, mine, theirs) {
            mine.to_owned()
        } else {
            scalar_conflicts.push(ScalarConflict {
                field: field.to_owned(),
                survivor: mine.to_owned(),
                absorbed: theirs.to_owned(),
            });
            match decisions.and_then(|d| d.scalars.get(field)) {
                Some(false) => theirs.to_owned(),
                Some(true) => mine.to_owned(),
                None => {
                    undecided = true;
                    mine.to_owned()
                }
            }
        };
        match field {
            "name" => merged.name = value,
            "email" => merged.email = value,
            "phone" => merged.phone = value,
            _ => merged.assessment = value,
        }
    }

    for attribute in attributes {
        let value_of = |rows: &WorkerRows| {
            rows.values
                .get(&attribute.id)
                .map_or(Value::Null, |raw| parse_value(raw))
        };
        let (mine, theirs) = (value_of(survivor), value_of(absorbed));
        let (mine_ids, their_ids) = (held_ids(&mine), held_ids(&theirs));
        let mut union = mine_ids.clone();
        for id in &their_ids {
            if !union.contains(id) {
                union.push(id.clone());
            }
        }
        let chosen = if their_ids.iter().all(|id| mine_ids.contains(id)) {
            None
        } else if mine_ids.is_empty() {
            Some(theirs.clone())
        } else if resolve_ids(&attribute.kind, &attribute.options, &union)
            .1
            .is_empty()
        {
            Some(shape_value(&attribute.kind, &attribute.options, &union))
        } else {
            attribute_conflicts.push(AttributeConflict {
                attribute_id: attribute.id.clone(),
                survivor: mine.clone(),
                absorbed: theirs.clone(),
            });
            match decisions.and_then(|d| d.attributes.get(&attribute.id)) {
                Some(false) => Some(theirs.clone()),
                Some(true) => None,
                None => {
                    undecided = true;
                    None
                }
            }
        };
        if let Some(value) = chosen {
            merged
                .values
                .insert(attribute.id.clone(), serde_json::to_string(&value)?);
        }
    }
    if let Some(decisions) = decisions {
        let scalars_known = decisions
            .scalars
            .keys()
            .all(|field| scalar_conflicts.iter().any(|c| &c.field == field));
        let attributes_known = decisions
            .attributes
            .keys()
            .all(|id| attribute_conflicts.iter().any(|c| &c.attribute_id == id));
        if undecided || !scalars_known || !attributes_known {
            return Ok(None);
        }
    }

    merged
        .agitations
        .extend(absorbed.agitations.iter().cloned());
    merged.languages.extend(absorbed.languages.iter().cloned());

    let mut notes = parse_notes(&survivor.notes);
    let mut used: BTreeSet<String> = notes
        .iter()
        .filter_map(|note| note.get("id").and_then(Value::as_str).map(str::to_owned))
        .collect();
    let mut note_collisions = 0;
    for mut note in parse_notes(&absorbed.notes) {
        let id = note
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned();
        if used.contains(&id) {
            note_collisions += 1;
            if let (Some(source), Some(object)) = (mint, note.as_object_mut()) {
                let fresh = source.next_id();
                object.insert("id".to_owned(), Value::String(fresh.clone()));
                used.insert(fresh);
            }
        } else {
            used.insert(id);
        }
        notes.push(note);
    }
    let note_count = notes.len();
    merged.notes = serde_json::to_string(&notes)?;

    let neighbours = state
        .edges
        .iter()
        .flat_map(|(a, b)| [a, b])
        .filter(|id| !ids.contains(&id.as_str()))
        .cloned()
        .collect();

    Ok(Some(Plan {
        survivor: merged,
        neighbours,
        scalar_conflicts,
        attribute_conflicts,
        note_count,
        note_collisions,
    }))
}

fn is_mergeable_pair(state: &AffectedState, worksite: &Worksite, ids: [&str; 2]) -> bool {
    ids[0] != ids[1]
        && state.worksite.as_deref() == Some(worksite.id.as_str())
        && ids.iter().all(|id| {
            state
                .workers
                .get(*id)
                .and_then(Option::as_ref)
                .is_some_and(|rows| rows.worksite_id == worksite.id)
        })
}

fn unresolved_drafts(state: &AffectedState) -> Vec<String> {
    state
        .drafts
        .iter()
        .filter(|(_, draft)| draft.is_some())
        .map(|(id, _)| id.clone())
        .collect()
}

/// Reads the two Workers and answers what a merge would decide and union. Writes nothing.
pub fn preview_merge(
    conn: &Connection,
    worksite: &Worksite,
    survivor_id: &str,
    absorbed_id: &str,
) -> Result<MergeOutcome<MergePreview>> {
    let ids = [survivor_id, absorbed_id];
    let state = capture(conn, worksite, ids)?;
    if !is_mergeable_pair(&state, worksite, ids) {
        return Ok(MergeOutcome::NotFound);
    }
    let attributes = get_worker_attributes(conn, &Some(worksite.clone()))?;
    let Some(plan) = plan(&state, ids, &attributes, None, None)? else {
        return Err(Error::Message("Merge plan unavailable.".to_owned()));
    };
    Ok(MergeOutcome::Done(MergePreview {
        read_set: state.digest()?,
        blocked_drafts: unresolved_drafts(&state),
        scalar_conflicts: plan.scalar_conflicts,
        attribute_conflicts: plan.attribute_conflicts,
        agitation_ids: plan.survivor.agitations.iter().cloned().collect(),
        language_ids: plan.survivor.languages.iter().cloned().collect(),
        relationship_ids: plan.neighbours.iter().cloned().collect(),
        note_count: plan.note_count,
        note_collisions: plan.note_collisions,
    }))
}

fn write_children(tx: &Connection, worker_id: &str, rows: &WorkerRows) -> Result<()> {
    for table in [
        "worker_attribute_values",
        "worker_agitations",
        "worker_languages",
    ] {
        tx.execute(
            &format!("DELETE FROM {table} WHERE worker_id = ?1"),
            params![worker_id],
        )?;
    }
    for (attribute_id, value) in &rows.values {
        tx.execute(
            "INSERT INTO worker_attribute_values (worker_id, attribute_id, value) \
             VALUES (?1, ?2, ?3)",
            params![worker_id, attribute_id, value],
        )?;
    }
    for agitation_id in &rows.agitations {
        tx.execute(
            "INSERT INTO worker_agitations (worker_id, agitation_id) VALUES (?1, ?2)",
            params![worker_id, agitation_id],
        )?;
    }
    for language_id in &rows.languages {
        tx.execute(
            "INSERT INTO worker_languages (worker_id, language_id) VALUES (?1, ?2)",
            params![worker_id, language_id],
        )?;
    }
    Ok(())
}

fn delete_incident_edges(tx: &Connection, ids: [&str; 2]) -> Result<()> {
    tx.execute(
        "DELETE FROM worker_relationships \
         WHERE worker_a_id IN (?1, ?2) OR worker_b_id IN (?1, ?2)",
        params![ids[0], ids[1]],
    )?;
    Ok(())
}

fn update_survivor(tx: &Connection, id: &str, rows: &WorkerRows) -> Result<()> {
    tx.execute(
        "UPDATE workers SET name = ?1, email = ?2, phone = ?3, assessment = ?4, notes = ?5 \
         WHERE id = ?6",
        params![
            rows.name,
            rows.email,
            rows.phone,
            rows.assessment,
            rows.notes,
            id
        ],
    )?;
    Ok(())
}

/// Commits the merge atomically and returns the snapshot to remember with its reply.
pub(crate) fn commit_merge(
    conn: &Connection,
    worksite: &Worksite,
    survivor_id: &str,
    absorbed_id: &str,
    read_set: &str,
    decisions: &MergeDecisions,
    id_source: &impl IdSource,
) -> Result<(MergeOutcome<MergeCommitted>, Option<MergeSnapshot>)> {
    let ids = [survivor_id, absorbed_id];
    let tx = Transaction::new_unchecked(conn, TransactionBehavior::Immediate)?;
    let pre = capture(&tx, worksite, ids)?;
    if !is_mergeable_pair(&pre, worksite, ids) {
        return Ok((MergeOutcome::NotFound, None));
    }
    let unresolved = unresolved_drafts(&pre);
    if !unresolved.is_empty() {
        return Ok((MergeOutcome::DraftsUnresolved(unresolved), None));
    }
    if pre.digest()? != read_set {
        return Ok((MergeOutcome::Stale, None));
    }
    let attributes = get_worker_attributes(&tx, &Some(worksite.clone()))?;
    let Some(plan) = plan(&pre, ids, &attributes, Some(decisions), Some(id_source))? else {
        return Ok((MergeOutcome::DecisionsRequired, None));
    };

    update_survivor(&tx, survivor_id, &plan.survivor)?;
    write_children(&tx, survivor_id, &plan.survivor)?;
    delete_incident_edges(&tx, ids)?;
    tx.execute("DELETE FROM workers WHERE id = ?1", params![absorbed_id])?;
    for neighbour in &plan.neighbours {
        let (a, b) = if survivor_id < neighbour.as_str() {
            (survivor_id, neighbour.as_str())
        } else {
            (neighbour.as_str(), survivor_id)
        };
        tx.execute(
            "INSERT INTO worker_relationships (worker_a_id, worker_b_id) VALUES (?1, ?2)",
            params![a, b],
        )?;
    }

    let post = capture(&tx, worksite, ids)?;
    tx.commit()?;

    let token = id_source.next_id();
    let committed = MergeCommitted {
        survivor_id: survivor_id.to_owned(),
        absorbed_id: absorbed_id.to_owned(),
        undo_token: token.clone(),
        remapped_notes: plan.note_collisions,
    };
    let snapshot = MergeSnapshot {
        token,
        worksite_id: worksite.id.clone(),
        survivor_id: survivor_id.to_owned(),
        absorbed_id: absorbed_id.to_owned(),
        pre,
        post,
    };
    Ok((MergeOutcome::Done(committed), Some(snapshot)))
}

/// Restores the pre-image if the token is the remembered one and every affected row still
/// equals what the merge left. The caller drops the snapshot whatever this answers.
pub(crate) fn undo_merge(
    conn: &Connection,
    worksite: Option<&Worksite>,
    snapshot: Option<&MergeSnapshot>,
    token: &str,
) -> Result<MergeOutcome<MergeUndone>> {
    let (Some(snapshot), Some(worksite)) = (snapshot, worksite) else {
        return Ok(MergeOutcome::UndoExpired);
    };
    if snapshot.token != token || snapshot.worksite_id != worksite.id {
        return Ok(MergeOutcome::UndoExpired);
    }
    let ids = [snapshot.survivor_id.as_str(), snapshot.absorbed_id.as_str()];
    let tx = Transaction::new_unchecked(conn, TransactionBehavior::Immediate)?;
    if capture(&tx, worksite, ids)? != snapshot.post {
        return Ok(MergeOutcome::UndoExpired);
    }

    delete_incident_edges(&tx, ids)?;
    for id in ids {
        let Some(Some(rows)) = snapshot.pre.workers.get(id) else {
            return Err(Error::Message("Merge pre-image is incomplete.".to_owned()));
        };
        if id == snapshot.survivor_id {
            update_survivor(&tx, id, rows)?;
        } else {
            tx.execute(
                "INSERT INTO workers (id, worksite_id, name, email, phone, assessment, notes) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![
                    id,
                    rows.worksite_id,
                    rows.name,
                    rows.email,
                    rows.phone,
                    rows.assessment,
                    rows.notes
                ],
            )?;
        }
        write_children(&tx, id, rows)?;
    }
    for (a, b) in &snapshot.pre.edges {
        tx.execute(
            "INSERT INTO worker_relationships (worker_a_id, worker_b_id) VALUES (?1, ?2)",
            params![a, b],
        )?;
    }
    if capture(&tx, worksite, ids)? != snapshot.pre {
        // Dropping the transaction rolls every write back.
        return Ok(MergeOutcome::UndoExpired);
    }
    tx.commit()?;

    Ok(MergeOutcome::Done(MergeUndone {
        survivor_id: snapshot.survivor_id.clone(),
        absorbed_id: snapshot.absorbed_id.clone(),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Db;
    use crate::id::CounterId;
    use crate::router::dispatch;
    use crate::test_support::{first_worksite, request_for, seeded};
    use serde_json::json;

    struct Fixture {
        db: Db,
        ids: CounterId,
        worksite: String,
        department: String,
        shifts: String,
        agitations: Vec<String>,
        languages: Vec<String>,
    }

    impl Fixture {
        fn call(&self, method: &str, path: &str, body: Option<Value>) -> (u16, Value) {
            let request = request_for(method, path, &self.worksite, body);
            let response = dispatch(&self.db, &request, &self.ids);
            (response.status, response.body)
        }

        fn worker(&self, body: Value) -> String {
            let mut worker = json!({
                "name": "", "email": "", "phone": "", "assessment": "Unassessed",
                "attributes": {}, "agitations": [], "languages": [],
                "relationships": [], "notes": []
            });
            for (key, value) in body.as_object().unwrap() {
                worker[key] = value.clone();
            }
            let attributes = worker["attributes"].as_object().unwrap().clone();
            let mut all = serde_json::Map::new();
            for attribute in self.dataset()["attributes"].as_array().unwrap() {
                let id = attribute["id"].as_str().unwrap();
                let empty = if attribute["kind"] == "category" {
                    json!("")
                } else {
                    json!([])
                };
                all.insert(id.to_owned(), attributes.get(id).cloned().unwrap_or(empty));
            }
            worker["attributes"] = Value::Object(all);
            let (status, reply) = self.call("POST", "/api/workers", Some(worker));
            assert_eq!(status, 201, "{reply}");
            reply["worker"]["id"].as_str().unwrap().to_owned()
        }

        fn dataset(&self) -> Value {
            self.call("GET", "/api/dataset", None).1
        }

        fn workers(&self) -> Vec<Value> {
            let mut workers = self.dataset()["workers"].as_array().unwrap().clone();
            workers.sort_by_key(|worker| worker["id"].as_str().unwrap().to_owned());
            workers
        }

        fn find(&self, id: &str) -> Option<Value> {
            self.workers().into_iter().find(|worker| worker["id"] == id)
        }

        fn preview(&self, a: &str, b: &str) -> (u16, Value) {
            self.call(
                "POST",
                "/api/worker-merge/preview",
                Some(json!({ "survivorId": a, "absorbedId": b })),
            )
        }

        fn merge(&self, a: &str, b: &str, decisions: Value) -> (u16, Value) {
            let (status, preview) = self.preview(a, b);
            assert_eq!(status, 200, "{preview}");
            self.merge_with(a, b, &preview["readSet"], decisions)
        }

        fn merge_with(&self, a: &str, b: &str, read_set: &Value, decisions: Value) -> (u16, Value) {
            self.call(
                "POST",
                "/api/worker-merge",
                Some(json!({
                    "survivorId": a, "absorbedId": b,
                    "readSet": read_set, "decisions": decisions
                })),
            )
        }

        fn undo(&self, token: &Value) -> (u16, Value) {
            self.call(
                "POST",
                "/api/worker-merge/undo",
                Some(json!({ "token": token })),
            )
        }
    }

    const NONE: fn() -> Value = || json!({ "scalars": {}, "attributes": {} });

    fn fixture() -> Fixture {
        let (db, ids) = seeded();
        let worksite = first_worksite(&db);
        let mut fixture = Fixture {
            db,
            ids,
            worksite,
            department: String::new(),
            shifts: String::new(),
            agitations: Vec::new(),
            languages: Vec::new(),
        };
        let mut attributes = fixture.dataset()["attributes"].as_array().unwrap().clone();
        for attribute in &mut attributes {
            match attribute["name"].as_str().unwrap() {
                "Department" => {
                    fixture.department = attribute["id"].as_str().unwrap().to_owned();
                    attribute["options"] = json!([
                        { "id": "cooks", "value": "Cooks" },
                        { "id": "servers", "value": "Servers" }
                    ]);
                }
                "Shifts" => {
                    fixture.shifts = attribute["id"].as_str().unwrap().to_owned();
                    attribute["options"] = json!([
                        { "id": "day", "value": "Day" },
                        { "id": "night", "value": "Night" }
                    ]);
                }
                _ => {}
            }
        }
        let (status, body) = fixture.call("PUT", "/api/attributes", Some(json!(attributes)));
        assert_eq!(status, 200, "{body}");
        for text in ["Pay", "Safety"] {
            let (_, body) = fixture.call("POST", "/api/agitations", Some(json!({ "text": text })));
            fixture
                .agitations
                .push(body["agitation"]["id"].as_str().unwrap().to_owned());
        }
        for name in ["English", "Spanish"] {
            let (_, body) = fixture.call("POST", "/api/languages", Some(json!({ "name": name })));
            fixture
                .languages
                .push(body["language"]["id"].as_str().unwrap().to_owned());
        }
        fixture
    }

    fn note(id: &str, text: &str) -> Value {
        json!({ "id": id, "text": text, "timestamp": "2026-01-01T00:00:00.000Z" })
    }

    /// Two overlapping Workers, one third party tied to both, one only to the absorbed.
    fn pair(f: &Fixture) -> (String, String, String, String) {
        let c = f.worker(json!({ "name": "Cy" }));
        let d = f.worker(json!({ "name": "Di" }));
        let a = f.worker(json!({
            "name": "Ana", "email": "ana@example.org",
            "attributes": { f.department.clone(): "cooks", f.shifts.clone(): ["day"] },
            "agitations": [f.agitations[0]], "languages": [f.languages[0]],
            "relationships": [c], "notes": [note("n1", "first")]
        }));
        let b = f.worker(json!({
            "name": "Ana", "phone": "(555) 123-4567",
            "attributes": { f.department.clone(): "cooks", f.shifts.clone(): ["night"] },
            "agitations": [f.agitations[1]], "languages": [f.languages[1]],
            "relationships": [c, d, a], "notes": [note("n1", "second"), note("n2", "third")]
        }));
        (a, b, c, d)
    }

    #[test]
    fn merge_unions_children_and_remaps_colliding_note_ids() {
        let f = fixture();
        let (a, b, c, d) = pair(&f);
        let (status, preview) = f.preview(&a, &b);
        assert_eq!(status, 200);
        assert_eq!(preview["scalarConflicts"], json!([]));
        assert_eq!(preview["attributeConflicts"], json!([]));
        assert_eq!(preview["noteCollisions"], 1);
        assert_eq!(preview["noteCount"], 3);
        let mut expected = vec![c.clone(), d.clone()];
        expected.sort();
        assert_eq!(preview["relationshipIds"], json!(expected));

        let (status, done) = f.merge(&a, &b, NONE());
        assert_eq!(status, 200, "{done}");
        assert_eq!(done["remappedNotes"], 1);
        assert!(f.find(&b).is_none());
        let merged = f.find(&a).unwrap();
        assert_eq!(merged["phone"], "(555) 123-4567");
        assert_eq!(merged["email"], "ana@example.org");
        assert_eq!(merged["attributes"][&f.shifts].as_array().unwrap().len(), 2);
        assert_eq!(merged["agitations"].as_array().unwrap().len(), 2);
        assert_eq!(merged["languages"].as_array().unwrap().len(), 2);
        assert_eq!(merged["relationships"].as_array().unwrap().len(), 2);
        let notes = merged["notes"].as_array().unwrap();
        let note_ids: BTreeSet<&str> = notes.iter().map(|n| n["id"].as_str().unwrap()).collect();
        assert_eq!(notes.len(), 3);
        assert_eq!(note_ids.len(), 3);
        assert!(notes
            .iter()
            .all(|n| n["timestamp"] == "2026-01-01T00:00:00.000Z"));
        // The removed Worker is not a self-edge anywhere.
        assert!(!f.find(&c).unwrap()["relationships"]
            .to_string()
            .contains(&b));
    }

    #[test]
    fn every_conflict_needs_a_decision_and_the_choice_is_kept() {
        let f = fixture();
        let a = f.worker(json!({
            "name": "Ana", "assessment": "Leader",
            "attributes": { f.department.clone(): "cooks" }
        }));
        let b = f.worker(json!({
            "name": "Anna", "assessment": "Unassessed",
            "attributes": { f.department.clone(): "servers" }
        }));
        let (_, preview) = f.preview(&a, &b);
        assert_eq!(preview["scalarConflicts"].as_array().unwrap().len(), 1);
        assert_eq!(preview["attributeConflicts"].as_array().unwrap().len(), 1);

        let (status, body) = f.merge_with(&a, &b, &preview["readSet"], NONE());
        assert_eq!(
            (status, body["code"].as_str()),
            (400, Some("merge_decisions_required"))
        );
        let partial = json!({ "scalars": { "name": "absorbed" }, "attributes": {} });
        assert_eq!(f.merge_with(&a, &b, &preview["readSet"], partial).0, 400);
        let extra = json!({
            "scalars": { "name": "absorbed", "email": "absorbed" },
            "attributes": { f.department.clone(): "survivor" }
        });
        assert_eq!(f.merge_with(&a, &b, &preview["readSet"], extra).0, 400);
        assert!(f.find(&b).is_some());

        let decisions = json!({
            "scalars": { "name": "absorbed" },
            "attributes": { f.department.clone(): "absorbed" }
        });
        let (status, body) = f.merge_with(&a, &b, &preview["readSet"], decisions);
        assert_eq!(status, 200, "{body}");
        let merged = f.find(&a).unwrap();
        assert_eq!(merged["name"], "Anna");
        assert_eq!(merged["attributes"][&f.department], "servers");
        assert_eq!(merged["assessment"], "Leader");
    }

    #[test]
    fn an_unresolved_draft_blocks_the_merge() {
        let f = fixture();
        let (a, b, ..) = pair(&f);
        let worker = f.find(&b).unwrap();
        let update = json!({
            "name": worker["name"], "email": "", "phone": "", "assessment": "Unassessed",
            "attributes": worker["attributes"], "agitations": [], "languages": [],
            "relationships": [], "notes": []
        });
        let (status, _) = f.call(
            "PUT",
            &format!("/api/worker-drafts/{b}"),
            Some(json!({ "update": update, "pendingNote": { "text": "x" }, "base": null })),
        );
        assert_eq!(status, 200);
        let (_, preview) = f.preview(&a, &b);
        assert_eq!(preview["blockedDrafts"], json!([b]));
        let (status, body) = f.merge_with(&a, &b, &preview["readSet"], NONE());
        assert_eq!(
            (status, body["code"].as_str()),
            (409, Some("merge_drafts_unresolved"))
        );
        assert!(f.find(&b).is_some());
    }

    #[test]
    fn commit_refuses_when_the_read_set_changed_after_the_preview() {
        let f = fixture();
        let (a, b, c, _) = pair(&f);
        for change in 0..4 {
            let (_, preview) = f.preview(&a, &b);
            match change {
                0 => assert_eq!(
                    f.call(
                        "PATCH",
                        &format!("/api/workers/{a}"),
                        Some(json!({"field":"email","value":"new@example.org"}))
                    )
                    .0,
                    200
                ),
                1 => assert_eq!(
                    f.call(
                        "PATCH",
                        &format!("/api/workers/{c}"),
                        Some(json!({"field":"name","value":"Cyrus"}))
                    )
                    .0,
                    200
                ),
                2 => {
                    f.call("POST", "/api/agitations", Some(json!({ "text": "New" })));
                    f.call("PATCH", &format!("/api/workers/{b}"), Some(json!({"field":"agitations","action":"unassign","value":{"id": f.agitations[1]}})));
                }
                _ => {
                    f.call(
                        "PATCH",
                        &format!("/api/workers/{a}"),
                        Some(json!({"field":"relationships","action":"add","value":{"id": b}})),
                    );
                }
            }
            let (status, body) = f.merge_with(&a, &b, &preview["readSet"], NONE());
            // A third party's own fields are outside the read-set; the rest are inside.
            if change == 1 {
                assert_eq!(status, 200, "{body}");
                return;
            }
            assert_eq!(
                (status, body["code"].as_str()),
                (409, Some("merge_stale")),
                "{change}"
            );
            assert!(f.find(&b).is_some());
        }
    }

    #[test]
    fn a_failure_inside_the_commit_rolls_everything_back() {
        let f = fixture();
        let (a, b, ..) = pair(&f);
        let before = f.workers();
        f.db.conn()
            .execute_batch(
                "CREATE TRIGGER boom BEFORE DELETE ON workers \
                 BEGIN SELECT RAISE(ABORT, 'boom'); END;",
            )
            .unwrap();
        let (status, _) = f.merge(&a, &b, NONE());
        assert_eq!(status, 500);
        assert_eq!(f.workers(), before);
        assert!(f.db.merge_snapshot().is_none());
    }

    #[test]
    fn workers_of_another_worksite_or_the_same_worker_are_not_found() {
        let f = fixture();
        let (a, b, ..) = pair(&f);
        assert_eq!(f.preview(&a, &a).0, 404);
        assert_eq!(f.preview(&a, "nobody").0, 404);
        let (_, second) = f.call("POST", "/api/worksite", None);
        let other = second["worksite"]["id"].as_str().unwrap().to_owned();
        let request = request_for(
            "POST",
            "/api/worker-merge/preview",
            &other,
            Some(json!({ "survivorId": a, "absorbedId": b })),
        );
        assert_eq!(dispatch(&f.db, &request, &f.ids).status, 404);
    }

    #[test]
    fn undo_restores_the_exact_pre_image_and_survives_unrelated_edits() {
        let f = fixture();
        let (a, b, c, _) = pair(&f);
        let before = f.workers();
        let (_, done) = f.merge(&a, &b, NONE());
        let token = done["undoToken"].clone();
        // An unrelated Worker's own edit does not invalidate the token.
        f.call(
            "PATCH",
            &format!("/api/workers/{c}"),
            Some(json!({"field":"name","value":"Cyrus"})),
        );
        let (status, body) = f.undo(&token);
        assert_eq!(status, 200, "{body}");
        let mut expected = before;
        for worker in &mut expected {
            if worker["id"] == c.as_str() {
                worker["name"] = json!("Cyrus");
            }
        }
        assert_eq!(f.workers(), expected);
        // The token is spent.
        assert_eq!(f.undo(&token).0, 409);
    }

    #[test]
    fn an_edit_to_an_affected_row_expires_the_token_and_leaves_the_data() {
        let f = fixture();
        for edit in 0..3 {
            let (a, b, c, _) = pair(&f);
            let (_, done) = f.merge(&a, &b, NONE());
            match edit {
                0 => assert_eq!(
                    f.call(
                        "PATCH",
                        &format!("/api/workers/{a}"),
                        Some(json!({"field":"name","value":"Edited"}))
                    )
                    .0,
                    200
                ),
                1 => assert_eq!(
                    f.call(
                        "PATCH",
                        &format!("/api/workers/{a}"),
                        Some(json!({"field":"relationships","action":"remove","value":{"id": c}}))
                    )
                    .0,
                    200
                ),
                _ => assert_eq!(f.call("DELETE", &format!("/api/workers/{c}"), None).0, 200),
            }
            let after = f.workers();
            let (status, body) = f.undo(&done["undoToken"]);
            assert_eq!(
                (status, body["code"].as_str()),
                (409, Some("merge_undo_expired")),
                "{edit}"
            );
            assert_eq!(f.workers(), after);
            assert!(f.db.merge_snapshot().is_none());
        }
    }

    #[test]
    fn only_the_latest_merge_can_be_undone() {
        let f = fixture();
        let (a, b, ..) = pair(&f);
        let (_, first) = f.merge(&a, &b, NONE());
        let x = f.worker(json!({ "name": "Xi" }));
        let y = f.worker(json!({ "name": "Xi" }));
        let (_, second) = f.merge(&x, &y, NONE());
        assert_eq!(f.undo(&first["undoToken"]).0, 409);
        // A wrong token does not end the remembered merge.
        assert_eq!(f.undo(&second["undoToken"]).0, 200);
    }

    #[test]
    fn dismissal_switch_and_worksite_delete_end_the_token() {
        let f = fixture();
        let (a, b, ..) = pair(&f);
        let (_, done) = f.merge(&a, &b, NONE());
        let token = done["undoToken"].clone();
        assert_eq!(
            f.call(
                "POST",
                "/api/worker-merge/dismiss",
                Some(json!({ "token": token }))
            )
            .0,
            200
        );
        assert_eq!(f.undo(&token).0, 409);

        let (a, b) = (
            f.worker(json!({ "name": "P" })),
            f.worker(json!({ "name": "P" })),
        );
        let (_, second) = f.call("POST", "/api/worksite", None);
        let other = second["worksite"]["id"].as_str().unwrap().to_owned();
        let (_, done) = f.merge(&a, &b, NONE());
        // Naming the same Worksite keeps it; switching away ends it, even if switched back.
        f.call(
            "PUT",
            "/api/worksite/active",
            Some(json!({ "id": f.worksite })),
        );
        assert!(f.db.merge_snapshot().is_some());
        f.call("PUT", "/api/worksite/active", Some(json!({ "id": other })));
        assert_eq!(f.undo(&done["undoToken"]).0, 409);

        let (a, b) = (
            f.worker(json!({ "name": "R" })),
            f.worker(json!({ "name": "R" })),
        );
        let (_, done) = f.merge(&a, &b, NONE());
        let request = request_for("DELETE", "/api/worksite", &other, None);
        assert_eq!(dispatch(&f.db, &request, &f.ids).status, 200);
        assert_eq!(f.undo(&done["undoToken"]).0, 409);
    }

    #[test]
    fn erase_and_restore_end_the_token() {
        for (path, body) in [
            ("/api/erase", json!({ "confirm": "erase" })),
            ("/api/restore", json!({ "path": "/nowhere" })),
        ] {
            let f = fixture();
            let (a, b, ..) = pair(&f);
            f.merge(&a, &b, NONE());
            assert!(f.db.merge_snapshot().is_some());
            // The in-memory database refuses both, but the token is gone before it answers.
            f.call("POST", path, Some(body));
            assert!(f.db.merge_snapshot().is_none(), "{path}");
        }
    }
}
