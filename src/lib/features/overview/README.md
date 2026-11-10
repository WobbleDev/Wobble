# features/overview

The Overview view: four readings laid over the Assessment bullseye floor.

Overall support and Committee coverage read the whole Worksite; By Attribute bands and
the Agitations matrix read the Attribute named by the `by` parameter (Department, then
the first Single-Select Attribute, when it is missing or unknown). The dashboard never
highlights, dims or filters the bullseye.
The Assessment Bullseye chart itself is documented in [bullseye/README.md](./bullseye/README.md).

The figures come from `support-summary.ts` -- `supportReading`, `assessmentCounts`,
`coverageReading`, `groupReadings`, the Agitation-by-group matrix
(`agitationGroupMatrix`) and `leaderTarget`: the page adds no new arithmetic seam of its own.
`overview-dashboard-presentation.ts` owns the presentation rules (heat ratio, cell
shade and tone, shade-key steps, segment order, the hide-count-below-5% rule, floor
placement). Every figure and matrix cell opens its Workers through
`summary-links.ts` plus `group-drilldown.ts`.

Agitations headers show each Attribute value's stored Short form (ADR 0046, generated in
the core) through the shared display rule in `#lib/shared/short-form-label.ts`: the full
name when it fits the column budget, otherwise the Short form; values that would show the
same text gain the fewest nearest ancestors ("Kitchen › Days"), and the No value reading
is always full. `agitations-headers.svelte.ts` measures the uppercase mono voice and
reserves the Worker count. Columns per page are counted at the ten-digit minimum budget;
each page then shares its spare width among its columns and the labels are chosen again,
so a label never adds a page. Shortened headers expose the full name on hover and focus
and as the accessible name, while the data table retains complete semantic headers.

The shell owns the bullseye ground behind the page: at rest it is large, faded,
blurred and inert on the floor at the lower right; an edge tab brings it into focus
(`overview-focus.svelte.ts`), where it grows slightly in place and becomes
interactive (drag, zoom, Reset zoom). Esc or the tab returns. Focus resets on each
arrival, as zoom does. Where the ground cannot be dragged (below the floor, reduced
motion, coarse pointer), the fitted chart is drawn in the page flow instead.
`overview-arrival.svelte.ts` and `overview-arrival-lifecycle.ts` own the arrival;
`overview-scroll-hint.ts` owns the fade at clipped card edges.

The page is a no-scroll surface shared with Mapping: the frame stays fixed and the
matrix scrolls vertically inside its card; the support breakdown pages whole group rows to its measured height. Both cards share the range footer in `group-pager.svelte`. `ChartHelp` stays; Reset zoom shows
only while focused. The setup dialog (`worksite-setup-dialog.svelte`) owns first-Worksite
onboarding as before.

It reads Workers and never edits them -- all Worker editing belongs to Workers.
