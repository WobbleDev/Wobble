use super::*;

/// A stored or proposed answer's label and parent, keyed by id.
pub(super) type AnswerPath = HashMap<String, (String, Option<String>)>;

pub(super) fn stored_answers(attribute: &PositionedWorkerAttributeDefinition) -> AnswerPath {
    attribute
        .options
        .iter()
        .map(|answer| {
            (
                answer.id.clone(),
                (answer.value.clone(), answer.parent_id.clone()),
            )
        })
        .collect()
}

pub(super) fn proposed_answers(attribute: &WorkerAttributeDefinition) -> AnswerPath {
    attribute
        .options
        .iter()
        .map(|answer| {
            (
                answer.id.clone(),
                (answer.value.clone(), answer.parent_id.clone()),
            )
        })
        .collect()
}

/// The labels from the root down to the answer, inclusive. A corrupt stored cycle reads as
/// no path rather than looping forever; the wire guard refuses cycles before any Save.
pub(super) fn path_to(answers: &AnswerPath, answer_id: &str) -> Vec<String> {
    let mut labels = Vec::new();
    let mut seen = HashSet::new();
    let mut current = Some(answer_id.to_owned());
    while let Some(id) = current {
        if !seen.insert(id.clone()) {
            return Vec::new();
        }
        let Some((label, parent)) = answers.get(&id) else {
            return Vec::new();
        };
        labels.push(label.clone());
        current = parent.clone();
    }
    labels.reverse();
    labels
}

pub(super) fn in_subtree(answers: &AnswerPath, answer_id: &str, root: &str) -> bool {
    let mut seen = HashSet::new();
    let mut current = Some(answer_id.to_owned());
    while let Some(id) = current {
        if id == root {
            return true;
        }
        if !seen.insert(id.clone()) {
            return false;
        }
        current = answers.get(&id).and_then(|(_, parent)| parent.clone());
    }
    false
}

/// Every stored answer whose parent changed in the proposal, in stored definition order.
/// A folded answer is a merge, not a move, so it never becomes a branch root here.
pub(super) fn move_roots(
    previous: &[PositionedWorkerAttributeDefinition],
    definitions: &[WorkerAttributeDefinition],
) -> Vec<(usize, String)> {
    let mut roots = Vec::new();
    for (index, previous_attribute) in previous.iter().enumerate() {
        let Some(next) = definitions
            .iter()
            .find(|definition| definition.id == previous_attribute.id)
        else {
            continue;
        };
        let next_by_id: HashMap<&str, &crate::attribute_migration::StoredAnswer> = next
            .options
            .iter()
            .map(|answer| (answer.id.as_str(), answer))
            .collect();
        for answer in &previous_attribute.options {
            let Some(next_answer) = next_by_id.get(answer.id.as_str()) else {
                continue;
            };
            if next_answer.merged_into.is_some() {
                continue;
            }
            if next_answer.parent_id != answer.parent_id {
                roots.push((index, answer.id.clone()));
            }
        }
    }
    roots
}

pub(super) fn moved_holder(
    worker_id: String,
    worker_name: String,
    held_answer_id: &str,
    previous: &AnswerPath,
    next: &AnswerPath,
) -> MovedAnswerHolder {
    MovedAnswerHolder {
        worker_id,
        worker_name,
        // A moved branch is held by a saved Worker value, never by a draft surface.
        kind: "worker",
        held_answer_id: held_answer_id.to_owned(),
        previous_path: path_to(previous, held_answer_id),
        path: path_to(next, held_answer_id),
    }
}

/// The moved branches of a proposal and every saved or draft holder whose classification
/// follows. Reads only: the preview calls this before any write and mints no id.
pub fn compute_move_impacts(
    conn: &Connection,
    worksite: &Worksite,
    previous: &[PositionedWorkerAttributeDefinition],
    definitions: &[WorkerAttributeDefinition],
) -> Result<MoveImpacts> {
    let roots = move_roots(previous, definitions);
    if roots.is_empty() {
        return Ok(MoveImpacts { moves: Vec::new() });
    }

    let worker_names = read_worker_names(conn, worksite)?;
    let (worker_ids, values) = read_attribute_migration_inputs(conn, worksite)?;

    let mut moves = Vec::new();

    for (index, root_id) in roots {
        let previous_attribute = &previous[index];
        let next = definitions
            .iter()
            .find(|definition| definition.id == previous_attribute.id)
            .expect("a move root names a proposed Attribute");
        let previous_map = stored_answers(previous_attribute);
        let next_map = proposed_answers(next);
        let subtree: Vec<String> = next
            .options
            .iter()
            .filter(|answer| answer.merged_into.is_none())
            .filter(|answer| in_subtree(&next_map, &answer.id, &root_id))
            .map(|answer| answer.id.clone())
            .collect();
        let subtree_set: HashSet<&str> = subtree.iter().map(String::as_str).collect();

        let mut holders = Vec::new();
        let mut affected_workers = BTreeSet::new();

        for worker_id in &worker_ids {
            let Some(value) = values
                .get(worker_id)
                .and_then(|held| held.get(&previous_attribute.id))
            else {
                continue;
            };
            let held = match value {
                Value::String(id) if !id.is_empty() => {
                    subtree_set.contains(id.as_str()).then_some(id.as_str())
                }
                Value::Array(ids) => ids
                    .iter()
                    .filter_map(Value::as_str)
                    .find(|id| subtree_set.contains(*id)),
                _ => None,
            };
            let Some(held) = held else {
                continue;
            };
            affected_workers.insert(worker_id.clone());
            let worker_name = worker_names
                .get(worker_id)
                .cloned()
                .unwrap_or_else(|| worker_id.clone());
            holders.push(moved_holder(
                worker_id.clone(),
                worker_name,
                held,
                &previous_map,
                &next_map,
            ));
        }

        moves.push(MovedAnswerImpact {
            attribute_id: previous_attribute.id.clone(),
            answer_id: root_id.clone(),
            parent_id: next_map
                .get(&root_id)
                .and_then(|(_, parent)| parent.clone()),
            previous_parent_id: previous_map
                .get(&root_id)
                .and_then(|(_, parent)| parent.clone()),
            previous_path: path_to(&previous_map, &root_id),
            path: path_to(&next_map, &root_id),
            subtree_answer_ids: subtree,
            affected_workers: affected_workers.len(),
            holders,
        });
    }

    Ok(MoveImpacts { moves })
}
