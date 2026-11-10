# Rust-only expectations

These routes cannot be recorded through the Node handlers, so they are **not** in
`contract/fixtures/scenarios.json`. They are hand-authored here and are run by `cargo test`.
The Vitest route-table coverage check (`src/lib/contract/route-table.spec.ts`) treats the
endpoints listed here as covered.

## §6.14 DB refuses an unsupported schema → 500 `{message}`, no panic (C02)

Node cannot record this: the old Node runner lived at git tag `pre-tauri-node` and is gone, so
there is no Node request to replay. The Rust core's current schema version is 22 and it upgrades
versions 12 through 21 on open. In Rust, open a database with `schema_migrations.version` set to
an unsupported value (e.g. 3), then for each request below `handle()` returns 500 with a
non-empty `{message}` naming the schema version and never panics:

| Request             | Expected        |
| ------------------- | --------------- |
| `GET /api/settings` | 500 `{message}` |
| `GET /api/worksite` | 500 `{message}` |
| `GET /api/dataset`  | 500 `{message}` |
| `POST /api/workers` | 500 `{message}` |

These are the four steps the B02 Node scenario `database/non-v12-500` used to run; B04 moved the
expectation here.

## `DELETE /api/settings` (ticket 01)

Node cannot record this: the route arrives with the v17 typed settings registry. It deletes
every `app_settings` row and returns the fresh defaults; Worksites, Workers and the Active
Worksite are untouched. The Rust handler tests cover it, and the settings e2e runs it end to end.

## §6.1 `POST /api/backup` (new, droppable) (F01 + D shim)

Node cannot record this: the route does not exist until F01, and the dev shim answers 501.

| Request                                          | Expected                                            |
| ------------------------------------------------ | --------------------------------------------------- |
| `POST /api/backup` with `{path}`                 | 200; copies the database to `path` (never moves it) |
| `POST /api/backup` with a missing/invalid `path` | 400 `{message}`                                     |
| `POST /api/backup` through `wobble-dev-shim`     | 501                                                 |

## Ticket 05 data controls: `GET /api/data-file`, `POST /api/restore`, `POST /api/erase`

Node cannot record these: they arrive with the Tauri data controls, and the dev shim serves them
from the Rust core. The Rust handler tests cover the validation failures, the safety copies and
the erase; the settings e2e drives Restore and Erase through the shim.

Every route-specific error carries a stable `code` beside `message` (ADR-0024). Settings
owns the copy for each code and keeps the core's message behind a Show details disclosure.
The shared malformed-body 400 (`"Request body must contain valid JSON."`) stays uncoded,
as it is on every route.

| Request                                       | Expected                                                                                                     |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `GET /api/data-file`                          | 200 `{path}` (absolute and canonical); 400 `{message, code: "data_file_no_path"}` for `:memory:`             |
| `POST /api/restore` with `{path}`             | 200 `{safetyCopyPath}`; the backup is swapped in, upgraded and the old data copied first                     |
| `POST /api/restore` with a bad file or path   | 400 `{message, code}`; 500 `{message, code: "restore_failed"}` with the safety copy path when the swap fails |
| `POST /api/erase` with `{confirm: "erase"}`   | 200 `{safetyCopyPath}`; every Worksite-scoped row is deleted, settings and schema kept                       |
| `POST /api/erase` with any other confirmation | 400 `{message, code: "erase_confirmation_required"}`                                                         |

The codes:

| Code                          | When                                                                           |
| ----------------------------- | ------------------------------------------------------------------------------ |
| `data_file_no_path`           | The open database is `:memory:`, so there is no file to show, restore or erase |
| `restore_path_required`       | The body has no non-blank string `path`                                        |
| `restore_unreadable`          | The chosen path cannot be read or canonicalized                                |
| `restore_not_a_file`          | The chosen path is a directory                                                 |
| `restore_current_file`        | The chosen file is the live database file                                      |
| `restore_not_sqlite`          | The chosen file cannot be opened as SQLite                                     |
| `restore_integrity`           | SQLite's integrity check does not return `ok`                                  |
| `restore_not_wobble`          | The file is SQLite but has no usable Wobble schema version                     |
| `restore_unsupported_schema`  | The backup's schema version is outside 12 through 22                           |
| `restore_failed`              | The safety copy could not be written, or the swap/upgrade failed               |
| `erase_confirmation_required` | `confirm` is not exactly `"erase"`                                             |
| `erase_failed`                | The safety copy could not be written, or the erase itself failed               |

## Saved views: `GET`/`POST /api/views`, `PUT`/`DELETE /api/views/[id]` (ticket 19)

Node cannot record these: they arrive with the v24 `saved_views` table. The Rust handler and
persistence tests cover them; the saved-views e2e drives them end to end.

A snapshot is `{version: 1, kind: "workers" | "mapping", workers | mapping}` and is read
strictly, on the way in and again on every read: an unsupported version, an unknown kind, an
unknown field (so no search, selection, Isolate, camera or manual position can be stored), a
mismatched body or a bad enum is refused (400 `invalid_view`) and nothing is written. Names are
trimmed, 1 to 80 characters and unique per Worksite regardless of case (409 `view_name_taken`).
Views live in a Worksite-scoped table that cascades with the Worksite; backup, restore and the
upgrade safety copy cover it as part of the database file, and restore refuses a database whose
stored views do not validate.

| Request                                   | Expected                                                                |
| ----------------------------------------- | ----------------------------------------------------------------------- |
| `GET /api/views`                          | 200 `{views}` by name; another Worksite's views never appear            |
| `POST /api/views` with `{name, snapshot}` | 201 `{view}`; 400 `invalid_view_name` or `invalid_view`; 409 name taken |
| `PUT /api/views/[id]` with `{snapshot}`   | 200 `{view}` (Update); 400 when the kind would change                   |
| `PUT /api/views/[id]` with `{name}`       | 200 `{view}` (Rename; the id is kept)                                   |
| `DELETE /api/views/[id]`                  | 200 `{viewId}`; 404 `view_not_found` when it is not in the Worksite     |
