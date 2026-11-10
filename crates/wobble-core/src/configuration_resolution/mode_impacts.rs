//! Select-mode changes (ADR 0043): a value switched from Multi-Select to Single-Select, or a
//! branch moved under a Single-Select value, can leave Workers holding several branches of
//! one group. Each such Worker keeps the first branch in value order and loses the rest. The
//! preview lists the surfaces that lose answers, and the Save needs one acknowledgement per
//! Attribute. Worker drafts follow the saved values so an unfinished edit stays valid.

use super::*;

use crate::attribute_migration::StoredAnswer;
use crate::select_mode::{resolve_ids, shape_value};

/// One surface whose held answers a mode change trims: the Worker's saved value or one of
/// its unfinished draft values.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(
    feature = "ts",
    derive(ts_rs::TS),
    ts(export, rename = "ConfigurationPreviewModeHolder")
)]
pub struct ModeHolderImpact {
    pub worker_id: String,
    pub worker_name: String,
    /// `value` for the saved Worker answer, `draft` for draft update, `base` for draft base.
    #[cfg_attr(feature = "ts", ts(as = "super::CardinalitySurfaceTs"))]
    pub surface: &'static str,
    /// The answers this surface held, in recorded order.
    pub held: Vec<String>,
    /// The answers it keeps.
    pub kept: Vec<String>,
    /// The answers it loses.
    pub dropped: Vec<String>,
}

/// One Attribute whose proposed group modes trim at least one surface.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(
    feature = "ts",
    derive(ts_rs::TS),
    ts(export, rename = "ConfigurationPreviewModeChange")
)]
pub struct ModeImpact {
    pub attribute_id: String,
    pub holders: Vec<ModeHolderImpact>,
}

/// The acknowledgement of one Attribute's mode change that trims held answers.
#[derive(Debug, Clone, PartialEq)]
pub struct ModeChangeResolution {
    pub attribute_id: String,
}

/// An Attribute's value structure as modes read it: each kept answer, its parent and, for an
/// answer with sub-values, its explicit mode.
fn signature(options: &[StoredAnswer]) -> Vec<(String, Option<String>, Option<String>)> {
    let parents: HashSet<&str> = options
        .iter()
        .filter(|answer| answer.merged_into.is_none())
        .filter_map(|answer| answer.parent_id.as_deref())
        .collect();
    options
        .iter()
        .filter(|answer| answer.merged_into.is_none())
        .map(|answer| {
            (
                answer.id.clone(),
                answer.parent_id.clone(),
                answer
                    .mode
                    .clone()
                    .filter(|_| parents.contains(answer.id.as_str())),
            )
        })
        .collect()
}

/// The structure and kind change that can newly break a group's mode, or a stored shape.
fn mode_relevant_change(
    previous: &PositionedWorkerAttributeDefinition,
    next: &WorkerAttributeDefinition,
) -> bool {
    previous.kind != next.kind || signature(&previous.options) != signature(&next.options)
}

/// The kind whose top level the mode check enforces. A Multi-Select to Single-Select change
/// of the Attribute itself is the cardinality resolution's to decide, so the top level is
/// left to it and only the sub-groups are checked here.
fn enforced_kind<'a>(
    previous: &PositionedWorkerAttributeDefinition,
    next: &'a WorkerAttributeDefinition,
) -> &'a str {
    if previous.kind == "tag" && next.kind == "category" {
        "tag"
    } else {
        next.kind.as_str()
    }
}

/// The surviving options of a proposed Attribute, as the planner stores them.
fn kept_options(next: &WorkerAttributeDefinition) -> Vec<StoredAnswer> {
    next.options
        .iter()
        .filter(|answer| answer.merged_into.is_none())
        .cloned()
        .collect()
}

/// What each Worker draft surface becomes for the Attributes whose structure changed, in the
/// shape the proposed Attribute stores. A write is produced when the value changes, trimmed
/// or not; the lossy ones are also reported by [`compute_mode_impacts`].
pub(super) fn mode_draft_writes(
    previous: &[PositionedWorkerAttributeDefinition],
    definitions: &[WorkerAttributeDefinition],
    worker_drafts: &[StoredWorkerDraft],
) -> Result<Vec<WorkerDraftValueWrite>> {
    let mut writes = Vec::new();
    for attribute in previous {
        let Some(next) = definitions
            .iter()
            .find(|definition| definition.id == attribute.id)
        else {
            continue;
        };
        if !mode_relevant_change(attribute, next) || attribute.kind != next.kind {
            // A kind change rewrites its drafts through the cardinality path.
            continue;
        }
        let options = kept_options(next);
        for draft in worker_drafts {
            for (surface, values) in [
                (WORKER_DRAFT_SURFACE, &draft.update),
                (WORKER_BASE_SURFACE, &draft.base),
            ] {
                let Some(stored) = values.get(&attribute.id).filter(|value| !value.is_null())
                else {
                    continue;
                };
                let held = surviving_answer_ids(stored, attribute, next)?;
                let (kept, _) = resolve_ids(&next.kind, &options, &held);
                let value = shape_value(&next.kind, &options, &kept);
                if &value != stored {
                    writes.push(WorkerDraftValueWrite {
                        worker_id: draft.worker_id.clone(),
                        surface,
                        attribute_id: attribute.id.clone(),
                        value,
                    });
                }
            }
        }
    }
    Ok(writes)
}

/// Every Attribute whose proposed modes trim a saved value or a Worker draft surface.
pub fn compute_mode_impacts(
    conn: &Connection,
    worksite: &Worksite,
    previous: &[PositionedWorkerAttributeDefinition],
    definitions: &[WorkerAttributeDefinition],
) -> Result<Vec<ModeImpact>> {
    let changes: Vec<(
        &PositionedWorkerAttributeDefinition,
        &WorkerAttributeDefinition,
    )> = previous
        .iter()
        .filter_map(|attribute| {
            let next = definitions
                .iter()
                .find(|definition| definition.id == attribute.id)?;
            mode_relevant_change(attribute, next).then_some((attribute, next))
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
        let options = kept_options(next);
        let kind = enforced_kind(attribute, next);
        let mut holders = Vec::new();
        let mut consider =
            |worker_id: &str, name: String, surface: &'static str, value: &Value| -> Result<()> {
                if value.is_null() {
                    return Ok(());
                }
                let held = surviving_answer_ids(value, attribute, next)?;
                let (kept, dropped) = resolve_ids(kind, &options, &held);
                if !dropped.is_empty() {
                    holders.push(ModeHolderImpact {
                        worker_id: worker_id.to_owned(),
                        worker_name: name,
                        surface,
                        held,
                        kept,
                        dropped,
                    });
                }
                Ok(())
            };

        for worker_id in &worker_ids {
            let Some(value) = values
                .get(worker_id)
                .and_then(|held| held.get(&attribute.id))
            else {
                continue;
            };
            let name = worker_names
                .get(worker_id)
                .cloned()
                .unwrap_or_else(|| worker_id.clone());
            consider(worker_id, name, VALUE_SURFACE, value)?;
        }
        for draft in &worker_drafts {
            let name = if draft.name.is_empty() {
                worker_names
                    .get(&draft.worker_id)
                    .cloned()
                    .unwrap_or_else(|| draft.worker_id.clone())
            } else {
                draft.name.clone()
            };
            for (surface, held) in [
                (WORKER_DRAFT_SURFACE, &draft.update),
                (WORKER_BASE_SURFACE, &draft.base),
            ] {
                if let Some(value) = held.get(&attribute.id) {
                    consider(&draft.worker_id, name.clone(), surface, value)?;
                }
            }
        }

        if !holders.is_empty() {
            impacts.push(ModeImpact {
                attribute_id: attribute.id.clone(),
                holders,
            });
        }
    }

    Ok(impacts)
}

/// Requires one acknowledgement per impacted Attribute, and refuses one that names an
/// Attribute whose mode change trims nothing.
pub(crate) fn acknowledge_mode_changes(
    impacts: &[ModeImpact],
    acknowledgements: &[ModeChangeResolution],
) -> std::result::Result<(), ResolutionRefusal> {
    let mut acknowledged: HashSet<&str> = HashSet::new();
    for acknowledgement in acknowledgements {
        let attribute = acknowledgement.attribute_id.as_str();
        if !impacts
            .iter()
            .any(|impact| impact.attribute_id == attribute)
        {
            return Err(invalid_replacement(format!(
                "Attribute \"{attribute}\" has no select-mode change that removes values in this Configuration change."
            )));
        }
        if !acknowledged.insert(attribute) {
            return Err(missing_resolution(format!(
                "The select-mode change of Attribute \"{attribute}\" is acknowledged twice."
            )));
        }
    }
    for impact in impacts {
        if !acknowledged.contains(impact.attribute_id.as_str()) {
            return Err(missing_resolution(format!(
                "A select-mode change in Attribute \"{}\" would remove held values and needs an explicit acknowledgement.",
                impact.attribute_id
            )));
        }
    }
    Ok(())
}
