//! Ticket 170: what the unlock path refuses.
//!
//! `open_database` owns the credential and the file, so a database it cannot trust must
//! fail before any pragma, backup or migration touches it: a missing one is never created,
//! a corrupt one is left byte-for-byte alone, and a keyed one refuses another credential
//! without writing an upgrade backup.

mod common;

use std::path::{Path, PathBuf};

use common::{keyed_v20_source, remove_database, upgrade_backups_beside};
use wobble_core::key::{self, Secret};
use wobble_core::open_database::OpenDatabase;

fn secret(text: &str) -> Secret {
    Secret::from_passphrase(text).expect("a fixture passphrase")
}

/// A path with any earlier run's copies already removed.
fn scratch(name: &str) -> PathBuf {
    let path: PathBuf = common::temp_db_path(name).into();
    remove_database(&path.to_string_lossy());
    path
}

#[test]
fn a_missing_database_is_refused_and_never_created() {
    let path = scratch("open-paths-missing.sqlite");
    let error = OpenDatabase::open(&path, secret("missing fixture"))
        .err()
        .expect("a missing database does not open");
    assert_eq!(error.code(), Some("database_missing"), "{error}");
    assert!(!path.exists(), "unlocking never creates the file");
}

#[test]
fn a_corrupt_database_is_refused_and_left_alone() {
    let path = scratch("open-paths-corrupt.sqlite");
    std::fs::write(&path, b"not a wobble database, only noise").expect("writes the corrupt file");
    let before = std::fs::read(&path).expect("reads the corrupt file");

    let error = OpenDatabase::open(&path, secret("corrupt fixture"))
        .err()
        .expect("a corrupt database does not open");
    // A file SQLite cannot parse is reported as the file it is, not as a database to
    // create: the probe runs before anything writes.
    assert_ne!(
        error.code(),
        Some("database_missing"),
        "a corrupt file is not a missing one: {error}"
    );
    assert!(!error.to_string().is_empty(), "the refusal says why");
    assert_eq!(
        std::fs::read(&path).expect("re-reads the corrupt file"),
        before,
        "the open left the file byte-for-byte alone"
    );
    assert!(
        !key::sidecars_present(&path),
        "the open left no journal or WAL beside it"
    );
}

#[test]
fn a_keyed_database_refuses_the_wrong_key_without_writing_an_upgrade_backup() {
    let installation = secret("the installation passphrase");
    let path: PathBuf = keyed_v20_source("open-paths", "keyed-wrong-key", &installation).into();

    let error = OpenDatabase::open(&path, secret("another installation passphrase"))
        .err()
        .expect("the wrong credential does not open a keyed database");
    assert_eq!(error.code(), Some(key::WRONG_KEY_CODE), "{error}");
    assert_eq!(
        upgrade_backups_beside(&path.to_string_lossy()),
        Vec::<PathBuf>::new(),
        "a refused key never reaches the upgrade backup"
    );

    // The failed open changed nothing: the right key still opens the same v20 database.
    let conn = key::open_keyed_readonly(Path::new(&path), Some(&installation))
        .expect("the right key still opens it");
    assert_eq!(
        common::legacy_db::raw_version(&conn),
        Some(20),
        "the refused open did not upgrade the database"
    );
    drop(conn);
    remove_database(&path.to_string_lossy());
}
