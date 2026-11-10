use super::*;

/// One stored Worker draft's attribute maps, in the shape a removal resolves. The draft's
/// contact and note input is not read here; the removal only touches these maps.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct StoredWorkerDraft {
    pub worker_id: String,
    /// The draft's recorded Worker name, so a not-yet-created draft still has a label.
    pub name: String,
    pub update: BTreeMap<String, Value>,
    pub base: BTreeMap<String, Value>,
}

pub(super) fn stored_attribute_map(value: Option<&Value>) -> BTreeMap<String, Value> {
    value
        .and_then(Value::as_object)
        .map(|object| {
            object
                .iter()
                .map(|(id, held)| (id.clone(), held.clone()))
                .collect()
        })
        .unwrap_or_default()
}

/// The Worksite's stored Worker drafts, validated as untrusted like every other read.
pub(crate) fn read_stored_worker_drafts(
    conn: &Connection,
    worksite: &Worksite,
) -> Result<Vec<StoredWorkerDraft>> {
    let mut statement = conn.prepare(
        "SELECT worker_id, payload FROM worker_drafts WHERE worksite_id = ?1 ORDER BY worker_id",
    )?;
    let rows = statement.query_map([&worksite.id], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    })?;

    let mut drafts = Vec::new();
    for row in rows {
        let (worker_id, payload) = row?;
        let input: WorkerDraftInput = serde_json::from_str(&payload)
            .map_err(|_| Error::Message(format!("Invalid Worker draft stored for {worker_id}.")))?;
        drafts.push(StoredWorkerDraft {
            worker_id,
            name: input.update.name.clone(),
            update: stored_attribute_map(Some(&input.update.attributes)),
            base: input
                .base
                .as_ref()
                .map(|base| stored_attribute_map(Some(&base.attributes)))
                .unwrap_or_default(),
        });
    }

    Ok(drafts)
}
