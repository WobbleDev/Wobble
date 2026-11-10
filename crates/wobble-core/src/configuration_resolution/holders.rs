use super::*;

/// Every Worker of the Worksite by id, so a draft-only holder names its Worker too.
pub(crate) fn read_worker_names(
    conn: &Connection,
    worksite: &Worksite,
) -> Result<HashMap<String, String>> {
    let mut statement = conn.prepare("SELECT id, name FROM workers WHERE worksite_id = ?1")?;
    let rows = statement.query_map([&worksite.id], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    })?;
    let mut names = HashMap::new();
    for row in rows {
        let (id, name) = row?;
        names.insert(id, name);
    }
    Ok(names)
}
