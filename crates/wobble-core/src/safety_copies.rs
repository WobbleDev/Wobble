//! Pruning of the safety copies that sit beside the database.
//!
//! Every schema upgrade, restore, erase, passphrase change and conversion leaves a full
//! encrypted copy named `<database>.pre-<kind>-<...>.sqlite` beside the live file. Left alone
//! they pile up, one database each. After each operation this module keeps the newest
//! [`KEEP_PER_KIND`] copies of every kind and removes the older ones. A copy named by a pending
//! operation marker is never removed, whatever its age, and only files that match the exact
//! naming pattern are ever touched.

use std::path::{Path, PathBuf};
use std::time::SystemTime;

use crate::key;

/// How many of the newest copies of each kind survive a prune.
pub const KEEP_PER_KIND: usize = 3;

struct Copy {
    path: PathBuf,
    kind: String,
    modified: SystemTime,
}

/// Removes all but the newest [`KEEP_PER_KIND`] safety copies of each kind beside `database`,
/// and returns how many it removed. Best effort: a copy that cannot be removed is skipped and
/// pruning never fails the operation that called it.
pub fn prune(database: &Path) -> usize {
    prune_keeping(database, KEEP_PER_KIND)
}

fn prune_keeping(database: &Path, keep: usize) -> usize {
    let Some(parent) = database.parent() else {
        return 0;
    };
    let parent = if parent.as_os_str().is_empty() {
        Path::new(".")
    } else {
        parent
    };
    let Some(name) = database
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
    else {
        return 0;
    };
    let protected = pending_recovery_path(database);
    let Ok(entries) = std::fs::read_dir(parent) else {
        return 0;
    };
    let mut copies: Vec<Copy> = entries
        .flatten()
        .filter_map(|entry| {
            let file_name = entry.file_name().to_string_lossy().into_owned();
            let kind = kind_of(&name, &file_name)?;
            let meta = std::fs::symlink_metadata(entry.path()).ok()?;
            if !meta.is_file() {
                return None;
            }
            Some(Copy {
                path: entry.path(),
                kind,
                modified: meta.modified().ok()?,
            })
        })
        .collect();
    // Newest first; the name breaks a tie so the order is stable.
    copies.sort_by(|a, b| {
        b.modified
            .cmp(&a.modified)
            .then_with(|| b.path.cmp(&a.path))
    });
    let mut seen: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
    let mut removed = 0;
    for copy in copies {
        let count = seen.entry(copy.kind.clone()).or_insert(0);
        *count += 1;
        if *count <= keep || is_protected(&copy.path, protected.as_deref()) {
            continue;
        }
        if remove_with_sidecars(&copy.path) {
            removed += 1;
        }
    }
    removed
}

/// The kind of a safety copy file, or `None` when `file_name` is not one of the copies for the
/// database called `database_name`: `<database>.pre-<kind>-<anything>.sqlite`.
fn kind_of(database_name: &str, file_name: &str) -> Option<String> {
    split_copy_name(database_name, file_name).map(|(kind, _)| kind)
}

/// The kind and the text after it (`<tail>` in `<database>.pre-<kind>-<tail>.sqlite`), or
/// `None` when `file_name` is not a safety copy of the database called `database_name`.
fn split_copy_name(database_name: &str, file_name: &str) -> Option<(String, String)> {
    let rest = file_name
        .strip_prefix(database_name)?
        .strip_prefix(".pre-")?;
    let rest = rest.strip_suffix(".sqlite")?;
    let (kind, tail) = rest.split_once('-')?;
    let known = [
        "upgrade",
        "restore",
        "erase",
        "rotation",
        "conversion",
        "create",
        AUTO_KIND,
    ];
    (known.contains(&kind) && !tail.is_empty()).then(|| (kind.to_owned(), tail.to_owned()))
}

/// The kind of the copies the scheduled backup writes: `<database>.pre-auto-<stamp>.sqlite`.
pub const AUTO_KIND: &str = "auto";

/// The stamp (`yyyymmddThhmmss`, UTC) of the newest copy of `kind` beside `database`, or
/// `None` when there is none. The stamp, not the file's modified time, decides which is
/// newest, so a copy that was touched or restored from elsewhere is not mistaken for fresh.
pub fn newest_stamp(database: &Path, kind: &str) -> Option<String> {
    let parent = database.parent()?;
    let parent = if parent.as_os_str().is_empty() {
        Path::new(".")
    } else {
        parent
    };
    let name = database.file_name()?.to_string_lossy().into_owned();
    std::fs::read_dir(parent)
        .ok()?
        .flatten()
        .filter_map(|entry| {
            let file_name = entry.file_name().to_string_lossy().into_owned();
            let (found, tail) = split_copy_name(&name, &file_name)?;
            (found == kind && entry.metadata().ok()?.is_file()).then_some(tail)
        })
        .max()
}

fn pending_recovery_path(database: &Path) -> Option<PathBuf> {
    let live = std::fs::canonicalize(database).unwrap_or_else(|_| database.to_path_buf());
    let marker = key::read_marker(&live).ok().flatten()?;
    Some(PathBuf::from(marker.recovery_path))
}

fn is_protected(path: &Path, protected: Option<&Path>) -> bool {
    let Some(protected) = protected else {
        return false;
    };
    let canonical =
        |path: &Path| std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    canonical(path) == canonical(protected)
}

fn remove_with_sidecars(path: &Path) -> bool {
    if std::fs::remove_file(path).is_err() {
        return false;
    }
    for suffix in ["-wal", "-shm", "-journal"] {
        let mut sidecar = path.as_os_str().to_owned();
        sidecar.push(suffix);
        let _ = std::fs::remove_file(PathBuf::from(sidecar));
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    fn scratch(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("wobble-safety-{name}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn touch(path: &Path, age_secs: u64) {
        std::fs::write(path, b"copy").unwrap();
        let when = SystemTime::now() - Duration::from_secs(age_secs);
        std::fs::File::options()
            .write(true)
            .open(path)
            .unwrap()
            .set_modified(when)
            .unwrap();
    }

    #[test]
    fn keeps_the_newest_three_of_each_kind_and_leaves_other_files_alone() {
        let dir = scratch("keep");
        let db = dir.join("wobble.sqlite");
        std::fs::write(&db, b"live").unwrap();
        for age in 1..=5 {
            touch(
                &dir.join(format!(
                    "wobble.sqlite.pre-restore-2026010{age}T000000.sqlite"
                )),
                age * 100,
            );
            touch(
                &dir.join(format!(
                    "wobble.sqlite.pre-upgrade-v{age}-20260101T000000.sqlite"
                )),
                age * 100,
            );
        }
        touch(&dir.join("wobble.sqlite.pre-rotation-1111.sqlite"), 50);
        touch(&dir.join("notes.txt"), 9_999);
        touch(
            &dir.join("other.sqlite.pre-restore-2026010T000000.sqlite"),
            9_999,
        );

        assert_eq!(prune(&db), 4);

        let names: Vec<String> = std::fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .collect();
        let restores = names
            .iter()
            .filter(|n| n.contains(".pre-restore-") && n.starts_with("wobble"))
            .count();
        let upgrades = names.iter().filter(|n| n.contains(".pre-upgrade-")).count();
        assert_eq!((restores, upgrades), (3, 3));
        assert!(names.contains(&"wobble.sqlite".to_owned()));
        assert!(names.contains(&"wobble.sqlite.pre-rotation-1111.sqlite".to_owned()));
        assert!(names.contains(&"notes.txt".to_owned()));
        assert!(names.contains(&"other.sqlite.pre-restore-2026010T000000.sqlite".to_owned()));
        // The two oldest of each kind are the ones that went.
        assert!(!names.contains(&"wobble.sqlite.pre-restore-20260105T000000.sqlite".to_owned()));
        assert!(!names.contains(&"wobble.sqlite.pre-restore-20260104T000000.sqlite".to_owned()));
        assert!(names.contains(&"wobble.sqlite.pre-restore-20260101T000000.sqlite".to_owned()));
    }

    #[test]
    fn removes_the_sidecars_of_a_pruned_copy() {
        let dir = scratch("sidecars");
        let db = dir.join("wobble.sqlite");
        std::fs::write(&db, b"live").unwrap();
        let old = dir.join("wobble.sqlite.pre-erase-20260101T000000.sqlite");
        touch(&old, 900);
        std::fs::write(
            dir.join("wobble.sqlite.pre-erase-20260101T000000.sqlite-wal"),
            b"w",
        )
        .unwrap();
        for age in 1..=3 {
            touch(
                &dir.join(format!(
                    "wobble.sqlite.pre-erase-2026020{age}T000000.sqlite"
                )),
                age,
            );
        }
        assert_eq!(prune(&db), 1);
        assert!(!old.exists());
        assert!(!dir
            .join("wobble.sqlite.pre-erase-20260101T000000.sqlite-wal")
            .exists());
    }

    #[test]
    fn a_missing_folder_or_database_is_not_an_error() {
        assert_eq!(prune(Path::new("/nonexistent-wobble-dir/wobble.sqlite")), 0);
        assert_eq!(prune(Path::new("wobble-no-such-file.sqlite")), 0);
    }

    #[test]
    fn only_the_exact_naming_pattern_counts_as_a_copy() {
        assert_eq!(
            kind_of("w.sqlite", "w.sqlite.pre-restore-20260101T000000.sqlite").as_deref(),
            Some("restore")
        );
        assert_eq!(
            kind_of(
                "w.sqlite",
                "w.sqlite.pre-upgrade-v3-20260101T000000-2.sqlite"
            )
            .as_deref(),
            Some("upgrade")
        );
        assert_eq!(kind_of("w.sqlite", "w.sqlite.pre-mystery-1.sqlite"), None);
        assert_eq!(
            kind_of("w.sqlite", "w.sqlite.pre-restore-1.sqlite-wal"),
            None
        );
        assert_eq!(kind_of("w.sqlite", "w.sqlite.wobble-1.stage"), None);
        assert_eq!(kind_of("w.sqlite", "x.sqlite.pre-restore-1.sqlite"), None);
    }
}
