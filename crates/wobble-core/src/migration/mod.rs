//! One-time conversions of stored data to its current shape. The crate root re-exports them
//! under their original names, so callers' paths are unchanged.

pub mod attribute;
pub(crate) mod work_assignment;
pub(crate) mod work_assignment_flattening;
