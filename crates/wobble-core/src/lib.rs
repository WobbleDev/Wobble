//! Wobble core: the Rust crate that owns SQLite access, validation, and persistence for the Tauri app.
//!
//! D8: rusqlite (bundled-sqlcipher-vendored-openssl), serde, serde_json, uuid (v4), zeroize; one error enum;
//! no unsafe; no async; no macros beyond derive.

pub mod abbreviation;
pub mod abbreviation_lists;
pub mod abbreviation_lists_generated;
pub mod abbreviation_revision;
pub mod agitation_persistence;
pub mod app_settings;
pub mod assembly;
pub mod attribute_migration;
pub mod attribute_persistence;
pub mod configuration_preview;
pub mod configuration_resolution;
pub mod db;
pub mod error;
pub mod handle;
pub(crate) mod handlers;
pub mod id;
#[cfg(feature = "replay")]
pub mod json;
pub mod key;
pub mod language_persistence;
pub mod open_database;
pub mod phone;
pub mod read_json_request;
pub mod relationship_persistence;
pub mod replacement;
#[cfg(feature = "replay")]
pub mod replay;
pub mod request_worksite;
pub mod router;
pub mod saved_view_persistence;
pub mod schema;
pub mod select_mode;
pub mod serialization;
pub mod service;
pub(crate) mod store_validation;
#[cfg(test)]
mod test_support;
pub mod upgrade_backup;
pub mod utils;
mod work_assignment_flattening;
pub(crate) mod work_assignment_migration;
pub mod worker_draft_persistence;
pub mod worker_merge;
pub mod worker_persistence;
pub mod worker_request;
pub mod worksite_persistence;

pub use error::{Error, Result};
