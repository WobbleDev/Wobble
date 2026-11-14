//! Worker attribute definitions and answers, and the plan that migrates stored answers to answer ids.

use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::configuration_resolution::attribute_moves::detect_attribute_moves;
use crate::error::{Error, Result};
use crate::serialization::is_worker_attribute_value;

/// The Rust shape of `WorkerAttributeDefinition`. `kind` stays a string because the
/// guard `is_worker_attribute_definition` has already pinned it to `category` or
/// `tag` by the time one of these exists.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
pub struct WorkerAttributeDefinition {
    pub id: String,
    pub name: String,
    #[cfg_attr(
        feature = "ts",
        ts(as = "crate::attribute_migration::WorkerAttributeKindTs")
    )]
    pub kind: String,
    pub options: Vec<StoredAnswer>,
}

/// `PositionedWorkerAttributeDefinition`: a definition plus its stored column position.
#[derive(Debug, Clone, PartialEq)]
pub struct PositionedWorkerAttributeDefinition {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub options: Vec<StoredAnswer>,
    pub position: i64,
}

/// One `worker_attribute_values` upsert of a plan: a category string or a tag array.
#[derive(Debug, Clone, PartialEq)]
pub struct AttributeValueWrite {
    pub worker_id: String,
    pub attribute_id: String,
    pub value: Value,
}

/// `AttributeMigrationPlan`: every write one replace needs, in the order it applies them.
#[derive(Debug, Clone, PartialEq)]
pub struct AttributeMigrationPlan {
    pub delete_definition_ids: Vec<String>,
    pub blank_name_ids: Vec<String>,
    pub upsert_definitions: Vec<PositionedWorkerAttributeDefinition>,
    pub value_writes: Vec<AttributeValueWrite>,
}

/// `emptyValue(kind)`: `''` for a category, `[]` for anything else.
pub fn empty_attribute_value(kind: &str) -> Value {
    if kind == "category" {
        Value::String(String::new())
    } else {
        Value::Array(Vec::new())
    }
}

/// One answer of an Attribute: `{id, value}` (ADR 0030). A Worker's stored answer refers to
/// it by `id`; `value` is only the text the organizer sees. On a Save request, `mergedInto`
/// marks an answer being folded into the surviving answer with that id; it is never stored.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
pub struct StoredAnswer {
    pub id: String,
    pub value: String,
    #[serde(default, rename = "parentId", skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub parent_id: Option<String>,
    /// The select mode (`single` or `multi`) for this answer's own sub-values (ADR 0043).
    /// Absent means it follows the Attribute's kind.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(
        feature = "ts",
        ts(optional, as = "Option<crate::attribute_migration::SelectModeTs>")
    )]
    pub mode: Option<String>,
    /// The Short form of this value (ADR 0046): at most 10 graphemes. Every stored value has
    /// one; a Save request may omit it, and the core then generates it.
    #[serde(default, rename = "shortForm", skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub short_form: Option<String>,
    /// How `short_form` came to be: `generated` or `edited`.
    #[serde(
        default,
        rename = "shortFormOrigin",
        skip_serializing_if = "Option::is_none"
    )]
    #[cfg_attr(
        feature = "ts",
        ts(
            optional,
            as = "Option<crate::attribute_migration::AbbreviationOriginTs>"
        )
    )]
    pub short_form_origin: Option<String>,
    #[serde(
        default,
        rename = "mergedInto",
        skip_serializing_if = "Option::is_none"
    )]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub merged_into: Option<String>,
}

/// TS-only mirror of `AbbreviationOrigin` (`generated` | `edited`).
///
/// The runtime field stays `Option<String>`; this narrows only the generated TS type.
#[cfg(feature = "ts")]
#[derive(ts_rs::TS)]
#[ts(export, rename = "AbbreviationOrigin")]
#[allow(dead_code)]
pub(crate) enum AbbreviationOriginTs {
    #[ts(rename = "generated")]
    Generated,
    #[ts(rename = "edited")]
    Edited,
}

/// TS-only mirror of `SelectMode` (`single` | `multi`) for `StoredAnswer.mode`.
#[cfg(feature = "ts")]
#[derive(ts_rs::TS)]
#[ts(export, rename = "SelectMode")]
#[allow(dead_code)]
pub(crate) enum SelectModeTs {
    #[ts(rename = "single")]
    Single,
    #[ts(rename = "multi")]
    Multi,
}

/// TS-only mirror of `WorkerAttributeKind` (`category` | `tag`) for
/// `WorkerAttributeDefinition.kind`.
#[cfg(feature = "ts")]
#[derive(ts_rs::TS)]
#[ts(export, rename = "WorkerAttributeKind")]
#[allow(dead_code)]
pub(crate) enum WorkerAttributeKindTs {
    #[ts(rename = "category")]
    Category,
    #[ts(rename = "tag")]
    Tag,
}

/// Parses a stored `options` JSON array of `{id, value}` objects. `None` when any item
/// is not that shape, including the pre-v14 array of plain strings.
pub fn answers_from_json(options: &Value) -> Option<Vec<StoredAnswer>> {
    options
        .as_array()?
        .iter()
        .map(|item| serde_json::from_value::<StoredAnswer>(item.clone()).ok())
        .collect()
}

/// The answers as the stored `options` JSON array.
pub fn answers_to_json(answers: &[StoredAnswer]) -> Value {
    serde_json::to_value(answers).unwrap_or_else(|_| Value::Array(Vec::new()))
}

/// The text to id map of one Attribute's answers. Only the v13 to v14 upgrade reads text;
/// the Save and read paths work on ids alone (ADR 0030).
pub fn ids_by_text(answers: &[StoredAnswer]) -> HashMap<String, String> {
    answers
        .iter()
        .map(|answer| (answer.value.clone(), answer.id.clone()))
        .collect()
}

/// Rewrites a stored Worker answer value through `map`: a category is one string, a tag is
/// an array of strings, and the empty category `''` and `null` pass through. `None` when a
/// string is not in the map.
pub fn map_answer_value(value: &Value, map: &HashMap<String, String>) -> Option<Value> {
    let map_text = |text: &str| -> Option<String> {
        if text.is_empty() {
            Some(String::new())
        } else {
            map.get(text).cloned()
        }
    };
    match value {
        Value::Null => Some(Value::Null),
        Value::String(text) => map_text(text).map(Value::String),
        Value::Array(items) => items
            .iter()
            .map(|item| item.as_str().and_then(map_text).map(Value::String))
            .collect::<Option<Vec<Value>>>()
            .map(Value::Array),
        _ => None,
    }
}

/// The corrupt-stored-value error both conversion checks report.
fn invalid_stored_value(attribute_id: &str) -> Error {
    Error::Message(format!(
        "Invalid value stored for worker attribute {attribute_id}."
    ))
}

/// `convertAttributeValue`, by id: validates the stored value against the *previous*
/// definition, then maps each held answer id through the merge pair (a folded id becomes
/// its survivor), keeps the ids that still exist in the next definition, and dedupes in
/// first-seen order, so a Worker holding both merged answers ends with the survivor once.
/// A category keeps only the first survivor and falls back to `''`; a tag keeps them all.
fn convert_attribute_value(
    raw: &Value,
    previous: &PositionedWorkerAttributeDefinition,
    next: &[StoredAnswer],
    folds: &HashMap<String, String>,
    kind: &str,
) -> Result<Value> {
    let previous_definition = json!({
        "id": previous.id,
        "name": previous.name,
        "kind": previous.kind,
        "options": answers_to_json(&previous.options),
    });
    if !is_worker_attribute_value(raw, &previous_definition) {
        return Err(invalid_stored_value(&previous.id));
    }

    // The guard above pins the shape to a string (category) or an array of strings
    // (tag). Any other shape is unreachable; it is reported as corruption, never
    // as a panic and never as `unreachable!`.
    let mut candidates: Vec<&str> = Vec::new();
    match raw {
        Value::String(text) => candidates.push(text),
        Value::Array(items) => {
            for item in items {
                match item.as_str() {
                    Some(text) => candidates.push(text),
                    None => return Err(invalid_stored_value(&previous.id)),
                }
            }
        }
        _ => return Err(invalid_stored_value(&previous.id)),
    }

    let mut seen = HashSet::new();
    let surviving: Vec<String> = candidates
        .into_iter()
        .map(|candidate| folds.get(candidate).map_or(candidate, String::as_str))
        .filter(|target| next.iter().any(|answer| answer.id == *target))
        .filter(|target| seen.insert(*target))
        .map(str::to_owned)
        .collect();

    // The shape follows the next definition (ADR 0043): a Single-Select Attribute with no
    // Multi-Select group keeps its first survivor as a string, and any other Attribute keeps
    // what its group modes allow, in recorded order.
    let (kept, _dropped) = crate::select_mode::resolve_ids(kind, next, &surviving);
    Ok(crate::select_mode::shape_value(kind, next, &kept))
}

/// The Short form and origin the core would store for each of `kept` (the surviving answers
/// of one proposed Attribute, in order): the one resolution a Save and a preview share.
/// `worksite_values` is every surviving value's name across every proposed Attribute, for
/// the sourced acronym step's worksite conflict check (ADR 0046). `lists_current` is
/// whether this Worksite's generated Short forms already match the bundled lists' revision
/// (ticket 05): when it does not, every generated value regenerates once and an edited one
/// stays untouched.
fn resolved_abbreviations(
    locale: &str,
    previous: Option<&PositionedWorkerAttributeDefinition>,
    kept: &[&StoredAnswer],
    worksite_values: &[&str],
    lists_current: bool,
) -> Vec<(String, String)> {
    let entries: Vec<crate::abbreviation::Entry> = kept
        .iter()
        .map(|answer| crate::abbreviation::Entry {
            name: answer.value.trim(),
            form: answer.short_form.as_deref(),
            origin: answer.short_form_origin.as_deref(),
            stored: previous
                .and_then(|previous| previous.options.iter().find(|old| old.id == answer.id))
                .and_then(|old| {
                    Some((
                        old.value.as_str(),
                        old.short_form.as_deref()?,
                        old.short_form_origin.as_deref()?,
                    ))
                }),
        })
        .collect();
    crate::abbreviation::resolve_attribute(locale, &entries, worksite_values, lists_current)
}

/// Every surviving value's trimmed name across every Attribute of `proposed`: the worksite
/// the sourced acronym step's conflict check (ADR 0046) is judged against. A folded answer
/// has already left the worksite, so it never counts.
fn worksite_value_names(proposed: &[WorkerAttributeDefinition]) -> Vec<&str> {
    proposed
        .iter()
        .flat_map(|attribute| attribute.options.iter())
        .filter(|answer| answer.merged_into.is_none())
        .map(|answer| answer.value.trim())
        .collect()
}

/// The Short form each surviving answer of every proposed Attribute would be stored with,
/// as `(attribute id, answer id, form, origin)`. A preview reports these so the frontend
/// never generates a form itself. `lists_current` is whether this Worksite's generated
/// Short forms already match the bundled lists' revision (ticket 05).
pub fn proposed_abbreviations(
    locale: &str,
    stored: &[PositionedWorkerAttributeDefinition],
    proposed: &[WorkerAttributeDefinition],
    lists_current: bool,
) -> Vec<(String, String, String, String)> {
    let worksite_values = worksite_value_names(proposed);
    let mut forms = Vec::new();
    for attribute in proposed {
        let previous = stored.iter().find(|stored| stored.id == attribute.id);
        let kept: Vec<&StoredAnswer> = attribute
            .options
            .iter()
            .filter(|answer| answer.merged_into.is_none())
            .collect();
        for (answer, (form, origin)) in kept.iter().zip(resolved_abbreviations(
            locale,
            previous,
            &kept,
            &worksite_values,
            lists_current,
        )) {
            forms.push((attribute.id.clone(), answer.id.clone(), form, origin));
        }
    }
    forms
}

/// `computeAttributeMigrationPlan`: compares the stored definitions and values with
/// the incoming configuration and returns every write needed to reconcile them.
///
/// Traps this mirrors from the TS:
/// - `options` compare as ordered arrays (`JSON.stringify`), so a reorder is a change;
/// - a renamed survivor is blanked first, because `UNIQUE (worksite_id, name)` would
///   otherwise reject a name swap;
/// - `??` is nullish: a stored JSON `null` falls back to the *previous* kind's empty
///   value, while the write condition still compares against the raw stored value;
/// - the route's trim is repeated here (idempotent).
///
/// `lists_current` is whether this Worksite's generated Short forms already match the
/// bundled lists' revision (ADR 0046, ticket 05): when it does not, this regenerates
/// every still-generated Short form once, across every Attribute, and never touches an
/// edited one. The caller persists the new revision once the plan is applied.
pub fn compute_attribute_migration_plan_in(
    locale: &str,
    existing_definitions: &[PositionedWorkerAttributeDefinition],
    worker_ids: &[String],
    existing_values_by_worker: &HashMap<String, HashMap<String, Value>>,
    definitions: &[WorkerAttributeDefinition],
    lists_current: bool,
) -> Result<AttributeMigrationPlan> {
    let existing_by_id: HashMap<&str, &PositionedWorkerAttributeDefinition> = existing_definitions
        .iter()
        .map(|definition| (definition.id.as_str(), definition))
        .collect();
    let definition_ids: HashSet<&str> = definitions
        .iter()
        .map(|definition| definition.id.as_str())
        .collect();
    // A promoted answer's new Attribute takes its holders' values from the stored Attribute
    // that held the answer, so the descendants a Worker held stay with the Worker.
    let promotion_sources: HashMap<String, &PositionedWorkerAttributeDefinition> =
        detect_attribute_moves(existing_definitions, definitions)
            .into_iter()
            .filter(|detected| detected.promoted)
            .filter_map(|detected| {
                existing_by_id
                    .get(detected.source_attribute_id.as_str())
                    .map(|source| (detected.target_attribute_id, *source))
            })
            .collect();

    let mut plan = AttributeMigrationPlan {
        delete_definition_ids: existing_definitions
            .iter()
            .filter(|definition| !definition_ids.contains(definition.id.as_str()))
            .map(|definition| definition.id.clone())
            .collect(),
        blank_name_ids: Vec::new(),
        upsert_definitions: Vec::new(),
        value_writes: Vec::new(),
    };

    let worksite_values = worksite_value_names(definitions);
    for (position, attribute) in definitions.iter().enumerate() {
        // The TS trims again here even though the route already trimmed (idempotent).
        let name = attribute.name.trim().to_owned();
        // A folded answer (one carrying `mergedInto`) leaves the list: the definition keeps
        // only the survivors, and every holder of a folded id is remapped to its survivor.
        let folds: HashMap<String, String> = attribute
            .options
            .iter()
            .filter_map(|answer| {
                answer
                    .merged_into
                    .as_ref()
                    .map(|target| (answer.id.clone(), target.clone()))
            })
            .collect();
        // A mode only means something while the answer has sub-values, so a childless answer
        // is stored without one and a later child starts from the Attribute's default.
        let parents: HashSet<&str> = attribute
            .options
            .iter()
            .filter(|answer| answer.merged_into.is_none())
            .filter_map(|answer| answer.parent_id.as_deref())
            .collect();
        let previous = existing_by_id.get(attribute.id.as_str()).copied();
        let kept: Vec<&StoredAnswer> = attribute
            .options
            .iter()
            .filter(|answer| answer.merged_into.is_none())
            .collect();
        // Edited forms and unchanged generated ones stay put; only the rest is generated.
        let forms =
            resolved_abbreviations(locale, previous, &kept, &worksite_values, lists_current);
        let survivors: Vec<StoredAnswer> = kept
            .iter()
            .zip(forms)
            .map(|(answer, (short_form, short_form_origin))| StoredAnswer {
                id: answer.id.clone(),
                value: answer.value.trim().to_owned(),
                parent_id: answer.parent_id.clone(),
                mode: answer
                    .mode
                    .clone()
                    .filter(|_| parents.contains(answer.id.as_str())),
                short_form: Some(short_form),
                short_form_origin: Some(short_form_origin),
                merged_into: None,
            })
            .collect();

        let definition_changed = previous.is_none_or(|previous| {
            previous.name != name
                || previous.kind != attribute.kind
                || previous.options != survivors
                || previous.position != position as i64
        });
        if !definition_changed {
            continue;
        }

        if previous.is_some_and(|previous| previous.name != name) {
            plan.blank_name_ids.push(attribute.id.clone());
        }

        plan.upsert_definitions
            .push(PositionedWorkerAttributeDefinition {
                id: attribute.id.clone(),
                name: name.clone(),
                kind: attribute.kind.clone(),
                options: survivors.clone(),
                position: position as i64,
            });

        let values_need_migration = previous.is_none_or(|previous| {
            previous.kind != attribute.kind || previous.options != survivors || !folds.is_empty()
        });
        if !values_need_migration {
            continue;
        }

        for worker_id in worker_ids {
            let stored = existing_values_by_worker
                .get(worker_id)
                .and_then(|values| values.get(&attribute.id));
            let value = match previous {
                Some(previous) => {
                    // `??`: a null or absent stored value is the empty value of the
                    // previous kind; `previous` exists, so that fallback always exists.
                    let prior = stored
                        .filter(|value| !value.is_null())
                        .cloned()
                        .unwrap_or_else(|| empty_attribute_value(&previous.kind));
                    convert_attribute_value(&prior, previous, &survivors, &folds, &attribute.kind)?
                }
                None => match promotion_sources.get(attribute.id.as_str()) {
                    Some(source) => {
                        let prior = existing_values_by_worker
                            .get(worker_id)
                            .and_then(|values| values.get(&source.id))
                            .filter(|value| !value.is_null())
                            .cloned()
                            .unwrap_or_else(|| empty_attribute_value(&source.kind));
                        convert_attribute_value(
                            &prior,
                            source,
                            &survivors,
                            &folds,
                            &attribute.kind,
                        )?
                    }
                    None => empty_attribute_value(&attribute.kind),
                },
            };

            // `storedValue === undefined || JSON.stringify(storedValue) !== JSON.stringify(value)`,
            // compared against the *raw* stored value, so a stored null still writes.
            let should_write = stored.is_none_or(|stored| *stored != value);
            if should_write {
                plan.value_writes.push(AttributeValueWrite {
                    worker_id: worker_id.clone(),
                    attribute_id: attribute.id.clone(),
                    value,
                });
            }
        }
    }

    Ok(plan)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn compute_attribute_migration_plan(
        existing_definitions: &[PositionedWorkerAttributeDefinition],
        worker_ids: &[String],
        existing_values_by_worker: &HashMap<String, HashMap<String, Value>>,
        definitions: &[WorkerAttributeDefinition],
    ) -> Result<AttributeMigrationPlan> {
        compute_attribute_migration_plan_in(
            "en",
            existing_definitions,
            worker_ids,
            existing_values_by_worker,
            definitions,
            true,
        )
    }

    /// Answers whose id is their text, so the expectations below read as the texts did.
    fn answers(texts: &[&str]) -> Vec<StoredAnswer> {
        texts
            .iter()
            .map(|text| StoredAnswer {
                id: (*text).to_owned(),
                value: (*text).to_owned(),
                parent_id: None,
                mode: None,
                short_form: Some(crate::abbreviation::generate("en", text, &[], &[])),
                short_form_origin: Some(crate::abbreviation::ORIGIN_GENERATED.to_owned()),
                merged_into: None,
            })
            .collect()
    }

    fn definition(id: &str, kind: &str, options: &[&str], name: &str) -> WorkerAttributeDefinition {
        WorkerAttributeDefinition {
            id: id.to_owned(),
            name: name.to_owned(),
            kind: kind.to_owned(),
            options: answers(options),
        }
    }

    fn existing(
        id: &str,
        position: i64,
        kind: &str,
        options: &[&str],
        name: &str,
    ) -> PositionedWorkerAttributeDefinition {
        PositionedWorkerAttributeDefinition {
            id: id.to_owned(),
            name: name.to_owned(),
            kind: kind.to_owned(),
            options: answers(options),
            position,
        }
    }

    /// The spec helper's defaults: a tag with `['one', 'two']` named after its id.
    fn default_definition(id: &str) -> WorkerAttributeDefinition {
        definition(id, "tag", &["one", "two"], id)
    }

    fn default_existing(id: &str, position: i64) -> PositionedWorkerAttributeDefinition {
        existing(id, position, "tag", &["one", "two"], id)
    }

    fn values(entries: &[(&str, &str, Value)]) -> HashMap<String, HashMap<String, Value>> {
        let mut by_worker: HashMap<String, HashMap<String, Value>> = HashMap::new();
        for (worker_id, attribute_id, value) in entries {
            by_worker
                .entry((*worker_id).to_owned())
                .or_default()
                .insert((*attribute_id).to_owned(), value.clone());
        }
        by_worker
    }

    fn write(worker_id: &str, attribute_id: &str, value: Value) -> AttributeValueWrite {
        AttributeValueWrite {
            worker_id: worker_id.to_owned(),
            attribute_id: attribute_id.to_owned(),
            value,
        }
    }

    #[test]
    fn empty_values_follow_the_kind() {
        assert_eq!(empty_attribute_value("category"), json!(""));
        assert_eq!(empty_attribute_value("tag"), json!([]));
    }

    #[test]
    fn blanks_exactly_the_renamed_survivors_in_a_name_swap() {
        let plan = compute_attribute_migration_plan(
            &[
                existing("a", 0, "tag", &["one"], "A"),
                existing("b", 1, "tag", &["two"], "B"),
            ],
            &["w1".to_owned()],
            &HashMap::new(),
            &[
                definition("a", "tag", &["one"], "B"),
                definition("b", "tag", &["two"], "A"),
            ],
        )
        .unwrap();

        assert_eq!(plan.delete_definition_ids, Vec::<String>::new());
        assert_eq!(plan.blank_name_ids, ["a", "b"]);
        assert_eq!(
            plan.upsert_definitions,
            [
                existing("a", 0, "tag", &["one"], "B"),
                existing("b", 1, "tag", &["two"], "A"),
            ]
        );
        assert_eq!(plan.value_writes, Vec::new());
    }

    #[test]
    fn blanks_only_the_definition_that_actually_changes_name() {
        let plan = compute_attribute_migration_plan(
            &[
                existing("a", 0, "tag", &["one"], "A"),
                existing("b", 1, "tag", &["two"], "B"),
            ],
            &[],
            &HashMap::new(),
            &[
                definition("a", "tag", &["one"], "A"),
                definition("b", "tag", &["two"], "C"),
            ],
        )
        .unwrap();

        assert_eq!(plan.blank_name_ids, ["b"]);
        assert_eq!(
            plan.upsert_definitions,
            [existing("b", 1, "tag", &["two"], "C")]
        );
    }

    #[test]
    fn converts_a_tag_to_a_category_by_keeping_the_first_surviving_option() {
        let plan = compute_attribute_migration_plan(
            &[default_existing("a", 0)],
            &["w1".to_owned()],
            &values(&[("w1", "a", json!(["one", "two"]))]),
            &[definition("a", "category", &["one", "two"], "a")],
        )
        .unwrap();

        assert_eq!(plan.value_writes, [write("w1", "a", json!("one"))]);
    }

    #[test]
    fn converts_a_category_to_a_tag_by_wrapping_the_surviving_option() {
        let plan = compute_attribute_migration_plan(
            &[existing("a", 0, "category", &["one", "two"], "a")],
            &["w1".to_owned()],
            &values(&[("w1", "a", json!("one"))]),
            &[definition("a", "tag", &["one", "two"], "a")],
        )
        .unwrap();

        assert_eq!(plan.value_writes, [write("w1", "a", json!(["one"]))]);
    }

    #[test]
    fn prunes_removed_options_from_a_tag_value() {
        let plan = compute_attribute_migration_plan(
            &[default_existing("a", 0)],
            &["w1".to_owned()],
            &values(&[("w1", "a", json!(["one", "two"]))]),
            &[definition("a", "tag", &["one"], "a")],
        )
        .unwrap();

        assert_eq!(plan.value_writes, [write("w1", "a", json!(["one"]))]);
    }

    #[test]
    fn falls_back_to_an_empty_category_when_the_stored_option_is_removed() {
        let plan = compute_attribute_migration_plan(
            &[existing("a", 0, "category", &["one", "two"], "a")],
            &["w1".to_owned()],
            &values(&[("w1", "a", json!("two"))]),
            &[definition("a", "category", &["one"], "a")],
        )
        .unwrap();

        assert_eq!(plan.value_writes, [write("w1", "a", json!(""))]);
    }

    #[test]
    fn reordering_options_is_a_definition_change_but_not_a_value_write() {
        let plan = compute_attribute_migration_plan(
            &[existing("a", 0, "tag", &["one", "two"], "a")],
            &["w1".to_owned()],
            &values(&[("w1", "a", json!(["two", "one"]))]),
            &[definition("a", "tag", &["two", "one"], "a")],
        )
        .unwrap();

        // The option reorder alone is a change: `JSON.stringify` order is compared.
        assert_eq!(
            plan.upsert_definitions,
            [existing("a", 0, "tag", &["two", "one"], "a")]
        );
        // The converted value equals the raw stored value, so nothing is rewritten.
        assert_eq!(plan.value_writes, Vec::new());
    }

    #[test]
    fn seeds_empty_values_for_a_newly_added_attribute_across_every_worker() {
        let plan = compute_attribute_migration_plan(
            &[],
            &["w1".to_owned(), "w2".to_owned()],
            &HashMap::new(),
            &[default_definition("a")],
        )
        .unwrap();

        assert_eq!(
            plan.upsert_definitions,
            [existing("a", 0, "tag", &["one", "two"], "a")]
        );
        assert_eq!(
            plan.value_writes,
            [write("w1", "a", json!([])), write("w2", "a", json!([])),]
        );
    }

    #[test]
    fn produces_an_empty_plan_when_nothing_changed() {
        let plan = compute_attribute_migration_plan(
            &[default_existing("a", 0)],
            &["w1".to_owned()],
            &values(&[("w1", "a", json!(["one"]))]),
            &[default_definition("a")],
        )
        .unwrap();

        assert_eq!(
            plan,
            AttributeMigrationPlan {
                delete_definition_ids: Vec::new(),
                blank_name_ids: Vec::new(),
                upsert_definitions: Vec::new(),
                value_writes: Vec::new(),
            }
        );
    }

    #[test]
    fn deletes_a_definition_that_is_absent_from_the_incoming_list() {
        let plan = compute_attribute_migration_plan(
            &[default_existing("a", 0), default_existing("b", 1)],
            &[],
            &HashMap::new(),
            &[default_definition("a")],
        )
        .unwrap();

        assert_eq!(plan.delete_definition_ids, ["b"]);
        assert_eq!(plan.upsert_definitions, Vec::new());
        assert_eq!(plan.value_writes, Vec::new());
    }

    #[test]
    fn repositions_surviving_definitions_when_an_earlier_one_is_removed() {
        let plan = compute_attribute_migration_plan(
            &[
                default_existing("a", 0),
                default_existing("b", 1),
                default_existing("c", 2),
            ],
            &[],
            &HashMap::new(),
            &[default_definition("a"), default_definition("c")],
        )
        .unwrap();

        assert_eq!(plan.delete_definition_ids, ["b"]);
        assert_eq!(plan.blank_name_ids, Vec::<String>::new());
        assert_eq!(plan.upsert_definitions, [default_existing("c", 1)]);
    }

    #[test]
    fn treats_a_stored_null_as_the_previous_kinds_empty_value_but_still_writes() {
        let tag_plan = compute_attribute_migration_plan(
            &[default_existing("a", 0)],
            &["w1".to_owned()],
            &values(&[("w1", "a", Value::Null)]),
            &[definition("a", "tag", &["one"], "a")],
        )
        .unwrap();
        assert_eq!(tag_plan.value_writes, [write("w1", "a", json!([]))]);

        let category_plan = compute_attribute_migration_plan(
            &[existing("a", 0, "category", &["one", "two"], "a")],
            &["w1".to_owned()],
            &values(&[("w1", "a", Value::Null)]),
            &[definition("a", "category", &["one"], "a")],
        )
        .unwrap();
        assert_eq!(category_plan.value_writes, [write("w1", "a", json!(""))]);
    }

    /// A stored Attribute whose answers keep their parents, for the promotion cases.
    fn tree(
        id: &str,
        kind: &str,
        options: &[(&str, Option<&str>)],
    ) -> PositionedWorkerAttributeDefinition {
        PositionedWorkerAttributeDefinition {
            id: id.to_owned(),
            name: id.to_owned(),
            kind: kind.to_owned(),
            options: options
                .iter()
                .map(|(answer, parent)| StoredAnswer {
                    id: (*answer).to_owned(),
                    value: (*answer).to_owned(),
                    parent_id: parent.map(str::to_owned),
                    mode: None,
                    short_form: Some(crate::abbreviation::generate("en", answer, &[], &[])),
                    short_form_origin: Some(crate::abbreviation::ORIGIN_GENERATED.to_owned()),
                    merged_into: None,
                })
                .collect(),
            position: 0,
        }
    }

    fn proposed_tree(
        id: &str,
        kind: &str,
        options: &[(&str, Option<&str>)],
    ) -> WorkerAttributeDefinition {
        let PositionedWorkerAttributeDefinition {
            id,
            name,
            kind,
            options,
            ..
        } = tree(id, kind, options);
        WorkerAttributeDefinition {
            id,
            name,
            kind,
            options,
        }
    }

    #[test]
    fn a_promoted_category_seeds_the_new_attribute_from_the_held_descendant() {
        let existing = [tree(
            "area",
            "category",
            &[
                ("region", None),
                ("north", Some("region")),
                ("store", Some("north")),
                ("other", None),
            ],
        )];
        let definitions = [
            proposed_tree("area", "category", &[("other", None)]),
            proposed_tree(
                "region",
                "category",
                &[("north", None), ("store", Some("north"))],
            ),
        ];
        let plan = compute_attribute_migration_plan(
            &existing,
            &["w1".to_owned(), "w2".to_owned(), "w3".to_owned()],
            &values(&[
                ("w1", "area", json!("north")),
                ("w2", "area", json!("region")),
                ("w3", "area", json!("other")),
            ]),
            &definitions,
        )
        .unwrap();

        assert_eq!(
            plan.value_writes,
            [
                write("w1", "area", json!("")),
                write("w2", "area", json!("")),
                write("w1", "region", json!("north")),
                write("w2", "region", json!("")),
                write("w3", "region", json!("")),
            ]
        );
    }

    #[test]
    fn a_promoted_tag_seeds_every_held_descendant_in_held_order() {
        let existing = [tree(
            "area",
            "tag",
            &[
                ("region", None),
                ("north", Some("region")),
                ("store", Some("north")),
                ("other", None),
            ],
        )];
        let definitions = [
            proposed_tree("area", "tag", &[("other", None)]),
            proposed_tree(
                "region",
                "tag",
                &[("north", None), ("store", Some("north"))],
            ),
        ];
        let plan = compute_attribute_migration_plan(
            &existing,
            &["w1".to_owned()],
            &values(&[("w1", "area", json!(["store", "other", "region", "north"]))]),
            &definitions,
        )
        .unwrap();

        assert_eq!(
            plan.value_writes,
            [
                write("w1", "area", json!(["other"])),
                write("w1", "region", json!(["store", "north"])),
            ]
        );
    }

    #[test]
    fn a_promoted_attribute_takes_the_kind_it_is_proposed_with() {
        let existing = [tree(
            "area",
            "tag",
            &[("region", None), ("north", Some("region"))],
        )];
        let definitions = [
            proposed_tree("area", "tag", &[]),
            proposed_tree("region", "category", &[("north", None)]),
        ];
        let plan = compute_attribute_migration_plan(
            &existing,
            &["w1".to_owned()],
            &values(&[("w1", "area", json!(["north"]))]),
            &definitions,
        )
        .unwrap();

        assert_eq!(
            plan.upsert_definitions
                .last()
                .map(|attribute| attribute.kind.as_str()),
            Some("category")
        );
        assert!(plan
            .value_writes
            .contains(&write("w1", "region", json!("north"))));
    }

    #[test]
    fn a_new_attribute_that_is_not_a_promotion_still_seeds_empty() {
        let existing = [tree("area", "category", &[("north", None)])];
        let definitions = [
            proposed_tree("area", "category", &[("north", None)]),
            proposed_tree("fresh", "category", &[("brand-new", None)]),
        ];
        let plan = compute_attribute_migration_plan(
            &existing,
            &["w1".to_owned()],
            &values(&[("w1", "area", json!("north"))]),
            &definitions,
        )
        .unwrap();

        assert!(plan.value_writes.contains(&write("w1", "fresh", json!(""))));
    }

    #[test]
    fn reports_a_stored_value_that_is_invalid_for_the_previous_kind() {
        let error = compute_attribute_migration_plan(
            &[existing("a", 0, "category", &["one", "two"], "a")],
            &["w".to_owned()],
            &values(&[("w", "a", json!("INVALID"))]),
            &[definition("a", "tag", &["one", "two"], "a")],
        )
        .unwrap_err();

        assert!(
            matches!(error, Error::Message(message) if message == "Invalid value stored for worker attribute a.")
        );
    }

    /// A stored Attribute with one stale generated Short form ("Cust Serv" is not what the
    /// current lists would themselves produce for "Customer Service": ticket 05's lists
    /// still shorten it to "Cust. Svc.", as `abbreviation::generate` already proves) and one
    /// edited Short form, with neither value renamed or otherwise changed.
    fn stale_abbreviation_attribute() -> PositionedWorkerAttributeDefinition {
        PositionedWorkerAttributeDefinition {
            id: "a".to_owned(),
            name: "a".to_owned(),
            kind: "tag".to_owned(),
            options: vec![
                StoredAnswer {
                    id: "customer-service".to_owned(),
                    value: "Customer Service".to_owned(),
                    parent_id: None,
                    mode: None,
                    short_form: Some("Cust Serv".to_owned()),
                    short_form_origin: Some(crate::abbreviation::ORIGIN_GENERATED.to_owned()),
                    merged_into: None,
                },
                StoredAnswer {
                    id: "my-choice".to_owned(),
                    value: "Maintenance".to_owned(),
                    parent_id: None,
                    mode: None,
                    short_form: Some("My Choice".to_owned()),
                    short_form_origin: Some(crate::abbreviation::ORIGIN_EDITED.to_owned()),
                    merged_into: None,
                },
            ],
            position: 0,
        }
    }

    fn as_proposed(stored: &PositionedWorkerAttributeDefinition) -> WorkerAttributeDefinition {
        WorkerAttributeDefinition {
            id: stored.id.clone(),
            name: stored.name.clone(),
            kind: stored.kind.clone(),
            options: stored.options.clone(),
        }
    }

    #[test]
    fn a_list_revision_change_writes_nothing_while_the_stored_lists_are_current() {
        let stored = stale_abbreviation_attribute();
        let proposed = as_proposed(&stored);

        let plan = compute_attribute_migration_plan_in(
            "en",
            &[stored],
            &[],
            &HashMap::new(),
            &[proposed],
            true,
        )
        .unwrap();

        assert_eq!(plan.upsert_definitions, Vec::new());
    }

    #[test]
    fn a_list_revision_change_regenerates_a_stale_form_but_leaves_an_edited_one_at_the_boundary() {
        let stored = stale_abbreviation_attribute();
        let proposed = as_proposed(&stored);

        let plan = compute_attribute_migration_plan_in(
            "en",
            &[stored],
            &[],
            &HashMap::new(),
            &[proposed],
            false,
        )
        .unwrap();

        let upserted = plan
            .upsert_definitions
            .first()
            .expect("the stale form makes this the one changed Attribute");
        assert_eq!(
            upserted.options[0].short_form.as_deref(),
            Some("Cust. Svc."),
            "a stale generated form moves once the bundled lists' revision has moved on"
        );
        assert_eq!(
            upserted.options[1].short_form.as_deref(),
            Some("My Choice"),
            "an edited Short form is never touched by a list revision change"
        );
    }
}
