# features/workers/data-table

The Workers table grid. TanStack Table runs headless here: `columns.ts` defines the columns and
their cell components, `data-table-features.ts` registers only the table APIs this grid
needs, and `data-table.svelte` renders it.

Each configured Attribute has its own column in Configuration order after Assessment and Languages.
Every Attribute uses the same ordinary cell: a Single-Select Attribute is an inline picker, a
Multi-Select Attribute a multi picker, both saved at once through the Worker Attribute endpoint
with Undo. A Worker with no value reads as the shared no-value reading ("No <Attribute name>"),
and each Attribute's filter offers that reading beside its answers for either cardinality. A
selected parent answer includes its descendants; an exact parent-remainder filter stays
distinguishable from that subtree reading.
The bulk bar's Edit menu sets one Attribute for the selection: a Single-Select choice replaces the
value, a Multi-Select choice adds or removes one answer, and each batch reports once with Undo.
A status report that carries actions stays until dismissed or replaced; others clear after a few seconds.

Rows are virtualized; summary fitting measures only mounted cells. Register a new
TanStack feature in `data-table-features.ts` rather than importing it ad hoc.
