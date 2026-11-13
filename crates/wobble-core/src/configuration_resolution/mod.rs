//! Configuration resolutions: every lossy change (removing a leaf answer, removing or
//! merging a parent, removing a definition, changing cardinality or a value's select mode) needs an explicit
//! decision for each saved or draft holder.
//!
//! The Configuration preview names every saved Worker value and every Worker draft that
//! holds a removed leaf answer, and offers each holder's replacement outcomes. The Save
//! carries one replacement or no-answer resolution per holder, plus the confirmed
//! resolution of any lossy cardinality change. It rechecks the preview base and writes
//! definitions and Worker values in one transaction. A preview never writes and never
//! consumes an id.

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};

use rusqlite::{params, Connection, OptionalExtension, Transaction, TransactionBehavior};
use serde::Serialize;
use serde_json::Value;

use crate::attribute_migration::{
    answers_to_json, compute_attribute_migration_plan_in, PositionedWorkerAttributeDefinition,
    WorkerAttributeDefinition,
};
use crate::attribute_persistence::{
    apply_attribute_migration_plan, get_stored_worker_attributes, get_worker_attributes,
    read_attribute_migration_inputs, reject_foreign_attribute_ids, validate_attribute_changes,
    AllowedEdits,
};
use crate::error::{Error, Result};
use crate::id::IdSource;
use crate::schema::Worksite;
use crate::serialization::is_worker_attribute_value;
use crate::worker_draft_persistence::WorkerDraftInput;

/// The wire names of the current holder kinds: a Worker's own saved value and a Worker
/// draft's unfinished value.
pub(crate) const WORKER_HOLDER: &str = "worker";
pub(crate) const WORKER_DRAFT_HOLDER: &str = "workerDraft";

/// The three independent surfaces a cardinality change can discard answers from: the saved
/// value, unfinished draft update, and unfinished draft base.
pub(crate) const VALUE_SURFACE: &str = "value";
pub(crate) const WORKER_DRAFT_SURFACE: &str = "draft";
pub(crate) const WORKER_BASE_SURFACE: &str = "base";

/// One leaf answer change and every holder the Save must resolve: a removal, or a merge
/// whose holders follow the surviving answer by id.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
pub struct RemovedAnswerImpact {
    pub attribute_id: String,
    pub answer_id: String,
    /// The surviving answer a merge folds this answer into; absent for a removal.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub merge_into: Option<String>,
    pub affected_workers: usize,
    pub affected_drafts: usize,
    /// Saved values plus the draft answer maps that hold the removed answer. A merge
    /// removes no value, so this stays zero.
    pub removed_values: usize,
    pub holders: Vec<HolderImpact>,
}

/// One holder of a removed answer or a removed Attribute: a Worker's own saved value or a
/// Worker draft's unfinished value.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(
    feature = "ts",
    derive(ts_rs::TS),
    ts(export, rename = "RemovedAnswerHolder")
)]
pub struct HolderImpact {
    pub worker_id: String,
    pub worker_name: String,
    /// `worker` or `workerDraft`.
    #[cfg_attr(feature = "ts", ts(type = "'worker' | 'workerDraft'"))]
    pub kind: &'static str,
    /// For a Worker draft holder, which of its two unfinished surfaces holds the answer:
    /// `draft` for the update being edited, `base` for the record it was based on. Absent
    /// for a saved Worker value.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional, type = "'draft' | 'base'"))]
    pub surface: Option<&'static str>,
    /// Whether choosing no answer would leave the Worker with nothing.
    pub empty_if_unanswered: bool,
    /// The stored value of the holder (a Single-Select string or a Multi-Select array).
    #[serde(skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional, type = "string | Array<string>"))]
    pub value: Option<Value>,
    pub replacements: Vec<ReplacementOutcome>,
}

/// One replacement an organizer may choose for a holder, with its exact result.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(
    feature = "ts",
    derive(ts_rs::TS),
    ts(export, rename = "RemovedAnswerReplacement")
)]
pub struct ReplacementOutcome {
    pub answer_id: String,
    /// The exact Worker value the holder would store after this replacement.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional, type = "string | Array<string>"))]
    pub resulting_value: Option<Value>,
}

/// One answer whose parent changed in a proposal: the branch root, the root-to-answer
/// paths it leaves and gains, and every holder whose reading follows.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(
    feature = "ts",
    derive(ts_rs::TS),
    ts(export, rename = "ConfigurationPreviewMove")
)]
pub struct MovedAnswerImpact {
    pub attribute_id: String,
    pub answer_id: String,
    /// The new parent; absent means the moved answer becomes a root.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub parent_id: Option<String>,
    /// The stored parent; absent means the answer was a root.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub previous_parent_id: Option<String>,
    pub previous_path: Vec<String>,
    pub path: Vec<String>,
    /// The root and every kept answer beneath it, in configured order.
    pub subtree_answer_ids: Vec<String>,
    pub affected_workers: usize,
    pub holders: Vec<MovedAnswerHolder>,
}

/// One saved holder of a moved branch. The answer is held by the Worker itself, so the
/// holder kind is always `worker`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(
    feature = "ts",
    derive(ts_rs::TS),
    ts(export, rename = "ConfigurationPreviewMoveHolder")
)]
pub struct MovedAnswerHolder {
    pub worker_id: String,
    pub worker_name: String,
    /// Always `worker`: a saved Worker value, never a draft surface.
    #[cfg_attr(feature = "ts", ts(type = "'worker'"))]
    pub kind: &'static str,
    pub held_answer_id: String,
    pub previous_path: Vec<String>,
    pub path: Vec<String>,
}

/// The moved branches a preview reports.
pub struct MoveImpacts {
    pub moves: Vec<MovedAnswerImpact>,
}

/// One holder's explicit resolution in the Save body.
#[derive(Debug, Clone, PartialEq)]
pub struct HolderResolution {
    pub worker_id: String,
    /// For a Worker draft holder, `draft` or `base`; absent for a saved Worker value.
    pub surface: Option<String>,
    /// The kept answer to replace the removed one with; absent means no answer.
    pub replacement: Option<String>,
}

/// One removed Attribute with every stored answer it takes away, and the holders whose
/// saved information or unfinished input depends on it.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
pub struct RemovedAttributeImpact {
    pub attribute_id: String,
    /// Every stored answer and branch of the removed Attribute, in configured order.
    pub answer_ids: Vec<String>,
    pub affected_workers: usize,
    pub affected_drafts: usize,
    /// Saved answers plus draft answers the removal discards.
    pub removed_values: usize,
    pub holders: Vec<HolderImpact>,
}

/// The TS union of cardinality surfaces, mirroring `CardinalitySurface`.
#[cfg(feature = "ts")]
#[derive(ts_rs::TS)]
#[ts(export, rename = "CardinalitySurface")]
#[allow(dead_code)]
pub(crate) enum CardinalitySurfaceTs {
    #[ts(rename = "value")]
    Value,
    #[ts(rename = "draft")]
    Draft,
    #[ts(rename = "base")]
    Base,
}

/// One surface that loses answers when a Multi-Select becomes a Single-Select: the
/// Worker's saved value, or one of its unfinished draft values. A Worker that recorded
/// several answers would otherwise have all but one discarded silently.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(
    feature = "ts",
    derive(ts_rs::TS),
    ts(export, rename = "ConfigurationPreviewCardinalityHolder")
)]
pub struct CardinalityHolderImpact {
    pub worker_id: String,
    pub worker_name: String,
    /// `value` for the saved Worker answer, `draft` for draft update, `base` for draft base.
    #[cfg_attr(feature = "ts", ts(as = "CardinalitySurfaceTs"))]
    pub surface: &'static str,
    /// The answers this surface holds, in recorded order and without duplicates.
    pub held: Vec<String>,
    /// Whether a Worker draft also exists for this Worker.
    pub has_draft: bool,
}

/// An Attribute changing from Multi-Select to Single-Select, with every surface that
/// holds several answers. The reverse conversion is lossless and reports none.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(
    feature = "ts",
    derive(ts_rs::TS),
    ts(export, rename = "ConfigurationPreviewCardinality")
)]
pub struct CardinalityImpact {
    pub attribute_id: String,
    #[cfg_attr(
        feature = "ts",
        ts(as = "crate::attribute_migration::WorkerAttributeKindTs")
    )]
    pub from: String,
    #[cfg_attr(
        feature = "ts",
        ts(as = "crate::attribute_migration::WorkerAttributeKindTs")
    )]
    pub to: String,
    pub holders: Vec<CardinalityHolderImpact>,
}

/// One surface's explicit choice: the single answer it keeps, or no answer at all.
#[derive(Debug, Clone, PartialEq)]
pub struct CardinalityHolderResolution {
    pub worker_id: String,
    pub surface: String,
    pub retained: Option<String>,
}

/// The resolutions for one cardinality change.
#[derive(Debug, Clone, PartialEq)]
pub struct CardinalityResolution {
    pub attribute_id: String,
    pub holders: Vec<CardinalityHolderResolution>,
}

/// The resolutions for one removed answer.
#[derive(Debug, Clone, PartialEq)]
pub struct RemovedAnswerResolution {
    pub attribute_id: String,
    pub answer_id: String,
    pub holders: Vec<HolderResolution>,
}

/// The explicit acknowledgement of one removed Attribute. Worker values and drafts have no
/// replacement to choose, so naming the Attribute is their explicit resolution.
#[derive(Debug, Clone, PartialEq)]
pub struct RemovedAttributeResolution {
    pub attribute_id: String,
}

/// The acknowledgement of one cross-Attribute move or promotion that strips a saved Worker
/// value: the source Attribute and the branch root (or promoted answer).
#[derive(Debug, Clone, PartialEq)]
pub struct AttributeMoveResolution {
    pub source_attribute_id: String,
    pub answer_id: String,
}

/// The acknowledgement of one Attribute's select-mode change that trims held answers.
pub use self::mode_impacts::ModeChangeResolution;

/// The Save body's resolutions. Every list may be empty when the change removes no held
/// answer or Attribute.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ConfigurationResolutions {
    pub removed_answers: Vec<RemovedAnswerResolution>,
    pub removed_attributes: Vec<RemovedAttributeResolution>,
    /// One explicit retained answer (or no answer) per lossy Worker value, draft update,
    /// and draft base surface.
    pub cardinality: Vec<CardinalityResolution>,
    /// One acknowledgement per cross-Attribute move or promotion that strips a saved value.
    pub attribute_moves: Vec<AttributeMoveResolution>,
    /// One acknowledgement per Attribute whose select-mode change trims held answers.
    pub mode_changes: Vec<ModeChangeResolution>,
}

/// Why a resolution-aware Save refused to write. Every refusal leaves the database intact.
#[derive(Debug, Clone, PartialEq)]
pub struct ResolutionRefusal {
    pub code: &'static str,
    pub status: u16,
    pub message: String,
}

/// What a resolution-aware Save did.
#[derive(Debug, Clone, PartialEq)]
pub enum ResolutionSaveOutcome {
    Saved {
        attributes: Vec<WorkerAttributeDefinition>,
    },
    Refused(ResolutionRefusal),
}

mod answer_impacts;
mod apply;
pub(crate) mod attribute_moves;
mod cardinality;
mod decode;
mod holders;
mod mode_impacts;
mod move_impacts;
mod preview_base;
mod refusals;
mod removed_attribute;
mod stored;

pub use self::answer_impacts::compute_answer_impacts;
pub(crate) use self::apply::{
    rewrite_worker_drafts_for_kind_changes, rewrite_worker_drafts_for_modes,
};
pub use self::attribute_moves::{
    compute_attribute_move_impacts, AttributeMoveHolder, AttributeMoveImpact,
};
pub use self::cardinality::compute_cardinality_impacts;
pub use self::decode::decode_configuration_resolutions;
pub use self::mode_impacts::{compute_mode_impacts, ModeHolderImpact, ModeImpact};
pub use self::move_impacts::compute_move_impacts;
pub use self::preview_base::configuration_preview_base;
pub use self::removed_attribute::compute_removed_attribute_impacts;
use self::stored::*;

use self::answer_impacts::*;
use self::apply::*;
use self::attribute_moves::{
    acknowledge_attribute_moves, detect_attribute_moves, strip_moved_worker_drafts,
};
use self::cardinality::*;
use self::holders::*;
use self::mode_impacts::{acknowledge_mode_changes, mode_draft_writes};
use self::refusals::*;

/// Saves definitions and explicit answer resolutions atomically. It rechecks the preview
/// base first, refuses an incomplete or invalid plan without writing, and otherwise applies
/// the definition migration, the Worker value changes and the draft updates in one
/// transaction.
pub fn save_attributes_with_resolutions(
    locale: &str,
    conn: &Connection,
    worksite: &Worksite,
    definitions: &[WorkerAttributeDefinition],
    resolutions: &ConfigurationResolutions,
    base: &str,
    id_source: &impl IdSource,
) -> Result<ResolutionSaveOutcome> {
    reject_foreign_attribute_ids(conn, worksite, definitions)?;

    let tx = Transaction::new_unchecked(conn, TransactionBehavior::Deferred)?;
    if configuration_preview_base(&tx, worksite)? != base {
        return Ok(ResolutionSaveOutcome::Refused(stale()));
    }

    let existing = get_stored_worker_attributes(&tx, &Some(worksite.clone()))?;
    let (worker_ids, existing_values) = read_attribute_migration_inputs(&tx, worksite)?;
    validate_attribute_changes(
        &tx,
        worksite,
        &existing,
        definitions,
        &existing_values,
        AllowedEdits::RESOLVED,
    )?;

    let worker_drafts = read_stored_worker_drafts(&tx, worksite)?;
    let impacts = compute_answer_impacts(&tx, worksite, &existing, definitions)?;
    let removed_attributes =
        compute_removed_attribute_impacts(&tx, worksite, &existing, definitions)?;
    let cardinality = compute_cardinality_impacts(&tx, worksite, &existing, definitions)?;
    let mut prepared = match prepare_resolutions(
        definitions,
        &impacts,
        &removed_attributes,
        &cardinality,
        resolutions,
    ) {
        Ok(prepared) => prepared,
        Err(refusal) => return Ok(ResolutionSaveOutcome::Refused(refusal)),
    };
    let attribute_moves = compute_attribute_move_impacts(&tx, worksite, &existing, definitions)?;
    if let Err(refusal) =
        acknowledge_attribute_moves(&attribute_moves, &resolutions.attribute_moves)
    {
        return Ok(ResolutionSaveOutcome::Refused(refusal));
    }
    let mode_impacts = compute_mode_impacts(&tx, worksite, &existing, definitions)?;
    if let Err(refusal) = acknowledge_mode_changes(&mode_impacts, &resolutions.mode_changes) {
        return Ok(ResolutionSaveOutcome::Refused(refusal));
    }
    // The mode writes go first, so an explicit answer resolution on the same draft surface
    // still wins over them.
    let mut draft_writes = mode_draft_writes(&existing, definitions, &worker_drafts)?;
    draft_writes.append(&mut prepared.worker_draft_writes);
    prepared.worker_draft_writes = draft_writes;
    prepared.cardinality_drafts = prepare_cardinality_drafts(
        &existing,
        definitions,
        &worker_drafts,
        &prepared.cardinality_choices,
    )?;

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
    apply_prepared(&tx, worksite, &prepared)?;
    strip_moved_worker_drafts(
        &tx,
        worksite,
        &detect_attribute_moves(&existing, definitions),
    )?;
    tx.commit()?;
    // Only the save that observes a stale revision records the new one; see
    // `replace_worker_attributes_in` for why the mark is conditional.
    if !lists_current {
        crate::abbreviation_revision::mark_lists_current(conn, &worksite.id)?;
    }

    Ok(ResolutionSaveOutcome::Saved {
        attributes: get_worker_attributes(conn, &Some(worksite.clone()))?,
    })
}
