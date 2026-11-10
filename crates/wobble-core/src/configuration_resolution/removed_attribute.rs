use super::*;

/// Every Attribute the proposal removes, with every answer it takes away and every holder
/// whose saved information or unfinished input depends on it: a Worker's saved value and
/// each of its draft's two surfaces.
pub fn compute_removed_attribute_impacts(
    conn: &Connection,
    worksite: &Worksite,
    previous: &[PositionedWorkerAttributeDefinition],
    definitions: &[WorkerAttributeDefinition],
) -> Result<Vec<RemovedAttributeImpact>> {
    let removed: Vec<&PositionedWorkerAttributeDefinition> = previous
        .iter()
        .filter(|attribute| {
            !definitions
                .iter()
                .any(|definition| definition.id == attribute.id)
        })
        .collect();
    if removed.is_empty() {
        return Ok(Vec::new());
    }

    let worker_drafts = read_stored_worker_drafts(conn, worksite)?;
    let worker_names = read_worker_names(conn, worksite)?;
    let (worker_ids, values) = read_attribute_migration_inputs(conn, worksite)?;

    let mut impacts = Vec::new();
    for attribute in removed {
        let mut holders: Vec<HolderImpact> = Vec::new();
        let mut affected_workers: BTreeSet<String> = BTreeSet::new();
        let mut discarded: BTreeSet<(String, String, String)> = BTreeSet::new();
        let mut affected_drafts = 0;

        for worker_id in &worker_ids {
            let Some(value) = values
                .get(worker_id)
                .and_then(|held| held.get(&attribute.id))
            else {
                continue;
            };
            let answer_ids = value_answer_ids(value, attribute)?;
            if answer_ids.is_empty() {
                continue;
            }
            for answer_id in &answer_ids {
                discarded.insert((worker_id.clone(), attribute.id.clone(), answer_id.clone()));
            }
            affected_workers.insert(worker_id.clone());
            let worker_name = worker_names
                .get(worker_id)
                .cloned()
                .unwrap_or_else(|| worker_id.clone());
            holders.push(HolderImpact {
                worker_id: worker_id.clone(),
                worker_name,
                kind: WORKER_HOLDER,
                surface: None,
                empty_if_unanswered: false,
                value: Some(value.clone()),
                replacements: Vec::new(),
            });
        }

        for draft in &worker_drafts {
            for (surface, held_value) in [
                (WORKER_DRAFT_SURFACE, draft.update.get(&attribute.id)),
                (WORKER_BASE_SURFACE, draft.base.get(&attribute.id)),
            ] {
                let Some(held) = held_value.filter(|value| value_is_known(value)) else {
                    continue;
                };
                let answer_ids = value_answer_ids(held, attribute)?;
                for answer_id in &answer_ids {
                    discarded.insert((
                        draft.worker_id.clone(),
                        attribute.id.clone(),
                        answer_id.clone(),
                    ));
                }
                if surface == WORKER_DRAFT_SURFACE {
                    affected_drafts += 1;
                }
                affected_workers.insert(draft.worker_id.clone());
                let worker_name = worker_names
                    .get(&draft.worker_id)
                    .cloned()
                    .unwrap_or_else(|| draft.worker_id.clone());
                holders.push(HolderImpact {
                    worker_id: draft.worker_id.clone(),
                    worker_name,
                    kind: WORKER_DRAFT_HOLDER,
                    surface: Some(surface),
                    empty_if_unanswered: false,
                    value: Some(held.clone()),
                    replacements: Vec::new(),
                });
            }
        }

        impacts.push(RemovedAttributeImpact {
            attribute_id: attribute.id.clone(),
            answer_ids: attribute
                .options
                .iter()
                .map(|answer| answer.id.clone())
                .collect(),
            affected_workers: affected_workers.len(),
            affected_drafts,
            removed_values: discarded.len(),
            holders,
        });
    }

    Ok(impacts)
}
