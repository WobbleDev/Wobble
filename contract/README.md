# Contract

The frozen HTTP contract between the TypeScript oracle and the Rust port.

| File                      | What it is                                                    | Ticket |
| ------------------------- | ------------------------------------------------------------- | ------ |
| `route-table.md`          | every endpoint, reconciled against the handlers               | B01    |
| `spec-ledger.md`          | every server/route/hooks spec → a Stage C target or a retire  | B03    |
| `fixtures/scenarios.json` | the recorded oracle (request/response + DB dump per scenario) | B02    |
| `fixtures/README.md`      | fixture shape and the record/replay commands                  | B02    |
| `rust-only.md`            | the §6 items Node cannot record (non-v12, backup)             | B04    |

## Normalizer (D6)

Every recorded scenario carries a `state` object: a normalized dump of all 11 tables
(`worksites`, `workers`, `worker_relationships`, `worker_attributes`,
`worker_attribute_values`, `agitations`, `worker_agitations`, `languages`,
`worker_languages`, `app_settings`, `schema_migrations`), each read `ORDER BY rowid`.

The dump and every response body pass through one normalizer
(`src/lib/contract/scenario-runner.ts` at git tag `pre-tauri-node`; the Rust replay in `crates/wobble-core/src/replay.rs` applies the same rules):

1. **Deterministic ids** — `node:crypto`'s `randomUUID` is stubbed with a per-scenario counter,
   so ids are literal (`00000000-0000-4000-8000-0000000000NN`) and no id normalization is needed
   (D-id determinism).
2. **Canonical object keys** — object keys are sorted recursively, so `json_group_object`
   attribute key order cannot drift between runs or between TypeScript and Rust.
3. **`schema_migrations.applied_at` → `"$t"`** — the only wall-clock value in the dump.
4. **Id lists keep the server's own sort** — `decodeIdList` in `assembly.ts` already sorts, so
   the normalizer does not re-sort arrays.

`normalize()` is applied to each response body and each dumped row.
