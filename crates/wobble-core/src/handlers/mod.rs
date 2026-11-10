//! The request handlers, one module per resource. `router::dispatch` picks the handler;
//! each handler parses the request, calls persistence or the service, and maps the result
//! to a response.

pub(crate) mod attributes;
pub(crate) mod backup;
pub(crate) mod configuration;
pub(crate) mod data;
pub(crate) mod datasets;
pub(crate) mod drafts;
pub(crate) mod runtime;
pub(crate) mod settings;
pub(crate) mod views;
pub(crate) mod vocabulary;
pub(crate) mod worker_merge;
pub(crate) mod workers;
pub(crate) mod worksite;
