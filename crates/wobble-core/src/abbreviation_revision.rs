//! Tracks, per Worksite, which bundled Short form lists revision (ADR 0046, ticket 05) its
//! generated Short forms were last resolved against. The lists are versioned by one
//! snapshot-wide revision (`abbreviation_lists::REVISION`, written by
//! `scripts/abbreviation-lists/build.mjs`). An app update that bundles a new snapshot changes
//! that constant; the next Save or preview for a Worksite whose stored revision disagrees
//! regenerates every still-generated Short form once and never touches an edited one, and
//! a Save then records the new revision.
//!
//! This reuses the installation-wide `app_settings` key/value table (`schema.rs`) under a
//! Worksite-scoped key it does not otherwise assign, rather than adding a schema column.
//! The settings registry in `app_settings.rs` validates and surfaces only the keys it
//! lists, so this key is invisible to the Settings read, write and reset request handlers;
//! a Settings reset (which deletes every `app_settings` row) simply clears it, which only
//! costs one extra regeneration pass, exactly like a Worksite that has never resolved a
//! Short form before.

use rusqlite::{params, Connection, OptionalExtension};

use crate::error::Result;

/// The `app_settings` key tracking `worksite_id`\u{2019}s lists revision. Public so
/// request-boundary tests can simulate a revision change with plain SQL.
pub fn revision_key(worksite_id: &str) -> String {
    format!("shortFormListsRevision::{worksite_id}")
}

/// Whether `worksite_id`'s generated Short forms were already resolved against the bundled
/// lists' current revision. A Worksite with no recorded revision (never resolved, or
/// cleared by a Settings reset) is never current, so its next resolution regenerates every
/// generated Short form once.
pub(crate) fn lists_current(conn: &Connection, worksite_id: &str) -> Result<bool> {
    let stored: Option<String> = conn
        .query_row(
            "SELECT value FROM app_settings WHERE key = ?1",
            params![revision_key(worksite_id)],
            |row| row.get(0),
        )
        .optional()?;
    Ok(stored.as_deref() == Some(crate::abbreviation_lists::REVISION))
}

/// Records that `worksite_id`'s generated Short forms now match the bundled lists' current
/// revision.
pub(crate) fn mark_lists_current(conn: &Connection, worksite_id: &str) -> Result<()> {
    conn.execute(
        "INSERT INTO app_settings (key, value) VALUES (?1, ?2) \
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![
            revision_key(worksite_id),
            crate::abbreviation_lists::REVISION
        ],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Db;

    fn conn() -> Db {
        Db::open(":memory:").unwrap()
    }

    #[test]
    fn a_worksite_with_no_recorded_revision_is_never_current() {
        let db = conn();
        assert!(!lists_current(db.conn(), "ws-1").unwrap());
    }

    #[test]
    fn marking_a_worksite_current_makes_it_current_only_for_that_worksite() {
        let db = conn();
        mark_lists_current(db.conn(), "ws-1").unwrap();
        assert!(lists_current(db.conn(), "ws-1").unwrap());
        assert!(!lists_current(db.conn(), "ws-2").unwrap());
    }

    #[test]
    fn marking_current_twice_leaves_one_row() {
        let db = conn();
        mark_lists_current(db.conn(), "ws-1").unwrap();
        mark_lists_current(db.conn(), "ws-1").unwrap();
        let rows: i64 = db
            .conn()
            .query_row(
                "SELECT COUNT(*) FROM app_settings WHERE key = ?1",
                params![revision_key("ws-1")],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(rows, 1);
    }
}
