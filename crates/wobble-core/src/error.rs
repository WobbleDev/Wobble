//! One error enum for the whole core (D8), with no unsafe and no async.

use std::fmt;

/// Every error the core can surface, in one enum.
#[derive(Debug)]
pub enum Error {
    /// A SQLite error from rusqlite.
    Database(rusqlite::Error),
    /// A JSON (de)serialization error.
    Json(serde_json::Error),
    /// A database whose schema version is unsupported (rust-only.md §6.14).
    UnsupportedSchema(String),
    /// A plain message, for parity with the Node handlers' uncaught throws.
    Message(String),
    /// A diagnostic with an explicit stable code (ADR-0024), so copy edits cannot change
    /// the wire code the UI maps to user words.
    Coded {
        /// The stable wire code.
        code: &'static str,
        /// The diagnostic message beside it.
        message: String,
    },
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Error::Database(error) => write!(f, "{error}"),
            Error::Json(error) => write!(f, "{error}"),
            Error::UnsupportedSchema(message)
            | Error::Message(message)
            | Error::Coded { message, .. } => write!(f, "{message}"),
        }
    }
}

impl std::error::Error for Error {}

impl From<rusqlite::Error> for Error {
    fn from(error: rusqlite::Error) -> Self {
        Error::Database(error)
    }
}

impl From<serde_json::Error> for Error {
    fn from(error: serde_json::Error) -> Self {
        Error::Json(error)
    }
}

impl Error {
    /// A diagnostic carrying its stable wire code, so editing the message cannot change
    /// the code the UI maps (ADR-0024).
    pub fn coded(code: &'static str, message: impl Into<String>) -> Self {
        Error::Coded {
            code,
            message: message.into(),
        }
    }

    /// The stable code the Worker edit flow's client maps to user copy (ADR-0024). A
    /// None keeps the reply uncoded for the flows whose codes are a later pass; every
    /// code here leaves the diagnostic message untouched beside it.
    pub fn code(&self) -> Option<&'static str> {
        match self {
            Error::Database(_) => Some("database"),
            Error::Coded { code, .. } => Some(code),
            Error::Message(message) if is_stored_data_invalid(message) => {
                Some("stored_data_invalid")
            }
            Error::Message(message) if message.contains("belongs to another Worksite") => {
                Some("vocabulary_other_worksite")
            }
            _ => None,
        }
    }
}

fn is_stored_data_invalid(message: &str) -> bool {
    message.starts_with("Invalid ") && message.contains(" stored")
}

pub type Result<T> = std::result::Result<T, Error>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codes_the_families_the_worker_flow_maps_and_leaves_the_rest_uncoded() {
        assert_eq!(
            Error::Database(rusqlite::Error::QueryReturnedNoRows).code(),
            Some("database")
        );
        for message in [
            "Invalid notes stored for worker w1.",
            "Invalid assessment stored for worker w1.",
            "Invalid worker attribute configuration stored in the database.",
        ] {
            assert_eq!(
                Error::Message(message.to_owned()).code(),
                Some("stored_data_invalid"),
                "{message}"
            );
        }
        assert_eq!(
            Error::Message("Agitation \"shared\" belongs to another Worksite.".to_owned()).code(),
            Some("vocabulary_other_worksite")
        );
        assert_eq!(Error::Message("Worker not found.".to_owned()).code(), None);
        assert_eq!(
            Error::coded("attribute_scope_in_use", "Any copy at all.").code(),
            Some("attribute_scope_in_use"),
            "an explicit code does not depend on the message"
        );
        assert_eq!(
            Error::coded("configuration_merge_invalid", "Any copy at all.").to_string(),
            "Any copy at all."
        );
    }
}
