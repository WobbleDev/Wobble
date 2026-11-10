//! Request and id-source helpers for the tests that drive the real request boundary.
#![allow(dead_code)]

use serde_json::Value;
use wobble_core::handle::Request;
use wobble_core::id::IdSource;

const HEADER: &str = "x-wobble-worksite";

/// An id source that fails the test the moment a preview consumes one.
pub struct NoIds;

impl IdSource for NoIds {
    fn next_id(&self) -> String {
        panic!("the preview consumed an id");
    }
}

pub fn request(method: &str, path: &str, worksite: Option<&str>, body: Option<Value>) -> Request {
    let mut headers = vec![("content-type".to_owned(), "application/json".to_owned())];
    if let Some(worksite) = worksite {
        headers.push((HEADER.to_owned(), worksite.to_owned()));
    }
    Request {
        method: method.to_owned(),
        path: path.to_owned(),
        query: String::new(),
        headers,
        body: body.map(|body| body.to_string()),
    }
}
