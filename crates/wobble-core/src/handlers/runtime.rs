//! The runtime's own identity: what build is running, where it runs, and the schema the
//! active database carries. A value the process cannot resolve is null, never a sample.

use std::env::consts::{ARCH, OS};

use rusqlite::Connection;
use serde::Serialize;

use crate::db::Db;
use crate::error::Result;
use crate::handle::Response;
use crate::router::json_response;

const BUILD_PROFILE: &str = if cfg!(debug_assertions) {
    "debug"
} else {
    "release"
};

/// Success body for `GET /api/runtime`: the running installation's identity.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
struct RuntimeReply {
    app_version: Option<&'static str>,
    build: String,
    platform: String,
    #[cfg_attr(feature = "ts", ts(type = "number | null"))]
    schema_version: Option<i64>,
}

/// `GET /api/runtime` — the running installation, read from the process itself. It names no
/// Worksite, so it answers the same whichever Worksite a request carries (or none).
pub(crate) fn get_runtime(db: &Db) -> Result<Response> {
    Ok(json_response(
        200,
        serde_json::to_value(RuntimeReply {
            app_version: non_empty(env!("CARGO_PKG_VERSION")),
            build: format!(
                "{} {} ({})",
                env!("CARGO_PKG_NAME"),
                env!("CARGO_PKG_VERSION"),
                BUILD_PROFILE
            ),
            platform: format!("{} · {}", os_name(), architecture()),
            schema_version: active_schema_version(db.conn()),
        })?,
    ))
}

fn non_empty(value: &str) -> Option<&str> {
    (!value.trim().is_empty()).then_some(value)
}

fn os_name() -> &'static str {
    match OS {
        "macos" => "macOS",
        "windows" => "Windows",
        "linux" => "Linux",
        other => other,
    }
}

fn architecture() -> &'static str {
    match ARCH {
        "aarch64" => "Apple silicon",
        "x86_64" => "Intel",
        "x86" => "32-bit x86",
        other => other,
    }
}

/// The schema the active database actually carries, or null when it cannot be read.
fn active_schema_version(conn: &Connection) -> Option<i64> {
    conn.query_row("SELECT MAX(version) FROM schema_migrations", [], |row| {
        row.get::<_, Option<i64>>(0)
    })
    .ok()
    .flatten()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::schema::CURRENT_SCHEMA_VERSION;
    use crate::test_support::seeded;
    use serde_json::json;

    #[test]
    fn product_gap_15_answers_the_running_build_platform_and_schema() {
        let (db, _ids) = seeded();
        let response = get_runtime(&db).expect("the runtime route answers");

        assert_eq!(response.status, 200);
        let body = &response.body;
        assert_eq!(body["appVersion"], json!(env!("CARGO_PKG_VERSION")));
        assert!(body["build"]
            .as_str()
            .unwrap()
            .contains(env!("CARGO_PKG_VERSION")));
        assert!(body["build"].as_str().unwrap().contains(BUILD_PROFILE));
        assert_eq!(body["schemaVersion"], json!(CURRENT_SCHEMA_VERSION));
        assert!(!body["platform"].as_str().unwrap().is_empty());

        // The old About samples must not survive as plausible-looking metadata.
        assert_ne!(body["build"], json!("a1b2c3d · 19 Oct 2026"));
        assert_ne!(body["schemaVersion"], json!(13));
    }

    #[test]
    fn product_gap_15_reads_the_active_database_schema() {
        let (db, _ids) = seeded();
        let reported = get_runtime(&db).unwrap().body["schemaVersion"].clone();
        let applied: i64 = db
            .conn()
            .query_row("SELECT MAX(version) FROM schema_migrations", [], |row| {
                row.get(0)
            })
            .unwrap();

        assert_eq!(reported, json!(applied));
    }
}
