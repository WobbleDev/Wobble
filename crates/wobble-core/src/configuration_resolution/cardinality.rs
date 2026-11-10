use super::*;

/// Whether a stored or draft value records at least one answer.
pub(super) fn value_is_known(value: &Value) -> bool {
    match value {
        Value::String(text) => !text.is_empty(),
        Value::Array(items) => items
            .iter()
            .filter_map(Value::as_str)
            .any(|id| !id.is_empty()),
        _ => false,
    }
}

/// The answer ids a stored Worker value holds, validated against its stored definition.
pub(super) fn value_answer_ids(
    value: &Value,
    attribute: &PositionedWorkerAttributeDefinition,
) -> Result<Vec<String>> {
    if value.is_null() {
        return Ok(Vec::new());
    }
    let definition = serde_json::json!({
        "id": attribute.id,
        "name": attribute.name,
        "kind": attribute.kind,
        "options": answers_to_json(&attribute.options),
    });
    if !is_worker_attribute_value(value, &definition) {
        return Err(Error::Message(format!(
            "Invalid value stored for worker attribute {}.",
            attribute.id
        )));
    }

    Ok(match value {
        Value::String(text) if !text.is_empty() => vec![text.clone()],
        Value::Array(items) => items
            .iter()
            .filter_map(Value::as_str)
            .map(str::to_owned)
            .collect(),
        _ => Vec::new(),
    })
}

/// Maps one surface's recorded answer ids through the proposal's folds and keeps only the
/// answers it keeps, deduplicated in recorded order. This is the reduction the migration
/// planner applies to a saved value before a Single-Select keeps one answer.
pub(super) fn surviving_answer_ids(
    value: &Value,
    previous: &PositionedWorkerAttributeDefinition,
    next: &WorkerAttributeDefinition,
) -> Result<Vec<String>> {
    let recorded = value_answer_ids(value, previous)?;
    let folds: HashMap<&str, &str> = next
        .options
        .iter()
        .filter_map(|answer| {
            answer
                .merged_into
                .as_deref()
                .map(|survivor| (answer.id.as_str(), survivor))
        })
        .collect();
    let kept: HashSet<&str> = next
        .options
        .iter()
        .filter(|answer| answer.merged_into.is_none())
        .map(|answer| answer.id.as_str())
        .collect();
    let mut seen = HashSet::new();
    Ok(recorded
        .into_iter()
        .map(|answer_id| {
            folds
                .get(answer_id.as_str())
                .map_or(answer_id, |survivor| (*survivor).to_owned())
        })
        .filter(|answer_id| kept.contains(answer_id.as_str()))
        .filter(|answer_id| seen.insert(answer_id.clone()))
        .collect())
}

/// Every Multi-Select to Single-Select change whose saved value or Worker draft holds
/// several answers. The reverse conversion is lossless and reports nothing.
pub fn compute_cardinality_impacts(
    conn: &Connection,
    worksite: &Worksite,
    previous: &[PositionedWorkerAttributeDefinition],
    definitions: &[WorkerAttributeDefinition],
) -> Result<Vec<CardinalityImpact>> {
    let changes: Vec<(
        &PositionedWorkerAttributeDefinition,
        &WorkerAttributeDefinition,
    )> = previous
        .iter()
        .filter_map(|attribute| {
            let next = definitions
                .iter()
                .find(|definition| definition.id == attribute.id)?;
            (attribute.kind != "category" && next.kind == "category").then_some((attribute, next))
        })
        .collect();
    if changes.is_empty() {
        return Ok(Vec::new());
    }

    let (worker_ids, values) = read_attribute_migration_inputs(conn, worksite)?;
    let worker_drafts = read_stored_worker_drafts(conn, worksite)?;
    let worker_names = read_worker_names(conn, worksite)?;
    let mut impacts = Vec::new();

    for (attribute, next) in changes {
        let mut holders = Vec::new();
        for worker_id in &worker_ids {
            let held = match values
                .get(worker_id)
                .and_then(|held| held.get(&attribute.id))
                .filter(|value| !value.is_null())
            {
                Some(value) => surviving_answer_ids(value, attribute, next)?,
                None => Vec::new(),
            };
            if held.len() < 2 {
                continue;
            }
            let has_draft = worker_drafts
                .iter()
                .any(|draft| draft.worker_id == *worker_id);
            holders.push(CardinalityHolderImpact {
                worker_id: worker_id.clone(),
                worker_name: worker_names
                    .get(worker_id)
                    .cloned()
                    .unwrap_or_else(|| worker_id.clone()),
                surface: VALUE_SURFACE,
                held,
                has_draft,
            });
        }

        // Draft update and base are independent of each other and of the saved value: an
        // unfinished edit may hold different sets, so each lossy surface needs its choice.
        for draft in &worker_drafts {
            for (surface, values) in [
                (WORKER_DRAFT_SURFACE, &draft.update),
                (WORKER_BASE_SURFACE, &draft.base),
            ] {
                let Some(value) = values.get(&attribute.id) else {
                    continue;
                };
                let held = if value.is_null() {
                    Vec::new()
                } else {
                    surviving_answer_ids(value, attribute, next)?
                };
                if held.len() < 2 {
                    continue;
                }
                holders.push(CardinalityHolderImpact {
                    worker_id: draft.worker_id.clone(),
                    worker_name: if draft.name.is_empty() {
                        worker_names
                            .get(&draft.worker_id)
                            .cloned()
                            .unwrap_or_else(|| draft.worker_id.clone())
                    } else {
                        draft.name.clone()
                    },
                    surface,
                    held,
                    has_draft: true,
                });
            }
        }

        if holders.is_empty() {
            continue;
        }
        impacts.push(CardinalityImpact {
            attribute_id: attribute.id.clone(),
            from: attribute.kind.clone(),
            to: next.kind.clone(),
            holders,
        });
    }

    Ok(impacts)
}
