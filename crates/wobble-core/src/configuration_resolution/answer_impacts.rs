use super::attribute_moves::moved_answer_ids;
use super::*;

/// One removed or folded answer of an Attribute: the stored answer id and the kept answers
/// its holders may choose instead.
pub(super) struct AnswerChange {
    pub(super) attribute_id: String,
    pub(super) answer_id: String,
    pub(super) merge_into: Option<String>,
    pub(super) replacements: Vec<String>,
    pub(super) kind: String,
}

/// The answers the proposal removes or folds. A kind conversion is its own workflow, so it
/// never reports holder rows here.
pub(super) fn answer_changes(
    previous: &[PositionedWorkerAttributeDefinition],
    definitions: &[WorkerAttributeDefinition],
) -> Vec<AnswerChange> {
    let mut changes = Vec::new();
    // A cross-Attribute move or a promotion leaves its answer id in place, so it is never a
    // removal whose holders pick a replacement.
    let moved = moved_answer_ids(previous, definitions);

    for previous_attribute in previous {
        let Some(next) = definitions
            .iter()
            .find(|definition| definition.id == previous_attribute.id)
        else {
            // Removing the whole Attribute has its own explicit workflow.
            continue;
        };
        if next.kind != previous_attribute.kind {
            // A kind change is refused or resolved by its own workflow.
            continue;
        }

        let kept: Vec<&str> = next
            .options
            .iter()
            .filter(|answer| answer.merged_into.is_none())
            .map(|answer| answer.id.as_str())
            .collect();
        let proposed: HashMap<&str, &crate::attribute_migration::StoredAnswer> = next
            .options
            .iter()
            .map(|answer| (answer.id.as_str(), answer))
            .collect();

        for answer in &previous_attribute.options {
            match proposed.get(answer.id.as_str()).copied() {
                None if moved.contains(&answer.id) => {}
                None => changes.push(AnswerChange {
                    attribute_id: previous_attribute.id.clone(),
                    answer_id: answer.id.clone(),
                    merge_into: None,
                    replacements: kept
                        .iter()
                        .filter(|id| **id != answer.id)
                        .map(|id| (*id).to_owned())
                        .collect(),
                    kind: next.kind.clone(),
                }),
                Some(proposed_answer) => {
                    let Some(survivor) = proposed_answer.merged_into.as_ref() else {
                        continue;
                    };
                    changes.push(AnswerChange {
                        attribute_id: previous_attribute.id.clone(),
                        answer_id: answer.id.clone(),
                        merge_into: Some(survivor.clone()),
                        replacements: vec![survivor.clone()],
                        kind: next.kind.clone(),
                    });
                }
            }
        }
    }

    changes
}

/// Every holder of every changed leaf answer, with the replacement outcomes each offers.
/// A merge's holders each offer exactly the surviving answer. A Worker-scoped holder is the
/// Worker's saved value or one of its draft's two surfaces.
pub fn compute_answer_impacts(
    conn: &Connection,
    worksite: &Worksite,
    previous: &[PositionedWorkerAttributeDefinition],
    definitions: &[WorkerAttributeDefinition],
) -> Result<Vec<RemovedAnswerImpact>> {
    let changes = answer_changes(previous, definitions);
    if changes.is_empty() {
        return Ok(Vec::new());
    }

    let worker_names = read_worker_names(conn, worksite)?;
    build_impacts(conn, worksite, previous, &changes, &worker_names)
}

/// The one answer-resolution step shared by the preview's replacement outcomes and the
/// Save's writes: replace the removed answer when the value holds it, or drop it for a
/// no-answer resolution. A category stores one answer; a tag keeps its recorded order and
/// deduplicates after the replacement, like the migration planner.
pub(super) fn apply_worker_answer_resolution(
    value: &Value,
    answer_id: &str,
    replacement: Option<&str>,
    kind: &str,
) -> Value {
    // A Single-Select Attribute stores a string until one of its values is Multi-Select
    // (ADR 0043), so the stored shape, not the kind, says which way to resolve.
    if let Value::String(held) = value {
        return if held == answer_id {
            Value::String(replacement.unwrap_or_default().to_owned())
        } else {
            value.clone()
        };
    }
    let _ = kind;

    let Value::Array(items) = value else {
        return value.clone();
    };
    let mut seen: HashSet<String> = HashSet::new();
    let mut resulting = Vec::new();
    for item in items {
        let Some(id) = item.as_str() else {
            return value.clone();
        };
        if id == answer_id {
            if let Some(replacement) = replacement {
                if seen.insert(replacement.to_owned()) {
                    resulting.push(Value::String(replacement.to_owned()));
                }
            }
        } else if seen.insert(id.to_owned()) {
            resulting.push(Value::String(id.to_owned()));
        }
    }
    Value::Array(resulting)
}

/// The answer ids a stored value holds, for the empty-holder reading. The value was already
/// validated by `value_answer_ids`.
pub(super) fn value_ids(value: &Value) -> Vec<&str> {
    match value {
        Value::String(text) if !text.is_empty() => vec![text.as_str()],
        Value::Array(items) => items.iter().filter_map(Value::as_str).collect(),
        _ => Vec::new(),
    }
}

/// One Worker value or Worker draft surface row of a changed answer.
pub(super) fn worker_holder_impact(
    worker_id: String,
    worker_name: String,
    kind: &'static str,
    surface: Option<&'static str>,
    value: &Value,
    held: &[String],
    change: &AnswerChange,
) -> HolderImpact {
    let replacements = change
        .replacements
        .iter()
        .map(|replacement| ReplacementOutcome {
            answer_id: replacement.clone(),
            resulting_value: Some(apply_worker_answer_resolution(
                value,
                &change.answer_id,
                Some(replacement),
                &change.kind,
            )),
        })
        .collect();
    let distinct_held: HashSet<&str> = held.iter().map(String::as_str).collect();

    HolderImpact {
        worker_id,
        worker_name,
        kind,
        surface,
        empty_if_unanswered: change.merge_into.is_none() && distinct_held.len() == 1,
        value: Some(value.clone()),
        replacements,
    }
}

/// Every saved Worker value and Worker draft surface that holds a changed answer. A draft's
/// update and base are independent surfaces, so each gets its own row; a merge offers only
/// the survivor.
fn build_impacts(
    conn: &Connection,
    worksite: &Worksite,
    previous_definitions: &[PositionedWorkerAttributeDefinition],
    changes: &[AnswerChange],
    worker_names: &HashMap<String, String>,
) -> Result<Vec<RemovedAnswerImpact>> {
    let (worker_ids, values) = read_attribute_migration_inputs(conn, worksite)?;
    let worker_drafts = read_stored_worker_drafts(conn, worksite)?;
    let mut impacts = Vec::new();

    for change in changes {
        let previous = previous_definitions
            .iter()
            .find(|attribute| attribute.id == change.attribute_id)
            .expect("an answer change names a stored Attribute");
        let mut holders = Vec::new();
        let mut affected_workers: BTreeSet<String> = BTreeSet::new();
        let mut affected_draft_workers: BTreeSet<String> = BTreeSet::new();
        let mut saved_values = 0;
        let mut draft_values = 0;

        for worker_id in &worker_ids {
            let Some(value) = values
                .get(worker_id)
                .and_then(|held| held.get(&change.attribute_id))
                .filter(|value| !value.is_null())
            else {
                continue;
            };
            let held = value_answer_ids(value, previous)?;
            if !held.iter().any(|id| id == &change.answer_id) {
                continue;
            }
            saved_values += 1;
            affected_workers.insert(worker_id.clone());
            holders.push(worker_holder_impact(
                worker_id.clone(),
                worker_names
                    .get(worker_id)
                    .cloned()
                    .unwrap_or_else(|| worker_id.clone()),
                WORKER_HOLDER,
                None,
                value,
                &held,
                change,
            ));
        }

        for draft in &worker_drafts {
            for (surface, held_value) in [
                (WORKER_DRAFT_SURFACE, draft.update.get(&change.attribute_id)),
                (WORKER_BASE_SURFACE, draft.base.get(&change.attribute_id)),
            ] {
                let Some(value) = held_value.filter(|value| value_is_known(value)) else {
                    continue;
                };
                let held = value_answer_ids(value, previous)?;
                if !held.iter().any(|id| id == &change.answer_id) {
                    continue;
                }
                draft_values += 1;
                affected_workers.insert(draft.worker_id.clone());
                affected_draft_workers.insert(draft.worker_id.clone());
                holders.push(worker_holder_impact(
                    draft.worker_id.clone(),
                    if draft.name.is_empty() {
                        worker_names
                            .get(&draft.worker_id)
                            .cloned()
                            .unwrap_or_else(|| draft.worker_id.clone())
                    } else {
                        draft.name.clone()
                    },
                    WORKER_DRAFT_HOLDER,
                    Some(surface),
                    value,
                    &held,
                    change,
                ));
            }
        }

        let empty_if_unanswered = change.merge_into.is_none()
            && holders
                .iter()
                .filter(|holder| holder.kind == WORKER_HOLDER)
                .flat_map(|holder| holder.value.iter())
                .flat_map(value_ids)
                .collect::<HashSet<_>>()
                .len()
                == 1;
        for holder in &mut holders {
            holder.empty_if_unanswered = empty_if_unanswered;
        }

        impacts.push(RemovedAnswerImpact {
            attribute_id: change.attribute_id.clone(),
            answer_id: change.answer_id.clone(),
            merge_into: change.merge_into.clone(),
            affected_workers: affected_workers.len(),
            affected_drafts: affected_draft_workers.len(),
            // A merge preserves every holder by moving it to the survivor.
            removed_values: if change.merge_into.is_some() {
                0
            } else {
                saved_values + draft_values
            },
            holders,
        });
    }

    Ok(impacts)
}
