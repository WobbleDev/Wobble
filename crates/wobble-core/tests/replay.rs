//! Cumulative port gate: the harness parses the fixture, every scenario whose routes
//! are ported replays green (status + canonical body + normalized dump), and the
//! canonical/counter primitives the replay relies on are correct.

use serde::Serialize;
use serde_json::json;
use wobble_core::db::open_seeded;
use wobble_core::id::{counter_id, CounterId, IdSource};
use wobble_core::json::normalize;
use wobble_core::replay::{fixture_path, is_ported, load_scenarios, record_scenario, run_scenario};

#[test]
fn parses_the_whole_fixture() {
    let fixture = load_scenarios(&fixture_path()).expect("scenarios.json parses");
    assert_eq!(fixture.version, 1);
    assert!(
        fixture.scenarios.len() >= 130,
        "got {}",
        fixture.scenarios.len()
    );
}

#[test]
fn every_scenario_name_maps_to_a_known_prefix() {
    let fixture = load_scenarios(&fixture_path()).unwrap();
    let prefixes = [
        "worksite/",
        "workers/",
        "agitations/",
        "languages/",
        "attributes/",
        "configuration/",
        "settings/",
        "dataset/",
    ];
    for scenario in &fixture.scenarios {
        assert!(
            prefixes.iter().any(|p| scenario.name.starts_with(p)),
            "scenario {} has no known prefix",
            scenario.name
        );
    }
}

#[test]
fn replays_every_ported_scenario() {
    let mut fixture = load_scenarios(&fixture_path()).unwrap();
    let mut replayed = 0;
    for scenario in &mut fixture.scenarios {
        if !is_ported(&scenario.name) {
            continue;
        }
        // One counter for both the seed and the route-minted ids: the seeded Worksite
        // takes 1, its three default attributes take 2-4, and the first POST continues
        // at 5, which is what the fixture records.
        let id_source = CounterId::new();
        let db = open_seeded(":memory:", &id_source).unwrap();
        run_scenario(&db, scenario, &id_source)
            .unwrap_or_else(|error| panic!("scenario {} failed: {error}", scenario.name));
        replayed += 1;
    }

    assert_eq!(replayed, 143);
}

/// Re-records contract/fixtures/scenarios.json from the current core. Each scenario replays
/// through the request entry point on a fresh seeded database, and its observed responses and
/// final state replace the recorded ones. Ignored by default; run it once when the contract
/// drifts, then review the diff:
///
/// ```sh
/// CARGO_BUILD_JOBS=1 cargo test -p wobble-core --test replay -- --ignored regenerate
/// ```
#[test]
#[ignore = "re-records contract/fixtures/scenarios.json from the current core"]
fn regenerate() {
    let path = fixture_path();
    let mut fixture = load_scenarios(&path).expect("scenarios.json parses");
    for scenario in &mut fixture.scenarios {
        record_scenario(scenario)
            .unwrap_or_else(|error| panic!("scenario {} failed: {error}", scenario.name));
    }

    // The fixture keeps the tab indentation and trailing newline it was committed with.
    let mut text = Vec::new();
    let formatter = serde_json::ser::PrettyFormatter::with_indent(b"\t");
    let mut serializer = serde_json::Serializer::with_formatter(&mut text, formatter);
    fixture
        .serialize(&mut serializer)
        .expect("serializes the fixture");
    text.push(b'\n');
    std::fs::write(&path, text).expect("writes the fixture");
}

#[test]
fn counter_id_matches_the_recorder_format() {
    assert_eq!(counter_id(1), "00000000-0000-4000-8000-000000000001");
    let ids = CounterId::new();
    assert_eq!(ids.next_id(), counter_id(1));
    assert_eq!(ids.next_id(), counter_id(2));
}

#[test]
fn canonical_json_sorts_keys_and_pins_applied_at() {
    let mut value = json!({ "z": 1, "a": { "applied_at": "2026", "b": 2 } });
    normalize(&mut value);
    assert_eq!(
        value,
        json!({ "a": { "applied_at": "$t", "b": 2 }, "z": 1 })
    );
}
