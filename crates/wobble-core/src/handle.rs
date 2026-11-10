//! The D1 entry point handle(method, path, query, headers, body) -> (status, json).
//! Route matching lives in router.rs; until a route is ported it answers 501.

use serde_json::{json, Value};

use crate::db::Db;
use crate::id::IdSource;
use crate::Error;

/// A request as the dev shim forwards it. body is the raw JSON text (None when absent).
pub struct Request {
    pub method: String,
    pub path: String,
    pub query: String,
    pub headers: Vec<(String, String)>,
    pub body: Option<String>,
}

impl Drop for Request {
    fn drop(&mut self) {
        use zeroize::Zeroize;
        if let Some(body) = &mut self.body {
            body.zeroize();
        }
    }
}

/// A response: an HTTP status, its headers, and a canonical JSON body.
///
/// `Serialize` exists for the Tauri shell, whose `api_request` command returns this type
/// over IPC; it changes nothing about how the routes build or compare responses.
#[derive(serde::Serialize)]
pub struct Response {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: Value,
}

/// One mutable lifecycle, serialized by the host request mutex. Interior mutability
/// preserves the existing request API without adding a second mutex or split state.
enum AppState {
    Unavailable(crate::key::BootState),
    /// Explicit compatibility constructor for ephemeral tests and intentional legacy
    /// fixtures. Native/shim startup use `locked` once 03–05 activate together.
    Legacy(Result<Db, Error>),
    Encrypted(crate::open_database::OpenDatabase),
}

pub struct App {
    state: std::cell::RefCell<AppState>,
    path: String,
}

#[derive(serde::Deserialize)]
#[serde(transparent)]
struct SecretText(String);
impl std::ops::Deref for SecretText {
    type Target = str;
    fn deref(&self) -> &str {
        &self.0
    }
}
impl Drop for SecretText {
    fn drop(&mut self) {
        use zeroize::Zeroize;
        self.0.zeroize();
    }
}

#[derive(serde::Deserialize, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Credentials {
    passphrase: Option<SecretText>,
    confirm: Option<SecretText>,
    current: Option<SecretText>,
    next: Option<SecretText>,
    path: Option<String>,
    source_passphrase: Option<SecretText>,
    #[serde(default)]
    legacy: bool,
}

fn credentials(request: &Request) -> crate::Result<Credentials> {
    serde_json::from_str(request.body.as_deref().unwrap_or("{}"))
        .map_err(|_| Error::coded("boot_invalid_request", "The credential request is invalid."))
}
fn required(value: &Option<SecretText>) -> crate::Result<&str> {
    value
        .as_deref()
        .ok_or_else(|| Error::coded("boot_invalid_request", "A passphrase is required."))
}
fn secret(value: &Option<SecretText>) -> crate::Result<crate::key::Secret> {
    crate::key::Secret::from_passphrase(required(value)?)
        .map_err(|message| Error::coded("boot_invalid_request", message))
}
fn new_secret(
    value: &Option<SecretText>,
    confirm: &Option<SecretText>,
) -> crate::Result<crate::key::Secret> {
    crate::key::Secret::validate_new(required(value)?, required(confirm)?)
        .map_err(|message| Error::coded("boot_invalid_request", message))
}
fn lifecycle_error(error: &Error) -> Response {
    let status = match error.code() {
        Some(crate::key::WRONG_KEY_CODE) => 401,
        Some(
            "boot_invalid_request"
            | "restore_source_credential_required"
            | "restore_same_file"
            | "restore_legacy_required",
        ) => 400,
        Some("database_locked") => 423,
        Some("boot_state_conflict") => 409,
        Some(code) if code.starts_with("restore_") && code != "restore_failed" => 400,
        _ => 500,
    };
    Response {
        status,
        headers: Vec::new(),
        body: json!({ "message": error.to_string(), "code": error.code() }),
    }
}
impl App {
    pub fn open(path: &str) -> App {
        if path != ":memory:" {
            return Self::locked(path);
        }
        Self {
            state: std::cell::RefCell::new(AppState::Legacy(Db::open(path))),
            path: path.to_owned(),
        }
    }
    /// LEGACY-PLAINTEXT-FIXTURE: explicit historical reader, excluded from production.
    #[cfg(any(test, feature = "test-fixtures"))]
    pub fn open_legacy_fixture(path: &str) -> App {
        Self {
            state: std::cell::RefCell::new(AppState::Legacy(Db::open_legacy_fixture(path))),
            path: path.to_owned(),
        }
    }

    pub fn locked(path: &str) -> App {
        Self {
            state: std::cell::RefCell::new(AppState::Unavailable(crate::key::describe_boot_state(
                path,
            ))),
            path: path.to_owned(),
        }
    }
    pub fn open_keyed(path: &str, credential: Option<&crate::key::Secret>) -> App {
        match credential {
            None => Self::open(path),
            Some(credential) => {
                let result = if std::path::Path::new(path).exists() {
                    crate::open_database::OpenDatabase::open(
                        std::path::Path::new(path),
                        credential.duplicate(),
                    )
                } else {
                    crate::open_database::OpenDatabase::create(
                        std::path::Path::new(path),
                        credential.duplicate(),
                    )
                };
                let state = match result {
                    Ok(open) => AppState::Encrypted(open),
                    Err(_) => AppState::Unavailable(crate::key::describe_boot_state(path)),
                };
                Self {
                    state: std::cell::RefCell::new(state),
                    path: path.to_owned(),
                }
            }
        }
    }
    fn status(state: &AppState) -> crate::key::BootState {
        match state {
            AppState::Unavailable(status) => status.clone(),
            AppState::Legacy(Ok(_)) => crate::key::BootState::Open,
            AppState::Legacy(Err(error)) => crate::key::BootState::Failed {
                reason: error.to_string(),
                recovery_path: None,
            },
            AppState::Encrypted(open) if open.db().is_ok() => crate::key::BootState::Open,
            AppState::Encrypted(_) => crate::key::BootState::Failed {
                reason: "Database recovery is required.".to_owned(),
                recovery_path: None,
            },
        }
    }
    fn status_value(state: &AppState) -> Value {
        let mut value = crate::key::boot_status_value(&Self::status(state));
        if matches!(Self::status(state), crate::key::BootState::Open) {
            value["encrypted"] = Value::Bool(matches!(state, AppState::Encrypted(_)));
        }
        value
    }

    pub fn boot_state(&self) -> crate::key::BootState {
        Self::status(&self.state.borrow())
    }
    pub fn db_path(&self) -> &str {
        &self.path
    }

    /// Native window restoration can consult preferences only after authentication.
    pub fn unlocked_window_preference(&self) -> crate::Result<Option<bool>> {
        match &*self.state.borrow() {
            AppState::Encrypted(open) => Ok(Some(
                crate::app_settings::get_app_settings(open.db()?.conn())?.remember_window,
            )),
            _ => Ok(None),
        }
    }

    fn boot(&self, state: &mut AppState, request: &Request) -> crate::Result<Response> {
        let status = Self::status(state);
        let payload = credentials(request)?;
        let path = std::path::Path::new(&self.path);
        match request.path.as_str() {
            "/api/boot-create" => {
                if !matches!(
                    status,
                    crate::key::BootState::Locked {
                        first_run: true,
                        ..
                    }
                ) {
                    return Err(Error::coded(
                        "boot_state_conflict",
                        "Storage already exists. Unlock it to continue.",
                    ));
                }
                let opened = crate::open_database::OpenDatabase::create(
                    path,
                    new_secret(&payload.passphrase, &payload.confirm)?,
                )?;
                *state = AppState::Encrypted(opened);
                Ok(crate::router::json_response(200, Self::status_value(state)))
            }
            "/api/boot-unlock" => {
                if matches!(status, crate::key::BootState::Open) {
                    return Err(Error::coded(
                        "boot_state_conflict",
                        "Storage is already unlocked.",
                    ));
                }
                let legacy = matches!(
                    crate::key::describe_boot_state(&self.path),
                    crate::key::BootState::Locked {
                        legacy_plaintext: true,
                        ..
                    }
                );
                let conversion = legacy
                    || crate::key::read_marker(path)?
                        .is_some_and(|marker| marker.op == "conversion");
                let opened = if legacy {
                    crate::open_database::OpenDatabase::convert(
                        path,
                        new_secret(&payload.passphrase, &payload.confirm)?,
                    )?
                } else {
                    crate::open_database::OpenDatabase::open(path, secret(&payload.passphrase)?)?
                };
                let receipt = if conversion {
                    opened.retained_recovery().zip(opened.db()?.path()).map(|(recovery, database)| json!({ "databasePath": database, "recoveryPath": recovery }))
                } else {
                    None
                };
                *state = AppState::Encrypted(opened);
                let mut value = Self::status_value(state);
                if let Some(receipt) = receipt {
                    value["conversion"] = receipt;
                }
                Ok(crate::router::json_response(200, value))
            }
            "/api/boot-change-passphrase" => {
                let AppState::Encrypted(opened) = state else {
                    return Err(Error::coded("database_locked", crate::key::LOCKED_MESSAGE));
                };
                let recovery = opened.rotate(
                    &secret(&payload.current)?,
                    new_secret(&payload.next, &payload.confirm)?,
                )?;
                Ok(crate::router::json_response(
                    200,
                    json!({ "safetyCopyPath": recovery }),
                ))
            }
            _ => Err(Error::coded(
                "boot_invalid_request",
                "The boot action is unavailable.",
            )),
        }
    }

    fn operation_error(&self, state: &AppState, error: &Error) -> Response {
        let mut response = lifecycle_error(error);
        if matches!(
            error.code(),
            Some("boot_invalid_request" | "boot_state_conflict" | crate::key::WRONG_KEY_CODE)
        ) {
            return response;
        }
        let path = match state {
            AppState::Encrypted(open) => open.retained_recovery().map(std::path::Path::to_owned),
            _ => crate::key::read_marker(std::path::Path::new(&self.path))
                .ok()
                .flatten()
                .and_then(|marker| {
                    let path = std::path::PathBuf::from(marker.recovery_path);
                    if crate::key::file_hash_hex(&path).ok().as_ref()
                        == marker.recovery_hash.as_ref()
                        && marker.recovery_hash.is_some()
                    {
                        Some(path)
                    } else {
                        None
                    }
                }),
        };
        if let Some(path) = path {
            response.body["recoveryPath"] = json!(path);
        }
        response
    }

    pub fn handle(&self, request: &Request, id_source: &impl IdSource) -> Response {
        let mut state = self.state.borrow_mut();
        if request.method == "GET" && request.path == crate::key::BOOT_STATUS_PATH {
            return crate::router::json_response(200, Self::status_value(&state));
        }
        if request.method == "POST" && crate::key::is_boot_route(&request.method, &request.path) {
            let result = self.boot(&mut state, request);
            if let Err(error) = &result {
                if matches!(&*state, AppState::Unavailable(_)) {
                    let status = if matches!(error, Error::UnsupportedSchema(_))
                        || error.code() == Some("database_recovery_required")
                    {
                        let marker = crate::key::marker_path(std::path::Path::new(&self.path));
                        crate::key::BootState::Failed {
                            reason: "Database recovery is required.".to_owned(),
                            recovery_path: Some(
                                if marker.exists() {
                                    marker
                                } else {
                                    std::path::PathBuf::from(&self.path)
                                }
                                .to_string_lossy()
                                .into_owned(),
                            ),
                        }
                    } else {
                        crate::key::describe_boot_state(&self.path)
                    };
                    *state = AppState::Unavailable(status);
                }
            }
            return result.unwrap_or_else(|error| self.operation_error(&state, &error));
        }
        match &mut *state {
            AppState::Unavailable(crate::key::BootState::Locked { .. }) => {
                let (status, code, message) = crate::key::locked_rejection();
                crate::router::coded_message_response(status, code, message)
            }
            AppState::Unavailable(_) => crate::router::coded_message_response(
                500,
                "database_recovery_required",
                "Database recovery is required.",
            ),
            AppState::Legacy(Err(error)) => crate::router::error_response(error),
            AppState::Legacy(Ok(db)) => crate::router::dispatch(db, request, id_source),
            AppState::Encrypted(opened) => {
                if opened.db().is_err() {
                    return crate::router::coded_message_response(
                        500,
                        "database_recovery_required",
                        "Database recovery is required.",
                    );
                }
                if request.method == "POST" && request.path == "/api/restore" {
                    let result = (|| -> crate::Result<Response> {
                        let payload = credentials(request)?;
                        let path = payload
                            .path
                            .as_deref()
                            .filter(|p| !p.trim().is_empty())
                            .ok_or_else(|| {
                                Error::coded("boot_invalid_request", "A backup path is required.")
                            })?;
                        let source_secret = payload
                            .source_passphrase
                            .as_ref()
                            .map(|_| secret(&payload.source_passphrase))
                            .transpose()?;
                        let restored = opened.restore(
                            std::path::Path::new(path),
                            source_secret.as_ref(),
                            payload.legacy,
                        );
                        // Whatever the restore did, a remembered merge no longer describes the data.
                        if let Ok(db) = opened.db() {
                            db.set_merge_snapshot(None);
                        }
                        let recovery = restored?;
                        Ok(crate::router::json_response(
                            200,
                            json!({ "safetyCopyPath": recovery }),
                        ))
                    })();
                    return result.unwrap_or_else(|error| {
                        let mut response = lifecycle_error(&error);
                        if let Some(path) = opened.retained_recovery() {
                            response.body["recoveryPath"] = json!(path);
                        }
                        response
                    });
                }
                match opened.db() {
                    Ok(db) => {
                        crate::router::dispatch_keyed(db, request, id_source, Some(opened.secret()))
                    }
                    Err(error) => lifecycle_error(&error),
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::id::CounterId;

    fn req(method: &str, path: &str) -> Request {
        Request {
            method: method.to_owned(),
            path: path.to_owned(),
            query: String::new(),
            headers: Vec::new(),
            body: None,
        }
    }

    #[test]
    fn locked_app_rejects_datasets_with_stable_code_and_answers_boot_status() {
        let app = App::locked("/tmp/wobble-keyed-test-locked.sqlite");
        assert_eq!(app.db_path(), "/tmp/wobble-keyed-test-locked.sqlite");
        let ids = CounterId::new();
        let rejected = app.handle(&req("GET", "/api/dataset"), &ids);
        assert_eq!(rejected.status, 423);
        assert_eq!(
            rejected.body["code"],
            serde_json::json!(crate::key::BOOT_LOCKED_CODE)
        );
        let message = rejected.body["message"].as_str().unwrap_or_default();
        assert!(message.to_lowercase().contains("unlock"), "{message}");
        assert!(!message.to_lowercase().contains("passphrase"));
        assert!(!message.to_lowercase().contains("key"));
        let status = app.handle(&req("GET", "/api/boot-status"), &ids);
        assert_eq!(status.status, 200);
        assert_eq!(status.body["state"], serde_json::json!("locked"));
    }

    #[test]
    fn open_app_answers_boot_status_as_open() {
        let app = App::open(":memory:");
        let ids = CounterId::new();
        let status = app.handle(&req("GET", "/api/boot-status"), &ids);
        assert_eq!(status.status, 200);
        assert_eq!(status.body["state"], serde_json::json!("open"));
    }
    struct Files(std::path::PathBuf);
    impl Files {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!("wobble-boot-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir(&path).unwrap();
            Self(path)
        }
        fn path(&self) -> String {
            self.0.join("app.sqlite").to_str().unwrap().to_owned()
        }
    }
    impl Drop for Files {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    fn post(path: &str, body: Value) -> Request {
        Request {
            method: "POST".to_owned(),
            path: path.to_owned(),
            query: String::new(),
            headers: vec![],
            body: Some(body.to_string()),
        }
    }
    #[test]
    fn create_requires_confirmed_credentials_and_initializes_no_worksite() {
        let files = Files::new();
        let path = files.path();
        let app = App::locked(&path);
        let ids = CounterId::new();
        for (passphrase, confirm) in [("", ""), ("   ", "   "), ("new", "different")] {
            assert_eq!(
                app.handle(
                    &post(
                        "/api/boot-create",
                        json!({"passphrase":passphrase,"confirm":confirm})
                    ),
                    &ids
                )
                .status,
                400
            );
            assert!(!std::path::Path::new(&path).exists());
        }
        assert_eq!(
            app.handle(
                &post(
                    "/api/boot-create",
                    json!({"passphrase":"  exact á secret  ","confirm":"  exact á secret  "})
                ),
                &ids
            )
            .status,
            200
        );
        let dataset = app.handle(&req("GET", "/api/dataset"), &ids);
        assert_eq!(dataset.status, 200);
        assert_eq!(dataset.body["worksites"], json!([]));
        assert_eq!(
            app.handle(
                &post(
                    "/api/boot-create",
                    json!({"passphrase":"other","confirm":"other"})
                ),
                &ids
            )
            .status,
            409
        );
    }
    #[test]
    fn relaunch_locks_all_data_until_exact_passphrase_and_never_echoes_secret() {
        let files = Files::new();
        let path = files.path();
        let ids = CounterId::new();
        {
            let app = App::locked(&path);
            assert_eq!(app.handle(&post("/api/boot-create", json!({"passphrase":"  private á credential  ","confirm":"  private á credential  "})), &ids).status, 200);
            let state = app.state.borrow();
            if let AppState::Encrypted(open) = &*state {
                open.db()
                    .unwrap()
                    .conn()
                    .execute(
                        "INSERT INTO worksites (id, name) VALUES ('private', 'Private Worksite')",
                        [],
                    )
                    .unwrap();
            }
        }
        let app = App::locked(&path);
        for route in [
            "/api/dataset",
            "/api/settings",
            "/api/worksite",
            "/api/data-file",
        ] {
            let response = app.handle(&req("GET", route), &ids);
            assert_eq!(response.status, 423);
            assert_eq!(response.body["code"], "database_locked");
            assert!(!response.body.to_string().contains("Private Worksite"));
        }
        assert_eq!(
            app.handle(
                &post(
                    "/api/boot-unlock",
                    json!({"passphrase":"private á credential"})
                ),
                &ids
            )
            .status,
            401
        );
        let response = app.handle(
            &post(
                "/api/boot-unlock",
                json!({"passphrase":"  private á credential  "}),
            ),
            &ids,
        );
        assert_eq!(response.status, 200);
        assert!(!response.body.to_string().contains("credential"));
        let data = app.handle(&req("GET", "/api/dataset"), &ids);
        assert_eq!(data.status, 200);
        assert!(data.body.to_string().contains("Private Worksite"));
    }
    #[test]
    fn boot_rotation_requires_current_and_confirmed_new_credentials() {
        let files = Files::new();
        let path = files.path();
        let ids = CounterId::new();
        let app = App::locked(&path);
        assert_eq!(
            app.handle(
                &post(
                    "/api/boot-create",
                    json!({"passphrase":"old","confirm":"old"})
                ),
                &ids
            )
            .status,
            200
        );
        assert_eq!(
            app.handle(
                &post(
                    "/api/boot-change-passphrase",
                    json!({"current":"wrong","next":"new","confirm":"new"})
                ),
                &ids
            )
            .status,
            401
        );
        assert_eq!(
            app.handle(
                &post(
                    "/api/boot-change-passphrase",
                    json!({"current":"old","next":"new","confirm":"different"})
                ),
                &ids
            )
            .status,
            400
        );
        assert!(matches!(app.boot_state(), crate::key::BootState::Open));
        let response = app.handle(
            &post(
                "/api/boot-change-passphrase",
                json!({"current":"old","next":"new","confirm":"new"}),
            ),
            &ids,
        );
        assert_eq!(response.status, 200);
        assert!(std::path::Path::new(response.body["safetyCopyPath"].as_str().unwrap()).exists());
        drop(app);
        let app = App::locked(&path);
        assert_eq!(
            app.handle(&post("/api/boot-unlock", json!({"passphrase":"old"})), &ids)
                .status,
            401
        );
        assert_eq!(
            app.handle(&post("/api/boot-unlock", json!({"passphrase":"new"})), &ids)
                .status,
            200
        );
    }
    #[test]
    fn unrecognized_operation_marker_blocks_boot_and_preserves_all_evidence() {
        let files = Files::new();
        let path = files.path();
        let ids = CounterId::new();
        let app = App::locked(&path);
        assert_eq!(
            app.handle(
                &post(
                    "/api/boot-create",
                    json!({
                        "passphrase":"marker credential", "confirm":"marker credential"
                    })
                ),
                &ids
            )
            .status,
            200
        );
        drop(app);
        let live_before = crate::key::file_hash_hex(std::path::Path::new(&path)).unwrap();
        let marker = crate::key::marker_path(std::path::Path::new(&path));
        let unknown = br#"{"version":999,"op":"unknown","phase":"unknown"}"#;
        std::fs::write(&marker, unknown).unwrap();
        let app = App::locked(&path);
        assert!(matches!(
            app.boot_state(),
            crate::key::BootState::Failed { .. }
        ));
        assert_ne!(app.handle(&req("GET", "/api/dataset"), &ids).status, 200);
        assert_ne!(
            app.handle(
                &post(
                    "/api/boot-unlock",
                    json!({
                        "passphrase":"marker credential"
                    })
                ),
                &ids
            )
            .status,
            200
        );
        assert_eq!(std::fs::read(&marker).unwrap(), unknown);
        assert_eq!(
            crate::key::file_hash_hex(std::path::Path::new(&path)).unwrap(),
            live_before
        );
    }

    #[test]
    fn window_preference_is_unavailable_until_authenticated() {
        let files = Files::new();
        let path = files.path();
        let app = App::locked(&path);
        let ids = CounterId::new();
        assert_eq!(app.unlocked_window_preference().unwrap(), None);
        assert!(!std::path::Path::new(&path).exists());
        assert_eq!(
            app.handle(
                &post(
                    "/api/boot-create",
                    json!({"passphrase":"window credential","confirm":"window credential"})
                ),
                &ids
            )
            .status,
            200
        );
        assert_eq!(app.unlocked_window_preference().unwrap(), Some(true));
        let response = app.handle(
            &Request {
                method: "PUT".to_owned(),
                path: "/api/settings".to_owned(),
                query: String::new(),
                headers: vec![],
                body: Some(json!({"rememberWindow":false}).to_string()),
            },
            &ids,
        );
        assert_eq!(response.status, 200);
        assert_eq!(app.unlocked_window_preference().unwrap(), Some(false));
    }
    #[test]
    fn conversion_reports_actual_encrypted_live_and_recovery_paths() {
        let files = Files::new();
        let path = files.path();
        let ids = CounterId::new();
        let fixture = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../contract/fixtures/rust-v12.sqlite");
        std::fs::copy(&fixture, &path).unwrap(); // LEGACY-PLAINTEXT-FIXTURE: conversion input.
        let fixture_hash = crate::key::file_hash_hex(&fixture).unwrap();
        let app = App::locked(&path);
        assert_eq!(app.handle(&req("GET", "/api/dataset"), &ids).status, 423);
        let response = app.handle(
            &post(
                "/api/boot-unlock",
                json!({"passphrase":"converted credential","confirm":"converted credential"}),
            ),
            &ids,
        );
        assert_eq!(response.status, 200, "{}", response.body);
        assert_eq!(response.body["encrypted"], true);
        let live = response.body["conversion"]["databasePath"]
            .as_str()
            .unwrap();
        let recovery = response.body["conversion"]["recoveryPath"]
            .as_str()
            .unwrap();
        assert_eq!(
            std::fs::canonicalize(live).unwrap(),
            std::fs::canonicalize(&path).unwrap()
        );
        let key = crate::key::Secret::from_passphrase("converted credential").unwrap();
        for value in [live, recovery] {
            assert!(crate::key::verify_copy_keyed(std::path::Path::new(value), Some(&key)).is_ok());
            assert!(crate::key::verify_copy_keyed(std::path::Path::new(value), None).is_err());
        }
        assert_eq!(crate::key::file_hash_hex(&fixture).unwrap(), fixture_hash);
        assert!(!response.body.to_string().contains("converted credential"));
    }

    #[test]
    fn failed_restore_reports_only_verified_pre_operation_recovery() {
        let files = Files::new();
        let path = files.path();
        let source = files.0.join("invalid-backup.sqlite");
        let ids = CounterId::new();
        let install = crate::key::Secret::from_passphrase("installation").unwrap();
        let backup = crate::key::Secret::from_passphrase("backup").unwrap();
        {
            let db = Db::open_keyed(&path, Some(&install)).unwrap();
            db.conn()
                .execute(
                    "INSERT INTO worksites (id, name) VALUES ('original', 'Original Worksite')",
                    [],
                )
                .unwrap();
            let source_db = Db::open_keyed(source.to_str().unwrap(), Some(&backup)).unwrap();
            source_db
                .conn()
                .execute_batch("DROP TABLE app_settings;")
                .unwrap();
        }
        let before = crate::key::file_hash_hex(&source).unwrap();
        let app = App::open_keyed(&path, Some(&install));
        let response = app.handle(
            &post(
                "/api/restore",
                json!({"path":source,"sourcePassphrase":"backup"}),
            ),
            &ids,
        );
        assert_eq!(response.status, 500);
        assert!(response.body.get("safetyCopyPath").is_none());
        let recovery = std::path::Path::new(response.body["recoveryPath"].as_str().unwrap());
        assert!(crate::key::verify_copy_keyed(recovery, Some(&install)).is_ok());
        assert_eq!(
            crate::replacement::records(recovery, Some(&install)).unwrap(),
            crate::replacement::records(std::path::Path::new(&path), Some(&install)).unwrap()
        );
        assert_eq!(crate::key::file_hash_hex(&source).unwrap(), before);
        assert!(matches!(app.boot_state(), crate::key::BootState::Open));
        assert!(app
            .handle(&req("GET", "/api/dataset"), &ids)
            .body
            .to_string()
            .contains("Original Worksite"));
    }
    #[test]
    fn no_key_persistent_constructors_never_bootstrap_or_serve_plaintext() {
        let files = Files::new();
        let path = files.path();
        let ids = CounterId::new();
        let error = match Db::open(&path) {
            Ok(_) => panic!("a persistent file requires a credential"),
            Err(error) => error,
        };
        assert_eq!(error.code(), Some("database_locked"));
        assert!(!std::path::Path::new(&path).exists());
        for app in [App::open(&path), App::open_keyed(&path, None)] {
            assert_eq!(app.handle(&req("GET", "/api/dataset"), &ids).status, 423);
        }
        assert!(!std::path::Path::new(&path).exists());
        let key = crate::key::Secret::from_passphrase("required credential").unwrap();
        let encrypted = App::open_keyed(&path, Some(&key));
        assert_eq!(
            encrypted.handle(&req("GET", "/api/dataset"), &ids).status,
            200
        );
        let before = crate::key::file_hash_hex(std::path::Path::new(&path)).unwrap();
        assert!(Db::open(&path).is_err());
        assert_eq!(
            App::open(&path)
                .handle(&req("GET", "/api/dataset"), &ids)
                .status,
            423
        );
        assert_eq!(
            crate::key::file_hash_hex(std::path::Path::new(&path)).unwrap(),
            before
        );
    }
}
