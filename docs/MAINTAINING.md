# Maintaining Wobble

A guide for changing Wobble without being a programmer. It says what each part of the project is
for, and which files to open for the changes people ask for most.

If a word here is unfamiliar, [GLOSSARY.md](../GLOSSARY.md) defines the project's vocabulary
exactly. It is short, and it will save you guessing.

## What Wobble is

Wobble tracks the people a team works with — who they are, how the team categorises them, and who
they know. Everything a team tracks lives inside one **Worksite**.

## The five views

Each view is two folders: the page under `src/routes/`, and its code under `src/lib/features/`.
The page folder is small. Almost everything you want is in the feature folder.

| View              | What it is for                                                                                        | Page                        | Code                              |
| ----------------- | ----------------------------------------------------------------------------------------------------- | --------------------------- | --------------------------------- |
| **Overview**      | The big picture: support at a glance, Committee coverage, top Agitations, and the Assessment Bullseye | `src/routes/overview/`      | `src/lib/features/overview/`      |
| **Workers**       | The roster table and the record you open from a row. The only place Worker information changes        | `src/routes/workers/`       | `src/lib/features/workers/`       |
| **Mapping**       | The Relationship map between Workers                                                                  | `src/routes/mapping/`       | `src/lib/features/mapping/`       |
| **Configuration** | What one Worksite is: its name, Attributes, Agitations and Languages, and deleting it                 | `src/routes/configuration/` | `src/lib/features/configuration/` |
| **Settings**      | Installation-wide preferences and data controls                                                       | `src/routes/settings/`      | `src/lib/features/settings/`      |

## How the code is arranged

`src/lib` has four parts, and one rule about which way they may point:

| Part               | What it holds                                | May use                   |
| ------------------ | -------------------------------------------- | ------------------------- |
| `shared/`          | Code more than one view needs                | nothing above it          |
| `features/<view>/` | One view's own code                          | `shared/`                 |
| `shell/`           | The frame around every page: sidebar, header | `shared/` and `features/` |
| `client/`          | Every call to the backend                    | `shared/`                 |

If you are unsure where something belongs, put it in the view that uses it. If two views use it,
it belongs in `shared/`.

Two things not to touch:

- `src/lib/components/ui/` is a vendored copy of a component library, kept exactly as its authors
  ship it. It is not ours.
- `contract/fixtures/scenarios.json` is the recorded contract the Rust core replays
  (`docs/adr/0021-the-rust-core-sits-behind-one-request-boundary.md`). The Node recorder is
  gone (last present at the `pre-tauri-node` tag), so edit it only deliberately and together with
  the Rust code that the change describes.

The backend is the Rust crate `crates/wobble-core`; `crates/wobble-dev-shim` serves it over HTTP
for browser runs and the Playwright suites, and `src-tauri/` is the desktop shell.

## Recipes

Each recipe is: what you want → the files to open → what to change.

### 1. Add a field to a Worker

A Worker field has to be added everywhere that carries it, in this order:

TypeScript side:

1. `src/lib/domain-vocabulary.ts` — the field's type.
2. `src/lib/client/workers-api.ts` (and `api-decode.ts` if the response shape changes) — carrying
   it to and from the backend.
3. `src/lib/features/workers/data-table/columns.ts` — showing it in the Workers table.
4. `src/lib/features/workers/worker-form/` — letting someone edit it.

Rust side, in `crates/wobble-core/src/`:

5. `schema.rs` and `attribute_migration.rs` — the database column. Follow the supported
   schema versions, migration behavior and backup requirements in [README.md](../README.md#data-storage); a schema change needs a compatible migration.
6. `serialization.rs` and `assembly.rs` — reading it out of the database and assembling a Worker.
7. `worker_request.rs` and `service.rs` — decoding and validating the request, and saving it.
8. `router.rs` only if the field needs a new route.

Then update `contract/fixtures/scenarios.json` and `contract/route-table.md` to match, and run `npm run test:rust` — the replay fails on any unrecorded change in a response or in
the database dump.

### 2. Change an Assessment colour

The six Assessment colours are set in two places that must stay in step:

- `src/lib/shared/assessment.ts` — the hex values the drawing code uses.
- `src/routes/layout.css` — the `--assess-*` tokens, near the top of the file.

The `--assessment-*` tokens further down point at those, so they follow automatically. Change a
token's value, never its name.

### 3. Add a default Attribute or Agitation

Open `src/lib/features/configuration/`. `attribute-draft.ts` and `attribute-validation.ts` hold
the rules for a new Attribute, and the editors beside them are the forms.

### 4. Add a view

A view is a folder under `src/routes/` for the page, and a folder under `src/lib/features/` for
its code. Add it to the sidebar's list in `src/lib/shell/navigation-rail.svelte`. A new view may use
`shared/`, never another view's folder.

### 5. Run the app and the tests

- `npx tauri dev` — start the desktop app.
- `npm test` — the fast TypeScript tests.
- `npm run test:rust` — format, clippy, and the Rust tests, including the contract replay.
- `npm run check` — the type check.
- `npm run lint` — formatting and style.
- `npm run test:e2e` — the browser tests; slower, and they build the SPA and start the dev shim themselves.

Always run `lint`, `check` and `test` before calling a change done.

### 6. Back up or restore the database

See **Data storage** and **Backups and rollback** in [README.md](../README.md). That file is the
source; do not copy it here, because two copies drift.

### 7. Delete a Worksite

`src/lib/features/configuration/worksite-danger-zone.svelte` is the control, and
`src/lib/client/workers-api.ts` sends the deletion. Deleting is a hard cascade — read
`docs/adr/0006-deleting-a-worksite-is-a-hard-cascade.md` before touching it.

### 8. Switch the Active Worksite

Three files: `src/lib/shell/navigation-rail.svelte` (the control),
`src/lib/client/worksite-api.ts` (the request), and `crates/wobble-core/src/worksite_persistence.rs`
(what the core does with it).

## Where to look when you are stuck

- `GLOSSARY.md` — what the project's words mean.
- `docs/adr/` — why things are the way they are. **Never edit these**; they are a record of
  decisions already made.
- `README.md` — running it, the database, and backups.
- `AGENTS.md` — the rules this codebase is built to.
- Each folder under `src/lib` has a short `README.md` of its own.
