# Saved views

Named Workers and Mapping questions kept per Worksite. The Rust core owns the `saved_views` table (schema 24), validates every snapshot strictly on the way in and on every read, and cascades the rows with the Worksite; backup, restore and the upgrade safety copy carry them as part of the database file.

- `saved-views.svelte.ts`: the controller each host creates with a literal host (kind, api, vocabulary, capture, apply). A view opens as an editable copy; only Update, Save as, Rename and Delete write.
- `saved-view-references.ts`: reads a snapshot's stable-id references against the live configuration. Each problem carries the one edit that drops it. Nothing is dropped, so nothing is broadened, without the organizer's choice (Needs review: Drop per reference, or Cancel).
- `workers-view-state.ts`, `mapping-view-state.ts`: pure moves between a host's state and a snapshot.
- `saved-views-menu.svelte`, `saved-view-review-dialog.svelte`: the Views control and Needs review.

## What a view holds

Workers: filters (answers, exact answers, no-answer readings, Agitations, Languages by id, Assessments), sort, hidden columns, column order. Mapping: grouping and sub-grouping, branch detail, layout, population filter, what is hidden, the Highlight query (`hq` is question state).

Never: the Name search or toolbar search, selection, Isolate, camera, manual positions. These are person state (`#lib/shared/person-state.svelte.ts`); the core refuses a snapshot that carries any unknown field.

## Transport per field

| Field                                                  | Applied through                               | After reload                |
| ------------------------------------------------------ | --------------------------------------------- | --------------------------- |
| Workers filters (`f`, `missing`, `agitation`)          | table column filters, written to the address  | kept (address)              |
| Workers sort, hidden columns, column order             | set on the table directly when the view opens | reset to the table defaults |
| Mapping grouping (`group`, `sub`), detail (`x`, `xs`)  | map view state, written to the address        | kept (address)              |
| Mapping layout (`layout`), population (`f`, `missing`) | map view state, written to the address        | kept (address)              |
| Mapping visibility (`no`, `hid`, `nolang`), `hq`       | map view state, written to the address        | kept (address)              |

Sort, columns and order have no address codec, so they diverge on reload. Adding codecs for them would expand the URL contract and needs an ADR.
