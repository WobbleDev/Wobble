//! Cross-Attribute moves: an answer that leaves its stored Attribute and lands un-merged in
//! another proposed Attribute, or a promoted answer that becomes an Attribute of its own.
//!
//! A moved branch keeps its answer ids. It leaves its source Attribute, so every Worker value
//! that holds one of its answers loses that answer; no Worker gains it in the target. A
//! promoted answer R becomes a new Attribute whose id is R: R itself is discarded, and its
//! descendants keep their ids and move into the new Attribute. The Save names one
//! acknowledgement per impact that would strip a saved Worker value.

use std::collections::{HashMap, HashSet};

use rusqlite::{params, Connection};
use serde::Serialize;
use serde_json::Value;

use crate::attribute_migration::{PositionedWorkerAttributeDefinition, WorkerAttributeDefinition};
use crate::attribute_persistence::{read_attribute_migration_inputs, StoredAttributeValues};
use crate::error::{Error, Result};
use crate::schema::Worksite;
use crate::worker_draft_persistence::WorkerDraftInput;

use super::holders::read_worker_names;
use super::refusals::{invalid_replacement, missing_resolution};
use super::{AttributeMoveResolution, ResolutionRefusal};

/// One cross-Attribute move detected from a stored Attribute and the proposal. The root is
/// the branch root, or the promoted answer for a promotion.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct DetectedMove {
    pub(crate) source_attribute_id: String,
    /// The branch root, or the promoted answer id.
    pub(crate) answer_id: String,
    /// The proposed Attribute the subtree lands in; the promoted answer id for a promotion.
    pub(crate) target_attribute_id: String,
    pub(crate) promoted: bool,
    /// The root and every moved descendant, in stored order.
    pub(crate) subtree_answer_ids: Vec<String>,
}

/// One saved Worker holding an answer of a moved subtree.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
pub struct AttributeMoveHolder {
    pub worker_id: String,
    pub worker_name: String,
    /// The held answers the Worker's saved value loses from its source Attribute.
    pub lost_answer_ids: Vec<String>,
    /// The held answers that stay with the Worker in the promoted Attribute.
    pub kept_answer_ids: Vec<String>,
}

/// One cross-Attribute move or promotion, with every saved holder whose value it changes.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
pub struct AttributeMoveImpact {
    pub source_attribute_id: String,
    pub answer_id: String,
    pub target_attribute_id: String,
    pub promoted: bool,
    pub subtree_answer_ids: Vec<String>,
    pub affected_workers: usize,
    pub holders: Vec<AttributeMoveHolder>,
}

/// Detects every cross-Attribute move and promotion of a proposal. Pure: it reads only the
/// stored and proposed definitions, so the preview, the Save and the planner share it.
pub(crate) fn detect_attribute_moves(
    previous: &[PositionedWorkerAttributeDefinition],
    definitions: &[WorkerAttributeDefinition],
) -> Vec<DetectedMove> {
    let stored_ids: HashSet<&str> = previous
        .iter()
        .map(|attribute| attribute.id.as_str())
        .collect();
    let proposed: HashMap<&str, &WorkerAttributeDefinition> = definitions
        .iter()
        .map(|definition| (definition.id.as_str(), definition))
        .collect();

    // Every proposed Attribute that holds an answer un-merged, by answer id.
    let mut homes: HashMap<&str, Vec<&str>> = HashMap::new();
    for definition in definitions {
        for answer in definition
            .options
            .iter()
            .filter(|answer| answer.merged_into.is_none())
        {
            homes
                .entry(answer.id.as_str())
                .or_default()
                .push(definition.id.as_str());
        }
    }

    // A stored answer that leaves its Attribute and whose id a new proposed Attribute takes
    // is promoted, unless some stored Attribute already holds that id.
    let mut promotions: HashMap<&str, &str> = HashMap::new();
    for source in previous {
        let Some(next) = proposed.get(source.id.as_str()) else {
            continue;
        };
        let kept: HashSet<&str> = next
            .options
            .iter()
            .map(|answer| answer.id.as_str())
            .collect();
        for answer in &source.options {
            let id = answer.id.as_str();
            if !kept.contains(id) && proposed.contains_key(id) && !stored_ids.contains(id) {
                promotions.entry(id).or_insert(source.id.as_str());
            }
        }
    }

    let mut moves = Vec::new();
    for source in previous {
        let Some(next) = proposed.get(source.id.as_str()) else {
            continue;
        };
        let kept: HashSet<&str> = next
            .options
            .iter()
            .map(|answer| answer.id.as_str())
            .collect();
        let promoted_here =
            |attribute: &str| promotions.get(attribute) == Some(&source.id.as_str());

        // Absent answers grouped by the attribute they land in. A promoted answer lands in
        // the new Attribute named after itself.
        let mut groups: Vec<(&str, Vec<&str>)> = Vec::new();
        for answer in &source.options {
            let id = answer.id.as_str();
            if kept.contains(id) {
                continue;
            }
            let target = if promoted_here(id) {
                id
            } else {
                let Some(target) = homes.get(id).and_then(|candidates| {
                    candidates
                        .iter()
                        .copied()
                        .find(|candidate| *candidate != source.id.as_str())
                }) else {
                    continue;
                };
                target
            };
            match groups.iter_mut().find(|(group, _)| *group == target) {
                Some((_, members)) => members.push(id),
                None => groups.push((target, vec![id])),
            }
        }

        let mut for_source = Vec::new();
        for (target, members) in groups {
            if promoted_here(target) {
                // The promoted root and every answer that lands in its new Attribute.
                for_source.push(DetectedMove {
                    source_attribute_id: source.id.clone(),
                    answer_id: target.to_owned(),
                    target_attribute_id: target.to_owned(),
                    promoted: true,
                    subtree_answer_ids: members.iter().map(|id| (*id).to_owned()).collect(),
                });
                continue;
            }
            for_source.extend(plain_moves(source, target, &members));
        }
        for_source.sort_by_key(|detected| {
            source
                .options
                .iter()
                .position(|answer| answer.id == detected.answer_id)
        });
        moves.extend(for_source);
    }

    moves
}

/// The top of a member's chain of moved parents. The step bound keeps a corrupt cycle from
/// looping; a valid stored hierarchy never reaches it.
fn chain_top<'a>(
    member: &'a str,
    parent_of: &HashMap<&'a str, Option<&'a str>>,
    member_set: &HashSet<&'a str>,
    bound: usize,
) -> &'a str {
    let mut current = member;
    for _ in 0..bound {
        match parent_of.get(current).copied().flatten() {
            Some(parent) if member_set.contains(parent) => current = parent,
            _ => break,
        }
    }
    current
}

/// The branch roots of one plain group: a member whose stored parent is not in the group
/// starts a branch, and every member belongs to the branch its chain of moved parents leads
/// to. Each root carries its members in stored order.
fn plain_moves(
    source: &PositionedWorkerAttributeDefinition,
    target: &str,
    members: &[&str],
) -> Vec<DetectedMove> {
    let parent_of: HashMap<&str, Option<&str>> = source
        .options
        .iter()
        .map(|answer| (answer.id.as_str(), answer.parent_id.as_deref()))
        .collect();
    let member_set: HashSet<&str> = members.iter().copied().collect();

    let owners: Vec<(&str, &str)> = members
        .iter()
        .map(|member| {
            (
                *member,
                chain_top(member, &parent_of, &member_set, members.len()),
            )
        })
        .collect();
    let mut moves = Vec::new();
    for (root, _) in owners.iter().filter(|(member, owner)| member == owner) {
        let subtree_answer_ids = owners
            .iter()
            .filter(|(_, owner)| owner == root)
            .map(|(member, _)| (*member).to_owned())
            .collect();
        moves.push(DetectedMove {
            source_attribute_id: source.id.clone(),
            answer_id: (*root).to_owned(),
            target_attribute_id: target.to_owned(),
            promoted: false,
            subtree_answer_ids,
        });
    }
    moves
}

/// The answer ids a Save moves out of their stored Attribute: a moved branch's members and
/// every promoted answer. These are never removals, so they need no holder replacement.
pub(crate) fn moved_answer_ids(
    previous: &[PositionedWorkerAttributeDefinition],
    definitions: &[WorkerAttributeDefinition],
) -> HashSet<String> {
    detect_attribute_moves(previous, definitions)
        .into_iter()
        .flat_map(|detected| detected.subtree_answer_ids)
        .collect()
}

/// Whether a detected move would strip the saved value of some Worker: a plain move holding
/// any subtree answer, or a promotion holding its own answer. A promotion holder who keeps
/// only descendants loses nothing.
pub(crate) fn move_strips_a_saved_value(
    detected: &DetectedMove,
    values: &StoredAttributeValues,
) -> bool {
    values
        .values()
        .filter_map(|attributes| attributes.get(&detected.source_attribute_id))
        .any(|value| !lost_answer_ids(detected, value).is_empty())
}

/// The answer ids a saved value loses from its source Attribute under a move: a plain move
/// loses every held subtree answer; a promotion loses only its own answer.
fn lost_answer_ids(detected: &DetectedMove, value: &Value) -> Vec<String> {
    held_answer_ids(value)
        .into_iter()
        .filter(|id| {
            if detected.promoted {
                *id == detected.answer_id
            } else {
                detected
                    .subtree_answer_ids
                    .iter()
                    .any(|answer| answer.as_str() == *id)
            }
        })
        .map(str::to_owned)
        .collect()
}

/// The answer ids a stored value holds, in recorded order. A value the planner has not
/// validated reads as whatever text or array of text it is.
fn held_answer_ids(value: &Value) -> Vec<&str> {
    match value {
        Value::String(text) if !text.is_empty() => vec![text.as_str()],
        Value::Array(items) => items.iter().filter_map(Value::as_str).collect(),
        _ => Vec::new(),
    }
}

/// Every detected move with its saved holders, in the same order the preview reports them.
pub fn compute_attribute_move_impacts(
    conn: &Connection,
    worksite: &Worksite,
    previous: &[PositionedWorkerAttributeDefinition],
    definitions: &[WorkerAttributeDefinition],
) -> Result<Vec<AttributeMoveImpact>> {
    let detected = detect_attribute_moves(previous, definitions);
    if detected.is_empty() {
        return Ok(Vec::new());
    }

    let worker_names = read_worker_names(conn, worksite)?;
    let (worker_ids, values) = read_attribute_migration_inputs(conn, worksite)?;

    let impacts = detected
        .into_iter()
        .map(|detected| {
            let mut holders = Vec::new();
            for worker_id in &worker_ids {
                let Some(value) = values
                    .get(worker_id)
                    .and_then(|held| held.get(&detected.source_attribute_id))
                else {
                    continue;
                };
                let lost = lost_answer_ids(&detected, value);
                let kept: Vec<String> = if detected.promoted {
                    held_answer_ids(value)
                        .into_iter()
                        .filter(|id| *id != detected.answer_id)
                        .filter(|id| {
                            detected
                                .subtree_answer_ids
                                .iter()
                                .any(|answer| answer.as_str() == *id)
                        })
                        .map(str::to_owned)
                        .collect()
                } else {
                    Vec::new()
                };
                if lost.is_empty() && kept.is_empty() {
                    continue;
                }
                holders.push(AttributeMoveHolder {
                    worker_id: worker_id.clone(),
                    worker_name: worker_names
                        .get(worker_id)
                        .cloned()
                        .unwrap_or_else(|| worker_id.clone()),
                    lost_answer_ids: lost,
                    kept_answer_ids: kept,
                });
            }
            AttributeMoveImpact {
                affected_workers: holders.len(),
                source_attribute_id: detected.source_attribute_id,
                answer_id: detected.answer_id,
                target_attribute_id: detected.target_attribute_id,
                promoted: detected.promoted,
                subtree_answer_ids: detected.subtree_answer_ids,
                holders,
            }
        })
        .collect();
    Ok(impacts)
}

/// The explicit acknowledgements of a Save: each impact that strips a saved value needs
/// exactly one entry, and an entry must name a detected move.
pub(crate) fn acknowledge_attribute_moves(
    impacts: &[AttributeMoveImpact],
    acknowledgements: &[AttributeMoveResolution],
) -> std::result::Result<(), ResolutionRefusal> {
    let mut acknowledged: HashSet<(&str, &str)> = HashSet::new();
    for acknowledgement in acknowledgements {
        let source = acknowledgement.source_attribute_id.as_str();
        let answer = acknowledgement.answer_id.as_str();
        let known = impacts
            .iter()
            .any(|impact| impact.source_attribute_id == source && impact.answer_id == answer);
        if !known {
            return Err(invalid_replacement(format!(
                "Answer \"{answer}\" is not a move out of Attribute \"{source}\" in this Configuration change."
            )));
        }
        if !acknowledged.insert((source, answer)) {
            return Err(missing_resolution(format!(
                "The move of answer \"{answer}\" out of Attribute \"{source}\" is acknowledged twice."
            )));
        }
    }

    for impact in impacts.iter().filter(|impact| {
        impact
            .holders
            .iter()
            .any(|holder| !holder.lost_answer_ids.is_empty())
    }) {
        if !acknowledged.contains(&(
            impact.source_attribute_id.as_str(),
            impact.answer_id.as_str(),
        )) {
            return Err(missing_resolution(format!(
                "The move of answer \"{}\" out of Attribute \"{}\" would remove a saved Worker value and needs an explicit acknowledgement.",
                impact.answer_id, impact.source_attribute_id
            )));
        }
    }

    Ok(())
}

/// Drops the moved answers from every Worker draft's update and base values of their source
/// Attribute. A category holding a moved answer becomes empty; a tag loses the moved answers.
/// Nothing else in the draft changes, and drafts are never listed in the preview.
pub(crate) fn strip_moved_worker_drafts(
    tx: &Connection,
    worksite: &Worksite,
    detected: &[DetectedMove],
) -> Result<()> {
    if detected.is_empty() {
        return Ok(());
    }

    let mut statement =
        tx.prepare("SELECT worker_id, payload FROM worker_drafts WHERE worksite_id = ?1")?;
    let rows = statement.query_map([&worksite.id], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    })?;
    let mut writes = Vec::new();
    for row in rows {
        let (worker_id, payload) = row?;
        let mut input: WorkerDraftInput = serde_json::from_str(&payload)
            .map_err(|_| Error::Message(format!("Invalid Worker draft stored for {worker_id}.")))?;
        let mut changed = false;
        for movement in detected {
            changed |= strip_moved_answers(&mut input.update.attributes, movement);
            if let Some(base) = input.base.as_mut() {
                changed |= strip_moved_answers(&mut base.attributes, movement);
            }
        }
        if changed {
            writes.push((worker_id, serde_json::to_string(&input)?));
        }
    }
    drop(statement);

    for (worker_id, payload) in writes {
        tx.execute(
            "UPDATE worker_drafts SET payload = ?1 WHERE worksite_id = ?2 AND worker_id = ?3",
            params![payload, worksite.id, worker_id],
        )?;
    }
    Ok(())
}

/// Removes one move's answers from one draft attribute map. Returns whether it changed.
fn strip_moved_answers(attributes: &mut Value, detected: &DetectedMove) -> bool {
    let Some(value) = attributes
        .as_object_mut()
        .and_then(|object| object.get_mut(&detected.source_attribute_id))
    else {
        return false;
    };
    let moved = |id: &str| {
        detected
            .subtree_answer_ids
            .iter()
            .any(|answer| answer == id)
    };
    match value {
        Value::String(text) if moved(text.as_str()) => {
            text.clear();
            true
        }
        Value::Array(items) => {
            let before = items.len();
            items.retain(|item| !item.as_str().is_some_and(moved));
            items.len() != before
        }
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::attribute_migration::StoredAnswer;
    use serde_json::json;

    fn answer(id: &str, parent: Option<&str>) -> StoredAnswer {
        StoredAnswer {
            id: id.to_owned(),
            value: id.to_owned(),
            parent_id: parent.map(str::to_owned),
            mode: None,
            short_form: None,
            short_form_origin: None,
            abbreviation: None,
            abbreviation_origin: None,
            merged_into: None,
        }
    }

    fn merged(id: &str, into: &str) -> StoredAnswer {
        StoredAnswer {
            merged_into: Some(into.to_owned()),
            ..answer(id, None)
        }
    }

    fn stored(
        id: &str,
        kind: &str,
        options: Vec<StoredAnswer>,
    ) -> PositionedWorkerAttributeDefinition {
        PositionedWorkerAttributeDefinition {
            id: id.to_owned(),
            name: id.to_owned(),
            kind: kind.to_owned(),
            options,
            position: 0,
        }
    }

    fn proposed(id: &str, kind: &str, options: Vec<StoredAnswer>) -> WorkerAttributeDefinition {
        WorkerAttributeDefinition {
            id: id.to_owned(),
            name: id.to_owned(),
            kind: kind.to_owned(),
            options,
        }
    }

    fn ids(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| (*value).to_owned()).collect()
    }

    #[test]
    fn a_leaf_that_lands_in_another_attribute_is_a_plain_move() {
        let previous = [stored(
            "area",
            "category",
            vec![answer("central", None), answer("store-a", Some("central"))],
        )];
        let definitions = [
            proposed("area", "category", vec![answer("central", None)]),
            proposed("site", "category", vec![answer("store-a", None)]),
        ];

        let moves = detect_attribute_moves(&previous, &definitions);

        assert_eq!(
            moves,
            vec![DetectedMove {
                source_attribute_id: "area".to_owned(),
                answer_id: "store-a".to_owned(),
                target_attribute_id: "site".to_owned(),
                promoted: false,
                subtree_answer_ids: ids(&["store-a"]),
            }]
        );
    }

    #[test]
    fn a_branch_moves_as_one_root_with_its_moved_descendants_in_stored_order() {
        let previous = [stored(
            "area",
            "tag",
            vec![
                answer("root", None),
                answer("mid", Some("root")),
                answer("deep", Some("mid")),
                answer("keep", None),
            ],
        )];
        let definitions = [
            proposed("area", "tag", vec![answer("keep", None)]),
            proposed(
                "site",
                "tag",
                vec![
                    answer("deep", None),
                    answer("root", None),
                    answer("mid", Some("root")),
                ],
            ),
        ];

        let moves = detect_attribute_moves(&previous, &definitions);

        assert_eq!(moves.len(), 1);
        assert_eq!(moves[0].answer_id, "root");
        assert_eq!(moves[0].target_attribute_id, "site");
        assert_eq!(moves[0].subtree_answer_ids, ids(&["root", "mid", "deep"]));
    }

    #[test]
    fn a_child_moved_away_from_a_staying_parent_is_its_own_root() {
        let previous = [stored(
            "area",
            "tag",
            vec![answer("parent", None), answer("child", Some("parent"))],
        )];
        let definitions = [
            proposed("area", "tag", vec![answer("parent", None)]),
            proposed("site", "tag", vec![answer("child", None)]),
        ];

        let moves = detect_attribute_moves(&previous, &definitions);

        assert_eq!(moves.len(), 1);
        assert_eq!(moves[0].answer_id, "child");
        assert_eq!(moves[0].subtree_answer_ids, ids(&["child"]));
    }

    #[test]
    fn a_branch_split_across_two_targets_gives_one_move_per_target() {
        let previous = [stored(
            "area",
            "tag",
            vec![
                answer("root", None),
                answer("left", Some("root")),
                answer("right", Some("root")),
            ],
        )];
        let definitions = [
            proposed("area", "tag", Vec::new()),
            proposed(
                "site",
                "tag",
                vec![answer("root", None), answer("left", Some("root"))],
            ),
            proposed("depot", "tag", vec![answer("right", None)]),
        ];

        let mut moves = detect_attribute_moves(&previous, &definitions);
        moves.sort_by(|a, b| a.target_attribute_id.cmp(&b.target_attribute_id));

        assert_eq!(moves.len(), 2);
        assert_eq!(moves[0].target_attribute_id, "depot");
        assert_eq!(moves[0].answer_id, "right");
        assert_eq!(moves[1].target_attribute_id, "site");
        assert_eq!(moves[1].answer_id, "root");
        assert_eq!(moves[1].subtree_answer_ids, ids(&["root", "left"]));
    }

    #[test]
    fn a_merged_or_kept_or_removed_answer_is_not_a_move() {
        let previous = [stored(
            "area",
            "category",
            vec![
                answer("kept", None),
                answer("folded", None),
                answer("gone", None),
            ],
        )];
        let definitions = [
            proposed(
                "area",
                "category",
                vec![answer("kept", None), merged("folded", "kept")],
            ),
            proposed("site", "category", vec![merged("gone", "kept")]),
        ];

        assert_eq!(detect_attribute_moves(&previous, &definitions), Vec::new());
    }

    #[test]
    fn an_answer_that_lands_nowhere_is_not_a_move() {
        let previous = [stored("area", "category", vec![answer("gone", None)])];
        let definitions = [proposed("area", "category", Vec::new())];

        assert_eq!(detect_attribute_moves(&previous, &definitions), Vec::new());
    }

    #[test]
    fn an_answer_of_a_removed_attribute_is_not_a_move() {
        let previous = [stored("area", "category", vec![answer("store-a", None)])];
        let definitions = [proposed("site", "category", vec![answer("store-a", None)])];

        assert_eq!(detect_attribute_moves(&previous, &definitions), Vec::new());
    }

    #[test]
    fn a_branch_root_promoted_to_an_attribute_keeps_its_descendants() {
        let previous = [stored(
            "area",
            "tag",
            vec![
                answer("region", None),
                answer("north", Some("region")),
                answer("store", Some("north")),
                answer("other", None),
            ],
        )];
        let definitions = [
            proposed("area", "tag", vec![answer("other", None)]),
            proposed(
                "region",
                "tag",
                vec![answer("north", None), answer("store", Some("north"))],
            ),
        ];

        let moves = detect_attribute_moves(&previous, &definitions);

        assert_eq!(
            moves,
            vec![DetectedMove {
                source_attribute_id: "area".to_owned(),
                answer_id: "region".to_owned(),
                target_attribute_id: "region".to_owned(),
                promoted: true,
                subtree_answer_ids: ids(&["region", "north", "store"]),
            }]
        );
    }

    #[test]
    fn a_promoted_answer_with_no_descendants_still_detects_its_promotion() {
        let previous = [stored("area", "category", vec![answer("lonely", None)])];
        let definitions = [
            proposed("area", "category", Vec::new()),
            proposed("lonely", "category", Vec::new()),
        ];

        let moves = detect_attribute_moves(&previous, &definitions);

        assert_eq!(moves.len(), 1);
        assert!(moves[0].promoted);
        assert_eq!(moves[0].subtree_answer_ids, ids(&["lonely"]));
    }

    #[test]
    fn an_answer_that_names_an_existing_attribute_is_not_promoted() {
        // A stored Attribute already has the id, so the proposal's Attribute is not new.
        let previous = [
            stored("area", "category", vec![answer("site", None)]),
            stored("site", "category", Vec::new()),
        ];
        let definitions = [
            proposed("area", "category", Vec::new()),
            proposed("site", "category", Vec::new()),
        ];

        assert_eq!(detect_attribute_moves(&previous, &definitions), Vec::new());
    }

    #[test]
    fn a_move_inside_one_attribute_is_not_a_cross_attribute_move() {
        let previous = [stored(
            "area",
            "category",
            vec![answer("a", None), answer("b", None)],
        )];
        let definitions = [proposed(
            "area",
            "category",
            vec![answer("a", None), answer("b", Some("a"))],
        )];

        assert_eq!(detect_attribute_moves(&previous, &definitions), Vec::new());
    }

    #[test]
    fn a_promotion_strips_only_a_holder_of_its_own_answer() {
        let detected = DetectedMove {
            source_attribute_id: "area".to_owned(),
            answer_id: "region".to_owned(),
            target_attribute_id: "region".to_owned(),
            promoted: true,
            subtree_answer_ids: ids(&["region", "north"]),
        };
        let values = |value: Value| -> StoredAttributeValues {
            HashMap::from([("w1".to_owned(), HashMap::from([("area".to_owned(), value)]))])
        };

        assert!(move_strips_a_saved_value(
            &detected,
            &values(json!("region"))
        ));
        assert!(!move_strips_a_saved_value(
            &detected,
            &values(json!("north"))
        ));
        assert!(!move_strips_a_saved_value(
            &detected,
            &values(json!(["north"]))
        ));
        assert!(move_strips_a_saved_value(
            &detected,
            &values(json!(["north", "region"]))
        ));
    }
}
