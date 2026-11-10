//! An authenticated installation: one connection and its credential share an owner.
//! App serializes this owner's methods under the existing request mutex. Taking the
//! connection before replacement prevents live handles or WAL sidecars crossing a swap.
use std::path::{Path, PathBuf};

use crate::db::Db;
use crate::key::{self, Secret};
use crate::replacement::{self, RecoveryOutcome};
use crate::{Error, Result};

pub struct OpenDatabase {
    path: PathBuf,
    db: Option<Db>,
    secret: Secret,
    recovery_copy: Option<(PathBuf, String)>,
}

impl OpenDatabase {
    pub fn open(path: &Path, secret: Secret) -> Result<Self> {
        if !path.is_file() {
            return Err(Error::coded(
                "database_missing",
                "Create encrypted storage before unlocking.",
            ));
        }
        let recovery_copy = key::read_marker(path)?
            .filter(|marker| marker.op == "conversion")
            .and_then(|marker| {
                let recovery = PathBuf::from(marker.recovery_path);
                let hash = key::file_hash_hex(&recovery).ok()?;
                if marker.recovery_hash.as_ref() == Some(&hash)
                    && key::verify_copy_keyed(&recovery, Some(&secret)).is_ok()
                {
                    Some((recovery, hash))
                } else {
                    None
                }
            });
        if replacement::recover(path, &secret)? == RecoveryOutcome::RetryConversion {
            return Err(Error::coded(
                "database_conversion_required",
                "Legacy conversion is required.",
            ));
        }
        let db = Db::open_keyed(
            path.to_str()
                .ok_or_else(|| Error::Message("The database path is invalid.".to_owned()))?,
            Some(&secret),
        )?;
        Ok(Self {
            path: path.to_owned(),
            db: Some(db),
            secret,
            recovery_copy,
        })
    }

    pub fn create(path: &Path, secret: Secret) -> Result<Self> {
        if key::read_marker(path)?.is_some() {
            match replacement::recover(path, &secret)? {
                RecoveryOutcome::RetryCreate => {}
                RecoveryOutcome::Settled => return Self::open(path, secret),
                RecoveryOutcome::RetryConversion => {
                    return Err(Error::coded(
                        "database_conversion_required",
                        "Legacy conversion is required.",
                    ))
                }
            }
        }
        let mut prepared = replacement::prepare_create(path, &secret)?;
        prepared.install(&secret)?;
        let db = Db::reopen_verified(
            path.to_str()
                .ok_or_else(|| Error::Message("The database path is invalid.".to_owned()))?,
            &secret,
        )?;
        prepared.complete()?;
        db.activate_wal()?;
        Ok(Self {
            path: path.to_owned(),
            db: Some(db),
            secret,
            recovery_copy: None,
        })
    }

    pub fn convert(path: &Path, secret: Secret) -> Result<Self> {
        if key::classify_source(path) != key::SourceKind::PlaintextLegacy {
            return Err(Error::coded(
                "database_conversion_required",
                "Choose the legacy conversion flow.",
            ));
        }
        if key::read_marker(path)?.is_some() {
            match replacement::recover(path, &secret)? {
                RecoveryOutcome::RetryConversion => {}
                RecoveryOutcome::Settled => return Self::open(path, secret),
                RecoveryOutcome::RetryCreate => {
                    return Err(Error::coded(
                        "database_missing",
                        "Create encrypted storage before unlocking.",
                    ))
                }
            }
        }
        let mut prepared = replacement::prepare(path, path, None, None, &secret, "conversion")?;
        prepared.install(&secret)?;
        let db = Db::reopen_verified(
            path.to_str()
                .ok_or_else(|| Error::Message("The database path is invalid.".to_owned()))?,
            &secret,
        )?;
        let recovery = prepared.complete()?;
        db.activate_wal()?;
        let recovery_copy = Some((recovery.clone(), key::file_hash_hex(&recovery)?));
        Ok(Self {
            path: path.to_owned(),
            db: Some(db),
            secret,
            recovery_copy,
        })
    }

    pub fn db(&self) -> Result<&Db> {
        self.db.as_ref().ok_or_else(|| {
            Error::coded(
                "database_recovery_required",
                "Database recovery is required.",
            )
        })
    }

    pub fn retained_recovery(&self) -> Option<&Path> {
        self.recovery_copy.as_ref().and_then(|(path, hash)| {
            (key::file_hash_hex(path).ok().as_ref() == Some(hash)).then_some(path.as_path())
        })
    }

    fn remember_recovery(&mut self, path: &Path) {
        self.recovery_copy = key::file_hash_hex(path)
            .ok()
            .map(|hash| (path.to_owned(), hash));
    }

    fn capture_pending_recovery(&mut self) {
        if let Ok(Some(marker)) = key::read_marker(&self.path) {
            let path = PathBuf::from(marker.recovery_path);
            let source = replacement::records(&self.path, Some(&self.secret));
            let recovery = replacement::records(&path, Some(&self.secret));
            if let (Ok(source), Ok(recovery)) = (source, recovery) {
                if source == recovery && key::verify_copy_keyed(&path, Some(&self.secret)).is_ok() {
                    self.remember_recovery(&path);
                }
            }
        }
    }

    pub fn secret(&self) -> &Secret {
        &self.secret
    }

    /// Explicit legacy restore is the only restore without a source credential.
    /// Validate the source before closing the installation; never modify its file.
    pub fn restore(
        &mut self,
        source: &Path,
        source_secret: Option<&Secret>,
        legacy: bool,
    ) -> Result<PathBuf> {
        self.recovery_copy = None;
        if source_secret.is_none() && !legacy {
            return Err(Error::coded(
                "restore_source_credential_required",
                "The backup passphrase is required.",
            ));
        }
        if same_file::is_same_file(&self.path, source).unwrap_or(false) {
            return Err(Error::coded(
                "restore_same_file",
                "Choose a backup other than the active database.",
            ));
        }
        if legacy && key::classify_source(source) != key::SourceKind::PlaintextLegacy {
            return Err(Error::coded(
                "restore_legacy_required",
                "Choose an explicitly supported legacy plaintext backup.",
            ));
        }
        validate_restore_source(source, source_secret)?;
        self.db.take();
        let result = replacement::prepare(
            &self.path,
            source,
            Some(&self.secret),
            source_secret,
            &self.secret,
            "restore",
        );
        let mut prepared = match result {
            Ok(prepared) => prepared,
            Err(error) => {
                self.capture_pending_recovery();
                self.reopen_previous();
                return Err(Error::coded("restore_failed", error.to_string()));
            }
        };
        self.remember_recovery(prepared.recovery_path());
        let result = prepared
            .install(&self.secret)
            .and_then(|()| self.reopen_with(&self.secret));
        match result {
            Ok(db) => match prepared.complete().and_then(|path| {
                db.activate_wal()?;
                Ok(path)
            }) {
                Ok(path) => {
                    self.db = Some(db);
                    Ok(path)
                }
                Err(error) => {
                    // Marker cleanup can fail after the replacement succeeded. Do not
                    // report a rollback that was not performed; require boot recovery.
                    drop(db);
                    Err(Error::coded("restore_failed", error.to_string()))
                }
            },
            Err(error) => {
                if prepared.rollback(&self.secret).is_ok() {
                    if let Ok(db) = self.reopen_with(&self.secret) {
                        if prepared.complete().is_ok() && db.activate_wal().is_ok() {
                            self.db = Some(db);
                        }
                    }
                }
                Err(Error::coded("restore_failed", error.to_string()))
            }
        }
    }

    /// Keep the old credential until the new database reopens and the marker clears.
    /// Every failure before completion attempts old-key rollback; failure to prove it
    /// leaves this owner without a connection, so ordinary routes remain unavailable.
    pub fn rotate(&mut self, current: &Secret, next: Secret) -> Result<PathBuf> {
        self.recovery_copy = None;
        key::verify_copy_keyed(&self.path, Some(current))?;
        self.db.take();
        let result = replacement::prepare(
            &self.path,
            &self.path,
            Some(&self.secret),
            Some(&self.secret),
            &next,
            "rotation",
        );
        let mut prepared = match result {
            Ok(prepared) => prepared,
            Err(error) => {
                self.capture_pending_recovery();
                self.reopen_previous();
                return Err(error);
            }
        };
        self.remember_recovery(prepared.recovery_path());
        match prepared
            .install(&next)
            .and_then(|()| self.reopen_with(&next))
        {
            Ok(db) => match prepared.complete().and_then(|path| {
                db.activate_wal()?;
                Ok(path)
            }) {
                Ok(path) => {
                    self.db = Some(db);
                    self.secret = next;
                    Ok(path)
                }
                Err(error) => {
                    drop(db);
                    if prepared.reconcile_before_rollback(&next).is_ok()
                        && prepared.rollback(&self.secret).is_ok()
                    {
                        if let Ok(db) = self.reopen_with(&self.secret) {
                            if prepared.complete().is_ok() && db.activate_wal().is_ok() {
                                self.db = Some(db);
                            }
                        }
                    }
                    Err(error)
                }
            },
            Err(error) => {
                if prepared.rollback(&self.secret).is_ok() {
                    if let Ok(db) = self.reopen_with(&self.secret) {
                        if prepared.complete().is_ok() && db.activate_wal().is_ok() {
                            self.db = Some(db);
                        }
                    }
                }
                Err(error)
            }
        }
    }

    fn reopen_with(&self, secret: &Secret) -> Result<Db> {
        Db::reopen_verified(
            self.path
                .to_str()
                .ok_or_else(|| Error::Message("The database path is invalid.".to_owned()))?,
            secret,
        )
    }

    fn reopen_previous(&mut self) {
        if replacement::recover(&self.path, &self.secret).is_ok() {
            self.db = self
                .reopen_with(&self.secret)
                .ok()
                .filter(|db| db.activate_wal().is_ok());
        }
    }
}

fn validate_restore_source(path: &Path, secret: Option<&Secret>) -> Result<()> {
    let metadata = std::fs::metadata(path)
        .map_err(|_| Error::coded("restore_unreadable", "The backup could not be read."))?;
    if !metadata.is_file() {
        return Err(Error::coded(
            "restore_not_a_file",
            "The chosen backup is not a file.",
        ));
    }
    let conn = key::open_keyed_readonly(path, secret)?;
    let integrity: String = conn
        .query_row("PRAGMA integrity_check", [], |row| row.get(0))
        .map_err(|_| {
            Error::coded(
                "restore_integrity",
                "The backup did not pass its integrity check.",
            )
        })?;
    if integrity != "ok" {
        return Err(Error::coded(
            "restore_integrity",
            "The backup did not pass its integrity check.",
        ));
    }
    let version = crate::schema::read_schema_version(&conn)?;
    match version {
        Some(v) if (12..=crate::schema::CURRENT_SCHEMA_VERSION).contains(&v) => Ok(()),
        Some(v) => Err(Error::coded(
            "restore_unsupported_schema",
            format!(
                "The backup's schema version {v} is unsupported. This app restores version 12 through version {} backups.",
                crate::schema::CURRENT_SCHEMA_VERSION
            ),
        )),
        None => Err(Error::coded(
            "restore_unsupported_schema",
            "The backup has an unsupported Wobble schema.",
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Files(PathBuf);
    impl Files {
        fn new() -> Self {
            let path =
                std::env::temp_dir().join(format!("wobble-open-owner-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir(&path).unwrap();
            Self(path)
        }
        fn live(&self) -> PathBuf {
            self.0.join("live.sqlite")
        }
    }
    impl Drop for Files {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    fn secret(text: &str) -> Secret {
        Secret::from_passphrase(text).unwrap()
    }
    fn create(path: &Path, key: &Secret, name: &str) {
        let db = Db::open_keyed(path.to_str().unwrap(), Some(key)).unwrap();
        db.conn()
            .execute("INSERT INTO worksites (id, name) VALUES (?1, ?1)", [name])
            .unwrap();
    }
    #[test]
    fn rotation_owns_new_key_only_after_reopen_and_retains_old_key_recovery() {
        let files = Files::new();
        let live = files.live();
        create(&live, &secret("old"), "original");
        let mut open = OpenDatabase::open(&live, secret("old")).unwrap();
        let recovery = open.rotate(&secret("old"), secret("new")).unwrap();
        assert!(open.db().is_ok());
        assert!(key::verify_copy_keyed(&recovery, Some(&secret("old"))).is_ok());
        drop(open);
        assert!(OpenDatabase::open(&live, secret("old")).is_err());
        assert!(OpenDatabase::open(&live, secret("new")).is_ok());
    }
    #[test]
    fn wrong_current_credential_leaves_connection_and_records_available() {
        let files = Files::new();
        let live = files.live();
        create(&live, &secret("old"), "original");
        let mut open = OpenDatabase::open(&live, secret("old")).unwrap();
        assert!(open.rotate(&secret("wrong"), secret("new")).is_err());
        let name: String = open
            .db()
            .unwrap()
            .conn()
            .query_row("SELECT name FROM worksites", [], |row| row.get(0))
            .unwrap();
        assert_eq!(name, "original");
        assert!(key::read_marker(&live).unwrap().is_none());
    }
    #[test]
    fn restore_retains_installation_credential_and_source_bytes() {
        let files = Files::new();
        let live = files.live();
        let source = files.0.join("backup.sqlite");
        create(&live, &secret("installation"), "old installation");
        create(&source, &secret("backup"), "restored");
        let source_hash = key::file_hash_hex(&source).unwrap();
        let mut open = OpenDatabase::open(&live, secret("installation")).unwrap();
        let recovery = open
            .restore(&source, Some(&secret("backup")), false)
            .unwrap();
        let name: String = open
            .db()
            .unwrap()
            .conn()
            .query_row("SELECT name FROM worksites", [], |row| row.get(0))
            .unwrap();
        assert_eq!(name, "restored");
        assert_eq!(key::file_hash_hex(&source).unwrap(), source_hash);
        assert!(key::verify_copy_keyed(&recovery, Some(&secret("installation"))).is_ok());
        drop(open);
        assert!(OpenDatabase::open(&live, secret("installation")).is_ok());
        assert!(OpenDatabase::open(&live, secret("backup")).is_err());
    }
    #[test]
    fn unlock_never_creates_a_missing_file() {
        let files = Files::new();
        let live = files.live();
        assert!(OpenDatabase::open(&live, secret("anything")).is_err());
        assert!(!live.exists());
    }
    #[test]
    fn verified_reopen_keeps_marker_hash_stable_until_cleanup() {
        let files = Files::new();
        let live = files.live();
        let old = secret("old");
        let next = secret("new");
        create(&live, &old, "original");
        let mut prepared =
            replacement::prepare(&live, &live, Some(&old), Some(&old), &next, "rotation").unwrap();
        prepared.install(&next).unwrap();
        let before = key::file_hash_hex(&live).unwrap();
        let db = Db::reopen_verified(live.to_str().unwrap(), &next).unwrap();
        assert_eq!(key::file_hash_hex(&live).unwrap(), before);
        assert!(!key::sidecars_present(&live));
        drop(db); // Crash boundary after application reopen, before marker removal.
        assert_eq!(
            replacement::recover(&live, &next).unwrap(),
            RecoveryOutcome::Settled
        );
        assert!(OpenDatabase::open(&live, next).is_ok());
    }
}
