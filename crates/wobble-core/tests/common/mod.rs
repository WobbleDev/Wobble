//! Helpers shared by the integration tests in this directory.

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
