//! Validate every Worksite through the same canonical readers used by the application.
//! Called on migrated, keyed staging before the active database can be replaced.
use rusqlite::Connection;

use crate::{Error, Result};

pub(crate) fn validate(conn: &Connection) -> Result<()> {
    if crate::schema::read_schema_version(conn)? != Some(crate::schema::CURRENT_SCHEMA_VERSION) {
        return Err(Error::Message(
            "The staged database has an unsupported schema.".to_owned(),
        ));
    }
    let mut foreign_keys = conn.prepare("PRAGMA foreign_key_check")?;
    if foreign_keys.query([])?.next()?.is_some() {
        return Err(Error::Message(
            "The staged database has invalid references.".to_owned(),
        ));
    }
    crate::app_settings::get_app_settings(conn)?;
    for worksite in crate::worksite_persistence::list_worksites(conn)? {
        crate::service::get_workers(conn, Some(&worksite))?;
        let scope = Some(worksite);
        crate::attribute_persistence::get_worker_attributes(conn, &scope)?;
        crate::agitation_persistence::get_agitations(conn, &scope)?;
        crate::language_persistence::get_languages(conn, &scope)?;
    }
    let mut statement = conn.prepare("SELECT worksite_id, worker_id FROM worker_drafts")?;
    let drafts = statement
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    for (worksite, worker) in drafts {
        // Preserve existing semantics: both 'new' and drafts of removed Workers can
        // exist. The canonical reader still validates the entire stored draft payload.
        crate::worker_draft_persistence::get_worker_draft(conn, &worksite, &worker)?;
    }
    crate::saved_view_persistence::validate_all(conn)?;
    Ok(())
}
