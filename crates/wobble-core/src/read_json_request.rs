//! Reads a request body as JSON, returning the core's error when it is malformed.

use serde_json::Value;

use crate::error::{Error, Result};

/// `readJsonRequest` minus the transport: parses the request body or blames it.
/// The 400 status is wired in C04; here the parse and its exact message live.
pub fn read_json_request(body: &str) -> Result<Value> {
    serde_json::from_str(body)
        .map_err(|_| Error::Message("Request body must contain valid JSON.".to_owned()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parses_a_json_body() {
        assert_eq!(read_json_request("{\"a\":1}").unwrap(), json!({ "a": 1 }));
    }

    #[test]
    fn reports_the_shared_message_for_a_bad_body() {
        let error = read_json_request("{").unwrap_err();

        assert!(
            matches!(error, Error::Message(message) if message == "Request body must contain valid JSON.")
        );
    }
}
