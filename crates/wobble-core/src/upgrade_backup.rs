//! Verified pre-upgrade backups.
//!
//! Before an existing supported, file-backed database is upgraded, it is copied through
//! SQLite's consistent backup API to a sibling file named
//! `<database>.pre-upgrade-v<incoming>-<yyyymmddThhmmss>.sqlite`. `<incoming>` is the schema
//! version found on open, and the UTC stamp is SQLite's own `strftime`, the same format the
//! `pre-restore` and `pre-erase` safety copies use. The destination is reserved with an
//! exclusive create, so a name that is already taken gets `-2`, `-3`, ... before `.sqlite`
//! instead of overwriting the file that is there.
//!
//! The copy is settled into a single rollback-journal file and then reopened read-only to
//! check `PRAGMA integrity_check` and the recorded incoming schema version. Only after both
//! checks pass does the caller start the migration transaction. A failure removes the partial
//! file and returns an error, so the live schema and application data stay untouched.
//!
//! Restore does not use this module: it upgrades a temporary staging copy by calling
//! `schema::apply_migrations` directly, so staging never creates a persistent upgrade backup.

use std::fs::OpenOptions;
use std::path::{Path, PathBuf};

use rusqlite::Connection;

use crate::error::{Error, Result};
use crate::schema;

/// How many sibling names one upgrade tries before it gives up on finding a free one.
const RESERVED_NAME_ATTEMPTS: u32 = 100;

/// Backs up a file-backed database that is about to be upgraded, returning the backup path,
/// or `None` when the database is fresh, already current, or not a supported upgrade source.
/// The caller must run the migration chain only after this returns successfully.
pub(crate) fn back_up_before_upgrade(
    conn: &Connection,
    database: &Path,
) -> Result<Option<PathBuf>> {
    back_up_before_upgrade_keyed(conn, database, None)
}

/// Reserves the first free upgrade-backup name beside `database` with an exclusive create and
/// returns that path. The returned file is empty; the caller fills it through SQLite's backup
/// API and removes it if that fails. A name already in use is never overwritten: the next
/// attempt appends `-2`, `-3`, ... before `.sqlite`, keeping the incoming version and stamp.
pub fn reserve_backup_file(database: &Path, version: i64, stamp: &str) -> Result<PathBuf> {
    for attempt in 1..=RESERVED_NAME_ATTEMPTS {
        let candidate = backup_path(database, version, stamp, attempt);
        match OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&candidate)
        {
            Ok(file) => {
                drop(file);
                return Ok(candidate);
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => {
                return Err(Error::Message(format!(
                    "The pre-upgrade backup {} could not be created: {error}. The database was left unchanged.",
                    candidate.display()
                )))
            }
        }
    }
    Err(Error::Message(format!(
        "No free pre-upgrade backup name was found beside {}. The database was left unchanged.",
        database.display()
    )))
}

/// `<database>.pre-upgrade-v<version>-<stamp>.sqlite`, or the same name with `-<attempt>`
/// before `.sqlite` once an earlier attempt's file is already there.
fn backup_path(database: &Path, version: i64, stamp: &str, attempt: u32) -> PathBuf {
    let mut path = database.as_os_str().to_owned();
    if attempt == 1 {
        path.push(format!(".pre-upgrade-v{version}-{stamp}.sqlite"));
    } else {
        path.push(format!(".pre-upgrade-v{version}-{stamp}-{attempt}.sqlite"));
    }
    PathBuf::from(path)
}

/// Writes the backup, settles it into one standalone file, and verifies it. Every failure is
/// a plain error so `Db::open` reports it instead of panicking.
pub(crate) fn back_up_before_upgrade_keyed(
    conn: &Connection,
    database: &Path,
    secret: Option<&crate::key::Secret>,
) -> Result<Option<PathBuf>> {
    let Some(version) = schema::read_schema_version(conn)? else {
        return Ok(None);
    };
    if version == schema::CURRENT_SCHEMA_VERSION || !schema::is_upgradable_source(version) {
        return Ok(None);
    }
    let stamp: String = conn
        .query_row("SELECT strftime('%Y%m%dT%H%M%S', 'now')", [], |row| row.get(0))
        .map_err(|error| Error::Message(format!("The pre-upgrade backup could not be named: {error}. The database was left unchanged.")))?;
    let path = reserve_backup_file(database, version, &stamp)?;
    match write_and_verify_keyed(conn, &path, version, secret) {
        Ok(()) => Ok(Some(path)),
        Err(error) => {
            discard_backup(&path);
            Err(error)
        }
    }
}

fn write_and_verify_keyed(
    conn: &Connection,
    path: &Path,
    version: i64,
    secret: Option<&crate::key::Secret>,
) -> Result<()> {
    write_backup_handle(conn, path, secret).map_err(|error| {
        Error::Message(format!(
            "The pre-upgrade backup {} could not be written: {error}. The database was left unchanged.",
            path.display()
        ))
    })?;
    crate::key::settle_to_single_file(path, secret)?;
    verify_backup_keyed(path, version, secret)
}

fn write_backup_handle(
    conn: &Connection,
    path: &Path,
    secret: Option<&crate::key::Secret>,
) -> Result<()> {
    if secret.is_none() {
        let mut dst = Connection::open(path).map_err(|error| Error::Message(format!("The pre-upgrade backup {} could not be written: {error}. The database was left unchanged.", path.display())))?;
        let backup = rusqlite::backup::Backup::new(conn, &mut dst).map_err(|error| Error::Message(format!("The pre-upgrade backup {} could not be written: {error}. The database was left unchanged.", path.display())))?;
        backup.run_to_completion(100, std::time::Duration::from_millis(0), None).map_err(|error| Error::Message(format!("The pre-upgrade backup {} could not be written: {error}. The database was left unchanged.", path.display())))?;
        return Ok(());
    }
    crate::key::export_via_attach(conn, path, secret)
}

/// Reopens the backup through a fresh keyed handle, then checks integrity and version.
/// Encrypted generations use the canonical probe (cipher_integrity_check plus schema
/// read on the same handle); plaintext generations use integrity_check. No header scan
/// alone counts as proof.
fn verify_backup_keyed(
    path: &Path,
    version: i64,
    secret: Option<&crate::key::Secret>,
) -> Result<()> {
    let conn = crate::key::open_keyed_readonly(path, secret).map_err(|error| {
            Error::Message(format!(
                "The pre-upgrade backup {} could not be opened for verification: {error}. The database was left unchanged.",
                path.display()
            ))
        },
    )?;
    let integrity: String = conn
        .query_row("PRAGMA integrity_check", [], |row| row.get(0))
        .map_err(|error| {
            Error::Message(format!(
                "The pre-upgrade backup {} failed its integrity check: {error}. The database was left unchanged.",
                path.display()
            ))
        })?;
    if integrity != "ok" {
        return Err(Error::Message(format!(
            "The pre-upgrade backup {} failed its integrity check: {integrity}. The database was left unchanged.",
            path.display()
        )));
    }
    if secret.is_some() {
        crate::key::probe_keyed_handle(&conn).map_err(|failure| Error::Message(format!(
            "The pre-upgrade backup {} failed its key verification: {}. The database was left unchanged.",
            path.display(),
            failure.message()
        )))?;
    }
    let recorded = schema::read_schema_version(&conn).map_err(|error| {
        Error::Message(format!(
            "The pre-upgrade backup {} could not be verified: {error}. The database was left unchanged.",
            path.display()
        ))
    })?;
    if recorded != Some(version) {
        let recorded = recorded
            .map(|version| version.to_string())
            .unwrap_or_else(|| "none".to_owned());
        return Err(Error::Message(format!(
            "The pre-upgrade backup {} records schema version {recorded}, not the incoming version {version}. The database was left unchanged.",
            path.display()
        )));
    }
    Ok(())
}

/// Removes a backup that failed to write or verify, together with any journal SQLite wrote
/// beside it. A failure leaves no half-made pre-upgrade file that could be mistaken for one.
fn discard_backup(path: &Path) {
    for suffix in ["", "-wal", "-shm", "-journal"] {
        let mut candidate = path.as_os_str().to_owned();
        candidate.push(suffix);
        let _ = std::fs::remove_file(PathBuf::from(candidate));
    }
}
