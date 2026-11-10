//! Golden vocabulary contract: contract/vocabulary.json is the one hand-maintained source
//! for the assessment, theme and density lists and the settings defaults. The Rust
//! registry and the schema's bootstrap must agree with it.

use std::fs;
use std::path::PathBuf;

use serde_json::{json, Value};
use wobble_core::app_settings::{
    get_app_settings, save_app_settings, setting_definition, AppSettings, AppSettingsUpdate,
    SettingKind, DATE_FORMAT_PREFERENCES, DENSITY_PREFERENCES, LANGUAGE_PREFERENCES,
    REDUCE_MOTION_PREFERENCES, TEXT_SIZE_PREFERENCES, THEME_PREFERENCES, TIME_FORMAT_PREFERENCES,
};
use wobble_core::db::Db;
use wobble_core::serialization::ASSESSMENT_OPTIONS;

fn vocabulary() -> Value {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../contract/vocabulary.json");
    let text = fs::read_to_string(&path).expect("contract/vocabulary.json reads");
    serde_json::from_str(&text).expect("contract/vocabulary.json parses")
}

fn list(value: &Value) -> Vec<&str> {
    value
        .as_array()
        .expect("the golden list is an array")
        .iter()
        .map(|item| item.as_str().expect("golden list entries are strings"))
        .collect()
}

fn update(key: &str, value: Value) -> AppSettingsUpdate {
    AppSettingsUpdate {
        key: key.to_owned(),
        value,
    }
}

#[test]
fn assessment_options_match_the_golden_file() {
    assert_eq!(
        ASSESSMENT_OPTIONS.to_vec(),
        list(&vocabulary()["assessment"])
    );
}

#[test]
fn theme_preferences_match_the_golden_file() {
    assert_eq!(THEME_PREFERENCES.to_vec(), list(&vocabulary()["theme"]));
}

#[test]
fn density_preferences_match_the_golden_file() {
    assert_eq!(DENSITY_PREFERENCES.to_vec(), list(&vocabulary()["density"]));
}

#[test]
fn every_registered_choice_list_matches_the_golden_file() {
    let golden = vocabulary();

    for (key, golden_key, expected) in [
        ("theme", "theme", THEME_PREFERENCES.to_vec()),
        ("density", "density", DENSITY_PREFERENCES.to_vec()),
        (
            "reduceMotion",
            "reduceMotion",
            REDUCE_MOTION_PREFERENCES.to_vec(),
        ),
        ("textSize", "textSize", TEXT_SIZE_PREFERENCES.to_vec()),
        ("dateFormat", "dateFormat", DATE_FORMAT_PREFERENCES.to_vec()),
        ("timeFormat", "timeFormat", TIME_FORMAT_PREFERENCES.to_vec()),
        ("language", "language", LANGUAGE_PREFERENCES.to_vec()),
    ] {
        let definition = setting_definition(key).expect("a registered choice");
        let SettingKind::Choice(choices) = definition.kind else {
            panic!("{key} is a choice");
        };
        assert_eq!(choices.to_vec(), expected, "{key} constant");
        assert_eq!(choices.to_vec(), list(&golden[golden_key]), "{key} golden");
    }
}

#[test]
fn the_registry_defaults_match_the_golden_file() {
    let golden = vocabulary();
    let defaults = AppSettings::default();
    let expected = &golden["defaults"];

    assert_eq!(defaults.theme, expected["theme"].as_str().unwrap());
    assert_eq!(defaults.density, expected["density"].as_str().unwrap());
    assert_eq!(
        defaults.reduce_motion,
        expected["reduceMotion"].as_str().unwrap()
    );
    assert_eq!(
        defaults.increase_contrast,
        expected["increaseContrast"].as_bool().unwrap()
    );
    assert_eq!(
        defaults.color_blind_assessments,
        expected["colorBlindAssessments"].as_bool().unwrap()
    );
    assert_eq!(defaults.text_size, expected["textSize"].as_str().unwrap());
    assert_eq!(
        defaults.remember_window,
        expected["rememberWindow"].as_bool().unwrap()
    );
    assert_eq!(
        defaults.date_format,
        expected["dateFormat"].as_str().unwrap()
    );
    assert_eq!(
        defaults.time_format,
        expected["timeFormat"].as_str().unwrap()
    );
    assert_eq!(defaults.language, expected["language"].as_str().unwrap());
}

#[test]
fn bootstrapped_settings_carry_the_golden_defaults() {
    let golden = vocabulary();
    let db = Db::open(":memory:").expect("in-memory database bootstraps");
    let settings = get_app_settings(db.conn()).expect("settings read");

    assert_eq!(
        settings.theme,
        golden["defaults"]["theme"].as_str().unwrap()
    );
    assert_eq!(
        settings.density,
        golden["defaults"]["density"].as_str().unwrap()
    );
    assert_eq!(settings, AppSettings::default());
}

#[test]
fn registry_accepts_every_golden_theme_and_density() {
    let golden = vocabulary();
    let db = Db::open(":memory:").expect("in-memory database bootstraps");

    for theme in list(&golden["theme"]) {
        let saved = save_app_settings(db.conn(), &update("theme", json!(theme)))
            .expect("golden theme is accepted by the registry");
        assert_eq!(saved.theme, theme);
    }
    for density in list(&golden["density"]) {
        let saved = save_app_settings(db.conn(), &update("density", json!(density)))
            .expect("golden density is accepted by the registry");
        assert_eq!(saved.density, density);
    }
}

#[test]
fn registry_rejects_a_bogus_theme_and_a_bogus_density_separately() {
    let db = Db::open(":memory:").expect("in-memory database bootstraps");

    assert!(save_app_settings(db.conn(), &update("theme", json!("bogus"))).is_err());
    assert!(save_app_settings(db.conn(), &update("density", json!("bogus"))).is_err());

    let settings = get_app_settings(db.conn()).expect("settings read");
    assert_eq!(settings.theme, AppSettings::default().theme);
    assert_eq!(settings.density, AppSettings::default().density);
}
