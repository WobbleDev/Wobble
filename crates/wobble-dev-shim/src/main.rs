//! The dev/test-only HTTP shim (D01/D02): serves the `handle()` API and the static SPA on
//! one origin, so the client's relative `fetch('/api/…')` reaches the Rust core and the
//! WebKit Playwright suites can drive the real UI before the Tauri shell exists.
//!
//! It is glue, not a port: it only touches `App::open`, `App::handle`, the request and
//! response types, and `RandomId`. `WOBBLE_DB_PATH`, `WOBBLE_SHIM_PORT` and
//! `WOBBLE_STATIC_DIR` mirror `database.ts`'s default path, the dev server's port, and
//! `adapter-static`'s output directory.

mod http;

use std::fs;
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::ExitCode;

use http::{Request, Response};
use wobble_core::handle::{App, Request as ForwardedRequest, Response as ForwardedResponse};
use wobble_core::id::{CounterId, IdSource, RandomId};

/// The default database path, the same one `database.ts:6-7` falls back to.
const DEFAULT_DB_PATH: &str = ".data/workers.sqlite";

/// The dev server's port, which the Playwright suites point at.
const DEFAULT_PORT: &str = "4173";

/// The static build's output directory, where `adapter-static` writes the SPA.
const DEFAULT_STATIC_DIR: &str = "build";

/// The SPA shell every deep link falls back to.
const SPA_FALLBACK: &str = "index.html";

/// Optional deterministic IDs for repeatable isolated browser captures.
enum ShimIds {
    Counter(CounterId),
    Random,
}

impl IdSource for ShimIds {
    fn next_id(&self) -> String {
        match self {
            Self::Counter(ids) => ids.next_id(),
            Self::Random => RandomId.next_id(),
        }
    }
}

fn main() -> ExitCode {
    let path = std::env::var("WOBBLE_DB_PATH").unwrap_or_else(|_| DEFAULT_DB_PATH.to_owned());
    let port = std::env::var("WOBBLE_SHIM_PORT").unwrap_or_else(|_| DEFAULT_PORT.to_owned());
    let static_dir = PathBuf::from(
        std::env::var("WOBBLE_STATIC_DIR").unwrap_or_else(|_| DEFAULT_STATIC_DIR.to_owned()),
    );
    let ids = if std::env::var("WOBBLE_TEST_COUNTER_IDS").as_deref() == Ok("1") {
        ShimIds::Counter(CounterId::new())
    } else {
        ShimIds::Random
    };
    let address = format!("127.0.0.1:{port}");

    let listener = match TcpListener::bind(&address) {
        Ok(listener) => listener,
        Err(error) => {
            eprintln!("wobble-dev-shim: cannot listen on {address}: {error}");
            return ExitCode::FAILURE;
        }
    };

    // Match native startup: key establishment is explicit through the boot API.
    let app = App::locked(&path);
    eprintln!(
        "wobble-dev-shim: listening on http://{address} (WOBBLE_DB_PATH={path}, \
         WOBBLE_STATIC_DIR={})",
        static_dir.display()
    );

    // Connections are read on their own threads; the core is still answered one request at
    // a time, here.
    for (request, reply) in http::listen(listener) {
        let _ = reply.send(serve(&app, &static_dir, &ids, request));
    }

    ExitCode::SUCCESS
}

/// Splits a request target into the path and the query `handle()` takes separately.
fn split_url(url: &str) -> (&str, &str) {
    match url.split_once('?') {
        Some((path, query)) => (path, query),
        None => (url, ""),
    }
}

fn json_response(status: u16, body: &str) -> Response {
    Response {
        status,
        headers: vec![("Content-Type".to_owned(), "application/json".to_owned())],
        body: body.as_bytes().to_vec(),
    }
}

/// The answer for a request the shim cannot even read: a minimal 400, never a panic.
fn unreadable_request_response() -> Response {
    json_response(
        400,
        r#"{"message":"The dev shim could not read the request."}"#,
    )
}

/// The answer for a static path that is neither a file nor the SPA shell.
fn not_found_response() -> Response {
    json_response(404, r#"{"message":"Not found."}"#)
}

/// Maps a `handle()` response onto HTTP: its status, its compact JSON body, the JSON
/// content type and its own headers. `Value`'s `Display` is that compact JSON, and cannot
/// fail, so the shim needs no JSON dependency of its own.
fn to_http_response(response: ForwardedResponse) -> Response {
    let mut http = json_response(response.status, &response.body.to_string());
    http.headers.extend(response.headers);
    http
}

/// The content type for a static file, from its extension.
fn content_type(path: &Path) -> &'static str {
    match path.extension().and_then(|extension| extension.to_str()) {
        Some("html") => "text/html; charset=utf-8",
        Some("js" | "mjs") => "text/javascript",
        Some("css") => "text/css",
        Some("json" | "map") => "application/json",
        Some("svg") => "image/svg+xml",
        Some("png") => "image/png",
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("webp") => "image/webp",
        Some("ico") => "image/x-icon",
        Some("woff2") => "font/woff2",
        Some("woff") => "font/woff",
        Some("txt") => "text/plain; charset=utf-8",
        Some("webmanifest") => "application/manifest+json",
        _ => "application/octet-stream",
    }
}

/// A file as a response, with its content type and its length from the file itself.
///
/// A directory is reported as missing rather than opened: `/` resolves to the static
/// directory itself, and streaming a directory would abort the browser's navigation
/// instead of falling back to the SPA shell.
fn file_response(path: &Path) -> std::io::Result<Response> {
    if !fs::metadata(path)?.is_file() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::NotFound,
            "not a file",
        ));
    }

    Ok(Response {
        status: 200,
        headers: vec![("Content-Type".to_owned(), content_type(path).to_owned())],
        body: fs::read(path)?,
    })
}

/// True when the request path tries to climb out of the static directory.
fn climbs_out(path: &str) -> bool {
    path.split('/').any(|segment| segment == "..")
}

/// Serves one static asset: the requested file when it exists, else the SPA shell, else a
/// 404. Every failure is a response, never a panic.
fn serve_static(static_dir: &Path, path: &str) -> Response {
    let requested = static_dir.join(path.trim_start_matches('/'));
    if !climbs_out(path) {
        if let Ok(response) = file_response(&requested) {
            return response;
        }
    }

    // The adapter-static fallback: `/workers`, `/settings`, … all get the shell back.
    let fallback = static_dir.join(SPA_FALLBACK);
    match file_response(&fallback) {
        Ok(response) => response,
        Err(error) => {
            eprintln!(
                "wobble-dev-shim: cannot read {}: {error}",
                fallback.display()
            );
            not_found_response()
        }
    }
}

/// Answers one request: `/api/*` through the app, everything else from the static build.
/// Nothing in here can panic — an unreadable body or missing file is a response.
fn serve(app: &App, static_dir: &Path, ids: &ShimIds, request: Request) -> Response {
    let (path, query) = split_url(&request.url);
    let path = path.to_owned();
    let query = query.to_owned();

    // An unknown `/api/*` path still goes to `handle()` and answers its 501, never a
    // static 404.
    if !path.starts_with("/api/") {
        return serve_static(static_dir, &path);
    }

    // POST /api/backup forwards to the lifecycle owner like every other route:
    // the core keys the copy with the installation secret when unlocked and rejects
    // when locked. The UI path stays gated behind the native save dialog
    // (pickBackupPath), which does not exist in the shim/browser build, so only
    // direct API callers (e2e with owned tmp paths) reach this route here.

    let Ok(body) = String::from_utf8(request.body) else {
        eprintln!(
            "wobble-dev-shim: cannot read {} {path}: body is not UTF-8",
            request.method
        );
        return unreadable_request_response();
    };

    let forwarded = ForwardedRequest {
        method: request.method,
        path,
        query,
        headers: request.headers,
        // `{}` is a body; nothing at all is `None`, which `handle()` reads as the empty
        // string its JSON parse rejects — exactly what the Node handlers saw.
        body: if body.is_empty() { None } else { Some(body) },
    };

    to_http_response(app.handle(&forwarded, ids))
}

#[cfg(test)]
mod tests {
    use super::http::{listen, Response};
    use super::{not_found_response, IdSource, ShimIds};
    use std::io::{Read, Write};
    use std::net::{TcpListener, TcpStream};
    use std::sync::{Arc, Barrier};
    use std::time::Duration;
    use wobble_core::id::CounterId;

    /// Opens `clients` connections at once, as a browser does for a page's assets, `rounds`
    /// times on one server, closing each burst before the next. Returns how many connections
    /// were never answered.
    fn unanswered_in_bursts(clients: usize, rounds: usize) -> usize {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let requests = listen(listener);
        std::thread::spawn(move || {
            for (_, reply) in requests {
                let _ = reply.send(Response {
                    status: 200,
                    headers: vec![],
                    body: b"ok".to_vec(),
                });
            }
        });
        let mut unanswered = 0;
        for _ in 0..rounds {
            let start = Arc::new(Barrier::new(clients));
            let handles: Vec<_> = (0..clients)
                .map(|_| {
                    let start = start.clone();
                    std::thread::spawn(move || {
                        start.wait();
                        let mut stream = TcpStream::connect(("127.0.0.1", port)).unwrap();
                        stream
                            .set_read_timeout(Some(Duration::from_millis(1500)))
                            .unwrap();
                        stream
                            .write_all(b"GET / HTTP/1.1\r\nHost: shim\r\n\r\n")
                            .unwrap();
                        stream.read(&mut [0u8; 64]).is_ok_and(|n| n > 0)
                    })
                })
                .collect();
            unanswered += handles
                .into_iter()
                .map(|handle| handle.join().unwrap())
                .filter(|answered| !answered)
                .count();
        }
        unanswered
    }

    #[test]
    fn bursts_of_connections_are_always_answered_even_after_earlier_ones_closed() {
        let lost: usize = (0..20).map(|_| unanswered_in_bursts(7, 3)).sum();
        assert_eq!(lost, 0, "connections never answered");
    }

    #[test]
    fn not_found_is_a_json_404() {
        let response = not_found_response();
        assert_eq!(response.status, 404);
    }

    #[test]
    fn counter_mode_makes_isolated_capture_ids_repeatable() {
        let ids = ShimIds::Counter(CounterId::new());
        assert_eq!(ids.next_id(), "00000000-0000-4000-8000-000000000001");
        assert_eq!(ids.next_id(), "00000000-0000-4000-8000-000000000002");
    }
}
