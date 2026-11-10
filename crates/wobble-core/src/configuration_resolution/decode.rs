use super::*;

/// Narrows an untrusted resolutions body. A malformed body is the caller's 400; holder
/// references are checked against the database later.
pub fn decode_configuration_resolutions(value: &Value) -> Option<ConfigurationResolutions> {
    let object = value.as_object()?;
    if object.keys().any(|key| {
        !matches!(
            key.as_str(),
            "removedAnswers"
                | "removedAttributes"
                | "cardinality"
                | "attributeMoves"
                | "modeChanges"
        )
    }) {
        return None;
    }

    let mut resolutions = ConfigurationResolutions::default();
    for entry in object
        .get("removedAnswers")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default()
    {
        let entry = entry.as_object()?;
        if entry
            .keys()
            .any(|key| !matches!(key.as_str(), "attributeId" | "answerId" | "holders"))
        {
            return None;
        }
        let holders = entry.get("holders")?.as_array()?;
        resolutions.removed_answers.push(RemovedAnswerResolution {
            attribute_id: non_empty(entry.get("attributeId"))?,
            answer_id: non_empty(entry.get("answerId"))?,
            holders: holders
                .iter()
                .map(decode_holder_resolution)
                .collect::<Option<Vec<_>>>()?,
        });
    }

    for entry in object
        .get("removedAttributes")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default()
    {
        let entry = entry.as_object()?;
        if entry
            .keys()
            .any(|key| !matches!(key.as_str(), "attributeId"))
        {
            return None;
        }
        resolutions
            .removed_attributes
            .push(RemovedAttributeResolution {
                attribute_id: non_empty(entry.get("attributeId"))?,
            });
    }

    for entry in object
        .get("cardinality")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default()
    {
        let entry = entry.as_object()?;
        if entry
            .keys()
            .any(|key| !matches!(key.as_str(), "attributeId" | "holders"))
        {
            return None;
        }
        let holders = entry.get("holders")?.as_array()?;
        resolutions.cardinality.push(CardinalityResolution {
            attribute_id: non_empty(entry.get("attributeId"))?,
            holders: holders
                .iter()
                .map(|holder| {
                    let holder = holder.as_object()?;
                    if holder
                        .keys()
                        .any(|key| !matches!(key.as_str(), "workerId" | "surface" | "retained"))
                    {
                        return None;
                    }
                    Some(CardinalityHolderResolution {
                        worker_id: non_empty(holder.get("workerId"))?,
                        surface: non_empty(holder.get("surface"))?,
                        retained: match holder.get("retained") {
                            None | Some(Value::Null) => None,
                            Some(value) => Some(non_empty(Some(value))?),
                        },
                    })
                })
                .collect::<Option<Vec<_>>>()?,
        });
    }

    for entry in object
        .get("attributeMoves")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default()
    {
        let entry = entry.as_object()?;
        if entry
            .keys()
            .any(|key| !matches!(key.as_str(), "sourceAttributeId" | "answerId"))
        {
            return None;
        }
        resolutions.attribute_moves.push(AttributeMoveResolution {
            source_attribute_id: non_empty(entry.get("sourceAttributeId"))?,
            answer_id: non_empty(entry.get("answerId"))?,
        });
    }

    for entry in object
        .get("modeChanges")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default()
    {
        let entry = entry.as_object()?;
        if entry.keys().any(|key| key.as_str() != "attributeId") {
            return None;
        }
        resolutions.mode_changes.push(ModeChangeResolution {
            attribute_id: non_empty(entry.get("attributeId"))?,
        });
    }

    Some(resolutions)
}

pub(super) fn decode_holder_resolution(value: &Value) -> Option<HolderResolution> {
    let object = value.as_object()?;
    if object
        .keys()
        .any(|key| !matches!(key.as_str(), "workerId" | "surface" | "replacement"))
    {
        return None;
    }
    Some(HolderResolution {
        worker_id: non_empty(object.get("workerId"))?,
        surface: optional_non_empty(object.get("surface"))?,
        replacement: match object.get("replacement") {
            None | Some(Value::Null) => None,
            Some(value) => Some(non_empty(Some(value))?),
        },
    })
}

pub(super) fn non_empty(value: Option<&Value>) -> Option<String> {
    let text = value?.as_str()?;
    if text.is_empty() || text != text.trim() {
        return None;
    }
    Some(text.to_owned())
}

/// An optional wire string: absent, `null` and the empty string all mean "not set". Any
/// other value must be a trimmed, non-empty string.
pub(super) fn optional_non_empty(value: Option<&Value>) -> Option<Option<String>> {
    match value {
        None | Some(Value::Null) => Some(None),
        Some(Value::String(text)) if text.is_empty() => Some(None),
        Some(value) => Some(Some(non_empty(Some(value))?)),
    }
}
