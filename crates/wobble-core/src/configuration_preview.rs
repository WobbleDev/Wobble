//! The read-only Configuration impact preview (product gap 12 and 13, requirements C1–C5).
//!
//! It reconciles a proposed Save with the stored Worksite through the same Attribute
//! migration planner the Save applies, reports what each change costs, and writes nothing.
//! A removed shared value costs every Worker value it held; a merge folds the holders into
//! the survivor without logical loss.

use std::collections::{BTreeSet, HashMap, HashSet};

use rusqlite::Connection;
use serde::Serialize;
use serde_json::{json, Value};

use crate::agitation_persistence::{
    get_agitations, reject_foreign_agitation_ids, validate_agitation_merges, Agitation,
    AgitationMerge,
};
use crate::attribute_migration::{
    answers_to_json, compute_attribute_migration_plan_in, proposed_abbreviations,
    PositionedWorkerAttributeDefinition, WorkerAttributeDefinition,
};
use crate::attribute_persistence::{
    get_stored_worker_attributes, read_attribute_migration_inputs, reject_foreign_attribute_ids,
    validate_attribute_changes, AllowedEdits, StoredAttributeValues,
};
use crate::configuration_resolution::{
    compute_answer_impacts, compute_attribute_move_impacts, compute_cardinality_impacts,
    compute_mode_impacts, compute_move_impacts, compute_removed_attribute_impacts,
    configuration_preview_base, AttributeMoveImpact, CardinalityImpact, ModeImpact, MoveImpacts,
    MovedAnswerImpact, RemovedAnswerImpact, RemovedAttributeImpact,
};
use crate::error::Result;
use crate::language_persistence::{
    get_languages, reject_foreign_language_ids, validate_language_merges, Language, LanguageMerge,
};
use crate::schema::Worksite;
use crate::serialization::is_worker_attribute_value;

/// One confirmed shared value (Agitation or Language) of a proposed Save: its stable id,
/// the current label, and the survivor id when the entry is being folded away.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProposedSharedValue {
    pub id: String,
    pub label: String,
    pub merged_into: Option<String>,
}

/// The three proposed sets a preview reconciles. All three are required: an absent set is
/// a validation error at the request boundary, never an instruction to delete one.
#[derive(Debug, Clone, PartialEq)]
pub struct ConfigurationPreviewProposal {
    pub attributes: Vec<WorkerAttributeDefinition>,
    pub agitations: Vec<ProposedSharedValue>,
    pub languages: Vec<ProposedSharedValue>,
}

/// The TS union of preview change entities, mirroring `ConfigurationPreviewEntity`.
#[cfg(feature = "ts")]
#[derive(ts_rs::TS)]
#[ts(export, rename = "ConfigurationPreviewEntity")]
#[allow(dead_code)]
pub(crate) enum ConfigurationPreviewEntityTs {
    #[ts(rename = "attribute")]
    Attribute,
    #[ts(rename = "answer")]
    Answer,
    #[ts(rename = "agitation")]
    Agitation,
    #[ts(rename = "language")]
    Language,
}

/// The TS union of preview change operations, mirroring `ConfigurationPreviewOperation`.
#[cfg(feature = "ts")]
#[derive(ts_rs::TS)]
#[ts(export, rename = "ConfigurationPreviewOperation")]
#[allow(dead_code)]
pub(crate) enum ConfigurationPreviewOperationTs {
    #[ts(rename = "remove")]
    Remove,
    #[ts(rename = "merge")]
    Merge,
    #[ts(rename = "convert")]
    Convert,
    #[ts(rename = "move")]
    Move,
    #[ts(rename = "moveToAttribute")]
    MoveToAttribute,
    #[ts(rename = "promote")]
    Promote,
    #[ts(rename = "selectMode")]
    SelectMode,
}

/// One reported change. An answer change names its Attribute; a merge names its survivor.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(
    feature = "ts",
    derive(ts_rs::TS),
    ts(export, rename = "ConfigurationPreviewChange")
)]
pub struct PreviewChange {
    /// `attribute`, `answer`, `agitation` or `language`.
    #[cfg_attr(feature = "ts", ts(as = "ConfigurationPreviewEntityTs"))]
    pub entity: &'static str,
    /// The stable id of the changed definition; the UI resolves its current label.
    pub id: String,
    /// `remove`, `merge` or `convert`.
    #[cfg_attr(feature = "ts", ts(as = "ConfigurationPreviewOperationTs"))]
    pub operation: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub attribute_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub survivor_id: Option<String>,
    pub affected_workers: usize,
    pub lossy_workers: usize,
    pub discarded_values: usize,
}

/// The deduplicated overall effect: Workers counted once across changes, discarded values
/// counted once each.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(
    feature = "ts",
    derive(ts_rs::TS),
    ts(export, rename = "ConfigurationPreviewTotals")
)]
pub struct PreviewTotals {
    pub affected_workers: usize,
    pub lossy_workers: usize,
    pub discarded_values: usize,
    /// Worker drafts that hold the removed answer or Attribute.
    pub affected_drafts: usize,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
pub struct ConfigurationPreview {
    /// The saved state this preview describes; the Save must send it back unchanged.
    pub base: String,
    pub changes: Vec<PreviewChange>,
    pub totals: PreviewTotals,
    /// Every removed leaf answer with its holders and replacement outcomes.
    pub removed_answers: Vec<RemovedAnswerImpact>,
    /// Every removed Attribute with its answers and holders.
    pub removed_attributes: Vec<RemovedAttributeImpact>,
    /// Every Multi-Select to Single-Select change whose saved value or Worker draft holds
    /// several answers, with the explicit choice each surface needs.
    pub cardinality: Vec<CardinalityImpact>,
    /// Every branch whose parent changed, with the holders across its whole subtree.
    pub moves: Vec<MovedAnswerImpact>,
    /// Every branch that leaves its Attribute for another proposed Attribute, and every
    /// answer promoted to an Attribute of its own, with the holders each one changes.
    pub attribute_moves: Vec<AttributeMoveImpact>,
    /// Every Attribute whose select-mode change trims the answers some Workers hold.
    pub mode_changes: Vec<ModeImpact>,
    /// The Short form each surviving proposed value would be stored with (ADR 0046), so the
    /// frontend never generates one.
    pub short_forms: Vec<SuggestedAbbreviation>,
}

/// One proposed value's Short form and its origin.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(
    feature = "ts",
    derive(ts_rs::TS),
    ts(export, rename = "ConfigurationPreviewAbbreviation")
)]
pub struct SuggestedAbbreviation {
    pub attribute_id: String,
    pub answer_id: String,
    pub short_form: String,
    #[cfg_attr(
        feature = "ts",
        ts(as = "crate::attribute_migration::AbbreviationOriginTs")
    )]
    pub short_form_origin: String,
}

/// The Short form each surviving value of the proposed Attributes would be stored with:
/// the light read behind the Configuration's Short form fields. Writes nothing.
pub fn suggest_abbreviations(
    locale: &str,
    conn: &Connection,
    worksite: &Worksite,
    proposal: &ConfigurationPreviewProposal,
) -> Result<Vec<SuggestedAbbreviation>> {
    reject_foreign_attribute_ids(conn, worksite, &proposal.attributes)?;
    let stored = get_stored_worker_attributes(conn, &Some(worksite.clone()))?;
    let lists_current = crate::abbreviation_revision::lists_current(conn, &worksite.id)?;
    Ok(suggested_forms(
        locale,
        &stored,
        &proposal.attributes,
        lists_current,
    ))
}

fn suggested_forms(
    locale: &str,
    stored: &[PositionedWorkerAttributeDefinition],
    proposed: &[WorkerAttributeDefinition],
    lists_current: bool,
) -> Vec<SuggestedAbbreviation> {
    proposed_abbreviations(locale, stored, proposed, lists_current)
        .into_iter()
        .map(
            |(attribute_id, answer_id, short_form, short_form_origin)| SuggestedAbbreviation {
                attribute_id,
                answer_id,
                short_form,
                short_form_origin,
            },
        )
        .collect()
}

/// One Worker value that a change discards, identified so the overall count counts each
/// value once: the Worker, the entity, the owning Attribute (for an answer) and the
/// discarded answer, Agitation or Language id.
type DiscardedValue = (String, &'static str, String, String);

/// Computes the preview. Reads only: it opens no write transaction, mints no id, and
/// changes no stored row.
pub fn preview_configuration(
    locale: &str,
    conn: &Connection,
    worksite: &Worksite,
    proposal: &ConfigurationPreviewProposal,
) -> Result<ConfigurationPreview> {
    // The save's own foreign-id guard runs first, so a preview can never call another
    // Worksite's definition new and report a misleading zero.
    reject_foreign_attribute_ids(conn, worksite, &proposal.attributes)?;

    let saved_agitations = get_agitations(conn, &Some(worksite.clone()))?;
    let saved_languages = get_languages(conn, &Some(worksite.clone()))?;
    let stored = get_stored_worker_attributes(conn, &Some(worksite.clone()))?;
    let (worker_ids, values) = read_attribute_migration_inputs(conn, worksite)?;
    let base = configuration_preview_base(conn, worksite)?;

    validate_attribute_changes(
        conn,
        worksite,
        &stored,
        &proposal.attributes,
        &values,
        AllowedEdits::RESOLVED,
    )?;
    let cardinality = compute_cardinality_impacts(conn, worksite, &stored, &proposal.attributes)?;
    let lists_current = crate::abbreviation_revision::lists_current(conn, &worksite.id)?;
    let mut accumulator = PreviewAccumulator::default();
    push_attribute_changes(
        locale,
        &mut accumulator,
        &stored,
        &worker_ids,
        &values,
        &proposal.attributes,
        &cardinality,
        lists_current,
    )?;
    let removed_answers = compute_answer_impacts(conn, worksite, &stored, &proposal.attributes)?;
    push_removed_answer_impacts(&mut accumulator, &removed_answers);
    let removed_attributes =
        compute_removed_attribute_impacts(conn, worksite, &stored, &proposal.attributes)?;
    push_removed_attribute_impacts(&mut accumulator, &removed_attributes);
    let move_impacts = compute_move_impacts(conn, worksite, &stored, &proposal.attributes)?;
    push_move_impacts(&mut accumulator, &move_impacts);
    let attribute_moves =
        compute_attribute_move_impacts(conn, worksite, &stored, &proposal.attributes)?;
    push_attribute_move_impacts(&mut accumulator, &attribute_moves);
    let mode_changes = compute_mode_impacts(conn, worksite, &stored, &proposal.attributes)?;
    push_mode_impacts(&mut accumulator, &mode_changes);

    let agitation_holders = shared_holder_ids(conn, worksite, "worker_agitations", "agitation_id")?;
    push_agitation_changes(
        &mut accumulator,
        conn,
        worksite,
        &proposal.agitations,
        &saved_agitations,
        &agitation_holders,
    )?;

    let language_holders = shared_holder_ids(conn, worksite, "worker_languages", "language_id")?;
    push_language_changes(
        &mut accumulator,
        conn,
        worksite,
        &proposal.languages,
        &saved_languages,
        &language_holders,
    )?;

    let short_forms = suggested_forms(locale, &stored, &proposal.attributes, lists_current);

    let totals = accumulator.totals();
    Ok(ConfigurationPreview {
        base,
        changes: accumulator.changes,
        totals,
        removed_answers,
        removed_attributes,
        cardinality,
        moves: move_impacts.moves,
        attribute_moves,
        mode_changes,
        short_forms,
    })
}

/// A select-mode change joins the deduplicated totals: every trimmed saved value counts its
/// Worker as affected and lossy, and each lost answer is one discarded value. A trimmed
/// draft surface counts its Worker's draft once.
fn push_mode_impacts(accumulator: &mut PreviewAccumulator, impacts: &[ModeImpact]) {
    for impact in impacts {
        let mut affected = BTreeSet::new();
        let mut lossy = BTreeSet::new();
        let mut discarded = BTreeSet::new();
        for holder in &impact.holders {
            affected.insert(holder.worker_id.clone());
            lossy.insert(holder.worker_id.clone());
            if holder.surface == "value" {
                for answer_id in &holder.dropped {
                    discarded.insert((
                        holder.worker_id.clone(),
                        "answer",
                        impact.attribute_id.clone(),
                        answer_id.clone(),
                    ));
                }
            } else {
                accumulator
                    .answer_drafts
                    .insert((holder.worker_id.clone(), String::new()));
            }
        }
        accumulator.push(ChangeInput {
            entity: "attribute",
            id: impact.attribute_id.clone(),
            operation: "selectMode",
            attribute_id: None,
            survivor_id: None,
            affected,
            lossy,
            discarded,
        });
    }
}

/// A cross-Attribute move or promotion joins the deduplicated totals: every holder counts as
/// affected, a holder whose saved value loses an answer counts as lossy, and each lost answer
/// is one discarded value of its source Attribute. A kept descendant is not discarded.
fn push_attribute_move_impacts(
    accumulator: &mut PreviewAccumulator,
    impacts: &[AttributeMoveImpact],
) {
    for impact in impacts {
        let affected: BTreeSet<String> = impact
            .holders
            .iter()
            .map(|holder| holder.worker_id.clone())
            .collect();
        let lossy: BTreeSet<String> = impact
            .holders
            .iter()
            .filter(|holder| !holder.lost_answer_ids.is_empty())
            .map(|holder| holder.worker_id.clone())
            .collect();
        let discarded: BTreeSet<DiscardedValue> = impact
            .holders
            .iter()
            .flat_map(|holder| {
                holder.lost_answer_ids.iter().map(|answer_id| {
                    (
                        holder.worker_id.clone(),
                        "answer",
                        impact.source_attribute_id.clone(),
                        answer_id.clone(),
                    )
                })
            })
            .collect();
        accumulator.push(ChangeInput {
            entity: "answer",
            id: impact.answer_id.clone(),
            operation: if impact.promoted {
                "promote"
            } else {
                "moveToAttribute"
            },
            attribute_id: Some(impact.source_attribute_id.clone()),
            survivor_id: None,
            affected,
            lossy,
            discarded,
        });
    }
}

/// The Worker value and Worker draft holders join the same deduplicated totals: a Worker
/// affected by both counts once, and a draft counts once across changed answers. A merge
/// removes no value; it reports one change row of its own and counts every holder it moves
/// to the survivor.
fn push_removed_answer_impacts(
    accumulator: &mut PreviewAccumulator,
    impacts: &[RemovedAnswerImpact],
) {
    for impact in impacts {
        let merge = impact.merge_into.is_some();
        // The change row is built from the same holder rows the Save resolves: a Worker
        // value, its draft update, and its draft base are each named.
        let affected: BTreeSet<String> = impact
            .holders
            .iter()
            .map(|holder| holder.worker_id.clone())
            .collect();
        let discarded: BTreeSet<DiscardedValue> = if merge {
            BTreeSet::new()
        } else {
            affected
                .iter()
                .map(|worker_id| {
                    (
                        worker_id.clone(),
                        "answer",
                        impact.attribute_id.clone(),
                        impact.answer_id.clone(),
                    )
                })
                .collect()
        };
        accumulator.push(ChangeInput {
            entity: "answer",
            id: impact.answer_id.clone(),
            operation: if merge { "merge" } else { "remove" },
            attribute_id: Some(impact.attribute_id.clone()),
            survivor_id: impact.merge_into.clone(),
            affected: affected.clone(),
            lossy: if merge {
                BTreeSet::new()
            } else {
                affected.clone()
            },
            discarded,
        });
        for holder in &impact.holders {
            accumulator.affected.insert(holder.worker_id.clone());
            if !merge {
                accumulator.lossy.insert(holder.worker_id.clone());
                accumulator.discarded.insert((
                    holder.worker_id.clone(),
                    "answer",
                    impact.attribute_id.clone(),
                    impact.answer_id.clone(),
                ));
            }
            if holder.kind == "workerDraft" {
                accumulator
                    .answer_drafts
                    .insert((holder.worker_id.clone(), String::new()));
            }
        }
    }
}

/// A removed Attribute joins the same deduplicated totals. Every holder is named; a Worker
/// value may hold several answers, and a draft contributes each unfinished answer it
/// records. The single change row is the Attribute
/// removal the summary renders.
fn push_removed_attribute_impacts(
    accumulator: &mut PreviewAccumulator,
    impacts: &[RemovedAttributeImpact],
) {
    for impact in impacts {
        let mut affected = BTreeSet::new();
        let mut lossy = BTreeSet::new();
        let mut discarded = BTreeSet::new();

        for holder in &impact.holders {
            affected.insert(holder.worker_id.clone());
            match holder.kind {
                "worker" => {
                    lossy.insert(holder.worker_id.clone());
                    for answer_id in holder
                        .value
                        .as_ref()
                        .map(held_value_ids)
                        .unwrap_or_default()
                    {
                        discarded.insert((
                            holder.worker_id.clone(),
                            "answer",
                            impact.attribute_id.clone(),
                            answer_id,
                        ));
                    }
                }
                "workerDraft" => {
                    accumulator
                        .answer_drafts
                        .insert((holder.worker_id.clone(), String::new()));
                    for answer_id in holder
                        .value
                        .as_ref()
                        .map(held_value_ids)
                        .unwrap_or_default()
                    {
                        discarded.insert((
                            holder.worker_id.clone(),
                            "answer",
                            impact.attribute_id.clone(),
                            answer_id,
                        ));
                    }
                }
                _ => {}
            }
        }

        accumulator.push(ChangeInput {
            entity: "attribute",
            id: impact.attribute_id.clone(),
            operation: "remove",
            attribute_id: None,
            survivor_id: None,
            affected,
            lossy,
            discarded,
        });
    }
}

/// The answer ids a reported Worker value holds. The removal's impact already validated the
/// value, so this only reads its shape.
fn held_value_ids(value: &Value) -> Vec<String> {
    match value {
        Value::String(text) if !text.is_empty() => vec![text.clone()],
        Value::Array(items) => items
            .iter()
            .filter_map(Value::as_str)
            .map(str::to_owned)
            .collect(),
        _ => Vec::new(),
    }
}

/// A moved branch joins the same deduplicated totals as every other change: a Worker.
/// affected by a move and another change counts once. A move is lossless, so its changes
/// report no lossy Workers and no discarded values.
fn push_move_impacts(accumulator: &mut PreviewAccumulator, impacts: &MoveImpacts) {
    for impact in &impacts.moves {
        let affected: BTreeSet<String> = impact
            .holders
            .iter()
            .map(|holder| holder.worker_id.clone())
            .collect();
        accumulator.push(ChangeInput {
            entity: "answer",
            id: impact.answer_id.clone(),
            operation: "move",
            attribute_id: Some(impact.attribute_id.clone()),
            survivor_id: None,
            affected,
            lossy: BTreeSet::new(),
            discarded: BTreeSet::new(),
        });
    }
}

/// The holders of one shared vocabulary table, keyed by the shared value and restricted to
/// this Worksite's Workers.
fn shared_holder_ids(
    conn: &Connection,
    worksite: &Worksite,
    table: &str,
    column: &str,
) -> Result<HashMap<String, BTreeSet<String>>> {
    let mut statement = conn.prepare(&format!(
        "SELECT holdings.{column}, holdings.worker_id \
         FROM {table} AS holdings \
         JOIN workers ON workers.id = holdings.worker_id \
         WHERE workers.worksite_id = ?1"
    ))?;
    let mut rows = statement.query([&worksite.id])?;

    let mut holders: HashMap<String, BTreeSet<String>> = HashMap::new();
    while let Some(row) = rows.next()? {
        holders.entry(row.get(0)?).or_default().insert(row.get(1)?);
    }

    Ok(holders)
}

/// The proposed Agitations with the Save's own merge and foreign-id validation, then the
/// shared reconciliation every shared set uses.
fn push_agitation_changes(
    accumulator: &mut PreviewAccumulator,
    conn: &Connection,
    worksite: &Worksite,
    proposed: &[ProposedSharedValue],
    saved: &[Agitation],
    holders: &HashMap<String, BTreeSet<String>>,
) -> Result<()> {
    let kept: Vec<Agitation> = proposed
        .iter()
        .filter(|value| value.merged_into.is_none())
        .map(|value| Agitation {
            id: value.id.clone(),
            text: value.label.clone(),
        })
        .collect();
    let merges: Vec<AgitationMerge> = proposed
        .iter()
        .filter_map(|value| {
            value.merged_into.as_ref().map(|survivor| AgitationMerge {
                folded_id: value.id.clone(),
                survivor_id: survivor.clone(),
            })
        })
        .collect();

    reject_foreign_agitation_ids(conn, worksite, &kept)?;
    let saved_ids: Vec<String> = saved.iter().map(|agitation| agitation.id.clone()).collect();
    let kept_ids: HashSet<&str> = kept.iter().map(|agitation| agitation.id.as_str()).collect();
    validate_agitation_merges(&saved_ids, &kept_ids, &merges)?;

    push_shared_reconciliation(accumulator, "agitation", &saved_ids, proposed, holders);
    Ok(())
}

/// The proposed Languages with the Save's own merge and foreign-id validation, then the
/// shared reconciliation every shared set uses.
fn push_language_changes(
    accumulator: &mut PreviewAccumulator,
    conn: &Connection,
    worksite: &Worksite,
    proposed: &[ProposedSharedValue],
    saved: &[Language],
    holders: &HashMap<String, BTreeSet<String>>,
) -> Result<()> {
    let kept: Vec<Language> = proposed
        .iter()
        .filter(|value| value.merged_into.is_none())
        .map(|value| Language {
            id: value.id.clone(),
            name: value.label.clone(),
        })
        .collect();
    let merges: Vec<LanguageMerge> = proposed
        .iter()
        .filter_map(|value| {
            value.merged_into.as_ref().map(|survivor| LanguageMerge {
                folded_id: value.id.clone(),
                survivor_id: survivor.clone(),
            })
        })
        .collect();

    reject_foreign_language_ids(conn, worksite, &kept)?;
    let saved_ids: Vec<String> = saved.iter().map(|language| language.id.clone()).collect();
    let kept_ids: HashSet<&str> = kept.iter().map(|language| language.id.as_str()).collect();
    validate_language_merges(&saved_ids, &kept_ids, &merges)?;

    push_shared_reconciliation(accumulator, "language", &saved_ids, proposed, holders);
    Ok(())
}

/// The final effect of one proposed shared set, from saved data to the draft: a kept value
/// preserves its holders, a merge moves the folded value's holders to the survivor without
/// loss, and an omitted value discards every Worker value it held. A value folded into
/// a survivor is reported by the survivor's entry, and a final removal (the value is gone
/// from the proposal) supersedes any staged merge into it.
fn push_shared_reconciliation(
    accumulator: &mut PreviewAccumulator,
    entity: &'static str,
    saved_ids: &[String],
    proposed: &[ProposedSharedValue],
    holders: &HashMap<String, BTreeSet<String>>,
) {
    let kept_ids: HashSet<&str> = proposed
        .iter()
        .filter(|value| value.merged_into.is_none())
        .map(|value| value.id.as_str())
        .collect();
    let folded_ids: HashSet<&str> = proposed
        .iter()
        .filter(|value| value.merged_into.is_some())
        .map(|value| value.id.as_str())
        .collect();
    let merges: Vec<(&str, &str)> = proposed
        .iter()
        .filter_map(|value| {
            value
                .merged_into
                .as_deref()
                .map(|survivor| (value.id.as_str(), survivor))
        })
        .collect();

    for saved_id in saved_ids {
        if kept_ids.contains(saved_id.as_str()) {
            for (folded, survivor) in &merges {
                if *survivor != saved_id.as_str() {
                    continue;
                }
                let affected = holders.get(*folded).cloned().unwrap_or_default();
                accumulator.push(ChangeInput {
                    entity,
                    id: (*folded).to_owned(),
                    operation: "merge",
                    attribute_id: None,
                    survivor_id: Some(saved_id.clone()),
                    affected,
                    lossy: BTreeSet::new(),
                    discarded: BTreeSet::new(),
                });
            }
        } else if !folded_ids.contains(saved_id.as_str()) {
            let affected = holders.get(saved_id).cloned().unwrap_or_default();
            let discarded = affected
                .iter()
                .map(|worker_id| (worker_id.clone(), entity, String::new(), saved_id.clone()))
                .collect();
            accumulator.push(ChangeInput {
                entity,
                id: saved_id.clone(),
                operation: "remove",
                attribute_id: None,
                survivor_id: None,
                affected: affected.clone(),
                lossy: affected,
                discarded,
            });
        }
    }
}

/// One change before it is counted: the identity sets are kept until the totals consume
/// them, so per-change counts and deduplicated totals agree by construction.
struct ChangeInput {
    entity: &'static str,
    id: String,
    operation: &'static str,
    attribute_id: Option<String>,
    survivor_id: Option<String>,
    affected: BTreeSet<String>,
    lossy: BTreeSet<String>,
    discarded: BTreeSet<DiscardedValue>,
}

#[derive(Default)]
struct PreviewAccumulator {
    changes: Vec<PreviewChange>,
    affected: BTreeSet<String>,
    lossy: BTreeSet<String>,
    discarded: BTreeSet<DiscardedValue>,
    /// The Worker drafts a changed answer resolves, counted once per Worker.
    answer_drafts: BTreeSet<(String, String)>,
    removed_values: usize,
}

impl PreviewAccumulator {
    fn push(&mut self, change: ChangeInput) {
        self.affected.extend(change.affected.iter().cloned());
        self.lossy.extend(change.lossy.iter().cloned());
        self.discarded.extend(change.discarded.iter().cloned());
        self.changes.push(PreviewChange {
            entity: change.entity,
            id: change.id,
            operation: change.operation,
            attribute_id: change.attribute_id,
            survivor_id: change.survivor_id,
            affected_workers: change.affected.len(),
            lossy_workers: change.lossy.len(),
            discarded_values: change.discarded.len(),
        });
    }

    fn totals(&self) -> PreviewTotals {
        PreviewTotals {
            affected_workers: self.affected.len(),
            lossy_workers: self.lossy.len(),
            discarded_values: self.discarded.len() + self.removed_values,
            affected_drafts: self.answer_drafts.len(),
        }
    }
}

/// The Attribute changes and the deduplicated totals are built from the same identity sets,
/// so a Worker affected by several changes counts once and an answer discarded once counts
/// once.
#[allow(clippy::too_many_arguments)]
fn push_attribute_changes(
    locale: &str,
    accumulator: &mut PreviewAccumulator,
    stored: &[PositionedWorkerAttributeDefinition],
    worker_ids: &[String],
    values: &StoredAttributeValues,
    proposed: &[WorkerAttributeDefinition],
    cardinality: &[CardinalityImpact],
    lists_current: bool,
) -> Result<()> {
    // The authoritative conversion arithmetic: the same planner the save applies.
    let plan = compute_attribute_migration_plan_in(
        locale,
        stored,
        worker_ids,
        values,
        proposed,
        lists_current,
    )?;
    let writes: HashMap<(&str, &str), &Value> = plan
        .value_writes
        .iter()
        .map(|write| {
            (
                (write.worker_id.as_str(), write.attribute_id.as_str()),
                &write.value,
            )
        })
        .collect();

    for previous in stored {
        match proposed.iter().find(|next| next.id == previous.id) {
            // A removed definition is reported with its holders by
            // `push_removed_attribute_impacts`, not per Worker value here.
            None => {}
            Some(next) => {
                let lossy_surfaces = cardinality
                    .iter()
                    .find(|impact| impact.attribute_id == previous.id);
                push_kept_attribute(
                    accumulator,
                    previous,
                    next,
                    worker_ids,
                    values,
                    &writes,
                    lossy_surfaces,
                )?
            }
        }
    }

    Ok(())
}

fn definition_json(previous: &PositionedWorkerAttributeDefinition) -> Value {
    json!({
        "id": previous.id,
        "name": previous.name,
        "kind": previous.kind,
        "options": answers_to_json(&previous.options),
    })
}

/// One Worker's saved answer ids for an Attribute, validated against the stored
/// definition. An absent or JSON `null` value is the empty value, as the planner
/// treats it; a value the guard rejects is the same corruption the save reports.
fn held_answer_ids(
    value: Option<&Value>,
    previous: &PositionedWorkerAttributeDefinition,
) -> Result<Vec<String>> {
    let Some(value) = value else {
        return Ok(Vec::new());
    };
    if value.is_null() {
        return Ok(Vec::new());
    }
    if !is_worker_attribute_value(value, &definition_json(previous)) {
        return Err(crate::error::Error::Message(format!(
            "Invalid value stored for worker attribute {}.",
            previous.id
        )));
    }

    Ok(crate::select_mode::held_ids(value))
}

/// A converted value as the answer ids it holds. The planner produced it from a value it
/// already validated, so this only reads the shape.
fn converted_answer_ids(value: &Value, _kind: &str) -> Vec<String> {
    crate::select_mode::held_ids(value)
}

/// What one Worker's saved value becomes under the proposal.
struct WorkerImpact {
    worker_id: String,
    lost: Vec<String>,
    affected: bool,
}

fn push_kept_attribute(
    accumulator: &mut PreviewAccumulator,
    previous: &PositionedWorkerAttributeDefinition,
    next: &WorkerAttributeDefinition,
    worker_ids: &[String],
    values: &StoredAttributeValues,
    writes: &HashMap<(&str, &str), &Value>,
    lossy_surfaces: Option<&CardinalityImpact>,
) -> Result<()> {
    let previous_ids: Vec<&str> = previous
        .options
        .iter()
        .map(|answer| answer.id.as_str())
        .collect();
    let proposed_ids: HashSet<&str> = next
        .options
        .iter()
        .map(|answer| answer.id.as_str())
        .collect();
    let removed: Vec<&str> = previous_ids
        .iter()
        .copied()
        .filter(|id| !proposed_ids.contains(id))
        .collect();
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
    // A folded answer that is new to this Worksite has no holders to report. An answer
    // that survives a merge is not removed; removing a survivor removes its folded
    // entries from the proposal, so the final removal supersedes the staged merge. The
    // proposed order keeps the reported changes deterministic.
    let merges: Vec<(&str, &str)> = next
        .options
        .iter()
        .filter_map(|answer| {
            let survivor = answer.merged_into.as_deref()?;
            previous_ids
                .contains(&answer.id.as_str())
                .then_some((answer.id.as_str(), survivor))
        })
        .collect();
    let kind_changed = previous.kind != next.kind;

    if removed.is_empty() && merges.is_empty() && !kind_changed {
        // A pure rename, reorder or added answer changes no saved value.
        return Ok(());
    }

    let mut impacts = Vec::with_capacity(worker_ids.len());
    for worker_id in worker_ids {
        let before = held_answer_ids(
            values
                .get(worker_id)
                .and_then(|held| held.get(&previous.id)),
            previous,
        )?;
        let after = writes
            .get(&(worker_id.as_str(), previous.id.as_str()))
            .map(|value| converted_answer_ids(value, &next.kind))
            .unwrap_or_else(|| before.clone());
        let lost: Vec<String> = before
            .iter()
            .filter(|answer_id| {
                let target = folds
                    .get(answer_id.as_str())
                    .copied()
                    .unwrap_or(answer_id.as_str());
                !after.iter().any(|held| held == target)
            })
            .cloned()
            .collect();
        // A type conversion counts a nonempty value as affected even when the same answer
        // id survives in the other representation; otherwise a value only counts when its
        // answer ids actually changed.
        let affected = if kind_changed {
            !before.is_empty()
        } else {
            before != after
        };
        impacts.push(WorkerImpact {
            worker_id: worker_id.clone(),
            lost,
            affected,
        });
    }

    if kind_changed {
        let mut affected: BTreeSet<String> = impacts
            .iter()
            .filter(|impact| impact.affected)
            .map(|impact| impact.worker_id.clone())
            .collect();
        let mut lossy: BTreeSet<String> = impacts
            .iter()
            .filter(|impact| !impact.lost.is_empty())
            .map(|impact| impact.worker_id.clone())
            .collect();
        let mut discarded: BTreeSet<DiscardedValue> = impacts
            .iter()
            .flat_map(|impact| {
                impact
                    .lost
                    .iter()
                    .map(|answer_id| {
                        (
                            impact.worker_id.clone(),
                            "answer",
                            previous.id.clone(),
                            answer_id.clone(),
                        )
                    })
                    .collect::<Vec<_>>()
            })
            .collect();
        // Worker draft update and base are independent surfaces: each may hold a different
        // set than the saved value and each needs its own retained answer. The conversion
        // row names every discarded set for an explicit choice.
        if let Some(impact) = lossy_surfaces {
            for holder in &impact.holders {
                affected.insert(holder.worker_id.clone());
                if holder.surface == "draft" || holder.surface == "base" {
                    lossy.insert(holder.worker_id.clone());
                    accumulator
                        .answer_drafts
                        .insert((holder.worker_id.clone(), String::new()));
                    for answer_id in holder.held.iter().skip(1) {
                        discarded.insert((
                            holder.worker_id.clone(),
                            "answer",
                            previous.id.clone(),
                            answer_id.clone(),
                        ));
                    }
                } else if holder.has_draft {
                    accumulator
                        .answer_drafts
                        .insert((holder.worker_id.clone(), String::new()));
                }
            }
        }
        accumulator.push(ChangeInput {
            entity: "attribute",
            id: previous.id.clone(),
            operation: "convert",
            attribute_id: None,
            survivor_id: None,
            affected,
            lossy,
            discarded,
        });

        return Ok(());
    }

    // A removed answer or fold is reported from its holder impact, where the saved value
    // and draft surfaces the resolution applies to are known.

    Ok(())
}
