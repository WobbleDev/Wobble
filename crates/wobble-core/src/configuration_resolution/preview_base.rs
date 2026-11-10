use super::*;

/// The saved state a preview was computed against. A Save that carries a different base is
/// stale and writes nothing. The fingerprint covers the definitions, every saved Worker
/// value, and every Worker draft's attribute maps (a Worker value or Worker draft change
/// must make a preview whose resolutions reason about it stale).
pub fn configuration_preview_base(conn: &Connection, worksite: &Worksite) -> Result<String> {
    let stored = get_stored_worker_attributes(conn, &Some(worksite.clone()))?;
    let mut canonical = String::from("configuration-v2\n");

    for attribute in &stored {
        canonical.push_str(&format!(
            "attribute|{}|{}|{}\n",
            attribute.id, attribute.name, attribute.kind
        ));
        for answer in &attribute.options {
            canonical.push_str(&format!(
                "answer|{}|{}|{}|{}\n",
                answer.id,
                answer.value,
                answer.parent_id.as_deref().unwrap_or(""),
                answer.merged_into.as_deref().unwrap_or("")
            ));
        }
    }

    // Worker values: sorted by Worker and Attribute so the fingerprint does not depend on
    // HashMap iteration order.
    let (worker_ids, values) = read_attribute_migration_inputs(conn, worksite)?;
    for worker_id in &worker_ids {
        let Some(attributes) = values.get(worker_id) else {
            continue;
        };
        let mut attribute_ids: Vec<&String> = attributes.keys().collect();
        attribute_ids.sort();
        for attribute_id in attribute_ids {
            canonical.push_str(&format!(
                "worker-value|{worker_id}|{attribute_id}|{}\n",
                attributes[attribute_id]
            ));
        }
    }

    // Worker drafts: the update and base attribute maps are the only parts a Configuration
    // resolution can rewrite, so they are the only parts that can make a preview stale.
    for draft in read_stored_worker_drafts(conn, worksite)? {
        canonical.push_str(&format!("worker-draft|{}\n", draft.worker_id));
        for (attribute_id, value) in &draft.update {
            canonical.push_str(&format!("worker-draft-update|{attribute_id}|{value}\n"));
        }
        for (attribute_id, value) in &draft.base {
            canonical.push_str(&format!("worker-draft-base|{attribute_id}|{value}\n"));
        }
    }

    Ok(fingerprint(&canonical))
}
