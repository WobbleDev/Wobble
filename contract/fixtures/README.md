# Contract fixtures

`scenarios.json` is the recorded oracle for the HTTP contract. It was generated from the real
SvelteKit handlers, never hand-written. The Node server and its recorder were removed in G01;
the last commit that has them is tagged `pre-tauri-node`.

## Databases

`node-v12.sqlite` and `rust-v12.sqlite` are the frozen cross-open pair. `workplace-v20.sqlite`
is a v20 source the browser settings suite restores: one Worksite, two Workers, legacy
Department/Role/Shifts answers and one pending Work Assignment draft each. It is committed, so
the normal suite only reads it; regenerate it with:

```sh
cargo test -p wobble-core --test restore_migration -- --ignored regenerate_the_v20_fixture
```

## Replay

```sh
cargo test -p wobble-core --test replay
```

Every `request`/`response` pair replays against the Rust `handle()`. The file is re-recorded
from the current core only when the contract drifts, by the ignored `regenerate` test below. Review
the diff, then replay again. Ids are literal: the replay mints them from a per-scenario `CounterId`.

```sh
CARGO_BUILD_JOBS=1 cargo test -p wobble-core --test replay -- --ignored regenerate
```

## Shape

```jsonc
{
  "version": 1,
  "scenarios": [
    {
      "name": "workers/post-creates",
      "checklist": [1],              // spec §6 checklist item(s)
      "description": "POST /api/workers creates a Worker",
      "setup": { "sql": ["..."] },                        // applied to the fresh v12 DB first
      "steps": [
        {
          "request": { "method": "POST", "path": "/api/workers", "headers": {"x-wobble-worksite": "..."}, "body": { }, "rawBody": false },
          "response": { "status": 201, "body": { } }
        }
      ],
      "state": { "worksites": [ ], "workers": [ ] }   // all tables, canonical JSON
    }
  ]
}
```

`rawBody` is `true` only on the malformed-JSON steps: there `body` is the exact string the
handler received, which the Rust replay sends verbatim instead of JSON-encoding.

## Normalisation (the only places the record is not raw)

- `randomUUID` → the counter-stubbed literal ids.
- Object keys are sorted recursively, so `json_group_object` attribute order cannot drift.
- `schema_migrations.applied_at` → `"$t"`.
- Id lists keep the server's own sort (`decodeIdList`).

## Not recorded here

`POST /api/backup` (F01/E02) and the non-v12 refusal (§6.14) cannot be produced by the Node
handlers; their hand-authored expectations live in `../rust-only.md`.
