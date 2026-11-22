//! What the app writes to the diagnostics log about a request: its method, the route it
//! matched, the status it got and the error code, and nothing else. See [`crate::event_log`].

use crate::event_log::{method_word, route_of, EventLog, Field, Level};
use crate::handle::{Request, Response};

/// The routes that change what the installation holds or how it is protected. Each is logged
/// whatever the outcome, so a support reader sees that a Restore ran, and how it ended.
const LIFECYCLE: [(&str, &str); 7] = [
    ("POST", "/api/boot-create"),
    ("POST", "/api/boot-unlock"),
    ("POST", "/api/boot-change-passphrase"),
    ("POST", "/api/restore"),
    ("POST", "/api/erase"),
    ("POST", "/api/backup"),
    ("POST", "/api/auto-backup/run"),
];

/// Logs one answered request, if it is worth a line: a lifecycle route always, anything else
/// only when it failed. The locked answer a boot screen gets for every poll is not a failure.
pub(crate) fn log_exchange(log: &EventLog, request: &Request, response: &Response) {
    let (route, id) = route_of(&request.path);
    let lifecycle = LIFECYCLE
        .iter()
        .any(|(method, path)| *method == request.method && *path == request.path);
    let failed = response.status >= 400 && response.status != 423;
    if !lifecycle && !failed {
        return;
    }
    let level = match response.status {
        500.. => Level::Error,
        400..=499 => Level::Warn,
        _ => Level::Info,
    };
    let mut fields = vec![
        Field::word("method", method_word(&request.method)),
        Field::word("route", route),
        Field::number("status", u64::from(response.status)),
    ];
    if let Some(code) = response.body.get("code").and_then(|code| code.as_str()) {
        fields.push(Field::code("code", code));
    }
    if let Some(id) = id {
        fields.push(Field::id("id", id));
    }
    log.record(level, "request", &fields);

    // A scheduled copy that could not be written answers 200 with the failure in its body.
    if request.path == "/api/auto-backup/run"
        && response
            .body
            .pointer("/autoBackup/failure")
            .is_some_and(|failure| !failure.is_null())
    {
        log.record(Level::Warn, "auto_backup_failed", &[]);
    }
}
