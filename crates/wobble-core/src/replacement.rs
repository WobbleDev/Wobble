//! Closed-connection, encrypted file replacement shared by restore, conversion and rotation.
//! The caller holds the App request mutex and drops its live Db before entering here.
use std::path::{Path, PathBuf};

use rusqlite::types::ValueRef;
use sha2::{Digest, Sha256};

use crate::key::{self, Marker, MarkerPhase, Secret};
use crate::{Error, Result};

fn recovery_error() -> Error {
    Error::coded(
        "database_recovery_required",
        "Database recovery is required. The recovery artifacts have been retained.",
    )
}

fn io(error: std::io::Error) -> Error {
    Error::Message(error.to_string())
}

/// Hash every stored application row with type/length framing, independent of row order.
/// This checks data preservation across SQLCipher's independently salted exports.
pub(crate) fn records(path: &Path, secret: Option<&Secret>) -> Result<Vec<u8>> {
    let conn = key::open_keyed_readonly(path, secret)?;
    records_connection(&conn)
}

fn records_connection(conn: &rusqlite::Connection) -> Result<Vec<u8>> {
    let mut tables = conn.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")?;
    let names = tables
        .query_map([], |row| row.get::<_, String>(0))?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    let mut result = Sha256::new();
    for name in names {
        result.update((name.len() as u64).to_le_bytes());
        result.update(name.as_bytes());
        let mut statement =
            conn.prepare(&format!("SELECT * FROM \"{}\"", name.replace('"', "\"\"")))?;
        let columns = statement.column_count();
        let mut rows = statement.query([])?;
        let mut hashes = Vec::new();
        while let Some(row) = rows.next()? {
            let mut hash = Sha256::new();
            for column in 0..columns {
                match row.get_ref(column)? {
                    ValueRef::Null => hash.update([0]),
                    ValueRef::Integer(value) => {
                        hash.update([1]);
                        hash.update(value.to_le_bytes());
                    }
                    ValueRef::Real(value) => {
                        hash.update([2]);
                        hash.update(value.to_bits().to_le_bytes());
                    }
                    ValueRef::Text(value) | ValueRef::Blob(value) => {
                        hash.update([if matches!(row.get_ref(column)?, ValueRef::Text(_)) {
                            3
                        } else {
                            4
                        }]);
                        hash.update((value.len() as u64).to_le_bytes());
                        hash.update(value);
                    }
                }
            }
            hashes.push(hash.finalize().to_vec());
        }
        hashes.sort();
        result.update((hashes.len() as u64).to_le_bytes());
        for hash in hashes {
            result.update(hash);
        }
    }
    Ok(result.finalize().to_vec())
}

fn reserve(path: &Path) -> Result<()> {
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(path).map_err(io)?.sync_all().map_err(io)
}

fn advance(marker: &mut Marker, phase: MarkerPhase) -> Result<()> {
    marker.phase = phase;
    key::write_marker(marker)?;
    Ok(())
}

/// Export an open database through a private, verified staging file. Overwriting a
/// chosen export is atomic; safety-copy callers require a new destination. A failure
/// never truncates an existing destination or attaches it as another schema.
pub(crate) fn export_connection(
    source: &rusqlite::Connection,
    destination: &Path,
    secret: Option<&Secret>,
    overwrite: bool,
) -> Result<()> {
    let parent = destination
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    let parent = std::fs::canonicalize(parent).map_err(io)?;
    let destination = parent.join(destination.file_name().ok_or_else(recovery_error)?);
    if destination
        .symlink_metadata()
        .is_ok_and(|m| m.file_type().is_symlink())
        || key::sidecars_present(&destination)
    {
        return Err(recovery_error());
    }
    let source_path: String = source.query_row(
        "SELECT file FROM pragma_database_list WHERE name = 'main'",
        [],
        |row| row.get(0),
    )?;
    if !source_path.is_empty()
        && destination.exists()
        && same_file::is_same_file(Path::new(&source_path), &destination).map_err(io)?
    {
        return Err(Error::Message(
            "The backup must use a different destination.".to_owned(),
        ));
    }
    if !overwrite {
        reserve(&destination)?;
    }
    let stage = parent.join(format!(".wobble-export-{}.stage", uuid::Uuid::new_v4()));
    let mut owns_stage = false;
    let result = (|| -> Result<()> {
        reserve(&stage)?;
        owns_stage = true;
        let expected = records_connection(source)?;
        match secret {
            Some(_) => key::export_via_attach(source, &stage, secret)?,
            None => {
                // Intentional ephemeral/legacy tests only; production callers supply a key.
                let mut target = rusqlite::Connection::open(&stage)?;
                key::backup_via_handles(source, &mut target)?;
            }
        }
        key::settle_to_single_file(&stage, secret)?;
        key::verify_copy_keyed(&stage, secret)?;
        if records(&stage, secret)? != expected {
            return Err(recovery_error());
        }
        key::atomic_replace(&stage, &destination)?;
        Ok(())
    })();
    if result.is_err() {
        if owns_stage {
            let _ = std::fs::remove_file(&stage);
        }
        if !overwrite
            && destination
                .metadata()
                .is_ok_and(|metadata| metadata.len() == 0)
        {
            let _ = std::fs::remove_file(&destination);
        }
    }
    result
}

fn retain_plaintext_original(marker: &Marker) -> Result<()> {
    let Some(hold) = &marker.plaintext_hold_path else {
        return Ok(());
    };
    let live = Path::new(&marker.live_path);
    let hold = Path::new(hold);
    if hold.exists() {
        if !same_file::is_same_file(live, hold).map_err(io)?
            || key::file_hash_hex(hold).ok().as_ref() != marker.src_hash.as_ref()
        {
            return Err(recovery_error());
        }
    } else {
        // This is another name for the pre-existing source inode, not a new plaintext
        // staging/recovery copy. hard_link is exclusive and same-volume.
        std::fs::hard_link(live, hold).map_err(io)?;
        key::fsync_file_and_dir(hold)?;
    }
    Ok(())
}

fn cleanup_plaintext_original(marker: &Marker) -> Result<()> {
    cleanup_plaintext_original_with(marker, |path| std::fs::remove_file(path))
}

fn cleanup_plaintext_original_with(
    marker: &Marker,
    unlink: impl FnOnce(&Path) -> std::io::Result<()>,
) -> Result<()> {
    let Some(value) = &marker.plaintext_hold_path else {
        return Ok(());
    };
    let path = Path::new(value);
    match path.symlink_metadata() {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Ok(metadata) if metadata.is_file() && !metadata.file_type().is_symlink() => {}
        _ => return Err(recovery_error()),
    }
    if key::file_hash_hex(path).ok().as_ref() != marker.src_hash.as_ref() {
        return Err(recovery_error());
    }
    unlink(path).map_err(|_| recovery_error())?;
    key::fsync_file_and_dir(Path::new(&marker.live_path))
}

fn cleanup_stage(marker: &Marker) -> Result<()> {
    let stage = Path::new(&marker.stage_path);
    match stage.symlink_metadata() {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Ok(metadata) if metadata.is_file() && !metadata.file_type().is_symlink() => {}
        _ => return Err(recovery_error()),
    }
    let prefix = format!(
        "{}.wobble-",
        Path::new(&marker.live_path)
            .file_name()
            .ok_or_else(recovery_error)?
            .to_string_lossy()
    );
    let nonce = stage
        .file_name()
        .and_then(|value| value.to_str())
        .and_then(|value| value.strip_prefix(&prefix))
        .and_then(|value| value.strip_suffix(".stage"))
        .ok_or_else(recovery_error)?;
    if uuid::Uuid::parse_str(nonce).is_err() {
        return Err(recovery_error());
    }
    if let Some(expected) = &marker.dst_hash {
        if key::file_hash_hex(stage).ok().as_ref() != Some(expected) {
            return Err(recovery_error());
        }
    }
    std::fs::remove_file(stage).map_err(|_| recovery_error())?;
    key::fsync_file_and_dir(Path::new(&marker.live_path))
}

fn reopen_before_cleanup(marker: &Marker, secret: &Secret) -> Result<()> {
    // No journal-mode changes while exact generation hashes still govern recovery.
    let db = crate::db::Db::reopen_verified(&marker.live_path, secret)?;
    drop(db);
    Ok(())
}

/// A verified replacement awaiting installation. No connection is kept open.
/// Artifacts are retained on errors so startup can reconcile their recorded identities.
pub struct PreparedReplacement {
    marker: Marker,
}

impl PreparedReplacement {
    pub fn recovery_path(&self) -> &Path {
        Path::new(&self.marker.recovery_path)
    }

    /// Verify every record before and after replacement; retain the marker until the
    /// caller has reopened its application Db and explicitly calls `complete`.
    pub fn install(&mut self, next: &Secret) -> Result<()> {
        let live = Path::new(&self.marker.live_path);
        let stage = Path::new(&self.marker.stage_path);
        if (self.marker.op == "create" && live.try_exists().map_err(io)?)
            || key::file_hash_hex(live).ok().as_ref() != self.marker.src_hash.as_ref()
            || key::file_hash_hex(stage).ok().as_ref() != self.marker.dst_hash.as_ref()
            || key::file_hash_hex(Path::new(&self.marker.recovery_path))
                .ok()
                .as_ref()
                != self.marker.recovery_hash.as_ref()
            || key::sidecars_present(live)
        {
            return Err(recovery_error());
        }
        let expected = records(stage, Some(next))?;
        key::verify_copy_keyed(stage, Some(next))?;
        retain_plaintext_original(&self.marker)?;
        advance(&mut self.marker, MarkerPhase::Swapping)?;
        key::atomic_replace(
            Path::new(&self.marker.stage_path),
            Path::new(&self.marker.live_path),
        )?;
        advance(&mut self.marker, MarkerPhase::Swapped)?;
        let live = Path::new(&self.marker.live_path);
        key::verify_copy_keyed(live, Some(next))?;
        if records(live, Some(next))? != expected {
            return Err(recovery_error());
        }
        Ok(())
    }

    /// Complete only after successful application reopen. Keep the encrypted recovery
    /// as the operation's safety copy; no persistent history is introduced.
    pub fn complete(&mut self) -> Result<PathBuf> {
        self.complete_with_unlink(|path| std::fs::remove_file(path))
    }

    fn complete_with_unlink(
        &mut self,
        unlink: impl FnOnce(&Path) -> std::io::Result<()>,
    ) -> Result<PathBuf> {
        if !matches!(
            self.marker.phase,
            MarkerPhase::Swapped | MarkerPhase::RolledBack
        ) {
            return Err(recovery_error());
        }
        if self.marker.phase == MarkerPhase::Swapped
            && key::file_hash_hex(Path::new(&self.marker.recovery_path))
                .ok()
                .as_ref()
                != self.marker.recovery_hash.as_ref()
        {
            return Err(recovery_error());
        }
        cleanup_plaintext_original_with(&self.marker, unlink)?;
        cleanup_stage(&self.marker)?;
        key::clear_marker(Path::new(&self.marker.live_path))?;
        Ok(PathBuf::from(
            if self.marker.phase == MarkerPhase::RolledBack {
                &self.marker.live_path
            } else {
                &self.marker.recovery_path
            },
        ))
    }

    /// If marker cleanup committed but runtime WAL setup then failed, record the
    /// verified current bytes before beginning rollback. Pending markers must already
    /// match; never rewrite an uncertain generation merely to make its hash fit.
    pub fn reconcile_before_rollback(&mut self, current: &Secret) -> Result<()> {
        let live = Path::new(&self.marker.live_path);
        if let Some(existing) = key::read_marker(live)? {
            if existing.generation != self.marker.generation || key::sidecars_present(live) {
                return Err(recovery_error());
            }
            let hash = key::file_hash_hex(live)?;
            if Some(&hash) != existing.src_hash.as_ref()
                && Some(&hash) != existing.dst_hash.as_ref()
            {
                return Err(recovery_error());
            }
            return Ok(());
        }
        key::settle_to_single_file(live, Some(current))?;
        key::verify_copy_keyed(live, Some(current))?;
        let conn = key::open_keyed_readonly(live, Some(current))?;
        crate::store_validation::validate(&conn)?;
        drop(conn);
        self.marker.dst_hash = Some(key::file_hash_hex(live)?);
        self.marker.phase = MarkerPhase::Swapped;
        key::create_marker(&self.marker)
    }

    /// Restore the separately salted recovery, preserving its old credential.
    pub fn rollback(&mut self, previous: &Secret) -> Result<()> {
        if key::sidecars_present(Path::new(&self.marker.live_path)) {
            return Err(recovery_error());
        }
        let recovery = Path::new(&self.marker.recovery_path);
        if key::file_hash_hex(recovery).ok().as_ref() != self.marker.recovery_hash.as_ref() {
            return Err(recovery_error());
        }
        key::verify_copy_keyed(recovery, Some(previous))?;
        advance(&mut self.marker, MarkerPhase::RollingBack)?;
        key::atomic_replace(
            Path::new(&self.marker.recovery_path),
            Path::new(&self.marker.live_path),
        )?;
        advance(&mut self.marker, MarkerPhase::RolledBack)?;
        key::verify_copy_keyed(Path::new(&self.marker.live_path), Some(previous))?;
        Ok(())
    }
}

/// Reserve, copy and verify before any live replacement. `source` can be an explicit
/// legacy plaintext input; both output artifacts are always encrypted. Migration runs
/// on the encrypted stage before its final identity is recorded, never after swapping.
pub fn prepare(
    live: &Path,
    source: &Path,
    current: Option<&Secret>,
    source_key: Option<&Secret>,
    next: &Secret,
    operation: &str,
) -> Result<PreparedReplacement> {
    if !matches!(operation, "conversion" | "rotation" | "restore")
        || key::read_marker(live)?.is_some()
    {
        return Err(recovery_error());
    }
    let live = std::fs::canonicalize(live).map_err(io)?;
    // The App's connection has been closed; settle before hashing the old generation.
    key::settle_to_single_file(&live, current)?;
    let expected_source = records(source, source_key)?;
    let expected_live = records(&live, current)?;
    let generation = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|_| recovery_error())?
        .as_millis() as i64;
    let stem = format!(
        "{}.wobble-{}",
        live.file_name()
            .ok_or_else(recovery_error)?
            .to_string_lossy(),
        uuid::Uuid::new_v4()
    );
    let parent = live.parent().ok_or_else(recovery_error)?;
    let stage = parent.join(format!("{stem}.stage"));
    let recovery = parent.join(format!(
        "{}.pre-{}-{}.sqlite",
        live.file_name()
            .ok_or_else(recovery_error)?
            .to_string_lossy(),
        operation,
        uuid::Uuid::new_v4()
    ));
    let mut marker = Marker {
        version: 1,
        op: operation.to_owned(),
        phase: MarkerPhase::Reserved,
        generation,
        created_at: generation.to_string(),
        src_hash: Some(key::file_hash_hex(&live)?),
        dst_hash: None,
        recovery_hash: None,
        live_path: live.to_string_lossy().into_owned(),
        stage_path: stage.to_string_lossy().into_owned(),
        recovery_path: recovery.to_string_lossy().into_owned(),
        plaintext_hold_path: (operation == "conversion").then(|| {
            parent
                .join(format!(
                    "{}.displaced-plaintext-{}",
                    live.file_name()
                        .expect("validated filename")
                        .to_string_lossy(),
                    uuid::Uuid::new_v4()
                ))
                .to_string_lossy()
                .into_owned()
        }),
    };
    key::create_marker(&marker)?;
    reserve(&stage)?;
    reserve(&recovery)?;
    advance(&mut marker, MarkerPhase::Copying)?;
    let recovery_key = current.unwrap_or(next);
    key::copy_db_keyed(&live, current, &recovery, Some(recovery_key))?;
    key::copy_db_keyed(source, source_key, &stage, Some(next))?;
    advance(&mut marker, MarkerPhase::Verifying)?;
    if records(&recovery, Some(recovery_key))? != expected_live
        || records(&stage, Some(next))? != expected_source
    {
        return Err(recovery_error());
    }
    // The encrypted staging copy can migrate without retaining another upgrade copy.
    {
        let conn = key::open_keyed(&stage, Some(next))?;
        conn.execute_batch("PRAGMA foreign_keys = ON;")?;
        crate::schema::apply_migrations(&conn)?;
        crate::store_validation::validate(&conn)?;
    }
    key::settle_to_single_file(&stage, Some(next))?;
    key::verify_copy_keyed(&stage, Some(next))?;
    key::verify_copy_keyed(&recovery, Some(recovery_key))?;
    key::fsync_file_and_dir(&stage)?;
    key::fsync_file_and_dir(&recovery)?;
    marker.dst_hash = Some(key::file_hash_hex(&stage)?);
    marker.recovery_hash = Some(key::file_hash_hex(&recovery)?);
    advance(&mut marker, MarkerPhase::Verified)?;
    Ok(PreparedReplacement { marker })
}

/// First-run schema initialization also stages before the live filename exists.
/// No Worksite is seeded; the regular setup flow owns that choice after unlock.
pub fn prepare_create(live: &Path, next: &Secret) -> Result<PreparedReplacement> {
    if live.exists() || key::read_marker(live)?.is_some() {
        return Err(recovery_error());
    }
    let parent = live
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    std::fs::create_dir_all(parent).map_err(io)?;
    let parent = std::fs::canonicalize(parent).map_err(io)?;
    let live = parent.join(live.file_name().ok_or_else(recovery_error)?);
    let generation = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|_| recovery_error())?
        .as_millis() as i64;
    let stem = format!(
        "{}.wobble-{}",
        live.file_name()
            .ok_or_else(recovery_error)?
            .to_string_lossy(),
        uuid::Uuid::new_v4()
    );
    let stage = parent.join(format!("{stem}.stage"));
    let recovery = parent.join(format!(
        "{}.pre-create-{}.sqlite",
        live.file_name()
            .ok_or_else(recovery_error)?
            .to_string_lossy(),
        uuid::Uuid::new_v4()
    ));
    let mut marker = Marker {
        version: 1,
        op: "create".to_owned(),
        phase: MarkerPhase::Reserved,
        generation,
        created_at: generation.to_string(),
        src_hash: None,
        dst_hash: None,
        recovery_hash: None,
        live_path: live.to_string_lossy().into_owned(),
        stage_path: stage.to_string_lossy().into_owned(),
        recovery_path: recovery.to_string_lossy().into_owned(),
        plaintext_hold_path: None,
    };
    key::create_marker(&marker)?;
    reserve(&stage)?;
    reserve(&recovery)?;
    advance(&mut marker, MarkerPhase::Copying)?;
    {
        // This exclusive empty staging file is initialized only through a keyed handle.
        let conn = rusqlite::Connection::open(&stage)?;
        key::apply_key(&conn, next)?;
        conn.execute_batch("PRAGMA foreign_keys = ON;")?;
        crate::schema::apply_migrations(&conn)?;
        crate::store_validation::validate(&conn)?;
    }
    key::settle_to_single_file(&stage, Some(next))?;
    key::copy_db_keyed(&stage, Some(next), &recovery, Some(next))?;
    advance(&mut marker, MarkerPhase::Verifying)?;
    if records(&stage, Some(next))? != records(&recovery, Some(next))? {
        return Err(recovery_error());
    }
    key::verify_copy_keyed(&stage, Some(next))?;
    key::verify_copy_keyed(&recovery, Some(next))?;
    key::fsync_file_and_dir(&stage)?;
    key::fsync_file_and_dir(&recovery)?;
    marker.dst_hash = Some(key::file_hash_hex(&stage)?);
    marker.recovery_hash = Some(key::file_hash_hex(&recovery)?);
    advance(&mut marker, MarkerPhase::Verified)?;
    Ok(PreparedReplacement { marker })
}

#[derive(Debug, PartialEq, Eq)]
pub enum RecoveryOutcome {
    /// Artifacts are reconciled; the caller must still open/probe the supplied key.
    Settled,
    RetryConversion,
    RetryCreate,
}

fn prepared_forward_phase(phase: MarkerPhase) -> bool {
    matches!(phase, MarkerPhase::Swapping | MarkerPhase::Swapped)
}

/// Reconcile the exact recorded generation using a credential supplied this launch.
/// Unknown/tampered states remain blocked. Unfinished artifacts are retained, never
/// deleted on the strength of marker-supplied paths alone.
pub fn recover(live: &Path, supplied: &Secret) -> Result<RecoveryOutcome> {
    let Some(marker) = key::read_marker(live)? else {
        return Ok(RecoveryOutcome::Settled);
    };
    if key::sidecars_present(live) {
        return Err(recovery_error());
    }
    if marker.op == "create" && !live.exists() {
        if matches!(
            marker.phase,
            MarkerPhase::Reserved | MarkerPhase::Copying | MarkerPhase::Verifying
        ) {
            // Roll back an incomplete empty installation without touching its artifacts.
            key::clear_marker(live)?;
            return Ok(RecoveryOutcome::RetryCreate);
        }
        if matches!(marker.phase, MarkerPhase::Verified | MarkerPhase::Swapping) {
            let mut prepared = PreparedReplacement { marker };
            prepared.install(supplied)?;
            reopen_before_cleanup(&prepared.marker, supplied)?;
            prepared.complete()?;
            return Ok(RecoveryOutcome::Settled);
        }
        return Err(recovery_error());
    }
    let live_hash = key::file_hash_hex(live)?;
    let original = marker.src_hash.as_deref() == Some(live_hash.as_str());
    let replacement = marker.dst_hash.as_deref() == Some(live_hash.as_str());
    let restored = marker.recovery_hash.as_deref() == Some(live_hash.as_str());
    let consistent = (original
        && matches!(
            marker.phase,
            MarkerPhase::Reserved
                | MarkerPhase::Copying
                | MarkerPhase::Verifying
                | MarkerPhase::Verified
                | MarkerPhase::Swapping
                | MarkerPhase::RollingBack
        ))
        || (replacement
            && matches!(
                marker.phase,
                MarkerPhase::Swapping | MarkerPhase::Swapped | MarkerPhase::RollingBack
            ))
        || (restored
            && matches!(
                marker.phase,
                MarkerPhase::RollingBack | MarkerPhase::RolledBack
            ));
    if !consistent {
        return Err(recovery_error());
    }

    if ((replacement && prepared_forward_phase(marker.phase)) || restored)
        && key::verify_copy_keyed(live, Some(supplied)).is_ok()
    {
        let mut prepared = PreparedReplacement { marker };
        advance(
            &mut prepared.marker,
            if restored {
                MarkerPhase::RolledBack
            } else {
                MarkerPhase::Swapped
            },
        )?;
        reopen_before_cleanup(&prepared.marker, supplied)?;
        prepared.complete()?;
        return Ok(RecoveryOutcome::Settled);
    }
    let mut prepared = PreparedReplacement { marker };
    if original {
        // Old credential can safely cancel an interrupted operation. The installation
        // stays on its verified old generation; the unused encrypted files remain.
        if key::verify_copy_keyed(live, Some(supplied)).is_ok() {
            reopen_before_cleanup(&prepared.marker, supplied)?;
            cleanup_plaintext_original(&prepared.marker)?;
            cleanup_stage(&prepared.marker)?;
            key::clear_marker(live)?;
            return Ok(RecoveryOutcome::Settled);
        }
        if prepared.marker.op == "conversion"
            && matches!(
                prepared.marker.phase,
                MarkerPhase::Reserved | MarkerPhase::Copying | MarkerPhase::Verifying
            )
        {
            key::verify_copy_keyed(live, None)?;
            cleanup_plaintext_original(&prepared.marker)?;
            cleanup_stage(&prepared.marker)?;
            key::clear_marker(live)?;
            return Ok(RecoveryOutcome::RetryConversion);
        }
        if matches!(
            prepared.marker.phase,
            MarkerPhase::Verified | MarkerPhase::Swapping
        ) {
            prepared.install(supplied)?;
            reopen_before_cleanup(&prepared.marker, supplied)?;
            prepared.complete()?;
            return Ok(RecoveryOutcome::Settled);
        }
    }
    if replacement
        && matches!(
            prepared.marker.phase,
            MarkerPhase::Swapping | MarkerPhase::Swapped | MarkerPhase::RollingBack
        )
    {
        // A supplied old credential can restore recovery without knowing the new key.
        prepared.rollback(supplied)?;
        reopen_before_cleanup(&prepared.marker, supplied)?;
        prepared.complete()?;
        return Ok(RecoveryOutcome::Settled);
    }
    Err(recovery_error())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Db;

    struct Files(PathBuf);
    impl Files {
        fn new() -> Self {
            let path =
                std::env::temp_dir().join(format!("wobble-replace-{}", uuid::Uuid::new_v4()));
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
    fn secret(value: &str) -> Secret {
        Secret::from_passphrase(value).unwrap()
    }
    fn create(path: &Path, key: Option<&Secret>) {
        let db = match key {
            Some(key) => Db::open_keyed(path.to_str().unwrap(), Some(key)),
            None => Db::open_legacy_fixture(path.to_str().unwrap()), // LEGACY-PLAINTEXT-FIXTURE.
        }
        .unwrap();
        db.conn()
            .execute(
                "INSERT INTO worksites (id, name) VALUES ('preserved', 'Keep this Worksite')",
                [],
            )
            .unwrap();
        drop(db);
        key::settle_to_single_file(path, key).unwrap();
    }

    #[test]
    fn rotation_preserves_every_record_and_recovery_uses_old_key() {
        let files = Files::new();
        let live = files.live();
        let old = secret("old exact secret");
        let new = secret("new exact secret");
        create(&live, Some(&old));
        let before = records(&live, Some(&old)).unwrap();
        let mut operation =
            prepare(&live, &live, Some(&old), Some(&old), &new, "rotation").unwrap();
        let recovery = operation.recovery_path().to_owned();
        assert!(key::verify_copy_keyed(&recovery, Some(&old)).is_ok());
        assert!(key::open_keyed_readonly(&recovery, Some(&new)).is_err());
        operation.install(&new).unwrap();
        assert_eq!(records(&live, Some(&new)).unwrap(), before);
        assert!(key::open_keyed_readonly(&live, Some(&old)).is_err());
        operation.complete().unwrap();
        assert!(recovery.exists());
        assert!(key::read_marker(&live).unwrap().is_none());
    }

    #[test]
    fn legacy_conversion_encrypts_both_outputs_before_live_changes() {
        let files = Files::new();
        let live = files.live();
        let new = secret("conversion secret");
        create(&live, None); // LEGACY-PLAINTEXT-FIXTURE: explicit conversion input.
        let hash = key::file_hash_hex(&live).unwrap();
        let mut operation = prepare(&live, &live, None, None, &new, "conversion").unwrap();
        assert_eq!(key::file_hash_hex(&live).unwrap(), hash);
        assert!(key::verify_copy_keyed(operation.recovery_path(), Some(&new)).is_ok());
        assert!(key::verify_copy_keyed(operation.recovery_path(), None).is_err());
        operation.install(&new).unwrap();
        operation.complete().unwrap();
        assert!(key::verify_copy_keyed(&live, None).is_err());
    }

    #[test]
    fn encrypted_restore_rekeys_without_changing_source() {
        let files = Files::new();
        let live = files.live();
        let source = files.0.join("backup.sqlite");
        let install = secret("installation");
        let source_key = secret("backup credential");
        create(&live, Some(&install));
        create(&source, Some(&source_key));
        let source_hash = key::file_hash_hex(&source).unwrap();
        let mut operation = prepare(
            &live,
            &source,
            Some(&install),
            Some(&source_key),
            &install,
            "restore",
        )
        .unwrap();
        operation.install(&install).unwrap();
        operation.complete().unwrap();
        assert_eq!(key::file_hash_hex(&source).unwrap(), source_hash);
        assert_eq!(
            records(&source, Some(&source_key)).unwrap(),
            records(&live, Some(&install)).unwrap()
        );
    }

    #[test]
    fn interrupted_swap_can_finish_with_new_or_rollback_with_old_credential() {
        for use_new in [true, false] {
            let files = Files::new();
            let live = files.live();
            let old = secret("old");
            let new = secret("new");
            create(&live, Some(&old));
            let mut operation =
                prepare(&live, &live, Some(&old), Some(&old), &new, "rotation").unwrap();
            advance(&mut operation.marker, MarkerPhase::Swapping).unwrap();
            key::atomic_replace(Path::new(&operation.marker.stage_path), &live).unwrap();
            assert_eq!(
                recover(&live, if use_new { &new } else { &old }).unwrap(),
                RecoveryOutcome::Settled
            );
            assert!(key::verify_copy_keyed(&live, Some(if use_new { &new } else { &old })).is_ok());
            assert_eq!(
                recover(&live, if use_new { &new } else { &old }).unwrap(),
                RecoveryOutcome::Settled
            );
        }
    }

    #[test]
    fn recovery_never_opens_unknown_live_bytes_or_wrong_credentials() {
        let files = Files::new();
        let live = files.live();
        let old = secret("old");
        let new = secret("new");
        create(&live, Some(&old));
        let _operation = prepare(&live, &live, Some(&old), Some(&old), &new, "rotation").unwrap();
        assert!(recover(&live, &secret("wrong")).is_err());
        assert!(key::read_marker(&live).unwrap().is_some());
        std::fs::write(&live, vec![7u8; 4096]).unwrap();
        assert!(recover(&live, &old).is_err());
        assert!(key::read_marker(&live).unwrap().is_some());
    }
    #[test]
    fn every_forward_and_rollback_phase_recovers_idempotently() {
        for phase in [
            MarkerPhase::Reserved,
            MarkerPhase::Copying,
            MarkerPhase::Verifying,
            MarkerPhase::Verified,
            MarkerPhase::Swapping,
            MarkerPhase::Swapped,
            MarkerPhase::RollingBack,
            MarkerPhase::RolledBack,
        ] {
            let files = Files::new();
            let live = files.live();
            let old = secret("old phase key");
            let new = secret("new phase key");
            create(&live, Some(&old));
            let mut operation =
                prepare(&live, &live, Some(&old), Some(&old), &new, "rotation").unwrap();
            let supplied = match phase {
                MarkerPhase::Swapped => {
                    operation.install(&new).unwrap();
                    &new
                }
                MarkerPhase::RollingBack | MarkerPhase::RolledBack => {
                    operation.install(&new).unwrap();
                    if phase == MarkerPhase::RolledBack {
                        operation.rollback(&old).unwrap();
                    }
                    &old
                }
                MarkerPhase::Verified | MarkerPhase::Swapping => &new,
                _ => &old,
            };
            advance(&mut operation.marker, phase).unwrap();
            assert_eq!(
                recover(&live, supplied).unwrap(),
                RecoveryOutcome::Settled,
                "{phase:?}"
            );
            assert_eq!(
                recover(&live, supplied).unwrap(),
                RecoveryOutcome::Settled,
                "{phase:?} repeat"
            );
            assert!(key::verify_copy_keyed(&live, Some(supplied)).is_ok());
        }
    }

    #[test]
    fn crash_after_rollback_rename_uses_persisted_recovery_identity() {
        let files = Files::new();
        let live = files.live();
        let old = secret("old");
        let new = secret("new");
        create(&live, Some(&old));
        let mut operation =
            prepare(&live, &live, Some(&old), Some(&old), &new, "rotation").unwrap();
        operation.install(&new).unwrap();
        advance(&mut operation.marker, MarkerPhase::RollingBack).unwrap();
        key::atomic_replace(operation.recovery_path(), &live).unwrap();
        assert!(!operation.recovery_path().exists());
        assert_eq!(recover(&live, &old).unwrap(), RecoveryOutcome::Settled);
    }

    #[test]
    fn mismatched_phase_and_generation_remains_in_recovery() {
        let files = Files::new();
        let live = files.live();
        let old = secret("old");
        let new = secret("new");
        create(&live, Some(&old));
        let mut operation =
            prepare(&live, &live, Some(&old), Some(&old), &new, "rotation").unwrap();
        assert!(operation.complete().is_err());
        operation = PreparedReplacement {
            marker: key::read_marker(&live).unwrap().unwrap(),
        };
        advance(&mut operation.marker, MarkerPhase::Swapped).unwrap();
        assert!(recover(&live, &old).is_err());
        assert!(key::read_marker(&live).unwrap().is_some());
    }
    #[test]
    fn export_and_pre_erase_copy_use_current_key_and_preserve_destinations_on_error() {
        let files = Files::new();
        let live = files.live();
        let current = secret("current copy key");
        create(&live, Some(&current));
        let db = Db::open_keyed(live.to_str().unwrap(), Some(&current)).unwrap();
        let export = files.0.join("export.sqlite");
        std::fs::write(&export, b"existing export stays until replacement").unwrap();
        export_connection(db.conn(), &export, Some(&current), true).unwrap();
        assert!(key::verify_copy_keyed(&export, Some(&current)).is_ok());
        assert!(key::verify_copy_keyed(&export, None).is_err());
        let hash = key::file_hash_hex(&export).unwrap();
        assert!(export_connection(db.conn(), &export, Some(&current), false).is_err());
        assert_eq!(key::file_hash_hex(&export).unwrap(), hash);
        assert!(export_connection(db.conn(), &live, Some(&current), true).is_err());
        let safety = files.0.join("safety.sqlite");
        export_connection(db.conn(), &safety, Some(&current), false).unwrap();
        assert_eq!(
            records(&safety, Some(&current)).unwrap(),
            records_connection(db.conn()).unwrap()
        );
    }
    #[test]
    fn new_credential_cannot_cancel_committed_rollback() {
        let files = Files::new();
        let live = files.live();
        let old = secret("old");
        let new = secret("new");
        create(&live, Some(&old));
        let mut operation =
            prepare(&live, &live, Some(&old), Some(&old), &new, "rotation").unwrap();
        operation.install(&new).unwrap();
        advance(&mut operation.marker, MarkerPhase::RollingBack).unwrap();
        assert!(recover(&live, &new).is_err());
        assert_eq!(
            key::read_marker(&live).unwrap().unwrap().phase,
            MarkerPhase::RollingBack
        );
        assert_eq!(recover(&live, &old).unwrap(), RecoveryOutcome::Settled);
        assert!(key::verify_copy_keyed(&live, Some(&old)).is_ok());
    }
    #[test]
    fn post_cleanup_runtime_rollback_rebases_exact_generation_before_intent() {
        let files = Files::new();
        let live = files.live();
        let old = secret("old");
        let next = secret("next");
        create(&live, Some(&old));
        let mut prepared =
            prepare(&live, &live, Some(&old), Some(&old), &next, "rotation").unwrap();
        prepared.install(&next).unwrap();
        let db = Db::reopen_verified(live.to_str().unwrap(), &next).unwrap();
        prepared.complete().unwrap();
        db.activate_wal().unwrap();
        drop(db);
        prepared.reconcile_before_rollback(&next).unwrap();
        advance(&mut prepared.marker, MarkerPhase::RollingBack).unwrap();
        assert_eq!(recover(&live, &old).unwrap(), RecoveryOutcome::Settled);
        assert!(key::verify_copy_keyed(&live, Some(&old)).is_ok());
    }

    #[test]
    fn first_run_schema_stays_locked_through_each_creation_phase() {
        for phase in [
            MarkerPhase::Reserved,
            MarkerPhase::Copying,
            MarkerPhase::Verifying,
            MarkerPhase::Verified,
            MarkerPhase::Swapping,
        ] {
            let files = Files::new();
            let live = files.live();
            let next = secret("first run");
            let mut prepared = prepare_create(&live, &next).unwrap();
            advance(&mut prepared.marker, phase).unwrap();
            assert!(!live.exists());
            let outcome = recover(&live, &next).unwrap();
            if matches!(
                phase,
                MarkerPhase::Reserved | MarkerPhase::Copying | MarkerPhase::Verifying
            ) {
                assert_eq!(outcome, RecoveryOutcome::RetryCreate);
                assert!(!live.exists());
            } else {
                assert_eq!(outcome, RecoveryOutcome::Settled);
                assert_eq!(key::verify_copy_keyed(&live, Some(&next)).unwrap().1, 0);
            }
        }
    }
    #[test]
    fn conversion_retains_the_original_inode_through_verified_application_reopen() {
        let files = Files::new();
        let live = files.live();
        let next = secret("conversion hold key");
        create(&live, None); // LEGACY-PLAINTEXT-FIXTURE: pre-existing source inode.
        let original = key::file_hash_hex(&live).unwrap();
        let mut prepared = prepare(&live, &live, None, None, &next, "conversion").unwrap();
        let hold = PathBuf::from(prepared.marker.plaintext_hold_path.clone().unwrap());
        assert!(!hold.exists());
        retain_plaintext_original(&prepared.marker).unwrap(); // Crash boundary before swap intent.
        assert!(same_file::is_same_file(&live, &hold).unwrap());
        prepared.install(&next).unwrap();
        assert_eq!(key::file_hash_hex(&hold).unwrap(), original);
        let db = Db::reopen_verified(live.to_str().unwrap(), &next).unwrap();
        assert!(hold.exists());
        drop(db); // Crash boundary after application reopen, before plaintext cleanup.
        assert_eq!(recover(&live, &next).unwrap(), RecoveryOutcome::Settled);
        assert!(!hold.exists());
        assert_eq!(recover(&live, &next).unwrap(), RecoveryOutcome::Settled);
    }

    #[test]
    fn failed_plaintext_cleanup_never_clears_the_operation_marker_or_reports_completion() {
        let files = Files::new();
        let live = files.live();
        let next = secret("cleanup key");
        create(&live, None); // LEGACY-PLAINTEXT-FIXTURE.
        let mut prepared = prepare(&live, &live, None, None, &next, "conversion").unwrap();
        prepared.install(&next).unwrap();
        let hold = PathBuf::from(prepared.marker.plaintext_hold_path.clone().unwrap());
        let db = Db::reopen_verified(live.to_str().unwrap(), &next).unwrap();
        drop(db);
        assert!(prepared
            .complete_with_unlink(|_| Err(std::io::Error::from(
                std::io::ErrorKind::PermissionDenied
            )))
            .is_err());
        assert!(hold.exists());
        assert!(key::read_marker(&live).unwrap().is_some());
        prepared.complete().unwrap();
        assert!(!hold.exists());
        assert!(key::read_marker(&live).unwrap().is_none());
    }

    #[test]
    fn recovery_repeats_plaintext_cleanup_after_a_crash_before_marker_removal() {
        let files = Files::new();
        let live = files.live();
        let next = secret("cleanup boundary");
        create(&live, None); // LEGACY-PLAINTEXT-FIXTURE.
        let mut prepared = prepare(&live, &live, None, None, &next, "conversion").unwrap();
        prepared.install(&next).unwrap();
        reopen_before_cleanup(&prepared.marker, &next).unwrap();
        cleanup_plaintext_original(&prepared.marker).unwrap(); // Crash before marker clear.
        assert!(key::read_marker(&live).unwrap().is_some());
        assert_eq!(recover(&live, &next).unwrap(), RecoveryOutcome::Settled);
        assert!(key::read_marker(&live).unwrap().is_none());
    }
}
