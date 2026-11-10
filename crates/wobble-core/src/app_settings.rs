//! App settings: the installation-wide typed key/value registry and its persistence.

use std::collections::HashMap;

use rusqlite::{params, Connection};
use serde::Serialize;
use serde_json::Value;

use crate::error::{Error, Result};

/// The theme preferences the app ships, exactly as the shared vocabulary lists them.
pub const THEME_PREFERENCES: [&str; 3] = ["system", "light", "dark"];

/// The density preferences the app ships, exactly as the shared vocabulary lists them.
pub const DENSITY_PREFERENCES: [&str; 3] = ["compact", "standard", "comfortable"];

/// The reduce-motion preferences: follow the system, always reduce, or never reduce.
pub const REDUCE_MOTION_PREFERENCES: [&str; 3] = ["system", "reduce", "full"];

/// The text-size multipliers, as percentages of the root font size.
pub const TEXT_SIZE_PREFERENCES: [&str; 4] = ["100", "110", "125", "150"];

/// The date formats: follow the computer, day-month-year, month-day-year, or ISO.
pub const DATE_FORMAT_PREFERENCES: [&str; 4] = ["system", "dmy", "mdy", "iso"];

/// The clock formats: follow the computer, 12-hour, or 24-hour.
pub const TIME_FORMAT_PREFERENCES: [&str; 3] = ["system", "12", "24"];

/// The interface languages: follow the computer, English, or Latin American Spanish.
pub const LANGUAGE_PREFERENCES: [&str; 3] = ["system", "en", "es-419"];

/// How a setting's value is typed, and the values a choice accepts.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum SettingKind {
    /// Stored as the text `true` or `false`, sent as a JSON boolean.
    Boolean,
    /// One of these exact strings.
    Choice(&'static [&'static str]),
}

/// One entry in the registry: the key, its type, its allowed values and its default.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct SettingDefinition {
    pub key: &'static str,
    pub kind: SettingKind,
    pub default: &'static str,
}

/// The registry. Every key here is stored, validated and surfaced; a key not here is
/// rejected on write and ignored on read.
pub const APP_SETTINGS: [SettingDefinition; 10] = [
    SettingDefinition {
        key: "theme",
        kind: SettingKind::Choice(&THEME_PREFERENCES),
        default: "system",
    },
    SettingDefinition {
        key: "density",
        kind: SettingKind::Choice(&DENSITY_PREFERENCES),
        default: "standard",
    },
    SettingDefinition {
        key: "reduceMotion",
        kind: SettingKind::Choice(&REDUCE_MOTION_PREFERENCES),
        default: "system",
    },
    SettingDefinition {
        key: "increaseContrast",
        kind: SettingKind::Boolean,
        default: "false",
    },
    SettingDefinition {
        key: "colorBlindAssessments",
        kind: SettingKind::Boolean,
        default: "false",
    },
    SettingDefinition {
        key: "textSize",
        kind: SettingKind::Choice(&TEXT_SIZE_PREFERENCES),
        default: "100",
    },
    SettingDefinition {
        key: "rememberWindow",
        kind: SettingKind::Boolean,
        default: "true",
    },
    SettingDefinition {
        key: "dateFormat",
        kind: SettingKind::Choice(&DATE_FORMAT_PREFERENCES),
        default: "system",
    },
    SettingDefinition {
        key: "timeFormat",
        kind: SettingKind::Choice(&TIME_FORMAT_PREFERENCES),
        default: "system",
    },
    SettingDefinition {
        key: "language",
        kind: SettingKind::Choice(&LANGUAGE_PREFERENCES),
        default: "system",
    },
];

/// The two settings that predate the registry: a fresh database still stores their
/// defaults, while every later key is written the first time someone changes it.
const SEEDED_SETTING_KEYS: [&str; 2] = ["theme", "density"];

impl SettingDefinition {
    /// Whether a stored text is a valid value for this setting.
    pub fn accepts(&self, text: &str) -> bool {
        match self.kind {
            SettingKind::Boolean => text == "true" || text == "false",
            SettingKind::Choice(choices) => choices.contains(&text),
        }
    }

    /// The text to store for a JSON value from a PUT, or None when the value has the
    /// wrong type or is not one of the allowed values.
    pub fn encode(&self, value: &Value) -> Option<String> {
        match self.kind {
            SettingKind::Boolean => value.as_bool().map(|value| value.to_string()),
            SettingKind::Choice(choices) => value
                .as_str()
                .filter(|value| choices.contains(value))
                .map(str::to_owned),
        }
    }
}

/// The definition registered for a key, or None when the key is unknown.
pub fn setting_definition(key: &str) -> Option<&'static SettingDefinition> {
    APP_SETTINGS.iter().find(|definition| definition.key == key)
}

/// The installation-wide settings as the handlers surface them, with every key present.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    pub theme: String,
    pub density: String,
    pub reduce_motion: String,
    pub increase_contrast: bool,
    pub color_blind_assessments: bool,
    pub text_size: String,
    pub remember_window: bool,
    pub date_format: String,
    pub time_format: String,
    pub language: String,
}

impl Default for AppSettings {
    fn default() -> Self {
        let definition =
            |key: &str| setting_definition(key).expect("every AppSettings field is registered");
        let text = |key: &str| definition(key).default.to_owned();
        Self {
            theme: text("theme"),
            density: text("density"),
            reduce_motion: text("reduceMotion"),
            increase_contrast: definition("increaseContrast").default == "true",
            color_blind_assessments: definition("colorBlindAssessments").default == "true",
            text_size: text("textSize"),
            remember_window: definition("rememberWindow").default == "true",
            date_format: text("dateFormat"),
            time_format: text("timeFormat"),
            language: text("language"),
        }
    }
}

/// One setting a PUT carries. Validation happens in `encode`, so the handler can answer
/// its 400 without touching the database and `save_app_settings` still refuses bad input.
#[derive(Debug, Clone, PartialEq)]
pub struct AppSettingsUpdate {
    pub key: String,
    pub value: Value,
}

impl AppSettingsUpdate {
    /// The text to store, or None when the key is unknown or the value is invalid.
    pub fn encode(&self) -> Option<String> {
        setting_definition(&self.key)?.encode(&self.value)
    }
}

fn read_stored(conn: &Connection) -> Result<HashMap<String, String>> {
    let mut statement = conn.prepare("SELECT key, value FROM app_settings")?;
    let rows = statement.query_map([], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    })?;

    let mut stored = HashMap::new();
    for row in rows {
        let (key, value) = row?;
        stored.insert(key, value);
    }
    Ok(stored)
}

/// A stored value when it is valid, otherwise the registry's default. An unknown key is
/// never asked for, so an old or hand-edited row cannot leak onto the wire.
fn stored_value(stored: &HashMap<String, String>, key: &str) -> String {
    let definition = setting_definition(key).expect("every AppSettings field is registered");
    stored
        .get(key)
        .filter(|value| definition.accepts(value))
        .cloned()
        .unwrap_or_else(|| definition.default.to_owned())
}

/// `getAppSettings`: every registered setting, defaulting any key that is absent or invalid.
pub fn get_app_settings(conn: &Connection) -> Result<AppSettings> {
    let stored = read_stored(conn)?;

    Ok(AppSettings {
        theme: stored_value(&stored, "theme"),
        density: stored_value(&stored, "density"),
        reduce_motion: stored_value(&stored, "reduceMotion"),
        increase_contrast: stored_value(&stored, "increaseContrast") == "true",
        color_blind_assessments: stored_value(&stored, "colorBlindAssessments") == "true",
        text_size: stored_value(&stored, "textSize"),
        remember_window: stored_value(&stored, "rememberWindow") == "true",
        date_format: stored_value(&stored, "dateFormat"),
        time_format: stored_value(&stored, "timeFormat"),
        language: stored_value(&stored, "language"),
    })
}

/// `saveAppSettings`: writes the one supplied setting and returns the fresh settings.
pub fn save_app_settings(conn: &Connection, update: &AppSettingsUpdate) -> Result<AppSettings> {
    let stored = update.encode().ok_or_else(|| {
        Error::Message(format!(
            "Invalid app setting \"{}\": the key is unknown or the value is not allowed.",
            update.key
        ))
    })?;

    conn.execute(
        "INSERT INTO app_settings (key, value) VALUES (?1, ?2) \
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![update.key, stored],
    )?;

    get_app_settings(conn)
}

/// `resetAppSettings`: deletes every settings row; the defaults then apply, and the
/// Worksites, Workers and the Active Worksite are untouched.
pub fn reset_app_settings(conn: &Connection) -> Result<AppSettings> {
    conn.execute("DELETE FROM app_settings", [])?;
    get_app_settings(conn)
}

/// Seeds the two settings that predate the registry on a fresh database.
pub fn seed_default_settings(conn: &Connection) -> Result<()> {
    for key in SEEDED_SETTING_KEYS {
        let definition = setting_definition(key).expect("a seeded key is registered");
        conn.execute(
            "INSERT INTO app_settings (key, value) VALUES (?1, ?2)",
            params![key, definition.default],
        )?;
    }
    Ok(())
}

/// Launch-time Remember window read, straight from the database file: the window-state
/// plugin is built before the request boundary exists, so the shell cannot ask the core.
///
/// False only when the v17 table has a `rememberWindow` row whose value is exactly
/// `false`. A missing file, table or row, an invalid value, a locked or corrupt database,
/// and the old v15 single-row table all keep the registry default: `true`. The file is
/// opened read-write so a read-only copy still reports; it is never created, migrated or
/// written. The busy timeout is short because a launch must not wait on another process.
// LEGACY-PLAINTEXT-FIXTURE: retained only for the historical reader's unit tests.
#[cfg(test)]
pub fn remember_window_from_db_file(path: &std::path::Path) -> bool {
    // Key-before-everything: never open an encrypted file without its key.
    // A locked or encrypted database keeps the registry default; 05 routes the
    // unlocked read through the keyed App after unlock.
    if crate::key::classify_source(path) == crate::key::SourceKind::EncryptedCandidate {
        return true;
    }
    let Ok(conn) = Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_WRITE)
    else {
        return true;
    };
    if conn
        .busy_timeout(std::time::Duration::from_millis(500))
        .is_err()
    {
        return true;
    }

    conn.query_row(
        "SELECT value FROM app_settings WHERE key = 'rememberWindow'",
        [],
        |row| row.get::<_, String>(0),
    )
    .map(|value| value != "false")
    .unwrap_or(true)
}

/// Remember-window read through an already-unlocked keyed handle (05 path).
/// Answers only after unlock; never touches bytes before the key.
pub fn remember_window_via_db(db: &crate::db::Db) -> bool {
    db.conn()
        .query_row(
            "SELECT value FROM app_settings WHERE key = 'rememberWindow'",
            [],
            |row| row.get::<_, String>(0),
        )
        .map(|value| value != "false")
        .unwrap_or(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{open_seeded, Db};
    use crate::id::CounterId;
    use serde_json::json;

    fn seeded() -> Db {
        open_seeded(":memory:", &CounterId::new()).expect("a seeded database")
    }

    fn stored(conn: &Connection, key: &str) -> Option<String> {
        conn.query_row(
            "SELECT value FROM app_settings WHERE key = ?1",
            [key],
            |row| row.get(0),
        )
        .ok()
    }

    fn set(conn: &Connection, key: &str, value: &str) {
        conn.execute(
            "INSERT INTO app_settings (key, value) VALUES (?1, ?2) \
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![key, value],
        )
        .unwrap();
    }

    fn update(key: &str, value: Value) -> AppSettingsUpdate {
        AppSettingsUpdate {
            key: key.to_owned(),
            value,
        }
    }

    #[test]
    fn the_registry_is_unique_and_every_default_is_valid() {
        let keys: std::collections::HashSet<&str> = APP_SETTINGS
            .iter()
            .map(|definition| definition.key)
            .collect();
        assert_eq!(keys.len(), APP_SETTINGS.len(), "keys are unique");

        for definition in &APP_SETTINGS {
            assert!(
                definition.accepts(definition.default),
                "{} has a valid default",
                definition.key
            );
            match definition.kind {
                SettingKind::Boolean => {
                    assert!(definition.accepts("true") && definition.accepts("false"));
                }
                SettingKind::Choice(choices) => {
                    assert!(!choices.is_empty(), "{} has choices", definition.key);
                }
            }
        }
    }

    #[test]
    fn reads_the_seeded_defaults() {
        let db = seeded();
        assert_eq!(get_app_settings(db.conn()).unwrap(), AppSettings::default());
        assert_eq!(stored(db.conn(), "theme").as_deref(), Some("system"));
        assert_eq!(stored(db.conn(), "density").as_deref(), Some("standard"));
    }

    #[test]
    fn saves_one_setting_at_a_time_and_leaves_the_others_alone() {
        let db = seeded();

        let themed = save_app_settings(db.conn(), &update("theme", json!("dark"))).unwrap();
        assert_eq!(themed.theme, "dark");
        assert_eq!(themed.density, "standard");
        assert_eq!(themed.reduce_motion, "system");

        let densified = save_app_settings(db.conn(), &update("density", json!("compact"))).unwrap();
        assert_eq!(densified.theme, "dark");
        assert_eq!(densified.density, "compact");

        let contrasted =
            save_app_settings(db.conn(), &update("increaseContrast", json!(true))).unwrap();
        assert!(contrasted.increase_contrast);
        assert_eq!(contrasted.theme, "dark");

        assert_eq!(get_app_settings(db.conn()).unwrap(), contrasted);
    }

    #[test]
    fn a_boolean_takes_a_json_boolean_and_a_choice_takes_an_exact_string() {
        let definition = setting_definition("increaseContrast").unwrap();
        assert_eq!(definition.encode(&json!(true)).as_deref(), Some("true"));
        assert_eq!(definition.encode(&json!(false)).as_deref(), Some("false"));
        for bad in [json!("true"), json!(1), json!(null), json!([])] {
            assert_eq!(definition.encode(&bad), None, "{bad}");
        }

        let definition = setting_definition("theme").unwrap();
        assert_eq!(definition.encode(&json!("dark")).as_deref(), Some("dark"));
        for bad in [json!("Dark"), json!(" dark "), json!(42), json!(null)] {
            assert_eq!(definition.encode(&bad), None, "{bad}");
        }
    }

    #[test]
    fn rejects_an_unknown_key_on_write_and_leaves_the_stored_settings_alone() {
        let db = seeded();
        save_app_settings(db.conn(), &update("theme", json!("dark"))).unwrap();

        let error = save_app_settings(db.conn(), &update("language", json!("fr"))).unwrap_err();
        assert!(error.to_string().contains("language"), "{error}");
        assert_eq!(stored(db.conn(), "language"), None);
        assert_eq!(
            get_app_settings(db.conn()).unwrap().theme,
            "dark",
            "a rejected write changes nothing"
        );

        for (key, value) in [
            ("theme", json!("sepia")),
            ("increaseContrast", json!("true")),
            ("textSize", json!(125)),
        ] {
            assert!(save_app_settings(db.conn(), &update(key, value)).is_err());
        }
    }

    #[test]
    fn an_invalid_stored_value_falls_back_to_its_default() {
        let db = seeded();
        set(db.conn(), "theme", "sepia");
        set(db.conn(), "density", "cozy");
        set(db.conn(), "increaseContrast", "maybe");
        set(db.conn(), "textSize", "gigantic");
        set(db.conn(), "dateFormat", "ymd");

        let settings = get_app_settings(db.conn()).unwrap();
        assert_eq!(settings.theme, "system");
        assert_eq!(settings.density, "standard");
        assert!(!settings.increase_contrast);
        assert_eq!(settings.text_size, "100");
        assert_eq!(settings.date_format, "system");
    }

    #[test]
    fn defaults_apply_when_the_rows_are_missing() {
        let db = seeded();
        db.conn().execute("DELETE FROM app_settings", []).unwrap();

        assert_eq!(get_app_settings(db.conn()).unwrap(), AppSettings::default());
    }

    #[test]
    fn reset_deletes_every_row_and_returns_the_fresh_defaults() {
        let db = seeded();
        save_app_settings(db.conn(), &update("theme", json!("dark"))).unwrap();
        save_app_settings(db.conn(), &update("density", json!("comfortable"))).unwrap();
        save_app_settings(db.conn(), &update("rememberWindow", json!(false))).unwrap();

        let settings = reset_app_settings(db.conn()).unwrap();

        assert_eq!(settings, AppSettings::default());
        let rows: i64 = db
            .conn()
            .query_row("SELECT COUNT(*) FROM app_settings", [], |row| row.get(0))
            .unwrap();
        assert_eq!(rows, 0);
        assert_eq!(get_app_settings(db.conn()).unwrap(), AppSettings::default());
    }

    fn temp_path(name: &str) -> std::path::PathBuf {
        let path = crate::test_support::temp_db_path(name);
        for suffix in ["", "-wal", "-shm"] {
            let _ = std::fs::remove_file(format!("{path}{suffix}"));
        }
        std::path::PathBuf::from(path)
    }

    fn open_file(path: &std::path::Path) -> Db {
        Db::open_legacy_fixture(&path.to_string_lossy()).expect("historical window-reader fixture")
    }

    #[test]
    fn remember_window_is_off_only_for_a_stored_exact_false() {
        let path = temp_path("remember-window-off.sqlite");
        let db = open_file(&path);
        set(db.conn(), "rememberWindow", "false");
        drop(db);

        assert!(!remember_window_from_db_file(&path));
    }

    #[test]
    fn remember_window_defaults_on_when_the_row_is_missing() {
        let path = temp_path("remember-window-missing-row.sqlite");
        let db = open_file(&path);
        assert_eq!(stored(db.conn(), "rememberWindow"), None);
        drop(db);

        assert!(remember_window_from_db_file(&path));
    }

    #[test]
    fn remember_window_defaults_on_when_the_file_is_missing() {
        let path = temp_path("remember-window-missing-file.sqlite");

        assert!(!path.exists());
        assert!(remember_window_from_db_file(&path));
    }

    #[test]
    fn remember_window_defaults_on_for_an_invalid_value() {
        let path = temp_path("remember-window-invalid.sqlite");
        let db = open_file(&path);
        set(db.conn(), "rememberWindow", "FALSE");
        drop(db);

        assert!(remember_window_from_db_file(&path));
    }

    #[test]
    fn remember_window_defaults_on_when_the_table_is_missing() {
        let path = temp_path("remember-window-missing-table.sqlite");
        // LEGACY-PLAINTEXT-FIXTURE: unit-test temp file asserting reject/default handling (never production).
        let conn = rusqlite::Connection::open(&path).unwrap();
        conn.execute_batch("CREATE TABLE unrelated (id INTEGER PRIMARY KEY);")
            .unwrap();
        drop(conn);

        assert!(remember_window_from_db_file(&path));
    }

    #[test]
    fn remember_window_defaults_on_for_a_legacy_single_row_table() {
        let path = temp_path("remember-window-legacy.sqlite");
        // LEGACY-PLAINTEXT-FIXTURE: unit-test temp file asserting legacy-table default (never production).
        let conn = rusqlite::Connection::open(&path).unwrap();
        conn.execute_batch(
            "CREATE TABLE app_settings (
               id INTEGER PRIMARY KEY CHECK (id = 1),
               theme TEXT NOT NULL CHECK (theme IN ('system', 'light', 'dark')),
               density TEXT NOT NULL CHECK (density IN ('compact', 'standard', 'comfortable'))
             );
             INSERT INTO app_settings (id, theme, density) VALUES (1, 'system', 'standard');",
        )
        .unwrap();
        drop(conn);

        assert!(remember_window_from_db_file(&path));
    }
}
