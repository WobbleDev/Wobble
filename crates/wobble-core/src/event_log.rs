//! The diagnostics log: a short, rotating record of what the app did and what went wrong.
//!
//! It is built so it cannot hold personal data. A line is a timestamp, a level, an event name
//! and `key=value` fields, and every part is chosen from what the code can prove is safe:
//! the event name and any fixed word are `&'static str`, a number is a number, and the only
//! text that comes from outside (an error code, an id) goes through [`Field::code`] or
//! [`Field::id`], which keep it only when it has the exact shape of a code or an id and
//! otherwise write `invalid`. There is no way to log a message, a name, an email, a note, a
//! phone number, a path or any other free text, because no function here accepts one.
//!
//! The newest events go to `wobble.log`; at [`MAX_FILE_BYTES`] it rotates to `wobble.1.log`,
//! and so on up to [`FILES_KEPT`] files, so the log never grows past a few hundred kilobytes.
//! Writing is best effort: a log that cannot be written never fails the request that logged.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

/// The live file; rotated copies are `wobble.1.log` (newest) to `wobble.4.log` (oldest).
const LIVE_FILE: &str = "wobble.log";
/// A file rotates once it reaches this size.
pub const MAX_FILE_BYTES: u64 = 256 * 1024;
/// How many files exist at most, the live one included.
pub const FILES_KEPT: usize = 5;
/// The most lines one read returns.
pub const MAX_RECENT_LINES: usize = 1000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Level {
    Info,
    Warn,
    Error,
}

impl Level {
    fn word(self) -> &'static str {
        match self {
            Self::Info => "INFO",
            Self::Warn => "WARN",
            Self::Error => "ERROR",
        }
    }
}

/// One `key=value` of a log line. The only ways to make one are the constructors below.
pub struct Field {
    key: &'static str,
    value: String,
}

impl Field {
    /// A fixed word chosen by the code.
    pub fn word(key: &'static str, value: &'static str) -> Self {
        Self {
            key,
            value: value.to_owned(),
        }
    }

    /// A number such as an HTTP status.
    pub fn number(key: &'static str, value: u64) -> Self {
        Self {
            key,
            value: value.to_string(),
        }
    }

    /// An error code: lowercase letters, digits, `_` and `.`, up to 64 long. Anything else is
    /// written as `invalid`.
    pub fn code(key: &'static str, value: &str) -> Self {
        let shaped = !value.is_empty()
            && value.len() <= 64
            && value
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_' || b == b'.');
        Self {
            key,
            value: if shaped { value } else { "invalid" }.to_owned(),
        }
    }

    /// An id: letters, digits and `-`, up to 64 long, which is every id the app generates.
    /// Anything else (an email, a name, a path) is written as `invalid`.
    pub fn id(key: &'static str, value: &str) -> Self {
        let shaped = !value.is_empty()
            && value.len() <= 64
            && value
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-');
        Self {
            key,
            value: if shaped { value } else { "invalid" }.to_owned(),
        }
    }
}

/// A log folder. Cheap to hold; every call opens the file it needs.
pub struct EventLog {
    dir: PathBuf,
}

impl EventLog {
    pub fn new(dir: impl Into<PathBuf>) -> Self {
        Self { dir: dir.into() }
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    fn file(&self, index: usize) -> PathBuf {
        if index == 0 {
            self.dir.join(LIVE_FILE)
        } else {
            self.dir.join(format!("wobble.{index}.log"))
        }
    }

    /// Appends one event. `name` is a fixed snake_case word such as `request_failed`.
    pub fn record(&self, level: Level, name: &'static str, fields: &[Field]) {
        let mut line = format!("{} {} {name}", iso_utc_now(), level.word());
        for field in fields {
            line.push(' ');
            line.push_str(field.key);
            line.push('=');
            line.push_str(&field.value);
        }
        line.push('\n');
        let _ = self.append(&line);
    }

    fn append(&self, line: &str) -> std::io::Result<()> {
        std::fs::create_dir_all(&self.dir)?;
        let live = self.file(0);
        if std::fs::metadata(&live).is_ok_and(|meta| meta.len() >= MAX_FILE_BYTES) {
            self.rotate();
        }
        let mut file = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(live)?;
        file.write_all(line.as_bytes())
    }

    /// Drops the oldest file and shifts the rest up by one.
    fn rotate(&self) {
        let _ = std::fs::remove_file(self.file(FILES_KEPT - 1));
        for index in (0..FILES_KEPT - 1).rev() {
            let _ = std::fs::rename(self.file(index), self.file(index + 1));
        }
    }

    /// The newest `count` lines (at most [`MAX_RECENT_LINES`]), oldest first. A missing log is
    /// an empty list.
    pub fn recent(&self, count: usize) -> Vec<String> {
        let count = count.clamp(1, MAX_RECENT_LINES);
        let mut lines: Vec<String> = Vec::new();
        for index in (0..FILES_KEPT).rev() {
            if let Ok(text) = std::fs::read_to_string(self.file(index)) {
                lines.extend(text.lines().map(str::to_owned));
            }
            if lines.len() > count {
                lines.drain(..lines.len() - count);
            }
        }
        lines
    }
}

/// The routes the app has, with each id-carrying one written as a pattern, so a log line names
/// a route and never the id-or-name-shaped text a request put in its path.
const ROUTES: &[&str] = &[
    "/api/boot-status",
    "/api/boot-create",
    "/api/boot-unlock",
    "/api/boot-change-passphrase",
    "/api/worksite/counts",
    "/api/worksite/active",
    "/api/worksite",
    "/api/attributes",
    "/api/configuration/preview",
    "/api/configuration/abbreviations",
    "/api/agitations",
    "/api/languages",
    "/api/worker-merge/preview",
    "/api/worker-merge/undo",
    "/api/worker-merge/dismiss",
    "/api/worker-merge",
    "/api/workers",
    "/api/dataset",
    "/api/views",
    "/api/runtime",
    "/api/settings",
    "/api/backup",
    "/api/auto-backup/run",
    "/api/auto-backup",
    "/api/data-file",
    "/api/restore",
    "/api/erase",
    "/api/logs",
    "/api/worker-drafts/:id",
    "/api/views/:id",
    "/api/workers/:id",
];

/// The route a path belongs to, and the id in its last segment when it has one. A path that
/// matches no known route is `unknown`, whatever it contains.
pub fn route_of(path: &str) -> (&'static str, Option<&str>) {
    if let Some(route) = ROUTES
        .iter()
        .find(|route| !route.ends_with(":id") && **route == path)
    {
        return (route, None);
    }
    for route in ROUTES.iter().filter(|route| route.ends_with(":id")) {
        let prefix = &route[..route.len() - 3];
        if let Some(id) = path.strip_prefix(prefix).filter(|id| !id.is_empty()) {
            return (route, Some(id));
        }
    }
    ("unknown", None)
}

/// A request method as a fixed word.
pub fn method_word(method: &str) -> &'static str {
    match method {
        "GET" => "GET",
        "POST" => "POST",
        "PUT" => "PUT",
        "PATCH" => "PATCH",
        "DELETE" => "DELETE",
        _ => "OTHER",
    }
}

/// `2026-11-22T16:00:14Z` for the current time, with no date library: the standard
/// days-since-epoch to civil-date conversion.
fn iso_utc_now() -> String {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_secs());
    iso_utc(secs)
}

fn iso_utc(secs: u64) -> String {
    let days = (secs / 86_400) as i64;
    let rest = secs % 86_400;
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let day_of_era = z.rem_euclid(146_097);
    let year_of_era =
        (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_index = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_index + 2) / 5 + 1;
    let month = if month_index < 10 {
        month_index + 3
    } else {
        month_index - 9
    };
    let year = year_of_era + era * 400 + i64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z",
        rest / 3_600,
        rest % 3_600 / 60,
        rest % 60
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("wobble-log-{name}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn timestamps_are_utc_calendar_dates() {
        assert_eq!(iso_utc(0), "1970-01-01T00:00:00Z");
        assert_eq!(iso_utc(951_782_400 + 3_661), "2000-02-29T01:01:01Z");
        assert_eq!(iso_utc(1_795_363_214), "2026-11-22T16:00:14Z");
    }

    #[test]
    fn only_code_and_id_shaped_text_gets_through() {
        assert_eq!(
            Field::code("code", "restore_failed").value,
            "restore_failed"
        );
        assert_eq!(
            Field::id("id", "0b8e1c52-4f7a-4d2e-9c31-7a5f2d6e8b90")
                .value
                .len(),
            36
        );
        for hostile in [
            "zed.testname@example.test",
            "Zed Testname",
            "zed\nERROR forged_line",
            "/Users/example/backup.sqlite",
            "",
            &"a".repeat(65),
        ] {
            assert_eq!(Field::id("id", hostile).value, "invalid", "{hostile:?}");
            assert_eq!(Field::code("code", hostile).value, "invalid", "{hostile:?}");
        }
    }

    #[test]
    fn routes_are_patterns_and_unknown_paths_are_not_echoed() {
        assert_eq!(route_of("/api/settings"), ("/api/settings", None));
        assert_eq!(route_of("/api/workers"), ("/api/workers", None));
        assert_eq!(
            route_of("/api/workers/abc-123"),
            ("/api/workers/:id", Some("abc-123"))
        );
        assert_eq!(
            route_of("/api/zed.testname@example.test"),
            ("unknown", None)
        );
        assert_eq!(route_of("/somewhere/else"), ("unknown", None));
    }

    #[test]
    fn a_line_is_timestamp_level_event_and_fields_and_recent_reads_them_back() {
        let dir = scratch("line");
        let log = EventLog::new(&dir);
        assert!(log.recent(10).is_empty());
        log.record(
            Level::Warn,
            "request_failed",
            &[
                Field::word("method", "GET"),
                Field::number("status", 400),
                Field::code("code", "worker_invalid"),
            ],
        );
        log.record(Level::Info, "app_started", &[]);
        let lines = log.recent(10);
        assert_eq!(lines.len(), 2);
        assert!(lines[0].ends_with("WARN request_failed method=GET status=400 code=worker_invalid"));
        assert!(lines[1].ends_with("INFO app_started"));
        assert_eq!(log.recent(1), vec![lines[1].clone()]);
    }

    #[test]
    fn the_log_rotates_and_keeps_a_bounded_number_of_files_with_the_newest_lines() {
        let dir = scratch("rotate");
        let log = EventLog::new(&dir);
        let line = "x".repeat(1_000);
        // Enough to rotate more than FILES_KEPT times.
        for _ in 0..(MAX_FILE_BYTES as usize / 1_000 + 1) * (FILES_KEPT + 2) {
            log.append(&format!("{line}\n")).unwrap();
        }
        log.record(Level::Info, "newest_event", &[]);
        let files = std::fs::read_dir(&dir).unwrap().count();
        assert_eq!(files, FILES_KEPT);
        let total: u64 = std::fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .map(|entry| entry.metadata().unwrap().len())
            .sum();
        assert!(total < MAX_FILE_BYTES * (FILES_KEPT as u64 + 1));
        assert!(log.recent(1)[0].ends_with("newest_event"));
        assert_eq!(log.recent(5_000).len(), MAX_RECENT_LINES);
    }
}
