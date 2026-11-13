//! The v23 migration gives every stored Attribute value a generated Short form (ADR 0046)
//! through the public open lifecycle, from v22 and from every older upgradable version.

mod common;

use common::legacy_db::{
    add_attribute, add_worksite, finish_source, migration_rows, raw_version, start_source,
};
use rusqlite::Connection;
use serde_json::{json, Value};
use wobble_core::handle::{App, Request};
use wobble_core::id::RandomId;

const WS: &str = "ws-short";

fn dataset(app: &App) -> Value {
    let response = app.handle(
        &Request {
            method: "GET".to_owned(),
            path: "/api/dataset".to_owned(),
            query: String::new(),
            headers: vec![("x-wobble-worksite".to_owned(), WS.to_owned())],
            body: None,
        },
        &RandomId,
    );
    assert_eq!(response.status, 200, "{}", response.body);
    response.body
}

#[test]
fn every_upgradable_version_backfills_a_generated_abbreviation_for_every_value() {
    for version in [12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22] {
        let (path, conn) = start_source("abbreviations", &format!("v{version}"));
        add_worksite(&conn, WS, "Versioned");
        add_attribute(
            &conn,
            WS,
            "dept",
            "Department",
            "category",
            "worker",
            true,
            &[("front", "Front"), ("long", "Back of House Maintenance")],
            0,
        );
        finish_source(&path, conn, version);

        let app = App::open_legacy_fixture(&path);
        let data = dataset(&app);
        // LEGACY-PLAINTEXT-FIXTURE: temp-constructed legacy-schema source for upgrade-read test (intentional plaintext, never production).
        let conn = Connection::open(&path).expect("opens the upgraded database");
        assert_eq!(raw_version(&conn), Some(25), "v{version}");
        assert_eq!(
            migration_rows(&conn).last().unwrap(),
            &(25, "committee-goal".to_owned()),
            "v{version}"
        );
        let options = &data["attributes"][0]["options"];
        let by_value = |text: &str| -> Value {
            options
                .as_array()
                .unwrap()
                .iter()
                .find(|option| option["value"] == text)
                .unwrap_or_else(|| panic!("v{version}: {text} is configured"))
                .clone()
        };
        let front = by_value("Front");
        assert_eq!(front["shortForm"], "Front", "v{version}");
        assert_eq!(front["shortFormOrigin"], "generated", "v{version}");
        let long = by_value("Back of House Maintenance");
        assert_eq!(long["shortForm"], "BHM", "v{version}");
        assert_eq!(long["shortFormOrigin"], "generated", "v{version}");
        // The stored options carry the fields too, so a later read needs no backfill.
        let stored: String = conn
            .query_row(
                "SELECT options FROM worker_attributes WHERE id = 'dept'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let stored: Value = serde_json::from_str(&stored).unwrap();
        // Versions before v14 mint fresh answer ids, so the stored shape is compared without it.
        let mut first = stored[0].clone();
        first.as_object_mut().unwrap().remove("id");
        assert_eq!(
            first,
            json!({ "value": "Front", "shortForm": "Front", "shortFormOrigin": "generated" }),
            "v{version}"
        );
        std::fs::remove_file(&path).ok();
    }
}
