//! Helpers shared by the integration tests in this directory.

use std::path::{Path, PathBuf};

pub mod http;
pub mod legacy_db;

/// A scratch database path under this process's temp directory. The directory is
/// created; the file is not, so a test removes any leftover copy before it writes.
pub fn temp_db_path(name: &str) -> String {
    let dir = std::env::temp_dir().join(format!("wobble-core-test-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    dir.join(name).to_string_lossy().into_owned()
}

/// Removes a scratch database and every file SQLite writes beside it. Used by the phone
/// suites only; every integration-test binary compiles this module, so the others see it
/// unused.
#[allow(dead_code)]
pub fn remove_database(path: &str) {
    for suffix in ["", "-wal", "-shm", "-journal"] {
        let _ = std::fs::remove_file(format!("{path}{suffix}"));
    }
}

/// A v20 source with one Worksite and one Worker, copied under a key through the same
/// keyed export an installation's own conversion uses, then removed so only the keyed
/// file an installation at that version has is left. Only the keyed paths use it, so the
/// other test binaries see it unused.
#[allow(dead_code)]
pub fn keyed_v20_source(prefix: &str, name: &str, secret: &wobble_core::key::Secret) -> String {
    let (plain, conn) = legacy_db::start_source(prefix, name);
    legacy_db::add_worksite(&conn, "ws-keyed", "Keyed Upgrade");
    legacy_db::add_worker(&conn, "ws-keyed", "ada", "Ada");
    legacy_db::finish_source(&plain, conn, 20);
    let keyed = temp_db_path(&format!("{prefix}-{name}-keyed.sqlite"));
    remove_database(&keyed);
    wobble_core::key::copy_db_keyed(Path::new(&plain), None, Path::new(&keyed), Some(secret))
        .expect("copies the v20 source under a key");
    remove_database(&plain);
    keyed
}

/// Every `pre-upgrade` sibling of a database, whatever version and stamp it names.
#[allow(dead_code)]
pub fn upgrade_backups_beside(path: &str) -> Vec<PathBuf> {
    let database = Path::new(path);
    let prefix = format!(
        "{}.pre-upgrade-",
        database
            .file_name()
            .expect("a database file name")
            .to_string_lossy()
    );
    let mut found: Vec<PathBuf> = std::fs::read_dir(database.parent().expect("a parent directory"))
        .expect("reads the database's folder")
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.path())
        .filter(|entry| {
            entry
                .file_name()
                .map(|name| name.to_string_lossy().starts_with(&prefix))
                .unwrap_or(false)
        })
        .collect();
    found.sort();
    found
}
