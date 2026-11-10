//! Database handle: opens the worksite SQLite file, applies migrations, and seeds a fresh database.

use std::path::{Path, PathBuf};

use rusqlite::Connection;

use crate::error::{Error, Result};
use crate::id::IdSource;
use crate::schema::{self, DEFAULT_WORKSITE_NAME};

/// An open database with the Node-identical pragmas applied.
pub struct Db {
    conn: Connection,
    /// The path the database was opened with; `:memory:` has none.
    path: Option<PathBuf>,
    /// The one recent Worker merge Undo can reverse. It lives only in this process.
    merge_snapshot: std::cell::RefCell<Option<crate::worker_merge::MergeSnapshot>>,
}

impl Db {
    /// Opens an ephemeral :memory: database. Persistent paths require open_keyed
    /// with an explicit credential; no-key calls never create or read their database.
    ///
    /// An existing supported file database is backed up and verified beside itself before
    /// any pragma or migration touches it (see `upgrade_backup`); a backup that cannot be
    /// made or verified returns an error and leaves the incoming file alone.
    pub fn open(path: &str) -> Result<Db> {
        Self::open_keyed(path, None)
    }

    pub fn open_keyed(path: &str, secret: Option<&crate::key::Secret>) -> Result<Db> {
        if path != ":memory:" && secret.is_none() {
            return Err(Error::coded(
                crate::key::BOOT_LOCKED_CODE,
                crate::key::LOCKED_MESSAGE,
            ));
        }
        Self::open_impl(path, secret)
    }

    /// LEGACY-PLAINTEXT-FIXTURE: historical schema/Node-interoperability inputs only.
    /// This constructor is absent from ordinary native/shim builds.
    #[cfg(any(test, feature = "test-fixtures"))]
    pub fn open_legacy_fixture(path: &str) -> Result<Db> {
        Self::open_impl(path, None)
    }

    fn open_impl(path: &str, secret: Option<&crate::key::Secret>) -> Result<Db> {
        if path != ":memory:" {
            if let Some(parent) = Path::new(path).parent() {
                if !parent.as_os_str().is_empty() {
                    std::fs::create_dir_all(parent)
                        .map_err(|error| Error::Message(error.to_string()))?;
                }
            }
        }
        if path == ":memory:" {
            // Ephemeral unit DBs stay unkeyed by design (intentional exception).
            let conn = Connection::open(path)?;
            conn.execute_batch(
                "PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;",
            )?;
            schema::apply_migrations(&conn)?;
            return Ok(Db {
                conn,
                path: None,
                merge_snapshot: Default::default(),
            });
        }
        let live = Path::new(path);
        // Downgrade fail-closed: a plaintext-only legacy open never serves an
        // encrypted file. No bytes are truncated or migrated here.
        if secret.is_none() && live.exists() {
            crate::key::guard_legacy_open(live)?;
        }
        // Key precedes everything on a file path: open, then immediately apply
        // the key and run the canonical probe on the SAME handle before any
        // schema read, backup, pragma, or migration. Fresh files have no
        // schema yet, so they skip the pre-migration probe and verify after
        // the bootstrap instead.
        let fresh = !live.exists();
        let conn = if fresh {
            let c = Connection::open(live)?;
            if let Some(secret) = secret {
                crate::key::apply_key(&c, secret)?;
            }
            c
        } else {
            crate::key::open_keyed(live, secret)?
        };
        // Before the pragmas and the whole migration chain, so a failed backup changes nothing
        // at all. Restore upgrades its staging copy through `schema::apply_migrations`
        // directly, so temporary restore copies never get a persistent upgrade backup.
        match secret {
            None => {
                crate::upgrade_backup::back_up_before_upgrade(&conn, live)?;
            }
            Some(_) => {
                crate::upgrade_backup::back_up_before_upgrade_keyed(&conn, live, secret)?;
            }
        }
        conn.execute_batch(
            "PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;",
        )?;
        schema::apply_migrations(&conn)?;
        if fresh && secret.is_some() {
            crate::key::probe_keyed_handle(&conn).map_err(|failure| match failure {
                crate::key::ProbeFailure::WrongKey(message) => Error::Coded {
                    code: crate::key::WRONG_KEY_CODE,
                    message,
                },
                crate::key::ProbeFailure::Io(message) => Error::Message(message),
            })?;
        }
        // A file database now exists, so store the absolute canonical path: the settings
        // page shows and copies it, and the shim's relative default would otherwise leak
        // its working directory. A failed canonicalize falls back to the path given.
        let stored_path = std::fs::canonicalize(path).unwrap_or_else(|_| PathBuf::from(path));
        Ok(Db {
            conn,
            path: Some(stored_path),
            merge_snapshot: Default::default(),
        })
    }

    /// Reopen a fully migrated replacement without changing its recorded file bytes.
    /// The caller clears its operation marker before enabling runtime WAL mode.
    pub(crate) fn reopen_verified(path: &str, secret: &crate::key::Secret) -> Result<Db> {
        let conn = crate::key::open_keyed(Path::new(path), Some(secret))?;
        crate::store_validation::validate(&conn)?;
        conn.execute_batch("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;")?;
        Ok(Db {
            conn,
            path: Some(std::fs::canonicalize(path).map_err(|e| Error::Message(e.to_string()))?),
            merge_snapshot: Default::default(),
        })
    }

    pub(crate) fn activate_wal(&self) -> Result<()> {
        self.conn.execute_batch("PRAGMA journal_mode = WAL;")?;
        Ok(())
    }

    pub(crate) fn merge_snapshot(&self) -> Option<crate::worker_merge::MergeSnapshot> {
        self.merge_snapshot.borrow().clone()
    }

    pub(crate) fn set_merge_snapshot(&self, snapshot: Option<crate::worker_merge::MergeSnapshot>) {
        *self.merge_snapshot.borrow_mut() = snapshot;
    }

    pub fn conn(&self) -> &Connection {
        &self.conn
    }

    /// The file this database was opened with, or `None` for an in-memory database.
    pub fn path(&self) -> Option<&Path> {
        self.path.as_deref()
    }
}

/// The Rust equivalent of useTemporaryDatabase: a fresh current database with the Worksite
/// and its default Worker-scoped attributes, ids drawn from id_source.
pub fn open_seeded(path: &str, id_source: &impl IdSource) -> Result<Db> {
    open_seeded_keyed(path, None, id_source)
}

pub fn open_seeded_keyed(
    path: &str,
    secret: Option<&crate::key::Secret>,
    id_source: &impl IdSource,
) -> Result<Db> {
    let db = Db::open_keyed(path, secret)?;
    let worksite = schema::insert_worksite(db.conn(), DEFAULT_WORKSITE_NAME, id_source)?;
    schema::seed_default_worker_attributes(db.conn(), &worksite.id, id_source)?;
    Ok(db)
}

/// LEGACY-PLAINTEXT-FIXTURE: emit explicit unencrypted interoperability inputs.
#[cfg(any(test, feature = "test-fixtures"))]
pub fn open_seeded_legacy_fixture(path: &str, id_source: &impl IdSource) -> Result<Db> {
    let db = Db::open_legacy_fixture(path)?;
    let worksite = schema::insert_worksite(db.conn(), DEFAULT_WORKSITE_NAME, id_source)?;
    schema::seed_default_worker_attributes(db.conn(), &worksite.id, id_source)?;
    Ok(db)
}
