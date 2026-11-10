# Short form list pipeline (ticket 05, ADR 0046)

A developer-run pipeline that builds the versioned Short form snapshot bundled in
`crates/wobble-core/src/short_form_lists_generated.rs` from pinned, checksummed
source inputs. It never runs as part of the app build, and neither `src/` nor
`crates/` contains networking code.

## Files

- `fetch.mjs` — downloads the pinned sources, keeps only the records the build
  reads, and writes them as filtered inputs plus `filtered-input/manifest.json`
  (SHA-256 per file, source, pin, record count). Maintainer-run, needs network:
  `node scripts/short-form-lists/fetch.mjs --revision <name> [--out <dir>]`.
- `gates.mjs` — the automatic gates every pair must pass (spec "Sources"):
  first letter, letters in order, shorter than the expansion, exact whole-word
  phrase. Pure, no I/O.
- `build.mjs` — reads the filtered inputs named in the manifest, verifies
  checksums, extracts candidates, applies the gates, and writes the snapshot,
  `build-report.json` (kept/dropped counts with reasons) and the repo-root
  `NOTICE` together. No network: `node scripts/short-form-lists/build.mjs`.
- `filtered-input/` — the saved inputs the build reads. Rebuilding from these
  files is byte-identical (proven by `build.spec.ts`). Refreshing a source
  means rerunning `fetch.mjs` and committing the new inputs as a reviewable diff.
- `build.spec.ts` — gates, extractors, drop counts, ambiguous-expansion
  retention, language split, NOTICE output and byte-identical rebuild. No network.

## Source pins (verified 2026-11-06, see the spec and sources.md)

- O*NET Database 31.0, `job_titles.json` from `db_31_0_json` (CC BY 4.0).
- Wiktionary via kaikki.org: enwiktionary dump 2026-10-01, wiktextract
  `19f9a30`, wikitextprocessor `6f96ddf`; Spanish extraction as of the same
  fetch (CC BY-SA 4.0, the derived file).
- Wikidata: per-item revision ids recorded in `fetch.mjs` (`PINS.wikidata`)
  for the concept list the script defines (CC0).
- ESCO is excluded by user decision (in-app credit requirement).

The committed `filtered-input/` is a small fixture sample following these pins:
this sandbox had no network access while ticket 05 was implemented, so a live
fetch could not run. A maintainer with network access replaces the fixtures with
the full pinned extracts; the revision in `manifest.json` then changes (for
example `sf05-onet31.0_kaikki2026-10-01`), and the next app update regenerates
every still-generated Short form once via the stored per-Worksite revision.

## After rebuilding

Run `cargo fmt` on the snapshot (the `test:rust` gate checks formatting), then
the affected Rust tests. `connectors` and `qualifiers` stay hand-authored in
`short_form_lists.rs`: they are closed function-word lists with no source.
