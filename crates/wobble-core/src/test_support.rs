//! Test-only helpers for the crate's unit tests: temp database paths and the request
//! builders the handler tests share. Integration tests keep their own copy in
//! `tests/common`, because they cannot see `#[cfg(test)]` code in this crate.

/// A scratch database path under this process's temp directory. The directory is
/// created; the file is not, so a test removes any leftover copy before it writes.
pub fn temp_db_path(name: &str) -> String {
    let dir = std::env::temp_dir().join(format!("wobble-core-test-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    dir.join(name).to_string_lossy().into_owned()
}

use crate::db::{open_seeded, Db};
use crate::handle::Request;
use crate::id::CounterId;
use crate::worksite_persistence::list_worksites;
use serde_json::Value;

/// The header that names the request's Worksite.
pub const HEADER: &str = "x-wobble-worksite";

/// An in-memory database with its first Worksite seeded, and the id source that seeded it.
pub fn seeded() -> (Db, CounterId) {
    let id_source = CounterId::new();
    let db = open_seeded(":memory:", &id_source).expect("a seeded database");
    (db, id_source)
}

/// A JSON request with no Worksite header.
pub fn request(method: &str, path: &str, body: Option<Value>) -> Request {
    Request {
        method: method.to_owned(),
        path: path.to_owned(),
        query: String::new(),
        headers: vec![("content-type".to_owned(), "application/json".to_owned())],
        body: body.map(|body| serde_json::to_string(&body).unwrap_or_default()),
    }
}

/// A JSON request naming the Worksite `id` in the Worksite header.
pub fn request_for(method: &str, path: &str, id: &str, body: Option<Value>) -> Request {
    let mut request = request(method, path, body);
    request.headers.push((HEADER.to_owned(), id.to_owned()));
    request
}

/// The id of the first Worksite.
pub fn first_worksite(db: &Db) -> String {
    list_worksites(db.conn()).unwrap().remove(0).id
}
