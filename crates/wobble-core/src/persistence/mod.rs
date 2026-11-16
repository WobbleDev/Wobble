//! Each module here owns the stored form of one kind of record. The crate root re-exports them
//! under their original `*_persistence` names, so callers' paths are unchanged.

pub mod agitation;
pub mod attribute;
pub mod language;
pub mod relationship;
pub mod saved_view;
pub mod worker;
pub mod worker_draft;
pub mod worksite;
