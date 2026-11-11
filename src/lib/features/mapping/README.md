# features/mapping

The Mapping view: the Relationship map with its floating control strip (search, Group by, Filter),
the Assessment key that also filters, the zoom cluster, and the worker card.

The drawn population is the shared projection's selection (`#lib/shared/worker-population.ts`):
the Filter panel's Narrow to controls write ordinary Attribute conditions (`f`/`missing`) through
the same shared toggles the Workers view reads, so identical conditions select identical Worker
ids. The panel's other dropdowns only hide drawn answers, and the address's own `f`/`missing`
conditions open the same reading. A person is always one graph node, one Map table row and one
Relationship set, however many answers a Multi-Select holds.

The Grouping reads each displayed Worker's own answers (`map-grouping.ts`): one cell per displayed
Worker, at the detail those answers can agree on. Either Attribute kind may group; several held
answers inside one displayed region stay one cell, and a Worker holding answers in two regions is
ambiguous rather than assigned a first value. An ordinary answer, an exact direct-parent remainder
and a Worker's no-answer reading carry distinct typed keys (`#lib/shared/region-identity.ts`), so a
real answer that reads like the system reading keeps its own identity. A choice is available only
when every displayed Worker occupies exactly one region; otherwise the Group by and Sub-group by lists do not offer it. An active choice that stopped
partitioning stays listed: the control names the conflicting Workers and regions, offers narrowing filters that were
simulated through the shared selector, and the map falls back to Free without rewriting the address.
The solver never sees the real definitions for that partition: a view-only synthetic definition
carries the displayed region keys, so one graph node per Worker, the Relationships and the Region
identities are unchanged.

Branch detail is the same shared hierarchy frontier Overview reads (`#lib/shared/answer-hierarchy.ts`: `normalizeExpansion`, the exact `#self:<attribute>:<answer>` remainder identity and the remainder wording). The Group popover opens one displayed branch at a time: the branch is replaced by its direct child regions and its occupied remainder, and an attempted expansion is refused before any state or address write when it would put a displayed Worker in two regions. The chosen detail is persisted by identity as repeated `x` (primary) and `xs` (secondary) entries; it is normalized against the Attribute it names when restored, and an active detail that no longer partitions keeps its ids, falls back to Free with the explanation, and can still be collapsed from the control. Primary and secondary detail are independent, one graph node and one Map table row remain per Worker, and a rename moves no identity, count, configured order or Relationship.

The view's files are named `map-*`; the `graph-*` files are the algorithms over the graph of Workers and Relationships and keep their names.
`graph-arrangement.ts` decides the automatic positions before manual geometry is applied: ungrouped (Free) runs
`graph-free-physics.ts` force-directed physics over the relationships alone, grouped lays each
group out with `graph-group-layout.ts` (which uses the `graph-stress.ts` stress layout inside each group) and runs the rigid bodies against each other with
`graph-group-physics.ts`, and `graph-relationship-routing.ts` routes each relationship around measured drawing obstacles, and Isolate is a focus
over either, not a layout: the arrangement takes the filter-visible set (the layout set) and never the
selection, while the dots, links and regions draw only the drawn set (the layout set narrowed to the
selected worker's two degrees). `map-view-model.ts` is the single source for what is visible, and
`map-canvas.svelte` draws it.

`map-canvas.svelte` keeps the camera, the text measurement and the landing glide, which depend on its bound sizes, and hands the rest to modules it wires together:

- `map-drag.svelte.ts` (`createMapDrag(host)`) is the drag gesture: a Worker's dot in Free and a group's body in Grouped. A press is armed and becomes a drag only past 4 screen pixels; the release of a drag that moved suppresses the click that follows it, and a surface press that travelled more than 4 pixels is a pan, not a dismissal. The host supplies `isolated`, `grouped`, `spaceHeld`, the `settled` arrangement, `panZoom` (a getter, for `toMapPoint`) and `commitWorker`/`commitGroup`; a drag is a delta from the press, which the canvas lays over its manual geometry while it travels and keeps on release.
- `map-hover-intent.svelte.ts` (`createHoverIntent(host)`) holds a node's tooltip back until the pointer has rested 120 ms, lets a shown card follow the pointer, and shows it 30 ms after a touch tap. The canvas calls `cancel` on destroy.
- `map-name-placement.ts` chooses initial names from the prepared scene facts, using packet names whenever a packet exists. Initial framing can call its bounded placement helpers. After preparation, `map-frozen-names.ts` replays stored attachments using arithmetic; ordinary camera and manual movement never calls the placement search. `floatingKeyBoxes` and `wholeMapViewport` describe reserved keys and usable canvas for initial preparation.
- `map-drawing.ts` is pure readings of the drawing: the settled frame the camera travels to, the regions with their headings (`labelViewRegions`), which regions a spotlight or Highlight keeps lit, the halo clip path, the flattened final paths, the reserved key rectangles and the strings a composition reserves room for.

Check the local project glossary before naming anything here — Mapping's vocabulary is deliberately narrow.

## One composed drawing (Grouped, one level)

With one Grouping, `arrange` is asked to compose: where the groups sit, where the names stand and every
Relationship's own path are chosen together, from numeric screen facts the canvas freezes at the layout
trigger (`ArrangeInput.composition`: the free canvas without the open card, the floating keys, the names
that stand at rest and a measured text snapshot). The shipped arrangement is always candidate one and
the complete fallback; `composition/graph-composition.ts` builds the small fixed set of alternatives (routes only,
all groups moving together, the same with an aspect correction), repairs each against the drawn
outlines, places headings and names, routes every pair and evaluates the finished drawing, then selects
a whole packet or keeps the original. `graph-composition.ts` holds the entry point; its
`graph-composition-*.ts` parts (all in `composition/`) hold the shared context, text, layout, collision, child-first, drawing,
hull, selection and candidate stages. Exhausting the per-solve work allowance (`graph-work-budget.ts`)
discards a candidate, never returns half of one.

- `graph-text-metrics.ts` is the browser seam: one SVG measurer, a revisioned numeric snapshot.
- `graph-relationship-routing.ts` routes each pair over fixed positions; `graph-shapes.ts` holds the
  signed geometry both it and the independent evaluator in `graph-layout-quality.ts` use. The evaluator
  reads final SVG path data, so a tie entering a dot between its waypoints is still found.
- The packet owns positions, centres, offsets, paths and reference text for one automatic arrangement (`Arrangement.revision`). That arrangement is made only when data, filters, Grouping, hierarchy or the frozen canvas facts change. Selection, hover, search, the card, the camera, a resize, a Reset and late fonts are outside its identity.
- Manual geometry (`graph-manual.ts`) is laid over it as pure translation: a group move shifts that group's members, centre, standing names, headings and internal paths rigidly; a Worker move shifts only that Worker, its name and the ends of its paths (a path's interior is bent by a linear blend of its two end shifts). There is no neighbour lean, no collision displacement and no route repair; overlap or an offscreen placement the organizer makes is accepted. A re-layout trigger drops the moves, and coming back to an earlier layout does not restore them. Reset and resize change the camera only.
- Standing names are frozen (`map-frozen-names.ts`): once a scene is framed, each name keeps its side and screen-pixel offset from its dot, so zoom, pan and a moved dot only do arithmetic. A name revealed later by hover or selection attaches to the right of its dot without a search. The surface publishes `data-scene-revision`, `data-manual-revision`, `data-manual-moves` and `data-scene-ready` for tests to wait on.
- Sub-grouping composes inside its parent. Free keeps the physics arrangement and frames measured resting names around its floating keys. Isolate is a focus over either reading.

## Initial name framing and frozen attachments

Initial Free framing uses measured resting names and reserves the floating keys. Initial
placement prefers names within 32 screen pixels of the dot surface; a name displaced farther
by crowded geometry draws its dotted leader. Initial placement and name fitting are bounded.
Composed Grouped drawings use their packet's reference fit; fallback drawings can validate
rendered names during initial framing. These searches run only while preparing a new scene.

After preparation, worker names retain their chosen side, visible size and screen gap.
The nearest point of the name box defines its attachment direction, so zoom arithmetic
preserves the gap even for names whose anchor is off-center. A moved worker carries its
name. Group and subgroup outlines/headings are frozen with the scene and a group move
translates them rigidly. Names and headings may overlap after user manipulation; they are
not re-searched, hidden or moved to repair the overlap. Hover/selection can reveal an extra
name beside its dot without changing the resting names.

Reset fits the current drawing using frozen names; resize changes the camera only. Neither
runs the initial placement or DOM name-fit pass again. A data/filter/grouping/hierarchy
change prepares a fresh automatic scene and discards manual shifts.

## Mapping verification

`npm run test:mapping` runs the focused unit cases, builds the app and shim once, and starts an owned temporary database. It
runs the fixed Mapping contract selection with one Chromium worker and zero retries.
The browser selection has a two-minute overall limit. Build time is reported separately.
Mapping chooses an unused port and a fresh temporary database by default, so an active app
server can stay running. `WOBBLE_E2E_PORT` and `WOBBLE_E2E_DB` can override those locations. The runner saves its manifest, results and failure traces in the printed
run directory. The selection includes captured initial drawings, exact density-sequence
replay, rigid manual movement, frozen headings/names, hierarchy invalidation, normal-motion
readiness, real backend loading, keyboard and touch. It does not run app-wide e2e.

A mounted canvas owns its arrangement caches. Automatic scene identity determines when
manual overrides expire; it includes relationship and grouping-answer changes even when
Worker and Attribute IDs stay identical. The scene exposes camera request revisions and
readiness only after the camera has arrived, dots landed and text attachments frozen.
Preparation exhaustion is an explicit error rather than successful readiness.

Once frozen, outlines/headings translate with the group's manual offset. An individually
moved worker may leave its outline. Initial fitting is the only stage that searches for
label positions; camera changes do not repeat it. Existing broader membership and graph
algorithm tests remain useful for their own modules; they are not a mandatory edit loop.

Collision diagnostics in `data-composition-report` describe the initial packet. They are not
re-evaluated during camera or manual movement. Browser tests that need an independent final-drawing
assessment collect the rendered geometry and evaluate it outside the production render path.
