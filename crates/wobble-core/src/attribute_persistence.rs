//! Worker attribute values: read, replace, and save them, including applying a migration plan.

use std::collections::HashMap;

use rusqlite::types::ValueRef;
use rusqlite::{params, Connection, OptionalExtension, Transaction, TransactionBehavior};
use serde_json::{json, Value};

use crate::attribute_migration::{
    answers_from_json, answers_to_json, compute_attribute_migration_plan_in, empty_attribute_value,
    AttributeMigrationPlan, PositionedWorkerAttributeDefinition, WorkerAttributeDefinition,
};
use crate::configuration_resolution::attribute_moves::{
    detect_attribute_moves, move_strips_a_saved_value, strip_moved_worker_drafts,
};
use crate::error::{Error, Result};
use crate::id::IdSource;
use crate::schema::Worksite;
use crate::serialization::{is_worker_attribute_configuration, is_worker_attribute_definition};
use crate::utils::{has_unique_values, parse_stored_json};

/// `findWorksiteAttributes`: one Worksite's attributes in stored column order.
const FIND_WORKSITE_ATTRIBUTES: &str = "SELECT id, name, kind, options, position \
     FROM worker_attributes WHERE worksite_id = ?1 ORDER BY position, rowid";

/// The one error for a stored position that is not a non-negative integer, or that
/// is not unique across the Worksite's attributes.
fn invalid_positions() -> Error {
    Error::Message("Invalid column positions stored for worker attributes.".to_owned())
}

/// `defaultAttributeValues`: every attribute's empty value, keyed by attribute id.
pub fn default_attribute_values(attributes: &[WorkerAttributeDefinition]) -> Value {
    let mut values = serde_json::Map::new();
    for attribute in attributes {
        values.insert(attribute.id.clone(), empty_attribute_value(&attribute.kind));
    }

    Value::Object(values)
}

/// `insertWorkerAttributeValues`: one row per attribute, `null` when the update carries
/// no value for it.
pub fn insert_worker_attribute_values(
    conn: &Connection,
    worker_id: &str,
    values: &Value,
    attributes: &[WorkerAttributeDefinition],
) -> Result<()> {
    let mut insert = conn.prepare(
        "INSERT INTO worker_attribute_values (worker_id, attribute_id, value) VALUES (?1, ?2, ?3)",
    )?;
    for attribute in attributes {
        // The values are answer ids already: the request decode has checked each one.
        let value = values.get(&attribute.id).cloned().unwrap_or(Value::Null);
        insert.execute(params![
            worker_id,
            attribute.id,
            serde_json::to_string(&value)?,
        ])?;
    }

    Ok(())
}

/// A `worker_attributes` row before its `options` column is parsed and validated.
struct StoredAttribute {
    id: String,
    name: String,
    kind: String,
    options: String,
    position: i64,
}

/// `getStoredWorkerAttributes`: reads and validates the Worksite's stored attribute
/// rows, positions included. No Worksite reads nothing.
pub(crate) fn get_stored_worker_attributes(
    conn: &Connection,
    worksite: &Option<Worksite>,
) -> Result<Vec<PositionedWorkerAttributeDefinition>> {
    let Some(worksite) = worksite else {
        return Ok(Vec::new());
    };

    let mut statement = conn.prepare(FIND_WORKSITE_ATTRIBUTES)?;
    let mut rows = statement.query([&worksite.id])?;

    let mut stored: Vec<StoredAttribute> = Vec::new();
    let mut positions: Vec<i64> = Vec::new();
    while let Some(row) = rows.next()? {
        let position = match row.get_ref(4)? {
            // `Number.isInteger(row.position)`: a text or real position is invalid
            // rather than coerced, so only a SQLite integer is accepted.
            ValueRef::Integer(position) => position,
            _ => return Err(invalid_positions()),
        };
        positions.push(position);
        stored.push(StoredAttribute {
            id: row.get(0)?,
            name: row.get(1)?,
            kind: row.get(2)?,
            options: row.get(3)?,
            position,
        });
    }

    if positions.iter().any(|position| *position < 0) || !has_unique_values(&positions) {
        return Err(invalid_positions());
    }

    stored
        .into_iter()
        .map(|row| {
            let answers = answers_from_json(&parse_stored_json(
                &row.options,
                &format!("Invalid options JSON for worker attribute {}.", row.id),
            )?)
            .ok_or_else(|| {
                Error::Message(format!(
                    "Invalid options JSON for worker attribute {}.",
                    row.id
                ))
            })?;
            let definition = json!({
                "id": &row.id,
                "name": &row.name,
                "kind": &row.kind,
                "options": answers_to_json(&answers),
            });

            if !is_worker_attribute_definition(&definition) {
                return Err(Error::Message(format!(
                    "Invalid worker attribute stored for {}.",
                    row.id
                )));
            }

            Ok(PositionedWorkerAttributeDefinition {
                id: row.id,
                name: row.name,
                kind: row.kind,
                options: answers,
                position: row.position,
            })
        })
        .collect()
}

/// `getWorkerAttributes`: the stored definitions with their positions dropped, guarded
/// as one configuration. A configuration the guards reject is a corrupt database.
pub fn get_worker_attributes(
    conn: &Connection,
    worksite: &Option<Worksite>,
) -> Result<Vec<WorkerAttributeDefinition>> {
    let stored = get_stored_worker_attributes(conn, worksite)?;
    let attributes: Vec<WorkerAttributeDefinition> = stored
        .into_iter()
        .map(|definition| WorkerAttributeDefinition {
            id: definition.id,
            name: definition.name,
            kind: definition.kind,
            options: definition.options,
        })
        .collect();

    if !is_worker_attribute_configuration(&serde_json::to_value(&attributes)?) {
        return Err(Error::Message(
            "Invalid worker attribute configuration stored in the database.".to_owned(),
        ));
    }

    Ok(attributes)
}

/// `replaceWorkerAttributes`'s foreign-id check: a definition already owned by another
/// Worksite is not this Worksite's to save, and the read-only preview refuses it the same
/// way rather than reconciling a foreign id as if it were new.
pub(crate) fn reject_foreign_attribute_ids(
    conn: &Connection,
    worksite: &Worksite,
    definitions: &[WorkerAttributeDefinition],
) -> Result<()> {
    let mut find_owner = conn.prepare("SELECT worksite_id FROM worker_attributes WHERE id = ?1")?;
    for definition in definitions {
        let owner: Option<String> = find_owner
            .query_row([&definition.id], |row| row.get(0))
            .optional()?;
        if let Some(owner) = owner {
            if owner != worksite.id {
                return Err(Error::Message(format!(
                    "Worker attribute \"{}\" belongs to another Worksite.",
                    definition.id
                )));
            }
        }
    }

    Ok(())
}

/// What a Configuration Save or preview has proved it can resolve explicitly. The legacy
/// array Save carries no resolutions, so it passes [`AllowedEdits::NONE`] and keeps every
/// refusal; the preview and the resolution-aware Save pass the intents their envelope
/// proves. Tickets 12, 13 and 15 reuse the same shape rather than growing private guards.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct AllowedEdits {
    /// Remove or fold a leaf answer a saved Worker value holds (tickets 09 and 10).
    pub leaf_answers: bool,
    /// Remove an answer that still has children (ticket 12).
    #[allow(dead_code)]
    pub branch_removal: bool,
    /// Fold an answer that still has children (ticket 13).
    #[allow(dead_code)]
    pub parent_fold: bool,
    /// Remove a whole Attribute with its answers (ticket 14).
    pub definition_removal: bool,
    /// Resolve a lossy Worker cardinality change (ticket 15).
    pub cardinality: bool,
    /// Move a branch or promote an answer out of its Attribute when a saved Worker value
    /// loses an answer; the resolution names each such move.
    pub attribute_moves: bool,
    /// Trim the answers a changed select mode no longer allows (ADR 0043); the resolution
    /// names each Attribute that does.
    pub mode_changes: bool,
}

impl AllowedEdits {
    /// The legacy array Save: no explicit-resolution envelope, so no edit is proved.
    pub(crate) const NONE: Self = Self {
        leaf_answers: false,
        branch_removal: false,
        parent_fold: false,
        definition_removal: false,
        cardinality: false,
        attribute_moves: false,
        mode_changes: false,
    };

    /// The preview and the resolution-aware Save: every answer removal, branch removal,
    /// parent fold, whole Attribute removal, lossy Worker cardinality change and lossy
    /// cross-Attribute move has a resolution path.
    pub(crate) const RESOLVED: Self = Self {
        leaf_answers: true,
        branch_removal: true,
        parent_fold: true,
        definition_removal: true,
        cardinality: true,
        attribute_moves: true,
        mode_changes: true,
    };
}

/// Removing an answer or definition that a saved Worker value or draft holds cannot
/// reinterpret that saved context. Both preview and save call this guard before planning
/// any writes. `allowed` admits only the edits the caller's envelope can resolve
/// explicitly: leaf answer removal and merge (tickets 09/10), whole Attribute removal
/// (ticket 14), parent removal, parent merge and cardinality. Everything else keeps its
/// refusal.
pub(crate) fn validate_attribute_changes(
    conn: &Connection,
    worksite: &Worksite,
    existing: &[PositionedWorkerAttributeDefinition],
    definitions: &[WorkerAttributeDefinition],
    values: &StoredAttributeValues,
    allowed: AllowedEdits,
) -> Result<()> {
    // A cross-Attribute move carries its whole subtree out of the Attribute together, so
    // its branch root is not an orphaned branch even though its children leave too.
    let moves = detect_attribute_moves(existing, definitions);
    let moved: std::collections::HashSet<&str> = moves
        .iter()
        .flat_map(|detected| detected.subtree_answer_ids.iter().map(String::as_str))
        .collect();

    // An answer that still has children is a branch, not a leaf. Removing it needs the
    // explicit child handling of the parent-removal workflow, so no Save may prune it here.
    for previous in existing {
        let Some(next) = definitions
            .iter()
            .find(|definition| definition.id == previous.id)
        else {
            continue;
        };
        let proposed: std::collections::HashSet<&str> = next
            .options
            .iter()
            .map(|answer| answer.id.as_str())
            .collect();
        for answer in &previous.options {
            if proposed.contains(answer.id.as_str()) || moved.contains(answer.id.as_str()) {
                continue;
            }
            if !allowed.branch_removal
                && previous
                    .options
                    .iter()
                    .any(|candidate| candidate.parent_id.as_deref() == Some(answer.id.as_str()))
            {
                return Err(Error::coded(
                    "configuration_answer_has_children",
                    format!(
                        "An answer with children cannot be removed alone: '{}' still has children.",
                        answer.id
                    ),
                ));
            }
        }
    }

    // A move that would strip a saved Worker value needs its explicit acknowledgement, which
    // only the resolution envelope can carry. A lossless move stays allowed.
    if !allowed.attribute_moves {
        if let Some(detected) = moves
            .iter()
            .find(|detected| move_strips_a_saved_value(detected, values))
        {
            return Err(Error::coded(
                "configuration_resolution_required",
                format!(
                    "Answer \"{}\" moves out of Worker Attribute \"{}\" and would remove a saved Worker value. Resolve it through the Configuration preview.",
                    detected.answer_id, detected.source_attribute_id
                ),
            ));
        }
    }

    // A lossy Worker Multi-Select to Single-Select change needs an explicit retained answer
    // for every surface that holds several answers. The preview and resolution-aware Save
    // prove that in their envelope; the legacy array Save cannot, so it refuses instead of
    // keeping the first surviving answer silently. Single-Select to Multi-Select is
    // lossless and stays allowed.
    if !allowed.cardinality {
        for definition in definitions {
            let Some(previous) = existing.iter().find(|stored| stored.id == definition.id) else {
                continue;
            };
            if previous.kind == "category" || definition.kind != "category" {
                continue;
            }
            let lossy_value = values.values().any(|attributes| {
                attributes
                    .get(&definition.id)
                    .is_some_and(|value| recorded_answer_count(value) > 1)
            });
            if lossy_value || worker_draft_holds_several(conn, worksite, &definition.id)? {
                return Err(Error::coded(
                    "configuration_resolution_required",
                    format!("Worker Attribute cardinality cannot change while a Worker or draft records several answers: \"{}\". Resolve each answer through the Configuration preview.", definition.id),
                ));
            }
        }
    }

    // A select-mode change that trims held answers needs its explicit acknowledgement, which
    // only the resolution envelope can carry (ADR 0043).
    if !allowed.mode_changes {
        let impacts = crate::configuration_resolution::compute_mode_impacts(
            conn,
            worksite,
            existing,
            definitions,
        )?;
        if let Some(impact) = impacts.first() {
            return Err(Error::coded(
                "configuration_resolution_required",
                format!(
                    "A select-mode change in Worker Attribute \"{}\" would remove held values. Resolve it through the Configuration preview.",
                    impact.attribute_id
                ),
            ));
        }
    }

    Ok(())
}

/// The answers one stored surface records, counted without validating the shape: a value
/// the planner rejects is its own error later. Duplicates collapse, as the planner's
/// conversion does.
fn recorded_answer_count(value: &Value) -> usize {
    match value {
        Value::String(text) => usize::from(!text.is_empty()),
        Value::Array(items) => {
            let mut seen = std::collections::HashSet::new();
            items
                .iter()
                .filter_map(Value::as_str)
                .filter(|answer_id| !answer_id.is_empty())
                .filter(|answer_id| seen.insert(*answer_id))
                .count()
        }
        _ => 0,
    }
}

/// Whether a Worker draft's unfinished value for one Attribute holds several answers.
fn worker_draft_holds_several(
    conn: &Connection,
    worksite: &Worksite,
    attribute_id: &str,
) -> Result<bool> {
    let mut statement = conn.prepare("SELECT payload FROM worker_drafts WHERE worksite_id = ?1")?;
    let payloads = statement
        .query_map([&worksite.id], |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    for payload in payloads {
        let draft: Value = serde_json::from_str(&payload)?;
        if draft
            .get("update")
            .and_then(|update| update.get("attributes"))
            .and_then(|attributes| attributes.get(attribute_id))
            .is_some_and(|value| recorded_answer_count(value) > 1)
        {
            return Ok(true);
        }
    }
    Ok(false)
}

/// One Worksite's stored answer values, keyed by Worker and then by Attribute.
pub(crate) type StoredAttributeValues = HashMap<String, HashMap<String, Value>>;

/// The Workers and stored answer values the migration planner reconciles, in the order
/// the save and the preview both read them.
pub(crate) fn read_attribute_migration_inputs(
    conn: &Connection,
    worksite: &Worksite,
) -> Result<(Vec<String>, StoredAttributeValues)> {
    let worker_ids = {
        let mut statement =
            conn.prepare("SELECT id FROM workers WHERE worksite_id = ?1 ORDER BY rowid")?;
        let ids = statement
            .query_map([&worksite.id], |row| row.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<String>>>()?;
        ids
    };
    let existing_values = {
        let mut statement = conn.prepare(
            "SELECT attribute_values.worker_id, attribute_values.attribute_id, attribute_values.value \
             FROM worker_attribute_values AS attribute_values \
             JOIN workers ON workers.id = attribute_values.worker_id \
             JOIN worker_attributes ON worker_attributes.id = attribute_values.attribute_id \
             WHERE workers.worksite_id = ?1 \
               AND worker_attributes.worksite_id = workers.worksite_id",
        )?;
        let mut rows = statement.query([&worksite.id])?;
        let mut values = StoredAttributeValues::new();
        while let Some(row) = rows.next()? {
            let worker_id: String = row.get(0)?;
            let attribute_id: String = row.get(1)?;
            let raw: String = row.get(2)?;
            let stored = parse_stored_json(
                &raw,
                &format!(
                    "Invalid attribute value JSON for worker {worker_id}, attribute {attribute_id}."
                ),
            )?;
            values
                .entry(worker_id)
                .or_default()
                .insert(attribute_id, stored);
        }
        values
    };

    Ok((worker_ids, existing_values))
}

/// `replaceWorkerAttributes`: rejects a foreign id, then reconciles the Worksite's
/// attributes and their values with `definitions` in one deferred transaction, and
/// returns the stored configuration the replace left behind.
pub fn replace_worker_attributes(
    conn: &Connection,
    worksite: &Worksite,
    definitions: &[WorkerAttributeDefinition],
    id_source: &impl IdSource,
) -> Result<Vec<WorkerAttributeDefinition>> {
    replace_worker_attributes_in("en", conn, worksite, definitions, id_source)
}

/// `replace_worker_attributes` generating Short forms under the lists of `locale`.
pub fn replace_worker_attributes_in(
    locale: &str,
    conn: &Connection,
    worksite: &Worksite,
    definitions: &[WorkerAttributeDefinition],
    id_source: &impl IdSource,
) -> Result<Vec<WorkerAttributeDefinition>> {
    // The foreign-id check sits outside the transaction: it rejects before any write.
    reject_foreign_attribute_ids(conn, worksite, definitions)?;

    // Deferred, unlike create_worksite's Immediate: `db.transaction()` in the TS is
    // deferred by default. `new_unchecked` keeps the `&Connection` signature.
    let tx = Transaction::new_unchecked(conn, TransactionBehavior::Deferred)?;

    let existing = get_stored_worker_attributes(&tx, &Some(worksite.clone()))?;
    let (worker_ids, existing_values) = read_attribute_migration_inputs(&tx, worksite)?;

    validate_attribute_changes(
        &tx,
        worksite,
        &existing,
        definitions,
        &existing_values,
        AllowedEdits::NONE,
    )?;
    // A bundled lists revision newer than the Worksite's stored one regenerates
    // every still-generated Short form once (ADR 0046, ticket 05); the revision is
    // recorded after the plan below commits.
    let lists_current = crate::abbreviation_revision::lists_current(conn, &worksite.id)?;
    let plan = compute_attribute_migration_plan_in(
        locale,
        &existing,
        &worker_ids,
        &existing_values,
        definitions,
        lists_current,
    )?;
    apply_attribute_migration_plan(&tx, worksite, &plan, id_source)?;
    strip_moved_worker_drafts(
        &tx,
        worksite,
        &detect_attribute_moves(&existing, definitions),
    )?;
    crate::configuration_resolution::rewrite_worker_drafts_for_kind_changes(
        &tx,
        worksite,
        &existing,
        definitions,
    )?;
    crate::configuration_resolution::rewrite_worker_drafts_for_modes(
        &tx,
        worksite,
        &existing,
        definitions,
    )?;
    tx.commit()?;
    // Only the save that observes a stale revision records the new one, so a steady-state
    // save writes nothing it does not have to (a no-op UPDATE would still count as a write).
    if !lists_current {
        crate::abbreviation_revision::mark_lists_current(conn, &worksite.id)?;
    }

    get_worker_attributes(conn, &Some(worksite.clone()))
}

/// `saveWorkerAttributeValues`: the worker's rows go, then the whole object is written
/// back. The `IN (SELECT …)` halves are the same-Worksite guards; the callers already
/// hold a transaction.
pub fn save_worker_attribute_values(
    conn: &Connection,
    worksite: &Worksite,
    worker_id: &str,
    values: &Value,
    attributes: &[WorkerAttributeDefinition],
) -> Result<()> {
    conn.execute(
        "DELETE FROM worker_attribute_values \
         WHERE worker_id = ?1 \
           AND worker_id IN (SELECT id FROM workers WHERE worksite_id = ?2) \
           AND attribute_id IN (
             SELECT id FROM worker_attributes WHERE worksite_id = ?2
           )",
        params![worker_id, worksite.id],
    )?;

    insert_worker_attribute_values(conn, worker_id, values, attributes)
}

/// `saveWorkerAttributeValue`: one value, written only when the worker and the attribute
/// both belong to this Worksite. The TS wraps this one in its own transaction.
pub fn save_worker_attribute_value(
    conn: &Connection,
    worksite: &Worksite,
    worker_id: &str,
    attribute_id: &str,
    value: &Value,
) -> Result<()> {
    let tx = Transaction::new_unchecked(conn, TransactionBehavior::Deferred)?;
    tx.execute(
        "INSERT INTO worker_attribute_values (worker_id, attribute_id, value) \
         SELECT ?1, ?2, ?3 \
         WHERE EXISTS (SELECT 1 FROM workers WHERE id = ?4 AND worksite_id = ?5) \
           AND EXISTS (SELECT 1 FROM worker_attributes WHERE id = ?6 AND worksite_id = ?7) \
         ON CONFLICT(worker_id, attribute_id) DO UPDATE SET value = excluded.value",
        params![
            worker_id,
            attribute_id,
            serde_json::to_string(value)?,
            worker_id,
            worksite.id,
            attribute_id,
            worksite.id,
        ],
    )?;

    tx.commit()?;

    Ok(())
}

/// `applyAttributeMigrationPlan`: deletes, blanks the renamed survivors, upserts the
/// definitions, then upserts the values — in that order, in one transaction.
pub(crate) fn apply_attribute_migration_plan(
    conn: &Connection,
    worksite: &Worksite,
    plan: &AttributeMigrationPlan,
    id_source: &impl IdSource,
) -> Result<()> {
    {
        let mut delete =
            conn.prepare("DELETE FROM worker_attributes WHERE id = ?1 AND worksite_id = ?2")?;
        for id in &plan.delete_definition_ids {
            delete.execute(params![id, worksite.id])?;
        }
    }

    {
        let mut blank = conn
            .prepare("UPDATE worker_attributes SET name = ?1 WHERE id = ?2 AND worksite_id = ?3")?;
        for id in &plan.blank_name_ids {
            // `__updating_${randomUUID()}`: the parking name is thrown away by the
            // upsert below, but the id is still minted so the counter the recorder
            // stubbed stays in lock-step with this port.
            let parking_name = format!("__updating_{}", id_source.next_id());
            blank.execute(params![parking_name, id, worksite.id])?;
        }
    }

    {
        let mut upsert = conn.prepare(
            "INSERT INTO worker_attributes (id, worksite_id, name, kind, options, position) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6) \
             ON CONFLICT(id) DO UPDATE SET \
               name = excluded.name, \
               kind = excluded.kind, \
               options = excluded.options, \
               position = excluded.position \
             WHERE worker_attributes.worksite_id = excluded.worksite_id",
        )?;
        for attribute in &plan.upsert_definitions {
            upsert.execute(params![
                attribute.id,
                worksite.id,
                attribute.name,
                attribute.kind,
                answers_to_json(&attribute.options).to_string(),
                attribute.position,
            ])?;
        }
    }

    {
        let mut upsert = conn.prepare(
            "INSERT INTO worker_attribute_values (worker_id, attribute_id, value) \
             VALUES (?1, ?2, ?3) \
             ON CONFLICT(worker_id, attribute_id) DO UPDATE SET value = excluded.value",
        )?;
        for write in &plan.value_writes {
            upsert.execute(params![
                write.worker_id,
                write.attribute_id,
                serde_json::to_string(&write.value)?,
            ])?;
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::worker_persistence::insert_bare_worker;

    use crate::attribute_migration::StoredAnswer;
    use crate::db::{open_seeded, Db};
    use crate::id::{counter_id, CounterId};
    use crate::worksite_persistence::resolve_active_worksite;

    fn seeded() -> (Db, CounterId, Worksite) {
        let ids = CounterId::new();
        let db = open_seeded(":memory:", &ids).unwrap();
        let worksite = resolve_active_worksite(db.conn(), None).unwrap().unwrap();
        (db, ids, worksite)
    }

    fn attribute(id: &str, name: &str, kind: &str, options: &[&str]) -> WorkerAttributeDefinition {
        WorkerAttributeDefinition {
            id: id.to_owned(),
            name: name.to_owned(),
            kind: kind.to_owned(),
            options: options
                .iter()
                .map(|option| StoredAnswer {
                    id: format!("{id}:{option}"),
                    value: (*option).to_owned(),
                    parent_id: None,
                    mode: None,
                    short_form: None,
                    short_form_origin: None,
                    abbreviation: None,
                    abbreviation_origin: None,
                    merged_into: None,
                })
                .collect(),
        }
    }

    /// The Seed ships attributes without options; tests that store values need some.
    fn give_department_options(conn: &Connection) {
        conn.execute(
            "UPDATE worker_attributes SET options = '[{\"id\":\"dept-front\",\"value\":\"Front of House\"},{\"id\":\"dept-back\",\"value\":\"Back of House\"},{\"id\":\"dept-middle\",\"value\":\"Middle of House\"}]' WHERE name = 'Department'",
            [],
        )
        .unwrap();
    }

    fn add_worker(conn: &Connection, worksite_id: &str, id: &str) {
        insert_bare_worker(conn, worksite_id, id, "W", "");
    }

    fn set_value(conn: &Connection, worker_id: &str, attribute_id: &str, value: &Value) {
        conn.execute(
            "INSERT INTO worker_attribute_values (worker_id, attribute_id, value) VALUES (?1, ?2, ?3)",
            params![worker_id, attribute_id, serde_json::to_string(value).unwrap()],
        )
        .unwrap();
    }

    fn total_changes(conn: &Connection) -> i64 {
        conn.query_row("SELECT total_changes()", [], |row| row.get(0))
            .unwrap()
    }

    fn stored_name(conn: &Connection, id: &str) -> Option<String> {
        conn.query_row(
            "SELECT name FROM worker_attributes WHERE id = ?1",
            params![id],
            |row| row.get(0),
        )
        .optional()
        .unwrap()
    }

    fn stored_kind_and_options(conn: &Connection, id: &str) -> Option<(String, String)> {
        conn.query_row(
            "SELECT kind, options FROM worker_attributes WHERE id = ?1",
            params![id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .unwrap()
    }

    fn stored_value(conn: &Connection, worker_id: &str, attribute_id: &str) -> Option<Value> {
        conn.query_row(
            "SELECT value FROM worker_attribute_values WHERE worker_id = ?1 AND attribute_id = ?2",
            params![worker_id, attribute_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .unwrap()
        .map(|raw| serde_json::from_str(&raw).unwrap())
    }

    fn attribute_ids(conn: &Connection, worksite_id: &str) -> Vec<String> {
        let mut statement = conn
            .prepare(
                "SELECT id FROM worker_attributes WHERE worksite_id = ?1 ORDER BY position, rowid",
            )
            .unwrap();
        statement
            .query_map([worksite_id], |row| row.get::<_, String>(0))
            .unwrap()
            .collect::<rusqlite::Result<Vec<String>>>()
            .unwrap()
    }

    #[test]
    fn reads_the_seeded_configuration_and_nothing_for_no_worksite() {
        let (db, _ids, worksite) = seeded();

        let expected = vec![
            attribute(&counter_id(2), "Department", "category", &[]),
            attribute(&counter_id(3), "Role", "category", &[]),
            attribute(&counter_id(4), "Shifts", "tag", &[]),
        ];

        assert_eq!(
            get_worker_attributes(db.conn(), &Some(worksite.clone())).unwrap(),
            expected
        );
        assert_eq!(get_worker_attributes(db.conn(), &None).unwrap(), Vec::new());
    }

    #[test]
    fn re_saves_an_unchanged_configuration_without_writing_anything() {
        let (db, _ids, worksite) = seeded();
        add_worker(db.conn(), &worksite.id, "w1");
        let before = total_changes(db.conn());

        let attributes = get_worker_attributes(db.conn(), &Some(worksite.clone())).unwrap();
        let replaced =
            replace_worker_attributes(db.conn(), &worksite, &attributes, &CounterId::new())
                .unwrap();

        assert_eq!(replaced, attributes);
        assert_eq!(total_changes(db.conn()), before);
    }

    #[test]
    fn renames_an_attribute_without_touching_its_values() {
        let (db, _ids, worksite) = seeded();
        add_worker(db.conn(), &worksite.id, "w1");
        let department = counter_id(2);
        set_value(db.conn(), "w1", &department, &json!("dept-front"));

        let attributes = get_worker_attributes(db.conn(), &Some(worksite.clone())).unwrap();
        let renamed: Vec<WorkerAttributeDefinition> = attributes
            .into_iter()
            .map(|candidate| {
                if candidate.id == department {
                    WorkerAttributeDefinition {
                        name: "Renamed".to_owned(),
                        ..candidate
                    }
                } else {
                    candidate
                }
            })
            .collect();

        let before = total_changes(db.conn());
        replace_worker_attributes(db.conn(), &worksite, &renamed, &CounterId::new()).unwrap();

        assert_eq!(stored_name(db.conn(), &department).unwrap(), "Renamed");
        assert_eq!(
            stored_value(db.conn(), "w1", &department),
            Some(json!("dept-front"))
        );
        // The blank-name parking update plus the definition upsert, and nothing else.
        assert_eq!(total_changes(db.conn()), before + 2);
    }

    #[test]
    fn seeds_empty_values_for_a_new_attribute_on_every_worker() {
        let (db, _ids, worksite) = seeded();
        add_worker(db.conn(), &worksite.id, "w1");
        add_worker(db.conn(), &worksite.id, "w2");
        let mut incoming = get_worker_attributes(db.conn(), &Some(worksite.clone())).unwrap();
        incoming.push(attribute("new-attribute", "New Attribute", "tag", &["x"]));

        let before = total_changes(db.conn());
        replace_worker_attributes(db.conn(), &worksite, &incoming, &CounterId::new()).unwrap();

        assert!(attribute_ids(db.conn(), &worksite.id).contains(&"new-attribute".to_owned()));
        assert_eq!(
            stored_value(db.conn(), "w1", "new-attribute"),
            Some(json!([]))
        );
        assert_eq!(
            stored_value(db.conn(), "w2", "new-attribute"),
            Some(json!([]))
        );
        // One definition upsert plus one value upsert per worker.
        assert_eq!(total_changes(db.conn()), before + 3);
    }

    #[test]
    fn deletes_a_definition_and_cascades_its_values_away() {
        let (db, _ids, worksite) = seeded();
        add_worker(db.conn(), &worksite.id, "w1");
        let department = counter_id(2);
        set_value(db.conn(), "w1", &department, &json!("dept-front"));

        let kept: Vec<WorkerAttributeDefinition> =
            get_worker_attributes(db.conn(), &Some(worksite.clone()))
                .unwrap()
                .into_iter()
                .filter(|candidate| candidate.id != department)
                .collect();
        replace_worker_attributes(db.conn(), &worksite, &kept, &CounterId::new()).unwrap();

        assert!(!attribute_ids(db.conn(), &worksite.id).contains(&department));
        assert_eq!(stored_value(db.conn(), "w1", &department), None);
    }

    #[test]
    fn converts_a_category_value_to_a_tag_value_end_to_end() {
        let (db, _ids, worksite) = seeded();
        give_department_options(db.conn());
        add_worker(db.conn(), &worksite.id, "w1");
        let department = counter_id(2);
        set_value(db.conn(), "w1", &department, &json!("dept-front"));

        let converted: Vec<WorkerAttributeDefinition> =
            get_worker_attributes(db.conn(), &Some(worksite.clone()))
                .unwrap()
                .into_iter()
                .map(|candidate| {
                    if candidate.id == department {
                        WorkerAttributeDefinition {
                            kind: "tag".to_owned(),
                            ..candidate
                        }
                    } else {
                        candidate
                    }
                })
                .collect();
        replace_worker_attributes(db.conn(), &worksite, &converted, &CounterId::new()).unwrap();

        assert_eq!(
            stored_value(db.conn(), "w1", &department),
            Some(json!(["dept-front"]))
        );
    }

    #[test]
    fn rejects_a_definition_owned_by_another_worksite() {
        let (db, _ids, worksite) = seeded();
        db.conn()
            .execute(
                "INSERT INTO worksites (id, name, committee_target) VALUES ('other', 'Other', 5)",
                [],
            )
            .unwrap();
        db.conn()
            .execute(
                "INSERT INTO worker_attributes (id, worksite_id, name, kind, options, position) \
                 VALUES ('shared', 'other', 'Shared', 'category', '[]', 0)",
                [],
            )
            .unwrap();

        let error = replace_worker_attributes(
            db.conn(),
            &worksite,
            &[attribute("shared", "Shared", "category", &[])],
            &CounterId::new(),
        )
        .unwrap_err();

        assert!(
            matches!(error, Error::Message(message) if message == "Worker attribute \"shared\" belongs to another Worksite.")
        );
        assert!(!attribute_ids(db.conn(), &worksite.id).contains(&"shared".to_owned()));
    }

    #[test]
    fn aborts_the_replace_when_a_stored_value_is_invalid_for_its_previous_kind() {
        let (db, _ids, worksite) = seeded();
        give_department_options(db.conn());
        add_worker(db.conn(), &worksite.id, "w1");
        let department = counter_id(2);
        set_value(db.conn(), "w1", &department, &json!("INVALID"));

        let converted: Vec<WorkerAttributeDefinition> =
            get_worker_attributes(db.conn(), &Some(worksite.clone()))
                .unwrap()
                .into_iter()
                .map(|candidate| {
                    if candidate.id == department {
                        WorkerAttributeDefinition {
                            kind: "tag".to_owned(),
                            ..candidate
                        }
                    } else {
                        candidate
                    }
                })
                .collect();

        let error = replace_worker_attributes(db.conn(), &worksite, &converted, &CounterId::new())
            .unwrap_err();

        assert!(
            matches!(error, Error::Message(message) if message == format!("Invalid value stored for worker attribute {department}."))
        );
        assert_eq!(
            stored_kind_and_options(db.conn(), &department),
            Some((
                "category".to_owned(),
                "[{\"id\":\"dept-front\",\"value\":\"Front of House\"},{\"id\":\"dept-back\",\"value\":\"Back of House\"},{\"id\":\"dept-middle\",\"value\":\"Middle of House\"}]".to_owned()
            ))
        );
    }

    #[test]
    fn blanks_a_renamed_attribute_by_consuming_one_counter_id() {
        let (db, ids, worksite) = seeded();
        let renamed: Vec<WorkerAttributeDefinition> =
            get_worker_attributes(db.conn(), &Some(worksite.clone()))
                .unwrap()
                .into_iter()
                .enumerate()
                .map(|(index, candidate)| {
                    if index == 0 {
                        WorkerAttributeDefinition {
                            name: "Renamed".to_owned(),
                            ..candidate
                        }
                    } else {
                        candidate
                    }
                })
                .collect();

        replace_worker_attributes(db.conn(), &worksite, &renamed, &ids).unwrap();

        // 1-4 were the seed; the blank-name parking name took 5, so the next is 6.
        assert_eq!(ids.next_id(), counter_id(6));
    }

    #[test]
    fn rejects_a_stored_position_that_is_negative_duplicated_or_not_an_integer() {
        let department = counter_id(2);
        let role = counter_id(3);
        let statements = [
            format!("UPDATE worker_attributes SET position = -1 WHERE id = '{department}'"),
            format!("UPDATE worker_attributes SET position = 0 WHERE id = '{role}'"),
            format!("UPDATE worker_attributes SET position = 1.5 WHERE id = '{role}'"),
        ];

        for statement in statements {
            let (db, _ids, worksite) = seeded();
            db.conn().execute_batch(&statement).unwrap();

            let error = get_worker_attributes(db.conn(), &Some(worksite.clone())).unwrap_err();

            assert!(
                matches!(error, Error::Message(message) if message == "Invalid column positions stored for worker attributes."),
                "statement {statement} did not report invalid positions"
            );
        }
    }

    #[test]
    fn reports_invalid_options_json_with_the_offending_id() {
        let (db, _ids, worksite) = seeded();
        let department = counter_id(2);
        // The v12 DDL's `CHECK (json_valid(options))` makes this unreachable in a
        // healthy database; the pragma is a test-only way to reach the guard.
        db.conn()
            .execute_batch("PRAGMA ignore_check_constraints = ON;")
            .unwrap();
        db.conn()
            .execute(
                "UPDATE worker_attributes SET options = '{' WHERE id = ?1",
                params![department],
            )
            .unwrap();

        let error = get_worker_attributes(db.conn(), &Some(worksite.clone())).unwrap_err();

        assert!(
            matches!(error, Error::Message(message) if message == format!("Invalid options JSON for worker attribute {department}."))
        );
    }

    #[test]
    fn reports_a_stored_definition_the_guard_rejects() {
        let (db, _ids, worksite) = seeded();
        let department = counter_id(2);
        db.conn()
            .execute(
                "UPDATE worker_attributes SET name = '   ' WHERE id = ?1",
                params![department],
            )
            .unwrap();

        let error = get_worker_attributes(db.conn(), &Some(worksite.clone())).unwrap_err();

        assert!(
            matches!(error, Error::Message(message) if message == format!("Invalid worker attribute stored for {department}."))
        );
    }

    #[test]
    fn reports_a_stored_configuration_whose_names_collide_once_trimmed() {
        let (db, _ids, worksite) = seeded();
        let role = counter_id(3);
        // `UNIQUE (worksite_id, name) COLLATE NOCASE` does not trim, so padding gets
        // this row past the constraint and into the configuration guard.
        db.conn()
            .execute(
                "UPDATE worker_attributes SET name = 'Department ' WHERE id = ?1",
                params![role],
            )
            .unwrap();

        let error = get_worker_attributes(db.conn(), &Some(worksite.clone())).unwrap_err();

        assert!(
            matches!(error, Error::Message(message) if message == "Invalid worker attribute configuration stored in the database.")
        );
    }

    #[test]
    fn reports_invalid_attribute_value_json_before_planning() {
        let (db, _ids, worksite) = seeded();
        let department = counter_id(2);
        add_worker(db.conn(), &worksite.id, "w1");
        db.conn()
            .execute_batch("PRAGMA ignore_check_constraints = ON;")
            .unwrap();
        db.conn()
            .execute(
                "INSERT INTO worker_attribute_values (worker_id, attribute_id, value) VALUES ('w1', ?1, '{')",
                params![department],
            )
            .unwrap();

        let error = replace_worker_attributes(
            db.conn(),
            &worksite,
            &get_worker_attributes(db.conn(), &Some(worksite.clone())).unwrap(),
            &CounterId::new(),
        )
        .unwrap_err();

        assert!(
            matches!(error, Error::Message(message) if message == format!("Invalid attribute value JSON for worker w1, attribute {department}."))
        );
    }
}
