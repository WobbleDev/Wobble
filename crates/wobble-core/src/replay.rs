//! The Rust replay harness: reads contract/fixtures/scenarios.json, filters by
//! scenario-name prefix, replays through router::dispatch, and compares status +
//! canonical JSON body + normalized DB dump.

use std::collections::{BTreeMap, HashMap};
use std::path::Path;

use rusqlite::{types::ValueRef, Connection, Row};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::db::{open_seeded, Db};
use crate::handle::Request;
use crate::id::{CounterId, IdSource};
use crate::{json, router};

/// Scenario-name prefixes whose routes were not yet ported to routing. Each C ticket
/// removed one or more; C09 ported the last of them (`dataset/`), so this is empty and
/// every scenario of the fixture replays.
pub const NOT_YET_PORTED_PREFIXES: &[&str] = &[];

/// Ported-prefix scenarios that still called a later ticket's routes. C09 left this empty
/// too: `workers/relationship-symmetry` and `workers/relationship-sort` end in
/// `GET /api/dataset`, which C09 ported.
pub const NOT_YET_PORTED_SCENARIOS: &[&str] = &[];

/// True once the scenario's route set is ported (and so should be replayed). With both
/// lists empty this is every scenario; the mechanism stays until the port is retired.
pub fn is_ported(name: &str) -> bool {
    !NOT_YET_PORTED_PREFIXES
        .iter()
        .any(|prefix| name.starts_with(prefix))
        && !NOT_YET_PORTED_SCENARIOS.contains(&name)
}

#[derive(Debug, Deserialize, Serialize)]
pub struct Fixture {
    pub version: u32,
    pub scenarios: Vec<Scenario>,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct Scenario {
    pub name: String,
    #[serde(default)]
    pub checklist: Vec<u32>,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub setup: Setup,
    pub steps: Vec<Step>,
    #[serde(default)]
    pub state: BTreeMap<String, Vec<Value>>,
}

#[derive(Debug, Default, Deserialize, Serialize)]
pub struct Setup {
    #[serde(default)]
    pub sql: Vec<String>,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct Step {
    pub request: RequestRecord,
    pub response: ResponseRecord,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct RequestRecord {
    pub method: String,
    pub path: String,
    #[serde(default)]
    pub headers: BTreeMap<String, String>,
    #[serde(default)]
    pub body: Option<Value>,
    /// True when body is a deliberately malformed JSON string sent verbatim.
    #[serde(default, rename = "rawBody")]
    pub raw_body: bool,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct ResponseRecord {
    pub status: u16,
    pub body: Value,
}

/// Loads and parses the fixture file.
pub fn load_scenarios(path: &str) -> crate::Result<Fixture> {
    let text =
        std::fs::read_to_string(path).map_err(|error| crate::Error::Message(error.to_string()))?;
    let fixture: Fixture = serde_json::from_str(&text)?;
    Ok(fixture)
}

/// The absolute path to contract/fixtures/scenarios.json from a workspace checkout.
pub fn fixture_path() -> String {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../contract/fixtures/scenarios.json")
        .to_string_lossy()
        .into_owned()
}

/// Answer ids are minted by the core (ADR 0030), so the recorded ids differ from a replay's.
/// Both sides rename each answer id to `answer#n`, numbered by first appearance in the
/// Worker attributes, so the comparison still checks which answers each value and option
/// refers to.
fn normalize_answer_ids(state: &mut BTreeMap<String, Vec<Value>>) {
    fn option_ids(options: &str) -> Vec<String> {
        serde_json::from_str::<Vec<Value>>(options)
            .unwrap_or_default()
            .iter()
            .filter_map(|answer| answer["id"].as_str().map(str::to_owned))
            .collect()
    }

    let mut placeholders: HashMap<String, String> = HashMap::new();
    for row in state.get("worker_attributes").into_iter().flatten() {
        if let Some(options) = row["options"].as_str() {
            for id in option_ids(options) {
                let next = format!("answer#{}", placeholders.len() + 1);
                placeholders.entry(id).or_insert(next);
            }
        }
    }
    if placeholders.is_empty() {
        return;
    }

    let rename = |value: &Value| -> Value {
        match value {
            Value::String(text) => placeholders
                .get(text)
                .map_or_else(|| value.clone(), |name| Value::String(name.clone())),
            Value::Array(items) => Value::Array(
                items
                    .iter()
                    .map(
                        |item| match item.as_str().and_then(|text| placeholders.get(text)) {
                            Some(name) => Value::String(name.clone()),
                            None => item.clone(),
                        },
                    )
                    .collect(),
            ),
            _ => value.clone(),
        }
    };

    for table in ["worker_attributes", "worker_attribute_values"] {
        let Some(rows) = state.get_mut(table) else {
            continue;
        };
        for row in rows.iter_mut() {
            let column = if table == "worker_attributes" {
                "options"
            } else {
                "value"
            };
            let Some(text) = row[column].as_str().map(str::to_owned) else {
                continue;
            };
            let Ok(parsed) = serde_json::from_str::<Value>(&text) else {
                continue;
            };
            let renamed = if table == "worker_attributes" {
                Value::Array(
                    parsed
                        .as_array()
                        .into_iter()
                        .flatten()
                        .map(|answer| {
                            let mut answer = answer.clone();
                            if let Some(id) = answer["id"].as_str().map(str::to_owned) {
                                answer["id"] = rename(&Value::String(id));
                            }
                            answer
                        })
                        .collect(),
                )
            } else {
                rename(&parsed)
            };
            row[column] = Value::String(serde_json::to_string(&renamed).unwrap_or(text));
        }
    }
}

const DUMPED_TABLES: &[&str] = &[
    "worksites",
    "workers",
    "worker_relationships",
    "worker_attributes",
    "worker_attribute_values",
    "agitations",
    "worker_agitations",
    "languages",
    "worker_languages",
    "app_settings",
    "worker_drafts",
    "schema_migrations",
];

fn row_to_json(row: &Row) -> rusqlite::Result<Value> {
    let count = row.as_ref().column_count();
    let mut map = serde_json::Map::new();
    for index in 0..count {
        let name = row.as_ref().column_name(index).unwrap_or("").to_owned();
        let value = match row.get_ref(index)? {
            ValueRef::Null => Value::Null,
            ValueRef::Integer(integer) => Value::Number(integer.into()),
            ValueRef::Real(real) => serde_json::Number::from_f64(real)
                .map(Value::Number)
                .unwrap_or(Value::Null),
            ValueRef::Text(text) => Value::String(String::from_utf8_lossy(text).into_owned()),
            ValueRef::Blob(blob) => Value::String(String::from_utf8_lossy(blob).into_owned()),
        };
        map.insert(name, value);
    }
    Ok(Value::Object(map))
}

/// Dumps the compared current tables, ORDER BY rowid, each row canonicalized (keys sorted,
/// applied_at pinned). The removed assignment tables are not part of the current schema.
pub fn dump_state(conn: &Connection) -> crate::Result<BTreeMap<String, Vec<Value>>> {
    let mut state = BTreeMap::new();
    for table in DUMPED_TABLES {
        let mut statement = conn.prepare(&format!("SELECT * FROM {table} ORDER BY rowid"))?;
        let rows = statement.query_map([], row_to_json)?;
        let mut table_rows = Vec::new();
        for row in rows {
            let mut value = row?;
            json::normalize(&mut value);
            pin_stamps(&mut value);
            table_rows.push(value);
        }
        state.insert((*table).to_owned(), table_rows);
    }
    Ok(state)
}

fn build_request(record: &RequestRecord) -> Request {
    let body = match &record.body {
        None => None,
        Some(value) if record.raw_body => value.as_str().map(|s| s.to_owned()),
        Some(value) => Some(serde_json::to_string(value).unwrap_or_default()),
    };
    Request {
        method: record.method.clone(),
        path: record.path.clone(),
        query: String::new(),
        headers: record
            .headers
            .iter()
            .map(|(name, value)| (name.clone(), value.clone()))
            .collect(),
        body,
    }
}

/// Replays one scenario against a fresh seeded database and compares every step plus the
/// final dump. Returns an Err describing the first mismatch.
pub fn run_scenario(db: &Db, scenario: &Scenario, id_source: &impl IdSource) -> crate::Result<()> {
    let conn = db.conn();
    for statement in &scenario.setup.sql {
        conn.execute_batch(statement)?;
    }

    for step in &scenario.steps {
        let response = router::dispatch(db, &build_request(&step.request), id_source);
        if response.status != step.response.status {
            return Err(crate::Error::Message(format!(
                "{}: {} {} expected status {}, got {}",
                scenario.name,
                step.request.method,
                step.request.path,
                step.response.status,
                response.status
            )));
        }
        let mut actual = response.body;
        json::normalize(&mut actual);
        pin_stamps(&mut actual);
        let mut expected = step.response.body.clone();
        json::normalize(&mut expected);
        pin_stamps(&mut expected);
        if actual != expected {
            return Err(crate::Error::Message(format!(
                "{}: {} {} response body mismatch",
                scenario.name, step.request.method, step.request.path
            )));
        }
    }

    let mut state = dump_state(conn)?;
    let mut expected = scenario.state.clone();
    normalize_answer_ids(&mut state);
    normalize_answer_ids(&mut expected);
    if state != expected {
        return Err(crate::Error::Message(format!(
            "{}: database dump mismatch",
            scenario.name
        )));
    }

    Ok(())
}

/// Stamps the core writes from the wall clock (a Worker draft's `updatedAt` and its table's
/// `updated_at`) are pinned to "$t", as `applied_at` is, so a re-record stays byte-stable.
fn pin_stamps(value: &mut Value) {
    match value {
        Value::Object(map) => {
            for (key, child) in map.iter_mut() {
                if matches!(key.as_str(), "updatedAt" | "updated_at") && child.is_string() {
                    *child = Value::String("$t".to_owned());
                } else {
                    pin_stamps(child);
                }
            }
        }
        Value::Array(items) => items.iter_mut().for_each(pin_stamps),
        _ => {}
    }
}

/// Re-records one scenario from the current core: each step's observed status and canonical
/// body, and the final dump, replace the recorded ones. Setup SQL runs first, as in
/// `run_scenario`, on a fresh seeded database with its own counter.
pub fn record_scenario(scenario: &mut Scenario) -> crate::Result<()> {
    let id_source = CounterId::new();
    let db = open_seeded(":memory:", &id_source)?;
    let conn = db.conn();
    for statement in &scenario.setup.sql {
        conn.execute_batch(statement)?;
    }
    for step in &mut scenario.steps {
        let response = router::dispatch(&db, &build_request(&step.request), &id_source);
        let mut body = response.body;
        json::normalize(&mut body);
        pin_stamps(&mut body);
        step.response = ResponseRecord {
            status: response.status,
            body,
        };
    }
    scenario.state = dump_state(conn)?;

    Ok(())
}
