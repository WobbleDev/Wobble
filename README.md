# Wobble

A **worksite** is the top-level container, in the way a workspace works in Notion or Airtable. Every worker, attribute definition, and relationship belongs to one worksite. Vocabulary lives in [GLOSSARY.md](./GLOSSARY.md); recorded decisions live in [docs/adr/](./docs/adr/).

## Views

The sidebar's **Views** are Overview, the Workers table, and Mapping. Configuration has a dedicated position in the sidebar footer.

### Mapping

The Mapping view draws a worksite's relationships as a network: one node per worker, sized by how many relationships they hold and coloured by assessment. The options panel beside it decides what that network shows.

- **Group by** partitions the workers into one region per value of a Single-Select attribute. It defaults to None, so a fresh map draws every worker ungrouped and grouping begins when such an attribute is chosen.
- **Sub-group by** adds an optional second partition nested inside the first, so every group's region holds one smaller region per value of a second Single-Select attribute. It defaults to None, so the flat map is what a team sees until they ask for more. Workers who left a question unanswered keep their place on the map, labelled after the question they left unanswered and drawn without an outline.
- **Filters** take workers off the map by assessment or by any attribute value. Filters and grouping are independent: clearing one leaves the other.

The toolbar offers **Grouped**, which arranges workers by the chosen grouping, and **Free**, which places them by their relationships. Once a worker is selected, **Isolate** focuses either layout on that worker and its first two degrees of neighbours: the worker and first degree stay solid, the second degree fades, and workers beyond it disappear. The chosen grouping stays in place.

Everything the options panel controls lives in the URL, so a shared link reopens the same map.

## Prerequisites

Wobble supports macOS for now. Install Node.js 22 (the version in `.nvmrc`), a Rust
toolchain, and the Xcode Command Line Tools (`xcode-select --install`). See the
[Tauri macOS prerequisites](https://v2.tauri.app/start/prerequisites/) for the
desktop build requirements.

## Commands

```sh
npx tauri dev     # run the desktop app (starts npm run dev for the frontend)
npm run dev       # frontend only, in a browser; no backend (see below)
npm run check     # svelte-check and TypeScript diagnostics
npm run lint      # prettier --check, eslint, and the knip dead-export guard
npm run format    # prettier --write
npm test          # vitest, single run
npm run test:rust # cargo fmt --check, clippy, and cargo test (the Rust core and the contract replay)
npm run test:mapping # focused Mapping unit + browser contract; build once, fresh DB, no retries
npm run test:e2e  # Playwright; builds the SPA and drives it through the dev shim
npm run build     # build the static SPA into build/
npx tauri build   # build the desktop app
```

Run `npm ci` after cloning. It invokes `prepare`, which runs the Paraglide i18n
compile and SvelteKit sync steps, then configures `core.hooksPath` for the local Git
hooks. The generated `src/lib/paraglide` files are local build output and are not
committed.

The backend is the Rust core in `crates/wobble-core`, behind one request boundary
([ADR-0021](./docs/adr/0021-the-rust-core-sits-behind-one-request-boundary.md)). `npm run dev`
alone has no backend, so use `npx tauri dev` for day-to-day work. To use the UI in a browser
against the real core, build the SPA and start the dev shim:
`npm run build && WOBBLE_STATIC_DIR=build cargo run -p wobble-dev-shim`, then open
http://127.0.0.1:4173.

For unattended macOS packaging on this machine, use:

```sh
CI=true CARGO_BUILD_JOBS=1 RUST_TEST_THREADS=1 npm run tauri -- build --ci
```

The `CI=true` environment flag makes Tauri skip Finder's cosmetic DMG positioning,
which can time out in an unattended session. The app and DMG still build; the disk
image uses the standard layout. This is the bundler's
[supported CI path](https://github.com/tauri-apps/tauri/blob/dev/crates/tauri-bundler/src/bundle/macos/dmg/mod.rs).

If `npm run dev` serves a blank page with a hydration error (`Cannot read properties of undefined (reading 'call')`), the Vite optimized-deps cache has gone stale. Clear it with `rm -rf node_modules/.vite` and restart, or start once with `vite dev --force`.

## Data storage

The desktop app stores its data in
`~/Library/Application Support/com.wobble.desktop/workers.sqlite`. The dev shim (browser runs and
the Playwright suites) uses `.data/workers.sqlite` relative to the working directory; set
`WOBBLE_DB_PATH` to point it at a different file.

The app keeps its Worksites in the same database. Each Worksite owns its workers, attribute
definitions, and shared agitation and language lists. Attribute definitions and their dropdown
values live in `worker_attributes` and are saved from the Configuration page as one atomic set;
every Attribute records its value directly on the Worker in `worker_attribute_values`, so a Worker
holds one value or none in a Single-Select Attribute and several distinct values or none in a
Multi-Select one, and the values stay editable when an Attribute is renamed, reordered, or removed.
Values may nest beneath a parent value inside the same Attribute; each value has at most one parent,
and readings treat a selected parent as including its descendants. Agitations live in `agitations`
with per-worker assignments in `worker_agitations`, so one agitation is shared by every worker that
has it. Languages live in `languages` with per-worker assignments in `worker_languages`, so one
language is shared by every worker that has it. Notes are private to a worker and stored as JSON on
the worker row. A Worker draft (ADR-0023) lives in `worker_drafts`, one row per (Worksite, worker |
the `new` sentinel), deleted with its worker or Worksite.

Fresh databases use schema version 24 and start without a Worksite. Worksites and their default
Attributes are created explicitly, rather than as a side effect of opening the database. A new
Worksite seeds its Department and Role attributes as Single-Select and its Shifts attribute as
Multi-Select (Departamento and Puesto as Single-Select and Turnos as Multi-Select for the Spanish
template).
The Rust core opens schema version 24. The upgrade to 14 mints a stable id for every stored
Attribute value (ADR 0030) and rewrites every stored Worker value from value text to that id, in
one transaction. The upgrade from 14 to 15 adds indexes for worker worksite lookup and reverse
relationship lookup; it changes no data. The upgrade from 15 to 16 reformats every stored clean
10-digit Phone to `(555) 010-0100` with the same rule the Phone field uses, writing only the rows
whose value changes and leaving any value that is not a clean number untouched. The upgrade from
16 to 17 replaces the single-row `app_settings` table with the typed key/value registry (ADR
0034), carrying the stored Theme and Density values over; a setting with no row uses its registry
default. Version 18 adds each Attribute's Worker or Work Assignment scope and its legacy
inference eligibility marker; earlier definitions default to Worker scope and remain eligible.
Version 19 adds Work Assignment storage: `work_assignments` and its linked values in
`work_assignment_answers`. Version 20 adds `work_assignment_drafts`.
Version 21 retains the one-time best-guess conversion described in the specification. It moves
Attributes still at Worker scope whose trimmed, case-insensitive name is on the bounded legacy
list (Department, Role, Job, Shift, Location and Store with their plurals and Spanish forms) to
Work Assignment scope, expands each Worker's selected values into assignments under the
documented tuple rule, deletes only those converted Worker values, and rewrites saved Worker
drafts and the New Worker draft in the same transaction. Explicitly Assignment-scoped or
non-eligible Attributes and every other Worker or Worksite record stay untouched. A draft that
cannot be read is left exactly as stored.
Version 22 retires the work-assignment model. For each formerly assignment-scoped Attribute inside
its own Worksite, it reads committed assignment answers only, keeps each Worker's distinct answer
ids ordered by the Attribute's configured value order (a directly selected parent and child are both
kept), and makes the Attribute Multi-Select for the whole Worksite when any Worker holds more than
one distinct id, otherwise Single-Select including when it is unused. Attributes that already
described Workers keep their cardinality and selections. Unfinished assignment edits never enter the
converted values or the inferred cardinality: they remain only in the verified pre-upgrade backup.
Ordinary Worker drafts keep their edits, notes and timestamps and receive the migrated value in both
their update and their base. The version then drops the assignment tables, triggers and the retired
Attribute scope metadata, so an upgraded database and a fresh one have the same schema.
Version 23 gives every Attribute value a Short form of at most 10 graphemes and records whether it
was generated or edited ([ADR 0046](docs/adr/0046-short-forms-are-stored-generated-or-edited.md)).
It is data only: each stored value receives a generated Short form (its full name when that fits,
otherwise its first 9 graphemes and an ellipsis) after the verified backup, and no table changes.
The upgrade from 23 to 24 adds the `saved_views` table: a Worksite's named, versioned Workers and
Mapping views, validated strictly on every read and deleted with the Worksite. It changes no data.
A version 12 database is upgraded through 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23 and 24 in one
run, which also adds the Worker drafts table. A database already at version 24 is left alone:
opening it writes nothing. The core opens versions 12 to 24, upgrading older supported versions in place, and
refuses any other version with the version it found. A database older than version 12 must be
migrated to 12 first, by running the last Node build (the `pre-tauri-node` tag) against it.

### Unlocking and legacy conversion

Persistent databases use SQLCipher. Create a passphrase on first run and enter it at every
process launch. Wobble stores no recovery key or remembered credential. A forgotten passphrase
means losing access to the database and every backup protected by it. Accepted passphrase
characters, including leading and trailing spaces, are significant.

An existing supported plaintext database opens the conversion screen before application data
loads. Confirm a new passphrase to convert it. Wobble verifies encrypted live and recovery copies,
retains the original plaintext file through replacement and verified reopening, then removes the
displaced original. Earlier exports and filesystem remnants may still contain plaintext. Conversion
does not erase those copies. The receipt identifies the encrypted database and recovery file.

The desktop build keeps its database in
`~/Library/Application Support/com.wobble.desktop/workers.sqlite` on macOS. Settings shows the
actual path for the running installation. `WOBBLE_DB_PATH` selects a separate database for
local development and tests; never point a rehearsal at the installed beta's own database.
Window geometry is restored after unlock only when the decrypted Remember window preference
allows it. Remembering the window does not remember the passphrase.

### Encrypted exports, restore and recovery

**Settings → Backups → Export backup** writes an encrypted copy to the chosen path using the
installation's current passphrase. It leaves the live database in place. Save that passphrase:
changing it later does not change earlier exports or recovery copies.

**Restore…** asks for the selected backup's passphrase. For an existing plaintext backup, choose
the explicit legacy option instead. Supported source schema versions are 12 through 23. Wobble
verifies the source and its records, creates an encrypted pre-restore recovery copy beside the live
database, migrates an encrypted staging copy, replaces the live file and verifies reopening before
reporting success. The restored installation keeps its **current installation passphrase**; the
source backup's passphrase is used only to read that backup. The selected source file is never
changed, so a legacy plaintext source remains plaintext.

**Change passphrase** requires the current passphrase and confirmation of the new one. Its recovery
copy remains protected by the old passphrase until the new database successfully opens. If the
operation cannot finish, Wobble restores the old database and credential or keeps startup in
recovery. Earlier backups retain their original passphrases.

**Erase all data** requires the exact typed `erase` confirmation and first creates an encrypted
pre-erase recovery copy using the current passphrase. It deletes every Worksite and its scoped
records, retaining application settings and schema. It does not remove separate exports or earlier
recovery files. The receipt gives the actual recovery path, with Copy and native reveal actions.

Conversion, restore and passphrase changes use same-volume staging and a secret-free operation
marker. Startup settles interrupted operations before loading data. If recovery cannot establish a
consistent state, keep the database and its recovery artifacts together; do not delete the marker
or sidecars to force it open. For an interrupted passphrase change, try the previous passphrase.

Before a supported schema upgrade, Wobble verifies an encrypted pre-upgrade copy beside the
database. Upgrade and routine recovery copies use the passphrase current when created. Receipts
and filenames identify those files; there is no persistent backup-history registry. Keep the copies
until you are sure they are no longer needed, and remove them yourself afterward.

Stock `sqlite3` cannot read these encrypted files. Use Wobble's Export and Restore actions rather
than copying a running database or its WAL/SHM sidecars. Removing migration rows is not a rollback.
Older plaintext-only Wobble builds cannot open the encrypted database or its encrypted backups;
retain a separate pre-conversion legacy backup if you need to rehearse with an older build.

## Data volume

The bullseye is designed around a roughly fifty-worker worksite ([ADR-0012](./docs/adr/0012-the-bullseye-draws-the-committees-reach.md)). The Workers table is virtualized, so it scrolls past that envelope rather than failing at it. The single-machine, single-file design ([ADR-0003](./docs/adr/0003-one-sqlite-file.md)) bounds practical growth. No measured ceiling is claimed. The scale is meant to grow: a worksite should eventually hold thousands of workers, and this prototype is built for the small roster first. What strains first at that scale is the data path — the whole roster is loaded on every page — and the two visualizations, which draw every worker.

## Bundled Short form list sources

The generated Short forms draw on word shortenings and acronyms built from
O*NET 31.0 (CC BY 4.0), Wiktionary via kaikki.org (the derived file is
CC BY-SA 4.0) and Wikidata (CC0) by `scripts/short-form-lists/`, which also
writes the repo-root `NOTICE` with the full credits and license links. This is
not legal advice; get a legal check before any commercial distribution.

## Status

This is a prototype being grown into the real app. Architecture and deployment:
[docs/product-context.md](./docs/product-context.md). The Node server was removed; the last
commit that has it is tagged `pre-tauri-node`.
