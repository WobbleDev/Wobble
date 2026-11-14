//! Shape validators for stored and request JSON: worker fields, attributes, agitations, languages and committee goal.

use std::collections::{HashMap, HashSet};

use serde_json::{Map, Value};

use crate::utils::has_unique_values;

/// The Worker's free-text fields, which the record panel writes one at a time. The one
/// list of them: request parsing, patch mapping and the shape validators all read it, so
/// a new text field is added here (and in `workerTextFields` in `domain-vocabulary.ts`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WorkerTextField {
    Name,
    Email,
    Phone,
}

impl WorkerTextField {
    /// Every text field, in the order they appear in an update body.
    pub const ALL: [WorkerTextField; 3] = [
        WorkerTextField::Name,
        WorkerTextField::Email,
        WorkerTextField::Phone,
    ];

    /// The wire key, which is also the `workers` column this field writes: the only
    /// strings that ever reach the statement's SQL, from an exhaustive match.
    pub fn key(self) -> &'static str {
        match self {
            WorkerTextField::Name => "name",
            WorkerTextField::Email => "email",
            WorkerTextField::Phone => "phone",
        }
    }

    /// The `workers` column this field writes.
    pub fn column(self) -> &'static str {
        self.key()
    }

    /// The field a patch names, or `None` for anything else.
    pub fn from_field(field: &str) -> Option<Self> {
        Self::ALL
            .into_iter()
            .find(|candidate| candidate.key() == field)
    }
}

/// `assessmentOptions` — case-sensitive, exactly as the vocabulary ships them.
pub const ASSESSMENT_OPTIONS: [&str; 6] = [
    "Unassessed",
    "Leader",
    "Activist",
    "Supporter",
    "Disengaged",
    "Hostile",
];

/// `committeeGoalMinimum`.
pub const COMMITTEE_GOAL_MINIMUM: i64 = 1;

/// `committeeGoalMaximum`.
pub const COMMITTEE_GOAL_MAXIMUM: i64 = 100;

/// `isAssessmentOption`: a string, matched case-sensitively against the options.
pub fn is_assessment_option(value: &Value) -> bool {
    value
        .as_str()
        .is_some_and(|option| ASSESSMENT_OPTIONS.contains(&option))
}

/// The ISO-8601 date-time shape `toISOString()` writes:
/// `YYYY-MM-DDTHH:mm:ss(.sss)?(Z|±HH:MM)`. Full legacy `Date.parse` acceptance
/// is out of scope, so this validates the shape and nothing more.
pub fn is_note_timestamp(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.len() < 20 {
        return false;
    }

    let digits = |range: std::ops::Range<usize>| bytes[range].iter().all(u8::is_ascii_digit);
    let separators = [(4, b'-'), (7, b'-'), (10, b'T'), (13, b':'), (16, b':')];
    if !digits(0..4)
        || !digits(5..7)
        || !digits(8..10)
        || !digits(11..13)
        || !digits(14..16)
        || !digits(17..19)
        || separators
            .iter()
            .any(|(index, expected)| bytes[*index] != *expected)
    {
        return false;
    }

    // Bytes 0..19 are ASCII, so index 19 is a char boundary.
    let mut rest = &value[19..];
    if let Some(fraction) = rest.strip_prefix('.') {
        let length = fraction.bytes().take_while(u8::is_ascii_digit).count();
        if length == 0 || length > 9 {
            return false;
        }
        rest = &fraction[length..];
    }

    if rest == "Z" {
        return true;
    }

    let offset = rest.as_bytes();
    offset.len() == 6
        && (offset[0] == b'+' || offset[0] == b'-')
        && offset[1].is_ascii_digit()
        && offset[2].is_ascii_digit()
        && offset[3] == b':'
        && offset[4].is_ascii_digit()
        && offset[5].is_ascii_digit()
}

/// `isWorkerNote`: the three required fields, non-empty, plus a parseable
/// timestamp. `editedAt` is validated when present and may be absent. A legacy
/// `occurredOn` is ignored. Extra keys are allowed — the TS guard checks no
/// key set.
fn is_worker_note(value: &Value) -> bool {
    let Some(note) = value.as_object() else {
        return false;
    };

    let non_empty = |key: &str| {
        note.get(key)
            .and_then(Value::as_str)
            .is_some_and(|text| !text.is_empty())
    };

    non_empty("id")
        && non_empty("text")
        && note
            .get("timestamp")
            .and_then(Value::as_str)
            .is_some_and(is_note_timestamp)
        && note
            .get("editedAt")
            .is_none_or(|edited| edited.as_str().is_some_and(is_note_timestamp))
}

/// `isWorkerNotes`: every note valid, with unique note ids.
pub fn is_worker_notes(value: &Value) -> bool {
    let Some(notes) = value.as_array() else {
        return false;
    };

    let ids: Vec<&str> = notes
        .iter()
        .filter_map(|note| note.get("id").and_then(Value::as_str))
        .collect();

    notes.iter().all(is_worker_note) && has_unique_values(&ids)
}

/// `isWorkerAttributeDefinition`: the four base keys, a self-trimmed id, a non-blank name, a
/// known kind, and options unique by trimmed lowercase.
pub fn is_worker_attribute_definition(value: &Value) -> bool {
    let Some(definition) = value.as_object() else {
        return false;
    };

    if definition
        .keys()
        .any(|key| !matches!(key.as_str(), "id" | "name" | "kind" | "options"))
    {
        return false;
    }

    let Some(id) = definition.get("id").and_then(Value::as_str) else {
        return false;
    };
    if id.trim().is_empty() || id != id.trim() {
        return false;
    }

    let Some(name) = definition.get("name").and_then(Value::as_str) else {
        return false;
    };
    if name.trim().is_empty() {
        return false;
    }

    if !matches!(
        definition.get("kind").and_then(Value::as_str),
        Some("category" | "tag")
    ) {
        return false;
    }

    let Some(options) = definition.get("options").and_then(Value::as_array) else {
        return false;
    };
    let Some(answers) = options
        .iter()
        .map(answer_fields)
        .collect::<Option<Vec<AnswerFields>>>()
    else {
        return false;
    };

    let answer_ids: Vec<&str> = answers.iter().map(|answer| answer.id).collect();
    if answers.iter().any(|answer| {
        answer
            .parent_id
            .is_some_and(|parent| !answer_ids.contains(&parent))
    }) {
        return false;
    }

    // Each answer has at most one parent in this Attribute, and following the parents
    // from any answer reaches a root: a parent chain that loops back on itself is not a
    // hierarchy. The step bound keeps a corrupt stored chain from walking forever even
    // when a future parse lets one through.
    let parent_of: HashMap<&str, Option<&str>> = answers
        .iter()
        .map(|answer| (answer.id, answer.parent_id))
        .collect();
    for answer in &answers {
        let mut current = answer.parent_id;
        let mut steps = 0;
        while let Some(parent) = current {
            if parent == answer.id || steps > answers.len() {
                return false;
            }
            steps += 1;
            current = parent_of.get(parent).copied().flatten();
        }
    }

    // A merge pair must fold into a surviving answer of this same Attribute.
    let survivors: Vec<&str> = answers
        .iter()
        .filter(|answer| answer.merged_into.is_none())
        .map(|answer| answer.id)
        .collect();
    if !answers
        .iter()
        .filter_map(|answer| answer.merged_into)
        .all(|target| survivors.contains(&target))
    {
        return false;
    }

    // A folded answer leaves the definition. A surviving child parented to it would be
    // stored with a dangling parent, so the merge is refused until the child is resolved
    // explicitly (ticket 12), exactly as removing the parent without its children is.
    if answers
        .iter()
        .filter(|answer| answer.merged_into.is_none())
        .any(|answer| {
            answer
                .parent_id
                .is_some_and(|parent| !survivors.contains(&parent))
        })
    {
        return false;
    }

    // Labels are unique among siblings, not across the whole Attribute: "Packing"
    // under Central and under Other are different paths and both stay valid.
    let mut labels_by_parent: HashMap<Option<&str>, Vec<String>> = HashMap::new();
    for answer in &answers {
        // A confirmed merge removes the folded identity from the resulting hierarchy;
        // its old label cannot conflict with the surviving answer's label.
        if answer.merged_into.is_some() {
            continue;
        }
        labels_by_parent
            .entry(answer.parent_id)
            .or_default()
            .push(answer.value.trim().to_lowercase());
    }
    labels_by_parent
        .values()
        .all(|labels| has_unique_values(labels))
}

/// One answer of a definition as the Save contract sends it: `{id, value}`, plus
/// `mergedInto` on an answer being folded into the surviving answer with that id.
struct AnswerFields<'a> {
    id: &'a str,
    value: &'a str,
    merged_into: Option<&'a str>,
    parent_id: Option<&'a str>,
}

/// Reads one answer, or `None` when it is not exactly that shape: no extra keys, a
/// self-trimmed non-empty id, a non-blank value, and a self-trimmed `mergedInto` if present.
fn answer_fields(value: &Value) -> Option<AnswerFields<'_>> {
    let answer = value.as_object()?;
    if answer.keys().any(|key| {
        !matches!(
            key.as_str(),
            "id" | "value" | "mergedInto" | "parentId" | "mode" | "shortForm" | "shortFormOrigin"
        )
    }) {
        return None;
    }

    let id = answer.get("id")?.as_str()?;
    if id.trim().is_empty() || id != id.trim() {
        return None;
    }

    let text = answer.get("value")?.as_str()?;
    if text.trim().is_empty() {
        return None;
    }

    let merged_into = match answer.get("mergedInto") {
        None => None,
        Some(target) => {
            let target = target.as_str()?;
            if target.trim().is_empty() || target != target.trim() {
                return None;
            }
            Some(target)
        }
    };

    // The select mode of this answer's own sub-values (ADR 0043).
    if let Some(mode) = answer.get("mode") {
        if !mode.as_str().is_some_and(crate::select_mode::is_mode) {
            return None;
        }
    }

    let parent_id = match answer.get("parentId") {
        None => None,
        Some(parent) => {
            let parent = parent.as_str()?;
            if parent.trim().is_empty() || parent != parent.trim() || parent == id {
                return None;
            }
            Some(parent)
        }
    };

    // A Short form travels with its origin (ADR 0046), and an edited one must be valid.
    if abbreviation_problem(answer).is_some() {
        return None;
    }

    Some(AnswerFields {
        id,
        value: text,
        merged_into,
        parent_id,
    })
}

/// Why an answer's `shortForm` and `shortFormOrigin` cannot be saved, or `None` when they
/// are absent or acceptable: both are given or neither, the origin is `generated` or
/// `edited`, and an edited form is 1 to 10 graphemes after trimming. A generated form is
/// produced by the core, so only its shape is checked.
fn abbreviation_problem(answer: &serde_json::Map<String, Value>) -> Option<&'static str> {
    let (form, origin) = (answer.get("shortForm"), answer.get("shortFormOrigin"));
    let (form, origin) = match (form, origin) {
        (None, None) => return None,
        (Some(form), Some(origin)) => (form, origin),
        _ => return Some("malformed"),
    };
    let (Some(form), Some(origin)) = (form.as_str(), origin.as_str()) else {
        return Some("malformed");
    };
    if !crate::abbreviation::is_origin(origin) {
        return Some("malformed");
    }
    if origin == crate::abbreviation::ORIGIN_EDITED && !crate::abbreviation::is_valid(form) {
        return Some("invalid");
    }
    None
}

/// One diagnosable hierarchy problem: a stable code for the client and a diagnostic
/// message naming the answers involved. Shape problems that are not about hierarchy stay
/// `None`, so the routes keep their generic validation refusal for those.
pub struct AttributeHierarchyDiagnosis {
    pub code: &'static str,
    pub message: String,
}

fn hierarchy_diagnosis(message: String) -> AttributeHierarchyDiagnosis {
    AttributeHierarchyDiagnosis {
        code: "configuration_hierarchy_invalid",
        message,
    }
}

/// The first hierarchy problem in a proposed Attribute list, or `None` when the shape is
/// not readable enough to diagnose it. The rules mirror `is_worker_attribute_definition`:
/// a parent must be an answer of the same Attribute, parent chains must be acyclic, and
/// labels are unique among siblings apart from case and padding. Relocation reuses this
/// diagnosis, so a sibling clash surfaces as a coded refusal instead of a generic invalid
/// body; a broken fold target keeps the generic validation refusal.
pub fn diagnose_attribute_hierarchy(value: &Value) -> Option<AttributeHierarchyDiagnosis> {
    let attributes = value.as_array()?;

    for attribute in attributes {
        let attribute = attribute.as_object()?;
        let options = attribute.get("options")?.as_array()?;
        let mut parsed: Vec<(&str, &str, Option<&str>, Option<&str>)> = Vec::new();
        for option in options {
            let option = option.as_object()?;
            let id = option.get("id")?.as_str()?;
            if abbreviation_problem(option) == Some("invalid") {
                return Some(AttributeHierarchyDiagnosis {
                    code: "short_form_invalid",
                    message: format!(
                        "Answer \"{id}\" has a Short form that is not 1 to {} characters.",
                        crate::abbreviation::ABBREVIATION_LIMIT
                    ),
                });
            }
            let label = option.get("value")?.as_str()?;
            let parent = match option.get("parentId") {
                None => None,
                Some(parent) => Some(parent.as_str()?),
            };
            let merged = match option.get("mergedInto") {
                None => None,
                Some(target) => Some(target.as_str()?),
            };
            parsed.push((id, label, parent, merged));
        }

        let ids: Vec<&str> = parsed.iter().map(|(id, ..)| *id).collect();
        if !has_unique_values(&ids) {
            // Duplicate ids are not a hierarchy problem; the shape guard reports them.
            return None;
        }
        for (id, _, parent, _) in &parsed {
            if let Some(parent) = parent {
                if !ids.contains(parent) {
                    return Some(hierarchy_diagnosis(format!(
                        "Answer \"{id}\" has a parent that is not an answer of the same Attribute."
                    )));
                }
                if parent == id {
                    return Some(hierarchy_diagnosis(format!(
                        "Answer \"{id}\" cannot be its own parent."
                    )));
                }
            }
        }

        // Each answer has at most one parent, and following the parents from any answer
        // reaches a root: a chain that loops back on itself is not a hierarchy.
        let parent_of: HashMap<&str, Option<&str>> = parsed
            .iter()
            .map(|(id, _, parent, _)| (*id, *parent))
            .collect();
        for (id, ..) in &parsed {
            let mut current = parent_of.get(id).copied().flatten();
            let mut steps = 0;
            while let Some(parent) = current {
                if parent == *id || steps > parsed.len() {
                    return Some(hierarchy_diagnosis(format!(
                        "Answer \"{id}\" belongs to a parent cycle."
                    )));
                }
                steps += 1;
                current = parent_of.get(parent).copied().flatten();
            }
        }

        // Labels are unique among siblings, not across the whole Attribute.
        let mut labels_by_parent: HashMap<Option<&str>, Vec<(&str, &str)>> = HashMap::new();
        for (id, label, parent, _) in &parsed {
            labels_by_parent
                .entry(*parent)
                .or_default()
                .push((id, label));
        }
        for siblings in labels_by_parent.values() {
            for (index, (first_id, first_label)) in siblings.iter().enumerate() {
                let wanted = first_label.trim().to_lowercase();
                if let Some((second_id, _)) = siblings[index + 1..]
                    .iter()
                    .find(|(_, label)| label.trim().to_lowercase() == wanted)
                {
                    return Some(AttributeHierarchyDiagnosis {
                        code: "configuration_sibling_label_conflict",
                        message: format!(
                            "Answers \"{first_id}\" and \"{second_id}\" have the same name under one parent."
                        ),
                    });
                }
            }
        }
    }

    // Attribute names are unique apart from case and padding, the same rule the shape guard
    // applies. Naming the repeated Attribute lets the client say which name to change.
    let mut names: HashSet<String> = HashSet::new();
    for attribute in attributes {
        let Some(name) = attribute.get("name").and_then(Value::as_str) else {
            continue;
        };
        let name = name.trim();
        if !names.insert(name.to_lowercase()) {
            return Some(AttributeHierarchyDiagnosis {
                code: "configuration_attribute_name_exists",
                message: format!(
                    "An Attribute named \"{name}\" already exists. Attribute names must be different, ignoring case and spacing."
                ),
            });
        }
    }

    None
}

/// `isWorkerAttributeConfiguration`: every definition valid, with unique attribute ids,
/// names unique apart from case and padding, and answer ids unique across the Worksite.
pub fn is_worker_attribute_configuration(value: &Value) -> bool {
    let Some(attributes) = value.as_array() else {
        return false;
    };

    if !attributes.iter().all(is_worker_attribute_definition) {
        return false;
    }

    let ids: Vec<&str> = attributes
        .iter()
        .filter_map(|attribute| attribute.get("id").and_then(Value::as_str))
        .collect();
    let names: Vec<String> = attributes
        .iter()
        .filter_map(|attribute| attribute.get("name").and_then(Value::as_str))
        .map(|name| name.trim().to_lowercase())
        .collect();

    let answer_ids: Vec<&str> = attributes
        .iter()
        .filter_map(|attribute| attribute.get("options").and_then(Value::as_array))
        .flatten()
        .filter_map(|answer| answer.get("id").and_then(Value::as_str))
        .collect();

    has_unique_values(&ids) && has_unique_values(&names) && has_unique_values(&answer_ids)
}

/// The `options` of an attribute definition, empty if it has none.
fn attribute_options(attribute: &Value) -> &[Value] {
    match attribute.get("options").and_then(Value::as_array) {
        Some(options) => options,
        None => &[],
    }
}

/// Whether the attribute holds an answer with this id.
fn has_answer(attribute: &Value, answer_id: &str) -> bool {
    attribute_options(attribute)
        .iter()
        .any(|answer| answer.get("id").and_then(Value::as_str) == Some(answer_id))
}

/// `isWorkerAttributeValues`: the keys are exactly the attribute ids, and each
/// value fits its attribute's kind — a category option or a unique tag subset.
pub fn is_worker_attribute_values(value: &Value, attributes: &[Value]) -> bool {
    let Some(assigned_values) = value.as_object() else {
        return false;
    };

    let attribute_ids: Vec<&str> = attributes
        .iter()
        .filter_map(|attribute| attribute.get("id").and_then(Value::as_str))
        .collect();
    if assigned_values
        .keys()
        .any(|id| !attribute_ids.contains(&id.as_str()))
    {
        return false;
    }

    attributes.iter().all(|attribute| {
        let Some(id) = attribute.get("id").and_then(Value::as_str) else {
            return false;
        };
        let Some(assigned) = assigned_values.get(id) else {
            return false;
        };

        let kind = attribute
            .get("kind")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let answers = crate::attribute_migration::answers_from_json(
            attribute.get("options").unwrap_or(&Value::Null),
        )
        .unwrap_or_default();

        // A Single-Select Attribute stores one id as a string. While one of its values is
        // Multi-Select it may also store a list of distinct ids, which is how it holds several
        // sub-values of that group (ADR 0043); either way every Single-Select group must stay within one branch.
        if kind == "category" {
            if let Some(answer_id) = assigned.as_str() {
                return answer_id.is_empty() || has_answer(attribute, answer_id);
            }
        }

        let Some(tags) = assigned.as_array() else {
            return false;
        };
        if !crate::select_mode::stores_a_list(kind, &answers) {
            return false;
        }
        let held: Vec<String> = tags
            .iter()
            .filter_map(|tag| tag.as_str().map(str::to_owned))
            .collect();
        has_unique_values(tags)
            && held.len() == tags.len()
            && held
                .iter()
                .all(|answer_id| has_answer(attribute, answer_id))
            && crate::select_mode::respects_modes(kind, &answers, &held)
    })
}

/// `isWorkerAttributeValue`: one attribute's value, wrapped as a single-key record.
pub fn is_worker_attribute_value(value: &Value, attribute: &Value) -> bool {
    let Some(attribute_id) = attribute.get("id").and_then(Value::as_str) else {
        return false;
    };

    let mut single = Map::new();
    single.insert(attribute_id.to_owned(), value.clone());

    is_worker_attribute_values(&Value::Object(single), std::slice::from_ref(attribute))
}

/// `isAgitation`: exactly `id` and `text`, both non-empty after their own rules.
fn is_agitation(value: &Value) -> bool {
    let Some(agitation) = value.as_object() else {
        return false;
    };

    if agitation
        .keys()
        .any(|key| !matches!(key.as_str(), "id" | "text" | "mergedInto"))
    {
        return false;
    }

    agitation
        .get("id")
        .and_then(Value::as_str)
        .is_some_and(|id| !id.is_empty())
        && agitation
            .get("text")
            .and_then(Value::as_str)
            .is_some_and(|text| !text.trim().is_empty())
}

/// `isAgitationList`: every agitation valid, with unique ids and unique text among the
/// kept entries; a merged entry (`mergedInto`) must name a kept entry of the list.
pub fn is_agitation_list(value: &Value) -> bool {
    let Some(agitations) = value.as_array() else {
        return false;
    };

    agitations.iter().all(is_agitation) && is_merge_list(agitations, "text")
}

/// Shared list rules for Agitations and Languages: ids unique across every entry,
/// texts or names unique across the kept entries only (a folded entry's text may
/// repeat its survivor's), and each `mergedInto` names a kept entry.
fn is_merge_list(entries: &[Value], text_key: &str) -> bool {
    let ids: Vec<&str> = entries
        .iter()
        .filter_map(|entry| entry.get("id").and_then(Value::as_str))
        .collect();
    if !has_unique_values(&ids) {
        return false;
    }

    let kept: Vec<&Value> = entries
        .iter()
        .filter(|entry| entry.get("mergedInto").is_none())
        .collect();
    let texts: Vec<String> = kept
        .iter()
        .filter_map(|entry| entry.get(text_key).and_then(Value::as_str))
        .map(|text| text.trim().to_lowercase())
        .collect();
    if !has_unique_values(&texts) {
        return false;
    }

    let kept_ids: std::collections::HashSet<&str> = kept
        .iter()
        .filter_map(|entry| entry.get("id").and_then(Value::as_str))
        .collect();
    entries.iter().all(|entry| match entry.get("mergedInto") {
        None => true,
        Some(survivor) => survivor
            .as_str()
            .is_some_and(|survivor| kept_ids.contains(survivor)),
    })
}

/// `isAgitationText`: a string with something other than whitespace in it.
pub fn is_agitation_text(value: &Value) -> bool {
    value.as_str().is_some_and(|text| !text.trim().is_empty())
}

/// `isAgitationIds`: unique non-empty strings, so "" is rejected.
pub fn is_agitation_ids(value: &Value) -> bool {
    let Some(ids) = value.as_array() else {
        return false;
    };

    ids.iter()
        .all(|id| id.as_str().is_some_and(|text| !text.is_empty()))
        && has_unique_values(ids)
}

/// `isLanguage`: exactly `id` and `name`, both non-empty after their own rules.
fn is_language(value: &Value) -> bool {
    let Some(language) = value.as_object() else {
        return false;
    };

    if language
        .keys()
        .any(|key| !matches!(key.as_str(), "id" | "name" | "mergedInto"))
    {
        return false;
    }

    language
        .get("id")
        .and_then(Value::as_str)
        .is_some_and(|id| !id.is_empty())
        && language
            .get("name")
            .and_then(Value::as_str)
            .is_some_and(|name| !name.trim().is_empty())
}

/// `isLanguageList`: every language valid, with unique ids and unique names.
pub fn is_language_list(value: &Value) -> bool {
    let Some(languages) = value.as_array() else {
        return false;
    };

    languages.iter().all(is_language) && is_merge_list(languages, "name")
}

/// `isLanguageName`: a string with something other than whitespace in it.
pub fn is_language_name(value: &Value) -> bool {
    value.as_str().is_some_and(|name| !name.trim().is_empty())
}

/// `isLanguageIds`: unique non-empty strings, so "" is rejected.
pub fn is_language_ids(value: &Value) -> bool {
    let Some(ids) = value.as_array() else {
        return false;
    };

    ids.iter()
        .all(|id| id.as_str().is_some_and(|text| !text.is_empty()))
        && has_unique_values(ids)
}

/// `isCommitteeGoal`: a whole number of workers per Leader, 1 to 100.
/// JS `Number.isInteger` accepts integer-valued floats, so `5.0` and `1e2`
/// pass here too; NaN and infinity are rejected by `is_finite`.
pub fn is_committee_goal(value: &Value) -> bool {
    match value.as_i64() {
        Some(target) => (COMMITTEE_GOAL_MINIMUM..=COMMITTEE_GOAL_MAXIMUM).contains(&target),
        None => value.as_f64().is_some_and(|target| {
            target.is_finite()
                && target.fract() == 0.0
                && target >= COMMITTEE_GOAL_MINIMUM as f64
                && target <= COMMITTEE_GOAL_MAXIMUM as f64
        }),
    }
}

/// `isWorkerImportContacts`: a non-empty batch of named contacts, with a string
/// email and phone when present. Extra keys are allowed — TS checks no key set.
pub fn is_worker_import_contacts(value: &Value) -> bool {
    let Some(contacts) = value.as_array() else {
        return false;
    };

    !contacts.is_empty()
        && contacts.iter().all(|contact| {
            let Some(record) = contact.as_object() else {
                return false;
            };

            if !record
                .get("name")
                .and_then(Value::as_str)
                .is_some_and(|name| !name.trim().is_empty())
            {
                return false;
            }

            WorkerTextField::ALL
                .iter()
                .filter(|field| **field != WorkerTextField::Name)
                .all(|field| match record.get(field.key()) {
                    Some(detail) => detail.is_string(),
                    None => true,
                })
        })
}

/// `isWorkerEmail`: an address-shaped string, so an obvious non-address never reaches
/// the database. The rule is deliberately shallow — one `@`, something either side of
/// it, and a dotted domain — because the core's job is to refuse what is plainly not an
/// address, not to parse RFC 5322. An empty string is a cleared field and is allowed.
pub fn is_worker_email(value: &str) -> bool {
    if value.is_empty() {
        return true;
    }

    let mut parts = value.split('@');
    let (Some(local), Some(domain), None) = (parts.next(), parts.next(), parts.next()) else {
        return false;
    };

    !local.is_empty()
        && !domain.is_empty()
        && domain.contains('.')
        && !domain.starts_with('.')
        && !domain.ends_with('.')
        && !value.chars().any(char::is_whitespace)
}

/// `isWorkerUpdate`: exactly the nine editable fields, each valid, with
/// relationships allowed to be empty strings but agitation ids not.
pub fn is_worker_update(value: &Value, attributes: &[Value]) -> bool {
    // The non-text editable fields; the text fields come from `WorkerTextField::ALL`.
    const OTHER_UPDATE_FIELDS: [&str; 6] = [
        "assessment",
        "attributes",
        "agitations",
        "languages",
        "relationships",
        "notes",
    ];

    let Some(update) = value.as_object() else {
        return false;
    };

    if update.keys().any(|key| {
        WorkerTextField::from_field(key).is_none() && !OTHER_UPDATE_FIELDS.contains(&key.as_str())
    }) {
        return false;
    }

    if !WorkerTextField::ALL
        .iter()
        .all(|field| update.get(field.key()).is_some_and(Value::is_string))
    {
        return false;
    }
    if !update.get("assessment").is_some_and(is_assessment_option) {
        return false;
    }
    if !update
        .get("attributes")
        .is_some_and(|assigned| is_worker_attribute_values(assigned, attributes))
    {
        return false;
    }
    if !update.get("agitations").is_some_and(is_agitation_ids) {
        return false;
    }
    if !update.get("languages").is_some_and(is_language_ids) {
        return false;
    }

    let Some(relationships) = update.get("relationships").and_then(Value::as_array) else {
        return false;
    };
    if !relationships.iter().all(Value::is_string) || !has_unique_values(relationships) {
        return false;
    }

    update.get("notes").is_some_and(is_worker_notes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn department() -> Value {
        json!({
            "id": "a1",
            "name": "Department",
            "kind": "category",
            "options": [{"id": "d-foh", "value": "Front of House"}, {"id": "d-boh", "value": "Back of House"}]
        })
    }

    fn shifts() -> Value {
        json!({
            "id": "a2",
            "name": "Shifts",
            "kind": "tag",
            "options": [{"id": "s-dinner", "value": "Dinner"}, {"id": "s-brunch", "value": "Brunch"}]
        })
    }

    fn attributes() -> Vec<Value> {
        vec![department(), shifts()]
    }

    fn valid_update() -> Value {
        json!({
            "name": "Lise Meitner",
            "email": "lise.meitner@example.test",
            "phone": "",
            "assessment": "Supporter",
            "attributes": { "a1": "d-foh", "a2": ["s-dinner"] },
            "agitations": ["g1"],
            "languages": [],
            "relationships": ["w02"],
            "notes": []
        })
    }

    /// The TS `{ ...validUpdate, key: value }` spread.
    fn with(update: &Value, key: &str, value: Value) -> Value {
        let mut spread = update.clone();
        spread[key] = value;
        spread
    }

    fn without(update: &Value, key: &str) -> Value {
        let mut spread = update.clone();
        spread.as_object_mut().expect("an update").remove(key);
        spread
    }

    #[test]
    fn is_assessment_option_accepts_every_configured_option() {
        for option in ASSESSMENT_OPTIONS {
            assert!(is_assessment_option(&json!(option)));
        }
    }

    #[test]
    fn is_assessment_option_rejects_unknown_mistyped_or_untrimmed_values() {
        assert!(!is_assessment_option(&json!("supporter")));
        assert!(!is_assessment_option(&json!("Supporter ")));
        assert!(!is_assessment_option(&json!(42)));
        assert!(!is_assessment_option(&Value::Null));
    }

    #[test]
    fn accepts_a_definition_with_no_options() {
        assert!(is_worker_attribute_definition(
            &json!({ "id": "a3", "name": "Notes", "kind": "category", "options": [] })
        ));
    }

    #[test]
    fn rejects_unknown_keys_unknown_kinds_and_untrimmed_identities() {
        assert!(!is_worker_attribute_definition(&with(
            &department(),
            "extra",
            json!(true)
        )));
        assert!(!is_worker_attribute_definition(&with(
            &department(),
            "kind",
            json!("single")
        )));
        assert!(!is_worker_attribute_definition(&with(
            &department(),
            "id",
            json!(" a1")
        )));
        assert!(!is_worker_attribute_definition(&with(
            &department(),
            "name",
            json!("   ")
        )));
    }

    #[test]
    fn rejects_options_that_repeat_apart_from_case_or_padding() {
        assert!(!is_worker_attribute_definition(&with(
            &department(),
            "options",
            json!([{"id": "s-1", "value": "Dinner"}, {"id": "s-2", "value": "dinner"}])
        )));
        assert!(!is_worker_attribute_definition(&with(
            &department(),
            "options",
            json!([{"id": "s-1", "value": "Dinner"}, {"id": "s-2", "value": " Dinner "}])
        )));
    }

    /// An Attribute whose answers form Central / Store A, Central / Packing and a root
    /// Other / Packing: the same label under two different parents is legitimate.
    fn hierarchy() -> Value {
        json!({
            "id": "a4",
            "name": "Location",
            "kind": "category",
            "options": [
                { "id": "central", "value": "Central" },
                { "id": "store-a", "value": "Store A", "parentId": "central" },
                { "id": "central-packing", "value": "Packing", "parentId": "central" },
                { "id": "other", "value": "Other" },
                { "id": "other-packing", "value": "Packing", "parentId": "other" }
            ]
        })
    }

    #[test]
    fn accepts_a_hierarchy_and_keeps_same_named_answers_under_different_parents() {
        assert!(is_worker_attribute_definition(&hierarchy()));
    }

    #[test]
    fn rejects_a_label_repeated_under_one_parent_but_not_under_another() {
        // Two roots named "Other" collide with each other.
        assert!(!is_worker_attribute_definition(&with(
            &hierarchy(),
            "options",
            json!([
                { "id": "other", "value": "Other" },
                { "id": "other-2", "value": " other " }
            ])
        )));

        // Two children of Central named "Packing" collide, apart from case and padding.
        assert!(!is_worker_attribute_definition(&with(
            &hierarchy(),
            "options",
            json!([
                { "id": "central", "value": "Central" },
                { "id": "central-packing", "value": "Packing", "parentId": "central" },
                { "id": "central-packing-2", "value": " packing ", "parentId": "central" }
            ])
        )));

        // The same label one level apart is a different path, not a collision.
        assert!(is_worker_attribute_definition(&with(
            &hierarchy(),
            "options",
            json!([
                { "id": "central", "value": "Packing" },
                { "id": "central-packing", "value": "Packing", "parentId": "central" }
            ])
        )));
    }

    #[test]
    fn rejects_self_parented_cross_attribute_dangling_and_cyclic_parents() {
        let with_parent = |parent: &str| {
            with(
                &hierarchy(),
                "options",
                json!([
                    { "id": "central", "value": "Central", "parentId": parent },
                    { "id": "store-a", "value": "Store A", "parentId": "central" }
                ]),
            )
        };

        assert!(!is_worker_attribute_definition(&with_parent("central")));
        assert!(!is_worker_attribute_definition(&with_parent("missing")));
        assert!(!is_worker_attribute_definition(&with_parent("s-dinner")));

        // A two-answer cycle and a longer chain back to its start.
        for options in [
            json!([
                { "id": "a", "value": "A", "parentId": "b" },
                { "id": "b", "value": "B", "parentId": "a" }
            ]),
            json!([
                { "id": "a", "value": "A", "parentId": "c" },
                { "id": "b", "value": "B", "parentId": "a" },
                { "id": "c", "value": "C", "parentId": "b" }
            ]),
        ] {
            assert!(!is_worker_attribute_definition(&with(
                &hierarchy(),
                "options",
                options
            )));
        }
    }

    #[test]
    fn rejects_a_merge_or_removal_that_would_strand_a_surviving_child() {
        // Folding Central away while its child survives leaves a dangling parent.
        assert!(!is_worker_attribute_definition(&json!({
            "id": "a5",
            "name": "Location",
            "kind": "category",
            "options": [
                { "id": "central", "value": "Central", "mergedInto": "other" },
                { "id": "other", "value": "Other" },
                { "id": "store-a", "value": "Store A", "parentId": "central" }
            ]
        })));

        // Folding a leaf is still a merge: its surviving siblings keep a valid parent.
        assert!(is_worker_attribute_definition(&json!({
            "id": "a5",
            "name": "Location",
            "kind": "category",
            "options": [
                { "id": "central", "value": "Central" },
                { "id": "store-a", "value": "Store A", "parentId": "central" },
                { "id": "store-a-2", "value": "Store A2", "parentId": "central", "mergedInto": "store-a" }
            ]
        })));
    }

    #[test]
    fn diagnoses_sibling_label_clashes_and_hierarchy_breakage() {
        let sibling = json!([{
            "id": "loc",
            "name": "Location",
            "kind": "category",
            "options": [
                { "id": "central", "value": "Central" },
                { "id": "a", "value": "Packing", "parentId": "central" },
                { "id": "b", "value": " packing ", "parentId": "central" }
            ]
        }]);
        let diagnosis = diagnose_attribute_hierarchy(&sibling).expect("a sibling clash");
        assert_eq!(diagnosis.code, "configuration_sibling_label_conflict");
        assert!(diagnosis.message.contains("\"a\""), "{}", diagnosis.message);
        assert!(diagnosis.message.contains("\"b\""), "{}", diagnosis.message);

        let same_label_elsewhere = json!([{
            "id": "loc",
            "name": "Location",
            "kind": "category",
            "options": [
                { "id": "central", "value": "Central" },
                { "id": "other", "value": "Other" },
                { "id": "a", "value": "Packing", "parentId": "central" },
                { "id": "b", "value": "Packing", "parentId": "other" }
            ]
        }]);
        assert!(diagnose_attribute_hierarchy(&same_label_elsewhere).is_none());

        let invalid = [
            json!([{
                "id": "loc",
                "name": "Location",
                "kind": "category",
                "options": [
                    { "id": "a", "value": "A", "parentId": "b" },
                    { "id": "b", "value": "B", "parentId": "a" }
                ]
            }]),
            json!([{
                "id": "loc",
                "name": "Location",
                "kind": "category",
                "options": [{ "id": "a", "value": "A", "parentId": "missing" }]
            }]),
            json!([{
                "id": "loc",
                "name": "Location",
                "kind": "category",
                "options": [{ "id": "a", "value": "A", "parentId": "a" }]
            }]),
        ];
        for value in invalid {
            let diagnosis = diagnose_attribute_hierarchy(&value).expect("a hierarchy problem");
            assert_eq!(diagnosis.code, "configuration_hierarchy_invalid", "{value}");
        }

        // A shape that is not readable enough to diagnose stays with the generic refusal.
        assert!(diagnose_attribute_hierarchy(&json!([{ "id": "loc" }])).is_none());
        assert!(diagnose_attribute_hierarchy(&json!([{
            "id": "loc",
            "options": [{ "id": "a" }]
        }]))
        .is_none());
    }

    #[test]
    fn diagnoses_an_attribute_name_repeated_ignoring_case_and_spacing() {
        let repeated = json!([
            { "id": "loc", "name": "Location", "kind": "category", "options": [] },
            { "id": "area", "name": " location ", "kind": "tag", "options": [] }
        ]);
        let diagnosis = diagnose_attribute_hierarchy(&repeated).expect("a repeated name");
        assert_eq!(diagnosis.code, "configuration_attribute_name_exists");
        assert_eq!(
            diagnosis.message,
            "An Attribute named \"location\" already exists. Attribute names must be different, ignoring case and spacing."
        );

        let distinct = json!([
            { "id": "loc", "name": "Location", "kind": "category", "options": [] },
            { "id": "area", "name": "Locations", "kind": "tag", "options": [] }
        ]);
        assert!(diagnose_attribute_hierarchy(&distinct).is_none());
    }

    #[test]
    fn configuration_accepts_the_configured_columns() {
        assert!(is_worker_attribute_configuration(&Value::Array(
            attributes()
        )));
        assert!(is_worker_attribute_configuration(&json!([])));
    }

    #[test]
    fn configuration_rejects_repeated_ids_or_case_variant_names() {
        let repeated_id = vec![department(), with(&shifts(), "id", json!("a1"))];
        assert!(!is_worker_attribute_configuration(&Value::Array(
            repeated_id
        )));

        let repeated_name = vec![department(), with(&shifts(), "name", json!("department"))];
        assert!(!is_worker_attribute_configuration(&Value::Array(
            repeated_name
        )));
    }

    #[test]
    fn attribute_value_allows_a_category_to_be_cleared_but_not_invented() {
        assert!(is_worker_attribute_value(&json!(""), &department()));
        assert!(is_worker_attribute_value(&json!("d-foh"), &department()));
        assert!(!is_worker_attribute_value(
            &json!("d-kitchen"),
            &department()
        ));
        assert!(!is_worker_attribute_value(&json!(["d-foh"]), &department()));
    }

    #[test]
    fn attribute_value_requires_a_tag_to_be_a_unique_subset_of_options() {
        assert!(is_worker_attribute_value(
            &json!(["s-dinner", "s-brunch"]),
            &shifts()
        ));
        assert!(is_worker_attribute_value(&json!([]), &shifts()));
        assert!(!is_worker_attribute_value(
            &json!(["s-dinner", "s-dinner"]),
            &shifts()
        ));
        assert!(!is_worker_attribute_value(&json!(["s-lunch"]), &shifts()));
        assert!(!is_worker_attribute_value(&json!("s-dinner"), &shifts()));
    }

    #[test]
    fn worker_update_accepts_a_complete_worker_update() {
        assert!(is_worker_update(&valid_update(), &attributes()));
    }

    #[test]
    fn worker_update_rejects_unknown_keys_and_missing_fields() {
        assert!(!is_worker_update(
            &with(&valid_update(), "id", json!("w01")),
            &attributes()
        ));
        assert!(!is_worker_update(
            &without(&valid_update(), "phone"),
            &attributes()
        ));
        assert!(!is_worker_update(
            &with(&valid_update(), "assignments", json!([])),
            &attributes()
        ));
    }

    #[test]
    fn worker_update_rejects_attribute_values_that_do_not_line_up() {
        assert!(!is_worker_update(
            &with(&valid_update(), "attributes", json!({ "a1": "d-foh" })),
            &attributes()
        ));
        assert!(!is_worker_update(
            &with(
                &valid_update(),
                "attributes",
                json!({ "a1": "d-foh", "a2": ["s-dinner"], "a3": "x" })
            ),
            &attributes()
        ));
        assert!(!is_worker_update(
            &with(
                &valid_update(),
                "attributes",
                json!({ "a1": "d-kitchen", "a2": ["s-dinner"] })
            ),
            &attributes()
        ));
    }

    #[test]
    fn worker_update_rejects_repeated_relationships_and_ids() {
        assert!(!is_worker_update(
            &with(&valid_update(), "relationships", json!(["w02", "w02"])),
            &attributes()
        ));
        assert!(!is_worker_update(
            &with(&valid_update(), "agitations", json!(["g1", "g1"])),
            &attributes()
        ));
        assert!(!is_worker_update(
            &with(&valid_update(), "agitations", json!([""])),
            &attributes()
        ));
        assert!(!is_worker_update(
            &with(&valid_update(), "languages", json!(["la1", "la1"])),
            &attributes()
        ));
        assert!(!is_worker_update(
            &with(&valid_update(), "languages", json!([""])),
            &attributes()
        ));
    }

    #[test]
    fn worker_update_rejects_note_lists_that_are_missing_blank_or_garbage() {
        assert!(!is_worker_update(
            &without(&valid_update(), "notes"),
            &attributes()
        ));
        assert!(!is_worker_update(
            &with(
                &valid_update(),
                "notes",
                json!([{ "id": "n1", "text": "", "timestamp": "2026-01-01T00:00:00.000Z" }])
            ),
            &attributes()
        ));
        assert!(!is_worker_update(
            &with(
                &valid_update(),
                "notes",
                json!([{ "id": "n1", "text": "Called", "timestamp": "yesterday" }])
            ),
            &attributes()
        ));
        assert!(!is_worker_update(
            &with(
                &valid_update(),
                "notes",
                json!([
                    { "id": "n1", "text": "Called", "timestamp": "2026-01-01T00:00:00.000Z" },
                    { "id": "n1", "text": "Called again", "timestamp": "2026-01-02T00:00:00.000Z" }
                ])
            ),
            &attributes()
        ));
    }

    #[test]
    fn worker_update_still_rejects_the_retired_details_blob() {
        assert!(!is_worker_update(
            &with(
                &valid_update(),
                "details",
                json!({ "agitations": [], "notes": [] })
            ),
            &attributes()
        ));
    }

    #[test]
    fn agitation_list_accepts_a_list_of_distinct_agitations() {
        assert!(is_agitation_list(&json!([
            { "id": "g1", "text": "Unpaid overtime" },
            { "id": "g2", "text": "Broken rota" }
        ])));
    }

    #[test]
    fn agitation_list_rejects_repeated_ids_repeated_text_and_blank_text() {
        assert!(!is_agitation_list(&json!([
            { "id": "g1", "text": "Unpaid overtime" },
            { "id": "g1", "text": "Broken rota" }
        ])));
        assert!(!is_agitation_list(&json!([
            { "id": "g1", "text": "Unpaid overtime" },
            { "id": "g2", "text": "unpaid OVERTIME" }
        ])));
        assert!(!is_agitation_list(&json!([{ "id": "g1", "text": "   " }])));
        assert!(!is_agitation_list(
            &json!([{ "id": "g1", "text": "x", "extra": true }])
        ));
    }

    #[test]
    fn agitation_ids_require_a_unique_list_of_non_empty_strings() {
        assert!(is_agitation_ids(&json!(["g1", "g2"])));
        assert!(is_agitation_ids(&json!([])));
        assert!(!is_agitation_ids(&json!(["g1", "g1"])));
        assert!(!is_agitation_ids(&json!([""])));
        assert!(!is_agitation_ids(&json!([1])));
    }

    #[test]
    fn agitation_text_requires_a_non_blank_string() {
        assert!(is_agitation_text(&json!("Unpaid overtime")));
        assert!(!is_agitation_text(&json!("   ")));
        assert!(!is_agitation_text(&json!(42)));
    }

    #[test]
    fn language_list_accepts_a_list_of_distinct_languages() {
        assert!(is_language_list(&json!([
            { "id": "la1", "name": "Spanish" },
            { "id": "la2", "name": "Polish" }
        ])));
    }

    #[test]
    fn language_list_rejects_repeated_ids_repeated_names_and_blank_names() {
        assert!(!is_language_list(&json!([
            { "id": "la1", "name": "Spanish" },
            { "id": "la1", "name": "Polish" }
        ])));
        assert!(!is_language_list(&json!([
            { "id": "la1", "name": "Spanish" },
            { "id": "la2", "name": "spanish" }
        ])));
        assert!(!is_language_list(&json!([{ "id": "la1", "name": "   " }])));
        assert!(!is_language_list(
            &json!([{ "id": "la1", "name": "Spanish", "extra": true }])
        ));
    }

    #[test]
    fn language_ids_require_a_unique_list_of_non_empty_strings() {
        assert!(is_language_ids(&json!(["la1", "la2"])));
        assert!(is_language_ids(&json!([])));
        assert!(!is_language_ids(&json!(["la1", "la1"])));
        assert!(!is_language_ids(&json!([""])));
        assert!(!is_language_ids(&json!([1])));
    }

    #[test]
    fn language_name_requires_a_non_blank_string() {
        assert!(is_language_name(&json!("Spanish")));
        assert!(!is_language_name(&json!("   ")));
        assert!(!is_language_name(&json!(42)));
    }

    #[test]
    fn committee_goal_accepts_whole_numbers_from_one_to_one_hundred() {
        assert!(is_committee_goal(&json!(1)));
        assert!(is_committee_goal(&json!(5)));
        assert!(is_committee_goal(&json!(100)));
    }

    #[test]
    fn committee_goal_rejects_non_integers_out_of_range_values_and_non_numbers() {
        assert!(!is_committee_goal(&json!(0)));
        assert!(!is_committee_goal(&json!(101)));
        assert!(!is_committee_goal(&json!(1.5)));
        assert!(!is_committee_goal(&json!(-1)));
        assert!(!is_committee_goal(&json!("5")));
        // Number.NaN and Number.POSITIVE_INFINITY have no JSON representation.
        assert!(!is_committee_goal(&Value::Null));
    }

    #[test]
    fn committee_goal_accepts_integer_valued_floats_like_js() {
        // JS is_committee_goal = Number.isInteger(value) && 1 <= value <= 100.
        assert!(is_committee_goal(&json!(5.0))); // Number.isInteger(5.0) === true
        assert!(is_committee_goal(&json!(1e2))); // 100.0
        assert!(!is_committee_goal(&json!(1.5)));
        assert!(!is_committee_goal(&json!(0.0)));
    }

    #[test]
    fn import_contacts_require_a_non_empty_batch_of_named_contacts() {
        assert!(!is_worker_import_contacts(&json!([])));
        assert!(is_worker_import_contacts(
            &json!([{ "name": "Rosalind Franklin" }])
        ));
        assert!(!is_worker_import_contacts(&json!([{ "name": "   " }])));
        assert!(!is_worker_import_contacts(
            &json!([{ "name": "Rosalind Franklin" }, { "name": "" }])
        ));
    }

    #[test]
    fn import_contacts_reject_non_string_but_present_contact_details() {
        assert!(!is_worker_import_contacts(
            &json!([{ "name": "Rosalind Franklin", "email": 42 }])
        ));
        assert!(is_worker_import_contacts(
            &json!([{ "name": "Rosalind Franklin", "phone": "(555) 010-0199" }])
        ));
    }

    // The asymmetries the TS guards rely on, pinned so a tidy-up cannot erase them.

    #[test]
    fn attribute_definition_enforces_trim_equality_on_the_id_only() {
        assert!(!is_worker_attribute_definition(&with(
            &department(),
            "id",
            json!("a1 ")
        )));
        assert!(is_worker_attribute_definition(&with(
            &department(),
            "name",
            json!(" Department ")
        )));
    }

    #[test]
    fn worker_update_allows_empty_strings_in_the_free_text_fields() {
        let blank = with(&valid_update(), "phone", json!(""));
        assert!(is_worker_update(&blank, &attributes()));
        assert!(is_worker_update(
            &with(&blank, "name", json!("")),
            &attributes()
        ));
        assert!(is_worker_update(
            &with(&blank, "email", json!("")),
            &attributes()
        ));
    }

    #[test]
    fn worker_update_allows_empty_string_relationship_ids() {
        assert!(is_worker_update(
            &with(&valid_update(), "relationships", json!(["", "w02"])),
            &attributes()
        ));
    }

    #[test]
    fn worker_notes_allow_extra_keys() {
        assert!(is_worker_notes(&json!([
            { "id": "n1", "text": "Called", "timestamp": "2026-01-01T00:00:00.000Z", "extra": true }
        ])));
    }

    #[test]
    fn worker_notes_accept_edited_at_when_it_is_valid() {
        assert!(is_worker_notes(&json!([
            {
                "id": "n1",
                "text": "Called",
                "timestamp": "2026-01-01T00:00:00.000Z",
                "editedAt": "2026-01-02T09:30:00.000Z"
            }
        ])));
    }

    #[test]
    fn worker_notes_ignore_a_legacy_occurred_on() {
        assert!(is_worker_notes(&json!([
            { "id": "n1", "text": "Called", "timestamp": "2026-01-01T00:00:00.000Z", "occurredOn": "2026-02-30" }
        ])));
    }

    #[test]
    fn worker_notes_reject_an_unparseable_edited_at() {
        assert!(!is_worker_notes(&json!([
            {
                "id": "n1",
                "text": "Called",
                "timestamp": "2026-01-01T00:00:00.000Z",
                "editedAt": "yesterday"
            }
        ])));
    }

    #[test]
    fn import_contacts_allow_extra_keys() {
        assert!(is_worker_import_contacts(&json!([
            { "name": "Rosalind Franklin", "extra": true }
        ])));
    }

    #[test]
    fn note_timestamps_accept_the_iso_shape_and_reject_everything_else() {
        assert!(is_note_timestamp("2026-01-01T00:00:00.000Z"));
        assert!(is_note_timestamp("2026-01-01T00:00:00Z"));
        assert!(is_note_timestamp("2026-01-01T00:00:00+01:00"));
        assert!(is_note_timestamp("2026-01-01T00:00:00.5-05:30"));
        assert!(!is_note_timestamp("yesterday"));
        assert!(!is_note_timestamp("2026-01-01"));
        assert!(!is_note_timestamp("2026-01-01T00:00:00"));
        assert!(!is_note_timestamp("2026-01-01T00:00:00.Z"));
        assert!(!is_note_timestamp("2026-01-01T00:00:00+0100"));
        assert!(!is_note_timestamp("2026-01-01T00:00:00Z "));
    }
}
