//! Wobble core: the Rust crate that owns SQLite access, validation, and persistence for the Tauri app.
//!
//! D8: rusqlite (bundled-sqlcipher-vendored-openssl), serde, serde_json, uuid (v4), zeroize; one error enum;
//! no unsafe; no async; no macros beyond derive.

pub mod abbreviation;
pub mod app_settings;
pub mod assembly;
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
pub mod migration;
pub mod open_database;
pub mod persistence;
pub mod phone;
pub mod read_json_request;
pub mod replacement;
#[cfg(feature = "replay")]
pub mod replay;
pub mod request_worksite;
pub mod router;
pub mod safety_copies;
pub mod schema;
pub mod select_mode;
pub mod serialization;
pub mod service;
pub(crate) mod store_validation;
#[cfg(test)]
mod test_support;
pub mod upgrade_backup;
pub mod utils;
pub mod worker_merge;
pub mod worker_request;

// Stable crate-root paths for the grouped modules.
pub use abbreviation::{
    lists as abbreviation_lists, lists_generated as abbreviation_lists_generated,
    revision as abbreviation_revision,
};
pub use migration::attribute as attribute_migration;
pub(crate) use migration::work_assignment as work_assignment_migration;
pub(crate) use migration::work_assignment_flattening;
pub use persistence::{
    agitation as agitation_persistence, attribute as attribute_persistence,
    language as language_persistence, relationship as relationship_persistence,
    saved_view as saved_view_persistence, worker as worker_persistence,
    worker_draft as worker_draft_persistence, worksite as worksite_persistence,
};

pub use error::{Error, Result};
