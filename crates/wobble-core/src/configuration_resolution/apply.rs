use super::*;

/// Everything the Save writes for the resolutions, validated against the exact stored
/// state before any row changes.
#[derive(Default)]
pub(super) struct PreparedResolutions {
    /// Removed Attributes whose key every Worker draft loses.
    pub(super) removed_attribute_ids: BTreeSet<String>,
    /// `(attribute id, worker id)` to the retained saved answer; `None` is no answer. This
    /// overrides the migration planner's surviving-first write for a lossy conversion.
    pub(super) cardinality_values: HashMap<(String, String), Option<String>>,
    /// Every validated surface choice, keyed by Attribute, Worker and surface.
    pub(super) cardinality_choices: HashMap<(String, String, String), Option<String>>,
    /// The Worker draft update and base values a kind change rewrites, so an unfinished
    /// draft keeps its recorded answers in the Attribute's new representation.
    pub(super) cardinality_drafts: Vec<CardinalityDraftWrite>,
    /// `(worker id, attribute id, resolved value)` for a Worker's saved answer, written after
    /// the migration planner so an explicit replacement wins over its removal or fold.
    pub(super) worker_value_writes: Vec<(String, String, Value)>,
    /// The Worker draft surface values an explicit answer resolution rewrites.
    pub(super) worker_draft_writes: Vec<WorkerDraftValueWrite>,
}

/// One Worker draft surface value an answer resolution rewrites. `surface` is `draft` for
/// the unfinished update or `base` for the record it was based on.
pub(super) struct WorkerDraftValueWrite {
    pub(super) worker_id: String,
    pub(super) surface: &'static str,
    pub(super) attribute_id: String,
    pub(super) value: Value,
}

/// One Worker draft's rewritten Attribute value for a kind change. `None` means the map
/// had no key for the Attribute, so it is left alone.
pub(super) struct CardinalityDraftWrite {
    pub(super) worker_id: String,
    pub(super) attribute_id: String,
    pub(super) update: Option<Value>,
    pub(super) base: Option<Value>,
}

/// One resolution looked up by its removed answer and holder: the Attribute, the removed
/// answer, the Worker, and the draft surface (or the empty string for a saved value).
pub(super) type ResolutionKey = (String, String, String, String);

/// The error's name for a holder: its draft surface when it has one, its Worker otherwise.
pub(super) fn holder_description(worker_id: &str, surface: &str) -> String {
    if surface.is_empty() {
        format!("Worker \"{worker_id}\"")
    } else {
        format!("the {surface} surface of Worker \"{worker_id}\"")
    }
}

/// The kept answer ids of one proposed Attribute.
pub(super) fn kept_answer_ids(
    definitions: &[WorkerAttributeDefinition],
    attribute_id: &str,
) -> HashSet<String> {
    definitions
        .iter()
        .find(|definition| definition.id == attribute_id)
        .map(|definition| {
            definition
                .options
                .iter()
                .filter(|answer| answer.merged_into.is_none())
                .map(|answer| answer.id.clone())
                .collect()
        })
        .unwrap_or_default()
}

/// Validates the Save's resolutions against the impacts and prepares the exact writes.
pub(super) fn prepare_resolutions(
    definitions: &[WorkerAttributeDefinition],
    impacts: &[RemovedAnswerImpact],
    removed_attributes: &[RemovedAttributeImpact],
    cardinality: &[CardinalityImpact],
    resolutions: &ConfigurationResolutions,
) -> std::result::Result<PreparedResolutions, ResolutionRefusal> {
    let mut expected: BTreeSet<ResolutionKey> = BTreeSet::new();
    for impact in impacts {
        for holder in &impact.holders {
            expected.insert((
                impact.attribute_id.clone(),
                impact.answer_id.clone(),
                holder.worker_id.clone(),
                holder.surface.unwrap_or_default().to_owned(),
            ));
        }
    }

    let mut provided: HashMap<ResolutionKey, &HolderResolution> = HashMap::new();
    for removed in &resolutions.removed_answers {
        let known_impact = impacts.iter().any(|impact| {
            impact.attribute_id == removed.attribute_id && impact.answer_id == removed.answer_id
        });
        if !known_impact {
            return Err(invalid_replacement(format!(
                "Answer \"{}\" is not a removed leaf answer of this Configuration change.",
                removed.answer_id
            )));
        }
        for holder in &removed.holders {
            let surface = holder.surface.as_deref().unwrap_or_default();
            let key = (
                removed.attribute_id.clone(),
                removed.answer_id.clone(),
                holder.worker_id.clone(),
                surface.to_owned(),
            );
            if !expected.contains(&key) {
                return Err(missing_resolution(format!(
                    "Resolution for {} does not name an affected holder.",
                    holder_description(&holder.worker_id, surface)
                )));
            }
            if provided.insert(key, holder).is_some() {
                return Err(missing_resolution(format!(
                    "{} resolves the same answer twice.",
                    holder_description(&holder.worker_id, surface)
                )));
            }
        }
    }
    if let Some(missing) = expected.iter().find(|key| !provided.contains_key(*key)) {
        return Err(missing_resolution(format!(
            "Every affected holder needs an explicit replacement or no-answer resolution; {} has none.",
            holder_description(&missing.2, &missing.3)
        )));
    }

    let mut prepared = PreparedResolutions {
        removed_attribute_ids: removed_attributes
            .iter()
            .map(|impact| impact.attribute_id.clone())
            .collect(),
        ..Default::default()
    };

    // Worker values and Worker draft surface values accumulate across impacts: one Worker
    // value may hold several removed answers, and each resolution applies in turn so the
    // final representation keeps the recorded order and has no duplicates.
    let mut worker_values: BTreeMap<(String, String), Value> = BTreeMap::new();
    let mut worker_draft_values: BTreeMap<(String, &'static str, String), Value> = BTreeMap::new();

    for impact in impacts {
        let kept = kept_answer_ids(definitions, &impact.attribute_id);
        for holder in &impact.holders {
            let surface = holder.surface.unwrap_or_default();
            let key = (
                impact.attribute_id.clone(),
                impact.answer_id.clone(),
                holder.worker_id.clone(),
                surface.to_owned(),
            );
            let resolution = provided
                .get(&key)
                .copied()
                .ok_or_else(|| missing_resolution("A holder resolution is missing."))?;
            let description = holder_description(&holder.worker_id, surface);

            if let Some(survivor) = &impact.merge_into {
                // A merge has no choice: the organizer chose the surviving answer, and every
                // holder follows it. Any other answer would be a different move.
                if resolution.replacement.as_deref() != Some(survivor.as_str()) {
                    return Err(invalid_replacement(format!(
                        "{description} holds the merged answer \"{}\"; its resolution must keep the surviving answer \"{survivor}\".",
                        impact.answer_id
                    )));
                }
            } else if let Some(replacement) = &resolution.replacement {
                if !kept.contains(replacement) || replacement == &impact.answer_id {
                    return Err(invalid_replacement(format!(
                        "The replacement for {description} must be a kept answer of the same Attribute."
                    )));
                }
            }

            let kind = definitions
                .iter()
                .find(|definition| definition.id == impact.attribute_id)
                .map(|definition| definition.kind.as_str())
                .ok_or_else(|| {
                    invalid_replacement(format!(
                        "Attribute \"{}\" is no longer part of this Configuration change.",
                        impact.attribute_id
                    ))
                })?;
            let stored = holder.value.as_ref().ok_or_else(|| {
                invalid_replacement(format!("{description} has no stored value to resolve."))
            })?;
            if holder.kind == WORKER_HOLDER {
                let current = worker_values
                    .entry((holder.worker_id.clone(), impact.attribute_id.clone()))
                    .or_insert_with(|| stored.clone());
                *current = apply_worker_answer_resolution(
                    current,
                    &impact.answer_id,
                    resolution.replacement.as_deref(),
                    kind,
                );
            } else {
                let surface = holder.surface.ok_or_else(|| {
                    invalid_replacement(format!(
                        "{description} must name the Worker draft surface it resolves."
                    ))
                })?;
                let current = worker_draft_values
                    .entry((
                        holder.worker_id.clone(),
                        surface,
                        impact.attribute_id.clone(),
                    ))
                    .or_insert_with(|| stored.clone());
                *current = apply_worker_answer_resolution(
                    current,
                    &impact.answer_id,
                    resolution.replacement.as_deref(),
                    kind,
                );
            }
        }
    }

    prepared.worker_value_writes = worker_values
        .into_iter()
        .map(|((worker_id, attribute_id), value)| (worker_id, attribute_id, value))
        .collect();
    prepared.worker_draft_writes = worker_draft_values
        .into_iter()
        .map(
            |((worker_id, surface, attribute_id), value)| WorkerDraftValueWrite {
                worker_id,
                surface,
                attribute_id,
                value,
            },
        )
        .collect();

    // Every removed Attribute needs its explicit acknowledgement whenever it has holders.
    let mut acknowledged: BTreeSet<&str> = BTreeSet::new();
    for resolution in &resolutions.removed_attributes {
        let Some(impact) = removed_attributes
            .iter()
            .find(|impact| impact.attribute_id == resolution.attribute_id)
        else {
            return Err(invalid_replacement(format!(
                "Attribute \"{}\" is not a removed Attribute of this Configuration change.",
                resolution.attribute_id
            )));
        };
        if !acknowledged.insert(impact.attribute_id.as_str()) {
            return Err(missing_resolution(format!(
                "Attribute \"{}\" is acknowledged twice.",
                impact.attribute_id
            )));
        }
    }
    for impact in removed_attributes {
        if !impact.holders.is_empty() && !acknowledged.contains(impact.attribute_id.as_str()) {
            return Err(missing_resolution(format!(
                "The removed Attribute \"{}\" needs an explicit acknowledgement.",
                impact.attribute_id
            )));
        }
    }

    // Cardinality: every lossy Worker value, Worker draft update, and Worker draft base needs
    // exactly one explicit retained answer or no-answer resolution. The retained answer must
    // be one the surface actually holds, so a guess can never pass as a choice.
    let mut expected_surfaces: BTreeSet<(String, String, String)> = BTreeSet::new();
    for impact in cardinality {
        for holder in &impact.holders {
            expected_surfaces.insert((
                impact.attribute_id.clone(),
                holder.worker_id.clone(),
                holder.surface.to_owned(),
            ));
        }
    }
    let mut retained_choices: HashMap<(String, String, String), Option<String>> = HashMap::new();
    for resolution in &resolutions.cardinality {
        let Some(impact) = cardinality
            .iter()
            .find(|impact| impact.attribute_id == resolution.attribute_id)
        else {
            return Err(invalid_replacement(format!(
                "Attribute \"{}\" does not have a Worker cardinality change in this Configuration change.",
                resolution.attribute_id
            )));
        };
        for holder in &resolution.holders {
            let key = (
                resolution.attribute_id.clone(),
                holder.worker_id.clone(),
                holder.surface.clone(),
            );
            let Some(impact_holder) = impact.holders.iter().find(|candidate| {
                candidate.worker_id == holder.worker_id && candidate.surface == holder.surface
            }) else {
                return Err(invalid_replacement(format!(
                    "The {} surface of Worker \"{}\" does not hold several answers in this Configuration change.",
                    holder.surface, holder.worker_id
                )));
            };
            if retained_choices
                .insert(key, holder.retained.clone())
                .is_some()
            {
                return Err(missing_resolution(format!(
                    "The {} surface of Worker \"{}\" is resolved twice.",
                    holder.surface, holder.worker_id
                )));
            }
            if let Some(retained) = &holder.retained {
                if !impact_holder.held.contains(retained) {
                    return Err(invalid_replacement(format!(
                        "The retained answer \"{retained}\" is not one of the answers the {} surface of Worker \"{}\" holds.",
                        holder.surface, holder.worker_id
                    )));
                }
            }
        }
    }
    if let Some((attribute_id, worker_id, surface)) = expected_surfaces
        .iter()
        .find(|key| !retained_choices.contains_key(*key))
    {
        return Err(missing_resolution(format!(
            "Every Worker value, draft update, and draft base that would lose answers needs an explicit retained answer or no-answer resolution; the {surface} surface of Worker \"{worker_id}\" (Attribute \"{attribute_id}\") has none."
        )));
    }
    for ((attribute_id, worker_id, surface), retained) in &retained_choices {
        if surface == VALUE_SURFACE {
            prepared
                .cardinality_values
                .insert((attribute_id.clone(), worker_id.clone()), retained.clone());
        }
    }

    prepared.cardinality_choices = retained_choices;

    Ok(prepared)
}

/// Rewrites every Worker draft's update and base value for an Attribute whose kind changes,
/// even when no answer is lost: an array stored for a now Single-Select Attribute (or a
/// string for a Multi-Select one) would no longer be the representation the Attribute
/// accepts. Lossy draft update and base surfaces each use their own explicit retained
/// choice, so a restored draft keeps its unfinished input and compares against the saved
/// state the Save actually leaves behind.
pub(super) fn prepare_cardinality_drafts(
    previous: &[PositionedWorkerAttributeDefinition],
    definitions: &[WorkerAttributeDefinition],
    worker_drafts: &[StoredWorkerDraft],
    choices: &HashMap<(String, String, String), Option<String>>,
) -> Result<Vec<CardinalityDraftWrite>> {
    let kind_changes: Vec<(
        &PositionedWorkerAttributeDefinition,
        &WorkerAttributeDefinition,
    )> = previous
        .iter()
        .filter_map(|attribute| {
            let next = definitions
                .iter()
                .find(|definition| definition.id == attribute.id)?;
            (attribute.kind != next.kind).then_some((attribute, next))
        })
        .collect();
    let mut writes = Vec::new();
    for draft in worker_drafts {
        for (attribute, next) in &kind_changes {
            let mut update = None;
            if let Some(stored) = draft.update.get(&attribute.id) {
                let held = surviving_answer_ids(stored, attribute, next)?;
                update = Some(if next.kind == "category" {
                    let retained = match choices.get(&(
                        attribute.id.clone(),
                        draft.worker_id.clone(),
                        WORKER_DRAFT_SURFACE.to_owned(),
                    )) {
                        Some(Some(retained)) => retained.clone(),
                        Some(None) => String::new(),
                        None => held.first().cloned().unwrap_or_default(),
                    };
                    Value::String(retained)
                } else {
                    Value::Array(held.into_iter().map(Value::String).collect())
                });
            }
            let mut base = None;
            if let Some(stored) = draft.base.get(&attribute.id) {
                let held = surviving_answer_ids(stored, attribute, next)?;
                base = Some(if next.kind == "category" {
                    let retained = match choices.get(&(
                        attribute.id.clone(),
                        draft.worker_id.clone(),
                        WORKER_BASE_SURFACE.to_owned(),
                    )) {
                        Some(Some(retained)) if held.contains(retained) => retained.clone(),
                        Some(None) => String::new(),
                        _ => held.first().cloned().unwrap_or_default(),
                    };
                    Value::String(retained)
                } else {
                    Value::Array(held.into_iter().map(Value::String).collect())
                });
            }
            if update.is_none() && base.is_none() {
                continue;
            }
            writes.push(CardinalityDraftWrite {
                worker_id: draft.worker_id.clone(),
                attribute_id: attribute.id.clone(),
                update,
                base,
            });
        }
    }
    Ok(writes)
}

/// Applies the prepared kind-change rewrites to the Worksite's Worker draft payloads,
/// changing only the affected Attribute keys in the update and base maps.
pub(super) fn apply_cardinality_draft_writes(
    tx: &Connection,
    worksite: &Worksite,
    writes: &[CardinalityDraftWrite],
) -> Result<()> {
    for write in writes {
        let payload: Option<String> = tx
            .query_row(
                "SELECT payload FROM worker_drafts WHERE worksite_id = ?1 AND worker_id = ?2",
                params![worksite.id, write.worker_id],
                |row| row.get(0),
            )
            .optional()?;
        let Some(payload) = payload else {
            continue;
        };
        let mut draft: Value = serde_json::from_str(&payload)?;
        let mut changed = false;
        if let Some(update) = &write.update {
            if let Some(attributes) = draft
                .pointer_mut("/update/attributes")
                .and_then(Value::as_object_mut)
            {
                changed |= attributes.get(&write.attribute_id) != Some(update);
                attributes.insert(write.attribute_id.clone(), update.clone());
            }
        }
        if let Some(base) = &write.base {
            if let Some(attributes) = draft
                .pointer_mut("/base/attributes")
                .and_then(Value::as_object_mut)
            {
                changed |= attributes.get(&write.attribute_id) != Some(base);
                attributes.insert(write.attribute_id.clone(), base.clone());
            }
        }
        if !changed {
            continue;
        }
        tx.execute(
            "UPDATE worker_drafts SET payload = ?1 \
             WHERE worksite_id = ?2 AND worker_id = ?3",
            params![serde_json::to_string(&draft)?, worksite.id, write.worker_id],
        )?;
    }
    Ok(())
}

/// Writes the explicit Worker value resolutions after the migration planner, changing only
/// the affected Worker/Attribute rows.
pub(super) fn apply_worker_value_writes(
    tx: &Connection,
    writes: &[(String, String, Value)],
) -> Result<()> {
    for (worker_id, attribute_id, value) in writes {
        tx.execute(
            "INSERT INTO worker_attribute_values (worker_id, attribute_id, value) \
             VALUES (?1, ?2, ?3) \
             ON CONFLICT (worker_id, attribute_id) DO UPDATE SET value = excluded.value",
            params![worker_id, attribute_id, serde_json::to_string(value)?],
        )?;
    }
    Ok(())
}

/// Applies the explicit Worker draft surface resolutions, changing only the affected
/// Attribute key in the update or base map. Contact input, the pending note and the stored
/// `updated_at` are left untouched.
pub(super) fn apply_worker_draft_value_writes(
    tx: &Connection,
    worksite: &Worksite,
    writes: &[WorkerDraftValueWrite],
) -> Result<()> {
    for write in writes {
        let payload: Option<String> = tx
            .query_row(
                "SELECT payload FROM worker_drafts WHERE worksite_id = ?1 AND worker_id = ?2",
                params![worksite.id, write.worker_id],
                |row| row.get(0),
            )
            .optional()?;
        let Some(payload) = payload else {
            continue;
        };
        let mut draft: Value = serde_json::from_str(&payload)?;
        let part = if write.surface == WORKER_BASE_SURFACE {
            "/base/attributes"
        } else {
            "/update/attributes"
        };
        let Some(attributes) = draft.pointer_mut(part).and_then(Value::as_object_mut) else {
            continue;
        };
        if attributes.get(&write.attribute_id) == Some(&write.value) {
            continue;
        }
        attributes.insert(write.attribute_id.clone(), write.value.clone());
        tx.execute(
            "UPDATE worker_drafts SET payload = ?1 \
             WHERE worksite_id = ?2 AND worker_id = ?3",
            params![serde_json::to_string(&draft)?, worksite.id, write.worker_id],
        )?;
    }
    Ok(())
}

/// The legacy array Save's kind-change draft reconciliation: every draft value moves into
/// the new representation with no choice, because a lossy Multi-Select to Single-Select
/// change never reaches this path (the guard refuses it). A lossless change keeps every
/// recorded answer, so the first surviving one is the only one there is.
pub(crate) fn rewrite_worker_drafts_for_kind_changes(
    conn: &Connection,
    worksite: &Worksite,
    previous: &[PositionedWorkerAttributeDefinition],
    definitions: &[WorkerAttributeDefinition],
) -> Result<()> {
    let drafts = read_stored_worker_drafts(conn, worksite)?;
    let writes = prepare_cardinality_drafts(previous, definitions, &drafts, &HashMap::new())?;
    apply_cardinality_draft_writes(conn, worksite, &writes)
}

/// The legacy array Save's draft reconciliation for select modes: a draft value moves into
/// the shape the Attribute now stores. The guard has already refused any change that would
/// trim a held answer, so nothing is lost here.
pub(crate) fn rewrite_worker_drafts_for_modes(
    conn: &Connection,
    worksite: &Worksite,
    previous: &[PositionedWorkerAttributeDefinition],
    definitions: &[WorkerAttributeDefinition],
) -> Result<()> {
    let drafts = read_stored_worker_drafts(conn, worksite)?;
    let writes = super::mode_impacts::mode_draft_writes(previous, definitions, &drafts)?;
    apply_worker_draft_value_writes(conn, worksite, &writes)
}

pub(super) fn apply_prepared(
    tx: &Connection,
    worksite: &Worksite,
    prepared: &PreparedResolutions,
) -> Result<()> {
    // The organizer's retained answer beats the planner's surviving-first conversion; the
    // planner has already written the Single-Select value that is replaced here.
    for ((attribute_id, worker_id), retained) in &prepared.cardinality_values {
        let value = Value::String(retained.clone().unwrap_or_default());
        tx.execute(
            "INSERT INTO worker_attribute_values (worker_id, attribute_id, value) \
             VALUES (?1, ?2, ?3) \
             ON CONFLICT (worker_id, attribute_id) DO UPDATE SET value = excluded.value",
            params![worker_id, attribute_id, serde_json::to_string(&value)?],
        )?;
    }

    // The explicit Worker answer resolutions win over the planner's removal or fold, so they
    // apply after it in the same transaction.
    apply_worker_value_writes(tx, &prepared.worker_value_writes)?;
    apply_worker_draft_value_writes(tx, worksite, &prepared.worker_draft_writes)?;
    apply_cardinality_draft_writes(tx, worksite, &prepared.cardinality_drafts)?;

    // The definition cascade already removed the stored answers and Worker values. Every
    // draft keeps its unrelated input but loses the removed question's key.
    prune_worker_drafts(tx, worksite, &prepared.removed_attribute_ids)?;

    Ok(())
}

/// Drops every removed Attribute's key from the Worksite's Worker drafts' update and base
/// maps, leaving contact input, the pending note and every other Attribute untouched.
pub(super) fn prune_worker_drafts(
    tx: &Connection,
    worksite: &Worksite,
    attribute_ids: &BTreeSet<String>,
) -> Result<()> {
    if attribute_ids.is_empty() {
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
        for attribute_id in attribute_ids {
            changed |= input
                .update
                .attributes
                .as_object_mut()
                .and_then(|attributes| attributes.remove(attribute_id))
                .is_some();
            if let Some(base) = input.base.as_mut() {
                changed |= base
                    .attributes
                    .as_object_mut()
                    .and_then(|attributes| attributes.remove(attribute_id))
                    .is_some();
            }
        }
        if changed {
            writes.push((worker_id, serde_json::to_string(&input)?));
        }
    }
    for (worker_id, payload) in writes {
        tx.execute(
            "UPDATE worker_drafts SET payload = ?1 WHERE worksite_id = ?2 AND worker_id = ?3",
            params![payload, worksite.id, worker_id],
        )?;
    }
    Ok(())
}
