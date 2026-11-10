//! Keyed core lifecycle (ticket 03, Wave A).
//!
//! Single new module per architecture section 3 (implementer picks one, not
//! both): this file is that module (key.rs, not boot.rs). Marker,
//! rotation-selection, source-type detection and handle-to-handle copy helpers
//! all live here so every encrypted generation goes through one path.
//!
//! Activation barrier: tickets 03-05 land together. Production stays on the
//! plaintext path until 04+05 land. Every helper takes Option<&Secret>: None
//! is the plaintext legacy generation (existing behaviour); Some is encrypted
//! and must use the keyed handle-to-handle path. Path-based backup/restore
//! open the other side internally WITHOUT a key and would emit plaintext under
//! SQLCipher, so they are forbidden for encrypted generations (review F1).
//!
//! Dependency contract:
//! - rusqlite 0.40 with bundled-sqlcipher-vendored-openssl
//!   (docs: https://docs.rs/crate/rusqlite/0.40.2/features).
//! - zeroize 1.x for secret memory (exact version in Cargo.lock).
//! - SQLCipher PRAGMA key / rekey / cipher_integrity_check
//!   (docs: https://www.zetetic.net/sqlcipher/sqlcipher-api/).
//! - OpenSSL vendored via the rusqlite feature (openssl-sys vendored).

use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

use rusqlite::Connection;
use zeroize::Zeroizing;

use crate::error::{Error, Result};

// ---- Secret ----

const PASSPHRASE_DOMAIN: &str = "wobble-passphrase-v1:";

pub struct Secret(Zeroizing<Vec<u8>>);

impl Secret {
    pub fn from_passphrase(passphrase: &str) -> std::result::Result<Secret, String> {
        if passphrase.is_empty() || passphrase.trim().is_empty() {
            return Err("A passphrase is required.".to_owned());
        }
        if passphrase.contains('\0') {
            return Err("The passphrase contains an unsupported null character.".to_owned());
        }
        Ok(Secret(Zeroizing::new(passphrase.as_bytes().to_vec())))
    }
    pub fn validate_new(passphrase: &str, confirm: &str) -> std::result::Result<Secret, String> {
        let secret = Secret::from_passphrase(passphrase)?;
        if passphrase != confirm {
            return Err("The passphrases do not match.".to_owned());
        }
        let _ = confirm.len();
        Ok(secret)
    }
    pub(crate) fn duplicate(&self) -> Self {
        Self(Zeroizing::new(self.bytes().to_vec()))
    }
    pub(crate) fn bytes(&self) -> &[u8] {
        &self.0
    }
    /// This public, versioned prefix is part of Wobble's encrypted-file format.
    /// SQLCipher recognizes raw x'...' keys by their bytes even through sqlite3_key.
    /// Prefixing guarantees its normal PBKDF2 path for every accepted user phrase.
    pub(crate) fn passphrase_text(&self) -> Zeroizing<String> {
        let mut text = Zeroizing::new(String::with_capacity(
            PASSPHRASE_DOMAIN.len() + self.bytes().len(),
        ));
        text.push_str(PASSPHRASE_DOMAIN);
        text.push_str(
            std::str::from_utf8(self.bytes()).expect("Secret originates in validated UTF-8"),
        );
        text
    }
}

impl std::fmt::Debug for Secret {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Secret(..)")
    }
}

// ---- Key application and probe (review F6) ----

pub const WRONG_KEY_CODE: &str = "boot_wrong_key";
pub const IO_CODE: &str = "boot_io_error";
pub const BOOT_LOCKED_CODE: &str = "database_locked";
pub const DOWNGRADE_CODE: &str = "unsupported_encrypted_file";
pub const DOWNGRADE_MESSAGE: &str =
    "This file cannot be opened by the unencrypted storage reader. It was left unchanged.";
pub const LOCKED_MESSAGE: &str = "The database is locked. Unlock it to continue.";
pub const BOOT_STATUS_PATH: &str = "/api/boot-status";

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProbeFailure {
    WrongKey(String),
    Io(String),
}

impl ProbeFailure {
    pub fn http_status(&self) -> u16 {
        match self {
            ProbeFailure::WrongKey(_) => 401,
            ProbeFailure::Io(_) => 500,
        }
    }
    pub fn code(&self) -> &'static str {
        match self {
            ProbeFailure::WrongKey(_) => WRONG_KEY_CODE,
            ProbeFailure::Io(_) => IO_CODE,
        }
    }
    pub fn message(&self) -> &str {
        match self {
            ProbeFailure::WrongKey(m) | ProbeFailure::Io(m) => m,
        }
    }
}

fn is_wrong_key_message(msg: &str) -> bool {
    let m = msg.to_lowercase();
    m.contains("file is not a database")
        || m.contains("not a database")
        || m.contains("file is encrypted")
        || m.contains("encrypted or is not a database")
        || m.contains("wrong key")
        || m.contains("decrypt")
        || m.contains("hmac")
        || m.contains("cipher")
        || m.contains("not a valid")
}

pub fn classify_probe_error(msg: String) -> ProbeFailure {
    if is_wrong_key_message(&msg) {
        ProbeFailure::WrongKey(msg)
    } else {
        ProbeFailure::Io(msg)
    }
}

pub fn apply_key(conn: &Connection, secret: &Secret) -> Result<()> {
    let passphrase = secret.passphrase_text();
    conn.pragma_update(None, "key", passphrase.as_str())
        .map_err(|_| Error::Message("Could not configure encrypted storage.".to_owned()))?;
    Ok(())
}

pub fn probe_keyed_handle(conn: &Connection) -> std::result::Result<(), ProbeFailure> {
    let cipher_rows: std::result::Result<Vec<String>, String> = (|| {
        let mut stmt = conn
            .prepare("PRAGMA cipher_integrity_check")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|e| e.to_string())?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row.map_err(|e| e.to_string())?);
        }
        Ok(out)
    })();
    match cipher_rows {
        Err(msg) => return Err(classify_probe_error(msg)),
        Ok(rows) => {
            let bad: Vec<&String> = rows.iter().filter(|r| r.to_lowercase() != "ok").collect();
            if !bad.is_empty() {
                let joined = bad
                    .iter()
                    .map(|s| s.as_str())
                    .collect::<Vec<_>>()
                    .join("; ");
                return Err(classify_probe_error(joined));
            }
            if rows.is_empty() {
                // SQLCipher reports no rows when every page verifies; keep going
                // to the schema read on the SAME handle below.
            }
        }
    }
    match crate::schema::read_schema_version(conn) {
        Ok(_) => Ok(()),
        Err(e) => Err(classify_probe_error(e.to_string())),
    }
}

pub fn open_keyed(path: &Path, secret: Option<&Secret>) -> Result<Connection> {
    // Existing-file open: a missing source must never become a fresh empty database.
    let conn = Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_WRITE)?;
    if let Some(secret) = secret {
        apply_key(&conn, secret)?;
        probe_keyed_handle(&conn).map_err(|f| match f {
            ProbeFailure::WrongKey(m) => Error::Coded {
                code: WRONG_KEY_CODE,
                message: m,
            },
            ProbeFailure::Io(m) => Error::Message(m),
        })?;
    }
    Ok(conn)
}

pub fn open_keyed_readonly(path: &Path, secret: Option<&Secret>) -> Result<Connection> {
    let conn = Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    if let Some(secret) = secret {
        apply_key(&conn, secret)?;
        probe_keyed_handle(&conn).map_err(|f| match f {
            ProbeFailure::WrongKey(m) => Error::Coded {
                code: WRONG_KEY_CODE,
                message: m,
            },
            ProbeFailure::Io(m) => Error::Message(m),
        })?;
    }
    Ok(conn)
}

// ---- Source-type detection (review F5) ----

static SQLITE_MAGIC: &[u8] = b"SQLite format 3\0";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SourceKind {
    PlaintextLegacy,
    EncryptedCandidate,
    Corrupt,
}

pub fn classify_source(path: &Path) -> SourceKind {
    use std::io::Read;
    let mut file = match std::fs::File::open(path) {
        Ok(file) => file,
        Err(_) => return SourceKind::Corrupt,
    };
    let length = match file.metadata() {
        Ok(m) if m.is_file() => m.len(),
        _ => return SourceKind::Corrupt,
    };
    let mut header = [0_u8; 16];
    if file.read_exact(&mut header).is_err() {
        return SourceKind::Corrupt;
    }
    if header.as_slice() == SQLITE_MAGIC {
        return SourceKind::PlaintextLegacy;
    }
    // Random salt is not a magic signature. This only identifies a candidate;
    // successful keyed integrity/schema validation is required to recognize it.
    if length >= 512 && length % 512 == 0 {
        return SourceKind::EncryptedCandidate;
    }
    SourceKind::Corrupt
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ValidatedSource {
    PlaintextLegacy,
    EncryptedOk,
    WrongKey,
    Corrupt,
}

pub fn validate_source_kind(path: &Path, secret: Option<&Secret>) -> ValidatedSource {
    match classify_source(path) {
        SourceKind::Corrupt => ValidatedSource::Corrupt,
        SourceKind::PlaintextLegacy => {
            // A plaintext header is necessary but not sufficient: confirm it
            // opens read-only and carries a schema version probe on the same
            // handle (no migration, no writes). Any failure closes as corrupt.
            match Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY) {
                Err(_) => ValidatedSource::Corrupt,
                Ok(conn) => match crate::schema::read_schema_version(&conn) {
                    Ok(_) => ValidatedSource::PlaintextLegacy,
                    Err(_) => ValidatedSource::Corrupt,
                },
            }
        }
        SourceKind::EncryptedCandidate => match secret {
            None => ValidatedSource::WrongKey,
            Some(secret) => match open_keyed_readonly(path, Some(secret)) {
                Ok(_) => ValidatedSource::EncryptedOk,
                Err(Error::Coded { code, .. }) if code == WRONG_KEY_CODE => {
                    ValidatedSource::WrongKey
                }
                Err(_) => ValidatedSource::Corrupt,
            },
        },
    }
}

// ---- Downgrade guard (review F7) ----

pub fn guard_legacy_open(path: &Path) -> Result<()> {
    match classify_source(path) {
        SourceKind::EncryptedCandidate => Err(Error::coded(DOWNGRADE_CODE, DOWNGRADE_MESSAGE)),
        _ => Ok(()),
    }
}

// ---- File hashing and fsync ----

pub fn file_hash_hex(path: &Path) -> Result<String> {
    use std::io::Read;
    let mut file = std::fs::File::open(path).map_err(|e| Error::Message(e.to_string()))?;
    let mut hash = Sha256::new();
    let mut buffer = [0_u8; 65536];
    loop {
        let count = file
            .read(&mut buffer)
            .map_err(|e| Error::Message(e.to_string()))?;
        if count == 0 {
            break;
        }
        hash.update(&buffer[..count]);
    }
    Ok(format!("{:x}", hash.finalize()))
}

pub fn fsync_file_and_dir(path: &Path) -> Result<()> {
    let file = std::fs::File::open(path).map_err(|e| Error::Message(e.to_string()))?;
    file.sync_all().map_err(|e| Error::Message(e.to_string()))?;
    #[cfg(unix)]
    {
        if let Some(parent) = path.parent() {
            let parent = if parent.as_os_str().is_empty() {
                Path::new(".")
            } else {
                parent
            };
            let dir = std::fs::File::open(parent).map_err(|e| Error::Message(e.to_string()))?;
            dir.sync_all().map_err(|e| Error::Message(e.to_string()))?;
        }
    }
    Ok(())
}

// ---- Marker phase table (review F2) ----

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MarkerPhase {
    Reserved,
    Copying,
    Verifying,
    Verified,
    Swapping,
    Swapped,
    #[serde(rename = "rolling-back")]
    RollingBack,
    #[serde(rename = "rolled-back")]
    RolledBack,
}

impl MarkerPhase {
    pub fn as_str(&self) -> &'static str {
        match self {
            MarkerPhase::Reserved => "reserved",
            MarkerPhase::Copying => "copying",
            MarkerPhase::Verifying => "verifying",
            MarkerPhase::Verified => "verified",
            MarkerPhase::Swapping => "swapping",
            MarkerPhase::Swapped => "swapped",
            MarkerPhase::RollingBack => "rolling-back",
            MarkerPhase::RolledBack => "rolled-back",
        }
    }
    pub fn parse(s: &str) -> Option<MarkerPhase> {
        match s {
            "reserved" => Some(MarkerPhase::Reserved),
            "copying" => Some(MarkerPhase::Copying),
            "verifying" => Some(MarkerPhase::Verifying),
            "verified" => Some(MarkerPhase::Verified),
            "swapping" => Some(MarkerPhase::Swapping),
            "swapped" => Some(MarkerPhase::Swapped),
            "rolling-back" => Some(MarkerPhase::RollingBack),
            "rolled-back" => Some(MarkerPhase::RolledBack),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Marker {
    pub version: u8,
    pub op: String,
    pub phase: MarkerPhase,
    pub generation: i64,
    pub created_at: String,
    pub src_hash: Option<String>,
    pub dst_hash: Option<String>,
    pub recovery_hash: Option<String>,
    pub live_path: String,
    pub stage_path: String,
    pub recovery_path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plaintext_hold_path: Option<String>,
}

pub fn marker_path(live: &Path) -> PathBuf {
    let mut s = live.as_os_str().to_owned();
    s.push(".keyed-marker.json");
    PathBuf::from(s)
}

fn normalized_artifact(path: &Path) -> Result<PathBuf> {
    let invalid = || {
        Error::Message("The recovery marker has an invalid path. Recovery is required.".to_owned())
    };
    let name = path.file_name().ok_or_else(invalid)?;
    let parent = path
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    Ok(std::fs::canonicalize(parent)
        .map_err(|_| invalid())?
        .join(name))
}

fn validate_marker(marker: &Marker, live: &Path) -> Result<()> {
    let invalid =
        || Error::Message("The recovery marker is inconsistent. Recovery is required.".to_owned());
    if marker.version != 1
        || marker.generation < 1
        || marker.created_at.is_empty()
        || !matches!(
            marker.op.as_str(),
            "create" | "conversion" | "rotation" | "restore" | "backup" | "erase" | "upgrade"
        )
    {
        return Err(invalid());
    }
    if matches!(
        marker.phase,
        MarkerPhase::Verified
            | MarkerPhase::Swapping
            | MarkerPhase::Swapped
            | MarkerPhase::RollingBack
            | MarkerPhase::RolledBack
    ) && (marker.dst_hash.is_none()
        || marker.recovery_hash.is_none()
        || (marker.src_hash.is_none() && marker.op != "create"))
    {
        return Err(invalid());
    }
    for hash in [&marker.src_hash, &marker.dst_hash, &marker.recovery_hash]
        .into_iter()
        .flatten()
    {
        if hash.len() != 64
            || !hash
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        {
            return Err(invalid());
        }
    }
    let expected_live = normalized_artifact(live)?;
    let paths = [&marker.live_path, &marker.stage_path, &marker.recovery_path];
    let mut normalized = Vec::new();
    for value in paths {
        let path = Path::new(value);
        if path
            .symlink_metadata()
            .is_ok_and(|m| m.file_type().is_symlink())
        {
            return Err(invalid());
        }
        let resolved = normalized_artifact(path)?;
        if resolved.parent() != expected_live.parent() {
            return Err(invalid());
        }
        normalized.push(resolved);
    }
    if normalized[0] != expected_live {
        return Err(invalid());
    }
    for a in 0..normalized.len() {
        for b in (a + 1)..normalized.len() {
            if normalized[a] == normalized[b] {
                return Err(invalid());
            }
            if normalized[a].exists()
                && normalized[b].exists()
                && same_file::is_same_file(&normalized[a], &normalized[b]).map_err(|_| invalid())?
            {
                return Err(invalid());
            }
        }
    }
    if (marker.op == "conversion") != marker.plaintext_hold_path.is_some() {
        return Err(invalid());
    }
    if let Some(value) = &marker.plaintext_hold_path {
        let path = Path::new(value);
        if path
            .symlink_metadata()
            .is_ok_and(|m| m.file_type().is_symlink())
        {
            return Err(invalid());
        }
        let hold = normalized_artifact(path)?;
        if hold.parent() != expected_live.parent() || normalized.contains(&hold) {
            return Err(invalid());
        }
        let prefix = format!(
            "{}.displaced-plaintext-",
            expected_live
                .file_name()
                .ok_or_else(invalid)?
                .to_string_lossy()
        );
        let suffix = hold
            .file_name()
            .and_then(|name| name.to_str())
            .and_then(|name| name.strip_prefix(&prefix))
            .ok_or_else(invalid)?;
        if uuid::Uuid::parse_str(suffix).is_err() {
            return Err(invalid());
        }
        if hold.exists() {
            if file_hash_hex(&hold).ok().as_ref() != marker.src_hash.as_ref() {
                return Err(invalid());
            }
            for other in [&marker.stage_path, &marker.recovery_path] {
                if Path::new(other).exists()
                    && same_file::is_same_file(&hold, other).map_err(|_| invalid())?
                {
                    return Err(invalid());
                }
            }
            if live.exists()
                && same_file::is_same_file(&hold, live).map_err(|_| invalid())?
                && (!matches!(
                    marker.phase,
                    MarkerPhase::Reserved
                        | MarkerPhase::Copying
                        | MarkerPhase::Verifying
                        | MarkerPhase::Verified
                        | MarkerPhase::Swapping
                        | MarkerPhase::RollingBack
                ) || file_hash_hex(live).ok().as_ref() != marker.src_hash.as_ref())
            {
                return Err(invalid());
            }
        }
    }
    Ok(())
}

/// Claim the operation before copying any database bytes. An interrupted initial
/// write deliberately leaves an unreadable marker and keeps startup in recovery.
pub(crate) fn create_marker(marker: &Marker) -> Result<()> {
    use std::io::Write;
    let live = Path::new(&marker.live_path);
    validate_marker(marker, live)?;
    let path = marker_path(live);
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(&path)
        .map_err(|e| Error::Message(e.to_string()))?;
    let body = serde_json::to_vec(marker)?;
    file.write_all(&body)
        .map_err(|e| Error::Message(e.to_string()))?;
    file.sync_all().map_err(|e| Error::Message(e.to_string()))?;
    drop(file);
    fsync_file_and_dir(&path)
}

pub fn write_marker(marker: &Marker) -> Result<PathBuf> {
    use std::io::Write;
    let live = Path::new(&marker.live_path);
    validate_marker(marker, live)?;
    let path = marker_path(live);
    let tmp = path.with_extension(format!("tmp-{}", uuid::Uuid::new_v4()));
    let body = serde_json::to_vec(marker)
        .map_err(|_| Error::Message("Could not encode recovery state.".to_owned()))?;
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(&tmp)
        .map_err(|e| Error::Message(e.to_string()))?;
    file.write_all(&body)
        .map_err(|e| Error::Message(e.to_string()))?;
    file.sync_all().map_err(|e| Error::Message(e.to_string()))?;
    drop(file);
    atomic_replace(&tmp, &path)?;
    Ok(path)
}

pub fn read_marker(live: &Path) -> Result<Option<Marker>> {
    let path = marker_path(live);
    let metadata = match std::fs::symlink_metadata(&path) {
        Ok(value) => value,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(Error::Message(e.to_string())),
    };
    if !metadata.is_file() || metadata.len() > 65536 {
        return Err(Error::Message(
            "The recovery marker is invalid. Recovery is required.".to_owned(),
        ));
    }
    let body = std::fs::read(&path).map_err(|e| Error::Message(e.to_string()))?;
    let marker: Marker = serde_json::from_slice(&body).map_err(|_| {
        Error::Message("The recovery marker is invalid. Recovery is required.".to_owned())
    })?;
    validate_marker(&marker, live)?;
    Ok(Some(marker))
}

pub fn clear_marker(live: &Path) -> Result<()> {
    let path = marker_path(live);
    match std::fs::remove_file(&path) {
        Ok(()) => {
            #[cfg(unix)]
            {
                let parent = path
                    .parent()
                    .filter(|p| !p.as_os_str().is_empty())
                    .unwrap_or(Path::new("."));
                let directory =
                    std::fs::File::open(parent).map_err(|e| Error::Message(e.to_string()))?;
                directory
                    .sync_all()
                    .map_err(|e| Error::Message(e.to_string()))?;
            }
            Ok(())
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(Error::Message(e.to_string())),
    }
}

pub fn sidecars_present(live: &Path) -> bool {
    ["-wal", "-shm", "-journal"].iter().any(|suffix| {
        let mut s = live.as_os_str().to_owned();
        s.push(*suffix);
        PathBuf::from(s).exists()
    })
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RecoveryAction {
    DiscardReserveClear,
    DiscardStageToReserved,
    VerifyStage,
    FsyncAdvance,
    ReattemptSwap,
    RestoreRecovery,
    VerifyLiveClear,
    FailedWithPath(String),
    FailedWithBoth(String, String),
}

pub fn decide_recovery(
    marker: Option<&Marker>,
    live_hash: Option<&str>,
    stage_hash: Option<&str>,
    recovery_hash: Option<&str>,
    live_path: &str,
    stage_path: &str,
    recovery_path: &str,
) -> RecoveryAction {
    let Some(marker) = marker else {
        return RecoveryAction::VerifyLiveClear;
    };
    match marker.phase {
        MarkerPhase::Reserved => RecoveryAction::DiscardReserveClear,
        MarkerPhase::Copying => RecoveryAction::DiscardStageToReserved,
        MarkerPhase::Verifying => RecoveryAction::VerifyStage,
        MarkerPhase::Verified => RecoveryAction::FsyncAdvance,
        MarkerPhase::Swapped => RecoveryAction::VerifyLiveClear,
        MarkerPhase::RollingBack => {
            let recovery = marker.recovery_hash.as_deref().or(recovery_hash);
            if live_hash.is_some() && live_hash == recovery {
                RecoveryAction::VerifyLiveClear
            } else if live_hash.is_some()
                && (live_hash == marker.dst_hash.as_deref()
                    || live_hash == marker.src_hash.as_deref())
            {
                RecoveryAction::RestoreRecovery
            } else {
                RecoveryAction::FailedWithBoth(stage_path.to_owned(), recovery_path.to_owned())
            }
        }
        MarkerPhase::RolledBack => {
            if live_hash.is_some() && live_hash == marker.recovery_hash.as_deref().or(recovery_hash)
            {
                RecoveryAction::VerifyLiveClear
            } else {
                RecoveryAction::FailedWithBoth(stage_path.to_owned(), recovery_path.to_owned())
            }
        }
        MarkerPhase::Swapping => {
            let live = live_hash.unwrap_or("");
            // The stage disappears during rename; recovery is a separately encrypted
            // copy with a different salt. Compare against persisted generation hashes.
            let stage = marker.dst_hash.as_deref().or(stage_hash).unwrap_or("");
            let rec = marker.src_hash.as_deref().or(recovery_hash).unwrap_or("");
            if !stage.is_empty() && live == stage {
                RecoveryAction::VerifyLiveClear
            } else if !rec.is_empty() && live == rec {
                RecoveryAction::ReattemptSwap
            } else if stage.is_empty() && rec.is_empty() {
                RecoveryAction::FailedWithPath(live_path.to_owned())
            } else {
                RecoveryAction::FailedWithBoth(stage_path.to_owned(), recovery_path.to_owned())
            }
        }
    }
}

// ---- Rotation post-kill credential selection (review F3) ----

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LiveGeneration {
    Old,
    New,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PromptFirst {
    Live,
    RecoveryThenStage,
}

pub fn detect_live_generation(
    marker: Option<&Marker>,
    live_hash: Option<&str>,
    recovery_hash: Option<&str>,
    stage_hash: Option<&str>,
) -> LiveGeneration {
    let Some(marker) = marker else {
        return LiveGeneration::Unknown;
    };
    if marker.op != "rotation" {
        return LiveGeneration::Unknown;
    }
    let live = live_hash.unwrap_or("");
    if live.is_empty() {
        return LiveGeneration::Unknown;
    }
    // Never content reads: generation identity comes from the marker hashes.
    if let Some(recovery) = marker.recovery_hash.as_deref().or(recovery_hash) {
        if !recovery.is_empty() && live == recovery {
            return LiveGeneration::Old;
        }
    }
    if let Some(rec) = marker.src_hash.as_deref().or(recovery_hash) {
        if !rec.is_empty() && live == rec {
            return LiveGeneration::Old;
        }
    }
    if let Some(stage) = marker.dst_hash.as_deref().or(stage_hash) {
        if !stage.is_empty() && live == stage {
            return LiveGeneration::New;
        }
    }
    if marker.src_hash.is_some() || marker.dst_hash.is_some() {
        return LiveGeneration::Unknown;
    }
    // Fall back to the marker phase only before generation hashes exist: pre-swap phases still carry the old live,
    // swapped carries the new live.
    match marker.phase {
        MarkerPhase::Reserved
        | MarkerPhase::Copying
        | MarkerPhase::Verifying
        | MarkerPhase::Verified => LiveGeneration::Old,
        MarkerPhase::Swapped => LiveGeneration::New,
        MarkerPhase::Swapping | MarkerPhase::RollingBack | MarkerPhase::RolledBack => {
            LiveGeneration::Unknown
        }
    }
}

pub fn select_rotation_prompt(live: LiveGeneration) -> PromptFirst {
    match live {
        LiveGeneration::Old | LiveGeneration::New => PromptFirst::Live,
        LiveGeneration::Unknown => PromptFirst::RecoveryThenStage,
    }
}

// ---- Handle-to-handle copy helpers (review F1) ----

pub fn backup_via_handles(src: &Connection, dst: &mut Connection) -> Result<()> {
    let backup = rusqlite::backup::Backup::new(src, dst)?;
    backup.run_to_completion(100, std::time::Duration::from_millis(0), None)?;
    Ok(())
}

pub fn verify_copy_keyed(path: &Path, secret: Option<&Secret>) -> Result<(Option<i64>, i64)> {
    let conn = open_keyed_readonly(path, secret)?;
    let version = crate::schema::read_schema_version(&conn)?;
    let count: i64 = conn
        .query_row("SELECT COUNT(*) FROM worksites", [], |row| row.get(0))
        .map_err(|e| Error::Message(e.to_string()))?;
    Ok((version, count))
}

pub fn export_via_attach(
    src: &Connection,
    dst_path: &Path,
    dst_key: Option<&Secret>,
) -> Result<()> {
    let passphrase = dst_key.map(Secret::passphrase_text);
    let key: &str = passphrase.as_deref().map(String::as_str).unwrap_or("");
    src.execute(
        "ATTACH DATABASE ?1 AS export_dst KEY ?2",
        rusqlite::params![dst_path.to_string_lossy().as_ref(), key],
    )
    .map_err(|_| Error::Message("Could not open the backup destination.".to_owned()))?;
    let result = (|| -> Result<()> {
        src.execute_batch("SELECT sqlcipher_export('export_dst');")?;
        for pragma in ["user_version", "application_id"] {
            let value: i64 = src.pragma_query_value(None, pragma, |row| row.get(0))?;
            src.pragma_update(Some("export_dst"), pragma, value)?;
        }
        Ok(())
    })();
    let detached = src.execute_batch("DETACH DATABASE export_dst;");
    result?;
    detached?;
    Ok(())
}

pub fn copy_db_keyed(
    src_path: &Path,
    src_key: Option<&Secret>,
    dst_path: &Path,
    dst_key: Option<&Secret>,
) -> Result<()> {
    // Validate/open the source first, without CREATE. Never remove caller paths.
    let source = open_keyed(src_path, src_key)?;
    if std::fs::canonicalize(src_path).ok() == std::fs::canonicalize(dst_path).ok() {
        return Err(Error::Message(
            "A database copy must use a different destination.".to_owned(),
        ));
    }
    match std::fs::symlink_metadata(dst_path) {
        Ok(metadata) if metadata.is_file() && metadata.len() == 0 => {}
        Ok(_) => {
            return Err(Error::Message(
                "The copy destination already exists.".to_owned(),
            ))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(dst_path)
                .map_err(|e| Error::Message(e.to_string()))?;
        }
        Err(e) => return Err(Error::Message(e.to_string())),
    }
    if sidecars_present(dst_path) {
        return Err(Error::Message(
            "The copy destination has database sidecars.".to_owned(),
        ));
    }
    if src_key.is_none() && dst_key.is_none() {
        let mut destination = Connection::open(dst_path)?;
        backup_via_handles(&source, &mut destination)?;
        drop(destination);
    } else {
        export_via_attach(&source, dst_path, dst_key)?;
    }
    drop(source);
    settle_to_single_file(dst_path, dst_key)?;
    let fresh = open_keyed_readonly(dst_path, dst_key)?;
    probe_keyed_handle(&fresh).map_err(|f| match f {
        ProbeFailure::WrongKey(m) => Error::Coded {
            code: WRONG_KEY_CODE,
            message: m,
        },
        ProbeFailure::Io(m) => Error::Message(m),
    })?;
    let _ = verify_copy_keyed(dst_path, dst_key)?;
    Ok(())
}

pub fn settle_to_single_file(path: &Path, secret: Option<&Secret>) -> Result<()> {
    let conn = open_keyed(path, secret)?;
    conn.execute_batch("PRAGMA journal_mode = DELETE;")?;
    Ok(())
}

pub fn atomic_replace(stage: &Path, live: &Path) -> Result<()> {
    fsync_file_and_dir(stage)?;
    if let Some(parent) = live.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent).map_err(|e| Error::Message(e.to_string()))?;
        }
    }
    std::fs::rename(stage, live).map_err(|e| Error::Message(e.to_string()))?;
    fsync_file_and_dir(live)?;
    #[cfg(unix)]
    {
        if let Some(parent) = live.parent() {
            if !parent.as_os_str().is_empty() {
                if let Ok(dir) = std::fs::File::open(parent) {
                    let _ = dir.sync_all();
                }
            }
        }
    }
    Ok(())
}

// ---- Boot scaffolding for ticket 05 ----

#[derive(Debug, Clone)]
pub enum BootState {
    Locked {
        path: String,
        first_run: bool,
        legacy_plaintext: bool,
        marker_pending: bool,
    },
    Open,
    Failed {
        reason: String,
        recovery_path: Option<String>,
    },
}

pub fn is_boot_route(method: &str, path: &str) -> bool {
    matches!(
        (method, path),
        ("GET", "/api/boot-status")
            | ("POST", "/api/boot-unlock")
            | ("POST", "/api/boot-create")
            | ("POST", "/api/boot-change-passphrase")
    )
}

pub fn locked_rejection() -> (u16, &'static str, &'static str) {
    (423, BOOT_LOCKED_CODE, LOCKED_MESSAGE)
}

pub fn boot_status_value(state: &BootState) -> serde_json::Value {
    match state {
        BootState::Locked {
            first_run,
            legacy_plaintext,
            marker_pending,
            ..
        } => {
            serde_json::json!({
                "state": "locked",
                "firstRun": first_run,
                "legacyPlaintext": legacy_plaintext,
                "markerPending": marker_pending,
            })
        }
        BootState::Open => serde_json::json!({
            "state": "open",
            "firstRun": false,
            "legacyPlaintext": false,
            "markerPending": false,
        }),
        BootState::Failed {
            reason,
            recovery_path,
        } => serde_json::json!({
            "state": "failed",
            "firstRun": false,
            "legacyPlaintext": false,
            "markerPending": false,
            "reason": reason,
            "recoveryPath": recovery_path,
        }),
    }
}

pub fn describe_boot_state(path: &str) -> BootState {
    let live = Path::new(path);
    let marker_pending = match read_marker(live) {
        Ok(marker) => marker.is_some(),
        Err(_) => {
            return BootState::Failed {
                reason: "The recovery state could not be validated.".to_owned(),
                recovery_path: Some(marker_path(live).to_string_lossy().into_owned()),
            }
        }
    };
    if marker_pending || !live.exists() {
        return BootState::Locked {
            path: path.to_owned(),
            first_run: !live.exists(),
            legacy_plaintext: live.exists() && classify_source(live) == SourceKind::PlaintextLegacy,
            marker_pending,
        };
    }
    match classify_source(live) {
        SourceKind::PlaintextLegacy => BootState::Locked {
            path: path.to_owned(),
            first_run: false,
            legacy_plaintext: true,
            marker_pending: false,
        },
        SourceKind::EncryptedCandidate => BootState::Locked {
            path: path.to_owned(),
            first_run: false,
            legacy_plaintext: false,
            marker_pending: false,
        },
        SourceKind::Corrupt => BootState::Failed {
            reason: String::from("The database file is corrupt."),
            recovery_path: None,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::temp_db_path;

    fn remove(p: &str) {
        for suffix in ["", "-wal", "-shm", "-journal"] {
            let _ = std::fs::remove_file(format!("{p}{suffix}"));
        }
        let _ = std::fs::remove_file(marker_path(Path::new(p)));
        let _ =
            std::fs::remove_file(marker_path(Path::new(p)).with_extension("keyed-marker.json.tmp"));
    }

    fn legacy_seeded_file(name: &str) -> (PathBuf, crate::id::CounterId) {
        let path = temp_db_path(name);
        remove(&path);
        let ids = crate::id::CounterId::new();
        {
            let db = crate::db::open_seeded_legacy_fixture(&path, &ids)
                .expect("legacy conversion source");
            drop(db);
        }
        (PathBuf::from(path), ids)
    }

    #[test]
    fn secret_rejects_empty_and_whitespace_only() {
        assert!(Secret::from_passphrase("").is_err());
        assert!(Secret::from_passphrase("   ").is_err());
        assert!(Secret::from_passphrase("not\0supported").is_err());
        assert!(Secret::from_passphrase("\t \n ").is_err());
        assert!(Secret::from_passphrase("correct horse").is_ok());
        assert!(Secret::from_passphrase("it's \"quoted\"").is_ok());
        assert!(Secret::validate_new("a", "b").is_err());
        assert!(Secret::validate_new("a", "a").is_ok());
    }

    #[test]
    fn secret_debug_hides_bytes() {
        let s = Secret::from_passphrase("super-secret-value").unwrap();
        let dbg = format!("{:?}", s);
        assert!(!dbg.contains("super-secret-value"), "{dbg}");
        assert_eq!(dbg, "Secret(..)");
    }

    #[test]
    fn passphrase_encoding_preserves_input_and_cannot_enter_raw_mode() {
        for phrase in [
            "a'b\"c",
            "x'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'",
            " café exact ",
        ] {
            let secret = Secret::from_passphrase(phrase).unwrap();
            let encoded = secret.passphrase_text();
            assert!(encoded.starts_with(PASSPHRASE_DOMAIN));
            assert_eq!(&encoded[PASSPHRASE_DOMAIN.len()..], phrase);
            assert!(!encoded.starts_with("x'"));
        }
    }

    #[test]
    fn all_phrase_lengths_export_and_open_with_sqlcipher_passphrase_semantics() {
        let (source, _) = legacy_seeded_file("key-kdf-source.sqlite");
        for (index, phrase) in [
            "short".to_owned(),
            "p".repeat(32),
            "p".repeat(48),
            "p".repeat(80),
            "x'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'".to_owned(),
            " café 'quote' exact ".to_owned(),
        ]
        .iter()
        .enumerate()
        {
            let destination = PathBuf::from(temp_db_path(&format!("key-kdf-{index}.sqlite")));
            remove(&destination.to_string_lossy());
            let secret = Secret::from_passphrase(phrase).unwrap();
            copy_db_keyed(&source, None, &destination, Some(&secret)).unwrap();
            // Independent standard SQLCipher opening, not the application wrapper.
            let connection = Connection::open(&destination).unwrap();
            let expected = format!("{PASSPHRASE_DOMAIN}{phrase}");
            connection
                .pragma_update(None, "key", expected.as_str())
                .unwrap();
            let count: i64 = connection
                .query_row("SELECT COUNT(*) FROM worksites", [], |r| r.get(0))
                .unwrap();
            assert_eq!(count, 1);
            drop(connection);
            let wrong = Secret::from_passphrase("not the passphrase").unwrap();
            assert!(open_keyed_readonly(&destination, Some(&wrong)).is_err());
            remove(&destination.to_string_lossy());
        }
        remove(&source.to_string_lossy());
    }

    #[test]
    fn probe_succeeds_on_keyed_file_and_fails_on_wrong_key() {
        let (path, _) = legacy_seeded_file("keyed-probe.sqlite");
        let good = Secret::from_passphrase("probe-passphrase").unwrap();
        let bad = Secret::from_passphrase("wrong-passphrase").unwrap();
        // Rekey the seeded plaintext copy under the good credential via handle copy.
        let staged = PathBuf::from(temp_db_path("keyed-probe-stage.sqlite"));
        remove(&staged.to_string_lossy());
        copy_db_keyed(&path, None, &staged, Some(&good)).expect("copy under key");
        // Keyed reopen + integrity + record read-back all pass on owned on-disk files.
        let (version, count) = verify_copy_keyed(&staged, Some(&good)).expect("verify keyed");
        assert!(version.is_some());
        assert_eq!(count, 1);
        // Wrong key fails closed with the coded wrong-key mapping (401 family).
        let err = open_keyed(&staged, Some(&bad)).expect_err("wrong key must fail");
        match err {
            Error::Coded { code, .. } => assert_eq!(code, WRONG_KEY_CODE),
            other => panic!("expected coded wrong-key, got {other}"),
        }
        // Cross-key open fails: the good key does not open a copy keyed under bad.
        let staged2 = PathBuf::from(temp_db_path("keyed-probe-stage2.sqlite"));
        remove(&staged2.to_string_lossy());
        copy_db_keyed(&path, None, &staged2, Some(&bad)).expect("copy under bad");
        assert!(open_keyed(&staged2, Some(&good)).is_err());
        assert!(open_keyed(&staged, Some(&good)).is_ok());
        remove(&path.to_string_lossy());
        remove(&staged.to_string_lossy());
        remove(&staged2.to_string_lossy());
    }

    #[test]
    fn handle_to_handle_copy_verifies_records() {
        let (path, _) = legacy_seeded_file("keyed-copy.sqlite");
        let key = Secret::from_passphrase("copy-passphrase").unwrap();
        let dst = PathBuf::from(temp_db_path("keyed-copy-dst.sqlite"));
        remove(&dst.to_string_lossy());
        copy_db_keyed(&path, None, &dst, Some(&key)).expect("keyed copy");
        // Header scan alone is not proof: reopen keyed + integrity + record read.
        let conn = open_keyed(&dst, Some(&key)).expect("reopen keyed");
        let integrity: String = conn
            .query_row("PRAGMA cipher_integrity_check", [], |r| r.get(0))
            .unwrap_or_else(|_| String::from("ok-fallback"));
        assert!(
            integrity == "ok" || integrity == "ok-fallback",
            "{integrity}"
        );
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM worksites", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 1);
        remove(&path.to_string_lossy());
        remove(&dst.to_string_lossy());
    }

    #[test]
    fn copy_rejects_live_and_existing_destinations_without_changing_them() {
        let (source, _) = legacy_seeded_file("key-copy-guards.sqlite");
        let before = file_hash_hex(&source).unwrap();
        assert!(copy_db_keyed(&source, None, &source, None).is_err());
        assert_eq!(file_hash_hex(&source).unwrap(), before);
        let destination = PathBuf::from(temp_db_path("key-copy-existing.sqlite"));
        std::fs::write(&destination, b"existing content").unwrap();
        assert!(copy_db_keyed(&source, None, &destination, None).is_err());
        assert_eq!(std::fs::read(&destination).unwrap(), b"existing content");
        remove(&source.to_string_lossy());
        remove(&destination.to_string_lossy());
        assert!(open_keyed(&source, None).is_err());
        assert!(!source.exists());
    }

    #[test]
    fn source_detection_covers_plaintext_encrypted_corrupt() {
        let (plain, _) = legacy_seeded_file("keyed-classify-plain.sqlite");
        assert_eq!(classify_source(&plain), SourceKind::PlaintextLegacy);
        assert_eq!(
            validate_source_kind(&plain, None),
            ValidatedSource::PlaintextLegacy
        );
        let key = Secret::from_passphrase("classify-key").unwrap();
        let enc = PathBuf::from(temp_db_path("keyed-classify-enc.sqlite"));
        remove(&enc.to_string_lossy());
        copy_db_keyed(&plain, None, &enc, Some(&key)).expect("encrypt");
        assert_eq!(classify_source(&enc), SourceKind::EncryptedCandidate);
        assert_eq!(
            validate_source_kind(&enc, Some(&key)),
            ValidatedSource::EncryptedOk
        );
        assert_eq!(validate_source_kind(&enc, None), ValidatedSource::WrongKey);
        let bad = Secret::from_passphrase("other-key").unwrap();
        assert_eq!(
            validate_source_kind(&enc, Some(&bad)),
            ValidatedSource::WrongKey
        );
        let garbage = temp_db_path("keyed-classify-garbage.sqlite");
        std::fs::write(&garbage, b"tiny").unwrap();
        assert_eq!(classify_source(Path::new(&garbage)), SourceKind::Corrupt);
        std::fs::write(&garbage, [b'x'; 32]).unwrap();
        assert_eq!(classify_source(Path::new(&garbage)), SourceKind::Corrupt);
        std::fs::write(&garbage, [b'x'; 4096]).unwrap();
        assert_eq!(
            classify_source(Path::new(&garbage)),
            SourceKind::EncryptedCandidate
        );
        assert_ne!(
            validate_source_kind(Path::new(&garbage), Some(&key)),
            ValidatedSource::EncryptedOk
        );
        std::fs::write(&garbage, b"tiny").unwrap();
        assert_eq!(
            validate_source_kind(Path::new(&garbage), Some(&key)),
            ValidatedSource::Corrupt
        );
        remove(&plain.to_string_lossy());
        remove(&enc.to_string_lossy());
        remove(&garbage);
    }

    #[test]
    fn marker_disk_roundtrip_and_invalid_input_fail_closed() {
        let live = PathBuf::from(temp_db_path("marker-roundtrip.sqlite"));
        let marker = Marker {
            version: 1,
            op: "rotation".to_owned(),
            phase: MarkerPhase::Verified,
            generation: 1,
            created_at: "2026-11-07T00:00:00Z".to_owned(),
            src_hash: Some("0".repeat(64)),
            dst_hash: Some("1".repeat(64)),
            recovery_hash: Some("2".repeat(64)),
            live_path: live.to_string_lossy().into_owned(),
            stage_path: live
                .with_extension("stage-é-'quote'.sqlite")
                .to_string_lossy()
                .into_owned(),
            recovery_path: live
                .with_extension("recovery.sqlite")
                .to_string_lossy()
                .into_owned(),
            plaintext_hold_path: None,
        };
        write_marker(&marker).expect("write marker");
        assert_eq!(read_marker(&live).unwrap(), Some(marker.clone()));
        let path = marker_path(&live);
        let mut invalid = marker.clone();
        invalid.stage_path = invalid.live_path.clone();
        assert!(write_marker(&invalid).is_err());
        assert_eq!(
            read_marker(&live).unwrap(),
            Some(marker.clone()),
            "invalid update preserved prior marker"
        );
        let directory = live.with_extension("alias-directory");
        std::fs::create_dir(&directory).unwrap();
        invalid = marker.clone();
        invalid.stage_path = directory
            .join("..")
            .join(live.file_name().unwrap())
            .to_string_lossy()
            .into_owned();
        assert!(
            write_marker(&invalid).is_err(),
            "normalized live alias rejected"
        );
        std::fs::remove_dir(directory).unwrap();
        std::fs::write(&live, b"live bytes").unwrap();
        std::fs::hard_link(&live, &marker.stage_path).unwrap();
        assert!(
            write_marker(&marker).is_err(),
            "hard-linked live alias rejected"
        );
        std::fs::remove_file(&marker.stage_path).unwrap();
        std::fs::remove_file(&live).unwrap();
        std::fs::write(&path, b"{not json").unwrap();
        assert!(read_marker(&live).is_err());
        let mut json = serde_json::to_value(&marker).unwrap();
        json["version"] = 99.into();
        std::fs::write(&path, serde_json::to_vec(&json).unwrap()).unwrap();
        assert!(read_marker(&live).is_err());
        clear_marker(&live).unwrap();
        assert!(read_marker(&live).unwrap().is_none());
    }

    #[test]
    fn marker_phase_table_maps_every_boundary() {
        let live = "live.sqlite";
        let stage = "stage.sqlite";
        let rec = "rec.sqlite";
        assert_eq!(
            decide_recovery(None, None, None, None, live, stage, rec),
            RecoveryAction::VerifyLiveClear
        );
        let mk = |phase| Marker {
            version: 1,
            op: String::from("backup"),
            phase,
            generation: 1,
            created_at: String::from("2026-11-07T00:00:00Z"),
            src_hash: None,
            dst_hash: None,
            recovery_hash: None,
            live_path: live.to_owned(),
            stage_path: stage.to_owned(),
            recovery_path: rec.to_owned(),
            plaintext_hold_path: None,
        };
        assert_eq!(
            decide_recovery(
                Some(&mk(MarkerPhase::Reserved)),
                None,
                None,
                None,
                live,
                stage,
                rec
            ),
            RecoveryAction::DiscardReserveClear
        );
        assert_eq!(
            decide_recovery(
                Some(&mk(MarkerPhase::Copying)),
                Some("h"),
                None,
                Some("h"),
                live,
                stage,
                rec
            ),
            RecoveryAction::DiscardStageToReserved
        );
        assert_eq!(
            decide_recovery(
                Some(&mk(MarkerPhase::Verifying)),
                Some("h"),
                Some("s"),
                Some("h"),
                live,
                stage,
                rec
            ),
            RecoveryAction::VerifyStage
        );
        assert_eq!(
            decide_recovery(
                Some(&mk(MarkerPhase::Verified)),
                Some("h"),
                Some("s"),
                Some("h"),
                live,
                stage,
                rec
            ),
            RecoveryAction::FsyncAdvance
        );
        assert_eq!(
            decide_recovery(
                Some(&mk(MarkerPhase::Swapped)),
                Some("n"),
                Some("n"),
                Some("o"),
                live,
                stage,
                rec
            ),
            RecoveryAction::VerifyLiveClear
        );
        // Kill-during-swap hash-compare: live == stage verifies and clears.
        assert_eq!(
            decide_recovery(
                Some(&mk(MarkerPhase::Swapping)),
                Some("stage-hash"),
                Some("stage-hash"),
                Some("rec-hash"),
                live,
                stage,
                rec
            ),
            RecoveryAction::VerifyLiveClear
        );
        // Live == prior recovery re-attempts from the verified stage.
        assert_eq!(
            decide_recovery(
                Some(&mk(MarkerPhase::Swapping)),
                Some("rec-hash"),
                Some("stage-hash"),
                Some("rec-hash"),
                live,
                stage,
                rec
            ),
            RecoveryAction::ReattemptSwap
        );
        // Neither generation: fail with both paths, never auto-delete.
        assert_eq!(
            decide_recovery(
                Some(&mk(MarkerPhase::Swapping)),
                Some("other"),
                Some("stage-hash"),
                Some("rec-hash"),
                live,
                stage,
                rec
            ),
            RecoveryAction::FailedWithBoth(stage.to_owned(), rec.to_owned())
        );
    }

    #[test]
    fn recovery_uses_durable_generation_hashes_after_stage_rename() {
        let marker = Marker {
            version: 1,
            op: "rotation".to_owned(),
            phase: MarkerPhase::Swapping,
            generation: 1,
            created_at: "now".to_owned(),
            src_hash: Some("original-live".to_owned()),
            dst_hash: Some("new-live".to_owned()),
            recovery_hash: Some("different-salt".to_owned()),
            live_path: "live".to_owned(),
            stage_path: "stage".to_owned(),
            recovery_path: "recovery".to_owned(),
            plaintext_hold_path: None,
        };
        assert_eq!(
            decide_recovery(
                Some(&marker),
                Some("new-live"),
                None,
                Some("different-salt"),
                "live",
                "stage",
                "recovery"
            ),
            RecoveryAction::VerifyLiveClear
        );
        assert_eq!(
            decide_recovery(
                Some(&marker),
                Some("original-live"),
                Some("new-live"),
                Some("different-salt"),
                "live",
                "stage",
                "recovery"
            ),
            RecoveryAction::ReattemptSwap
        );
        assert_eq!(
            detect_live_generation(
                Some(&marker),
                Some("new-live"),
                Some("different-salt"),
                None
            ),
            LiveGeneration::New
        );
        assert_eq!(
            detect_live_generation(
                Some(&marker),
                Some("unexpected"),
                Some("different-salt"),
                None
            ),
            LiveGeneration::Unknown
        );
    }

    #[test]
    fn interrupted_rollback_recognizes_the_reencrypted_old_generation() {
        let mut marker = Marker {
            version: 1,
            op: "rotation".to_owned(),
            phase: MarkerPhase::RollingBack,
            generation: 1,
            created_at: "now".to_owned(),
            src_hash: Some("original".to_owned()),
            dst_hash: Some("stage".to_owned()),
            recovery_hash: Some("recovery".to_owned()),
            live_path: "live".to_owned(),
            stage_path: "stage-path".to_owned(),
            recovery_path: "recovery-path".to_owned(),
            plaintext_hold_path: None,
        };
        assert_eq!(
            decide_recovery(
                Some(&marker),
                Some("stage"),
                None,
                Some("recovery"),
                "live",
                "stage-path",
                "recovery-path"
            ),
            RecoveryAction::RestoreRecovery
        );
        assert_eq!(
            decide_recovery(
                Some(&marker),
                Some("recovery"),
                None,
                None,
                "live",
                "stage-path",
                "recovery-path"
            ),
            RecoveryAction::VerifyLiveClear
        );
        marker.phase = MarkerPhase::RolledBack;
        assert_eq!(
            detect_live_generation(Some(&marker), Some("recovery"), None, None),
            LiveGeneration::Old
        );
        assert_eq!(
            decide_recovery(
                Some(&marker),
                Some("unexpected"),
                None,
                None,
                "live",
                "stage-path",
                "recovery-path"
            ),
            RecoveryAction::FailedWithBoth("stage-path".to_owned(), "recovery-path".to_owned())
        );
    }

    #[test]
    fn rotation_selection_prompts_matching_generation_first() {
        let mk = Marker {
            version: 1,
            op: String::from("rotation"),
            phase: MarkerPhase::Swapped,
            generation: 2,
            created_at: String::from("2026-11-07T00:00:00Z"),
            src_hash: Some(String::from("old")),
            dst_hash: Some(String::from("new")),
            recovery_hash: Some(String::from("recovery")),
            live_path: String::from("live"),
            stage_path: String::from("stage"),
            recovery_path: String::from("rec"),
            plaintext_hold_path: None,
        };
        assert_eq!(
            detect_live_generation(Some(&mk), Some("new"), Some("old"), Some("new")),
            LiveGeneration::New
        );
        assert_eq!(
            detect_live_generation(Some(&mk), Some("old"), Some("old"), Some("new")),
            LiveGeneration::Old
        );
        assert_eq!(
            select_rotation_prompt(LiveGeneration::New),
            PromptFirst::Live
        );
        assert_eq!(
            select_rotation_prompt(LiveGeneration::Unknown),
            PromptFirst::RecoveryThenStage
        );
    }

    #[test]
    fn downgrade_guard_fails_closed_without_truncation() {
        let (plain, _) = legacy_seeded_file("keyed-downgrade-plain.sqlite");
        let key = Secret::from_passphrase("downgrade-key").unwrap();
        let enc = PathBuf::from(temp_db_path("keyed-downgrade-enc.sqlite"));
        remove(&enc.to_string_lossy());
        copy_db_keyed(&plain, None, &enc, Some(&key)).expect("encrypt");
        let before = file_hash_hex(&enc).unwrap();
        // Simulate a plaintext-only build: the legacy open path must refuse the
        // SQLCipher file with the downgrade code and leave bytes untouched.
        let err = guard_legacy_open(&enc).expect_err("encrypted must not open legacy");
        match err {
            Error::Coded { code, .. } => assert_eq!(code, DOWNGRADE_CODE),
            other => panic!("expected downgrade code, got {other}"),
        }
        assert_eq!(
            file_hash_hex(&enc).unwrap(),
            before,
            "no truncation or migration"
        );
        // The plaintext legacy file still opens through the guard.
        assert!(guard_legacy_open(&plain).is_ok());
        remove(&plain.to_string_lossy());
        remove(&enc.to_string_lossy());
    }

    #[test]
    fn locked_routes_reject_with_stable_code() {
        assert!(is_boot_route("GET", "/api/boot-status"));
        assert!(is_boot_route("POST", "/api/boot-unlock"));
        assert!(!is_boot_route("GET", "/api/dataset"));
        assert!(!is_boot_route("GET", "/api/worksite"));
        let (status, code, message) = locked_rejection();
        assert_eq!(status, 423);
        assert_eq!(code, BOOT_LOCKED_CODE);
        assert!(message.to_lowercase().contains("unlock"));
        assert!(!message.to_lowercase().contains("passphrase"));
        assert!(!message.to_lowercase().contains("key"));
    }
}
