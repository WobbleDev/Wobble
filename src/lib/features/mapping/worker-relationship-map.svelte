<script lang="ts">
	/**
	 * The Mapping page body: it builds the graph model, holds the view state, and hands
	 * both to the canvas.
	 */
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { searchResults } from './map-search-results.ts';
	import type { PersonPartition } from '#lib/shared/person-state.svelte.ts';
	import { onDestroy, onMount, tick, untrack } from 'svelte';
	import { MediaQuery, SvelteSet } from 'svelte/reactivity';
	import { assessmentOptions, type Worker } from '#lib/domain-vocabulary.ts';
	import type { Agitation, Language, WorkerAttributeDefinition } from '#lib/domain-vocabulary.ts';
	import { answerDisplayLabel } from '#lib/shared/answer-path.ts';
	import { collapseBranch } from '#lib/shared/answer-hierarchy.ts';
	import { formatAttributeValue } from '#lib/shared/format.ts';
	import { normalizeForMatch } from '#lib/shared/text.ts';
	import { toPopulationFilters } from '#lib/shared/contextual-filters.ts';
	import { heldIds, storesList } from '#lib/shared/select-mode.ts';
	import { selectWorkerPopulation } from '#lib/shared/worker-population.ts';
	import { assessmentColorKey, assessmentColorFor } from '../../shared/assessment.ts';
	import { assessmentLabel } from '#lib/i18n/assessment.ts';
	import { m } from '#lib/paraglide/messages.js';
	import { buildAdjacency } from './layout/graph-analysis.ts';
	import { assessmentCounts } from './map-reading.ts';
	import { nodeRadius } from './map-style.ts';
	import { dotSizeKeyGeometry } from './dot-size-key.ts';
	import { evaluateHighlightQuery } from './map-highlight-query.ts';
	import {
		MapViewState,
		readMapViewSnapshot,
		type MapViewCapture
	} from './map-view-state.svelte.ts';
	import {
		deriveVisibleGraph,
		dossierNeighbours,
		isolateDrawnLinkIds,
		isolateNeighbourhood,
		labelledWorkerIds,
		linkRegions as readLinkRegions,
		resolveEffectiveLayout
	} from './map-view-model.ts';
	import {
		attemptExpansion,
		projectLayoutInput,
		readGrouping,
		type ExpansionBranch,
		type ExpansionRefusal
	} from './grouping/map-grouping.ts';
	import { contextFilterLabels } from './map-contextual-filters.ts';
	import { createPanZoom } from './map-pan-zoom.svelte.ts';
	import { floatingGutter } from './layout/graph-free-canvas.ts';
	import { buildWorkerGraph, type WorkerGraphNode } from './worker-relationship-map-model.ts';
	import MapCanvas from './map-canvas.svelte';
	import MapToolbar from './map-toolbar.svelte';
	import WorkerDossier from './worker-dossier.svelte';
	import MapTable from './map-table.svelte';
	import { mapEmptyKind, mapScope } from './map-scope.ts';
	import { createView, deleteView, listViews, updateView } from '#lib/client/views-api.ts';
	import { createSavedViews } from '#lib/features/saved-views/saved-views.svelte.ts';
	import SavedViewReviewDialog from '#lib/features/saved-views/saved-view-review-dialog.svelte';
	import {
		captureMappingView,
		mappingViewToSnapshot
	} from '#lib/features/saved-views/mapping-view-state.ts';

	type Props = {
		workers: readonly Worker[];
		attributes: readonly WorkerAttributeDefinition[];
		languages: readonly Language[];
		agitations: readonly Agitation[];
		/** The private person-specific partition of the active Worksite. */
		person: PersonPartition;
	};

	let { workers, attributes, languages, agitations, person }: Props = $props();

	const view = new MapViewState(
		untrack(() => ({
			attributes,
			languages,
			agitations,
			person,
			// The address itself, not `page.url`: after Back to an entry rewritten in place,
			// `page.url` can still be the entry's earlier address, and the legend would then
			// disagree with the URL.
			initial: readMapViewSnapshot(new URLSearchParams(window.location.search), attributes)
		}))
	);
	/**
	 * Saved Mapping views. Opening one sets the map's own question (it rides the address
	 * through the view state); the toolbar search, the selected Worker, Isolate, the camera
	 * and manual positions stay the organizer's and are never stored.
	 */
	const savedViews = createSavedViews({
		kind: 'mapping',
		api: {
			list: listViews,
			create: createView,
			update: updateView,
			remove: deleteView
		},
		vocabulary: () => ({ attributes, languages, agitations }),
		capture: () => ({ version: 1, kind: 'mapping', mapping: captureMappingView(view.capture()) }),
		apply: (snapshot) => {
			if (!snapshot.mapping) return;
			view.restore({
				...mappingViewToSnapshot(snapshot.mapping, view.isolated),
				query: view.query,
				selected: view.selectedId
			});
		}
	});
	const panZoom = createPanZoom();
	/** At the floating breakpoint the keys ride over the canvas in their glass chrome. */
	const floatingChrome = new MediaQuery('min-width: 1024px');

	// A restored `x`/`xs` list the current configuration cannot honour is rewritten to
	// the applied detail once, after the router and the first effect flush are ready.
	onMount(() => {
		void tick().then(() => view.canonicalizeAddress());
	});

	let canvasElement: HTMLElement | undefined = $state();
	let stripHeight = $state(0);
	let keyHeight = $state(0);
	let keyWidth = $state(0);
	let dotKeyHeight = $state(0);
	let dotKeyWidth = $state(0);

	const graph = $derived(buildWorkerGraph(workers));
	const adjacency = $derived(buildAdjacency(graph));

	const workerById = $derived(new Map(workers.map((worker) => [worker.id, worker])));
	const selectedWorker = $derived(view.selectedId ? workerById.get(view.selectedId) : undefined);
	const selectedNeighbours = $derived(
		dossierNeighbours(
			view.selectedId,
			adjacency,
			new Map(graph.nodes.map((node) => [node.id, node]))
		)
	);

	const baseCounts = $derived(assessmentCounts(workers));

	/**
	 * The map's population: the shared projection selects the same distinct Workers
	 * the Workers view selects for the same conditions. Every condition is read on the
	 * Worker itself, so a Multi-Select holding several answers still leaves the person
	 * once — the graph and the Map table are built from Workers.
	 */
	const populationFilters = $derived(toPopulationFilters(view.contextFilters));
	const population = $derived(selectWorkerPopulation(workers, attributes, populationFilters));
	const populationIds = $derived(new Set(population.workers.map((worker) => worker.id)));

	function isFilteredOut(worker: Worker): boolean {
		if (!populationIds.has(worker.id)) return true;
		if (view.hiddenAssessments.includes(worker.assessment)) return true;

		for (const attribute of attributes) {
			const hidden = view.hiddenValues[attribute.id];
			if (!hidden || hidden.length === 0) continue;

			const held = heldIds(worker.attributes[attribute.id]);
			if (!storesList(attribute)) {
				if (held.length > 0 && hidden.includes(held[0])) return true;
			} else if (held.length > 0 && held.every((id) => hidden.includes(id))) {
				return true;
			}
		}

		if (
			worker.languages.length > 0 &&
			worker.languages.every((id) => view.hiddenLanguages.includes(id))
		) {
			return true;
		}

		return false;
	}

	/**
	 * The selected Worker's neighbourhood, partitioned once: the two-hop set the
	 * map is narrowed to, and the second degree the canvas ghosts.
	 */
	const isolatedNeighbourhood = $derived(
		isolateNeighbourhood(adjacency, view.selectedId, view.isolated)
	);

	const isolatedKeptIds = $derived(isolatedNeighbourhood?.keptIds);
	const ghostedIds = $derived(isolatedNeighbourhood?.secondDegree ?? new Set<string>());

	const filteredIds = $derived(new Set(workers.filter(isFilteredOut).map((worker) => worker.id)));

	$effect(() => {
		if (view.selectedId && filteredIds.has(view.selectedId)) view.select('');
	});

	/** The filter groups currently hiding workers, for the empty state's explanation. */
	const activeFilterLabels = $derived.by(() => {
		const labels: string[] = [];
		if (view.hiddenAssessments.length > 0) labels.push(m.mapping_table_assessment());
		for (const [attributeId, values] of Object.entries(view.hiddenValues)) {
			if (values.length === 0) continue;
			labels.push(
				attributes.find((attribute) => attribute.id === attributeId)?.name ?? attributeId
			);
		}
		if (view.hiddenLanguages.length > 0) labels.push(m.domain_language());
		// The contextual conditions narrow the same population; the empty map names the
		// questions that took every Worker out.
		labels.push(...contextFilterLabels(view.contextFilters, attributes));
		return labels;
	});

	/** The Workers outside the Isolate neighbourhood, which the map does not draw. */
	const isolatedOutsideIds = $derived(
		isolatedKeptIds === undefined
			? new Set<string>()
			: new Set(
					workers.filter((worker) => !isolatedKeptIds.has(worker.id)).map((worker) => worker.id)
				)
	);

	const queryMatches = $derived.by(() => {
		const query = normalizeForMatch(view.query);
		if (!query) return new Set<string>();

		return new Set(
			workers
				.filter((worker) => worker.name.toLowerCase().includes(query))
				.map((worker) => worker.id)
		);
	});

	const highlightIds = $derived(evaluateHighlightQuery(view.highlight, workers, attributes));

	const spotlightIds = $derived.by(() => {
		const ids = new SvelteSet<string>();

		for (const id of queryMatches) ids.add(id);

		const anchor = view.hoveredId || view.selectedId;
		if (anchor) {
			ids.add(anchor);
			for (const neighbor of adjacency.get(anchor) ?? []) ids.add(neighbor);
		}

		return ids;
	});

	function colorFor(node: WorkerGraphNode): string {
		// The global token, not the chart's injected `--color-*` <style>: the desktop CSP drops that.
		return assessmentColorFor(node.assessment);
	}

	function radiusFor(node: WorkerGraphNode): number {
		return nodeRadius(node.relationshipCount);
	}

	const chartConfig = $derived.by(() => {
		const config: Record<string, { label: string; color: string }> = {};
		for (const assessment of assessmentOptions) {
			config[assessmentColorKey(assessment)] = {
				label: assessmentLabel(assessment),
				color: assessmentColorFor(assessment)
			};
		}
		return config;
	});

	/**
	 * What the arrangement places: the filters alone, so Isolate moves no dot.
	 */
	const layoutGraph = $derived.by(() => deriveVisibleGraph(graph.nodes, graph.links, filteredIds));

	/**
	 * The one grouping ledger every choice reads: the layout set's Workers and their
	 * own held answers. Availability for every choice is cheap; narrowing guidance is
	 * asked for only for the refusal that is actually on screen.
	 */
	const groupingInput = $derived({
		nodes: layoutGraph.nodes,
		workers,
		attributes,
		filters: populationFilters
	});
	const groupingReadings = $derived.by(
		() =>
			new Map(
				view.groupableAttributes.map((attribute) => [
					attribute.id,
					readGrouping(groupingInput, attribute.id)
				])
			)
	);
	const activeGroupingReading = $derived.by(() =>
		view.groupingAttribute
			? readGrouping(groupingInput, view.groupingAttribute.id, {
					subAttributeId: view.subGroupingAttribute?.id,
					guidance: true,
					expandedIds: view.expanded,
					expandedSubIds: view.expandedSub
				})
			: undefined
	);
	const activeGrouping = $derived(
		activeGroupingReading?.status === 'available' ? activeGroupingReading : undefined
	);

	/**
	 * The branches the Group control can open or close at this detail: every occupied
	 * answer region that has children, plus the branches already open so a restored
	 * detail can still be collapsed. An empty region is no affordance.
	 */
	function expansionBranchesFor(
		attribute: WorkerAttributeDefinition | undefined,
		reading: { regions: readonly { key: string; label: string; identity: string }[] } | undefined,
		expanded: readonly string[]
	): ExpansionBranch[] {
		if (!attribute) return [];
		const parents = new Set(
			attribute.answers
				.map((answer) => answer.parentId)
				.filter((parentId): parentId is string => typeof parentId === 'string')
		);
		const rows: ExpansionBranch[] = [];
		for (const region of reading?.regions ?? []) {
			if (region.identity !== 'answer' || !parents.has(region.key)) continue;
			if (rows.some((row) => row.answerId === region.key)) continue;
			rows.push({ answerId: region.key, label: region.label, expanded: false });
		}
		for (const answerId of expanded) {
			if (!attribute.answers.some((answer) => answer.id === answerId)) continue;
			const row = {
				answerId,
				label: answerDisplayLabel(attribute.answers, answerId),
				expanded: true
			};
			const existing = rows.findIndex((entry) => entry.answerId === answerId);
			if (existing === -1) rows.push(row);
			else rows[existing] = row;
		}
		const position = new Map(attribute.answers.map((answer, index) => [answer.id, index]));
		return rows.sort(
			(first, second) => (position.get(first.answerId) ?? 0) - (position.get(second.answerId) ?? 0)
		);
	}

	const primaryExpansionBranches = $derived.by(() =>
		expansionBranchesFor(view.groupingAttribute, activeGrouping, view.expanded)
	);
	const secondaryExpansionBranches = $derived.by(() =>
		expansionBranchesFor(
			view.subGroupingAttribute,
			activeGrouping?.subGrouping?.status === 'available' ? activeGrouping.subGrouping : undefined,
			view.expandedSub
		)
	);

	/**
	 * Whether each secondary choice puts every displayed Worker in one pair. Only the
	 * primary availability gates them: an unavailable primary shows no per-choice
	 * marking, because the primary's own status explains the fallback.
	 */
	const subGroupingReadings = $derived.by(() => {
		const primary = view.groupingAttribute;
		if (!primary || !activeGrouping) return new Map();
		return new Map(
			view.subGroupingAttributes.map((attribute) => {
				const reading = readGrouping(groupingInput, primary.id, {
					subAttributeId: attribute.id
				});
				return [
					attribute.id,
					reading.status === 'available' ? reading.subGrouping : undefined
				] as const;
			})
		);
	});

	/**
	 * The solver's view of the same partition: projected region keys and a view-only
	 * synthetic definition. The real definition stays authoritative for predicates,
	 * and the graph itself — one node per Worker, the same links — is untouched.
	 */
	const projectedGrouping = $derived.by(() => {
		const attribute = view.groupingAttribute;
		if (!attribute || !activeGrouping) return undefined;
		return projectLayoutInput(
			layoutGraph.nodes,
			activeGrouping,
			attribute,
			view.subGroupingAttribute
		);
	});
	const groupingAttribute = $derived(projectedGrouping?.groupingAttribute);
	/** A projected secondary exists only while the pairing is available. */
	const effectiveSubGroupingAttribute = $derived(projectedGrouping?.subGroupingAttribute);
	/** An unavailable primary Grouping falls back to Free and takes its Sub-grouping with it. */
	const effectiveLayout = $derived(resolveEffectiveLayout(view.layout, groupingAttribute));
	const projectedNodesById = $derived(
		new Map((projectedGrouping?.nodes ?? []).map((node) => [node.id, node]))
	);
	const projectedLayoutNodes = $derived(projectedGrouping?.nodes ?? layoutGraph.nodes);
	const tooltipAttributes = $derived(
		attributes.map((attribute) =>
			attribute.id === groupingAttribute?.id
				? groupingAttribute
				: attribute.id === effectiveSubGroupingAttribute?.id
					? effectiveSubGroupingAttribute
					: attribute
		)
	);
	const workerNames = $derived(new Map(workers.map((worker) => [worker.id, worker.name])));

	/** What the map draws: the layout set narrowed by the Isolate focus. */
	const excludedIds = $derived(new Set([...filteredIds, ...isolatedOutsideIds]));

	/**
	 * The Relationships Isolate keeps: its own neighbourhood's, second↔second left
	 * out. Undefined outside Isolate, when every filtered Relationship is drawn.
	 */
	const isolatedLinkIds = $derived(
		isolatedNeighbourhood ? isolateDrawnLinkIds(graph.links, isolatedNeighbourhood) : undefined
	);

	const visibleGraph = $derived.by(() => {
		const visible = deriveVisibleGraph(graph.nodes, graph.links, excludedIds);
		if (!isolatedLinkIds) return visible;

		return {
			nodes: visible.nodes,
			links: visible.links.filter((link) => isolatedLinkIds.has(link.id))
		};
	});

	/** The same drawn Workers, carrying their projected region key for the layout. */
	const projectedVisibleNodes = $derived(
		visibleGraph.nodes.map((node) => projectedNodesById.get(node.id) ?? node)
	);

	const scopeInput = $derived({
		total: workers.length,
		layoutCount: projectedLayoutNodes.length,
		visibleCount: projectedVisibleNodes.length,
		isolatedInEffect: view.isolatedInEffect
	});
	const emptyKind = $derived(mapEmptyKind(scopeInput));
	const scope = $derived(mapScope(scopeInput));

	const searchResultList = $derived(
		searchResults({
			query: view.query,
			workers,
			attributes,
			drawnIds: new Set(projectedVisibleNodes.map((node) => node.id))
		})
	);

	/** How many drawn Workers the complete Highlight query selects, out of the drawn total. */
	const highlightCount = $derived(
		highlightIds === undefined
			? undefined
			: {
					matching: projectedVisibleNodes.filter((node) => highlightIds.has(node.id)).length,
					drawn: projectedVisibleNodes.length
				}
	);

	/** The names that stand at rest: the cap's ranking with selection and hover neutralized. */
	const restingLabelIds = $derived(labelledWorkerIds(graph.nodes, {}));

	// Isolate draws a small neighbourhood, so every dot in it is named.
	const labelIds = $derived.by(() => {
		if (view.isolatedInEffect) return new Set(visibleGraph.nodes.map((node) => node.id));
		// Free names the resting set first and adds the hovered or selected name on top, so
		// pointing at a Worker never takes another Worker's name away. Grouped keeps the
		// shipped cap, which counts an active name inside it.
		if (groupingAttribute === undefined) {
			const ids = new SvelteSet(restingLabelIds);
			for (const id of [view.selectedId, view.hoveredId]) if (id) ids.add(id);
			return ids;
		}
		return labelledWorkerIds(graph.nodes, {
			selectedId: view.selectedId,
			hoveredId: view.hoveredId
		});
	});

	/** Each Relationship read as crossing between Grouping regions or staying within one. */
	const linkRegionReadings = $derived(
		readLinkRegions(projectedLayoutNodes, layoutGraph.links, groupingAttribute)
	);

	/**
	 * The one derived view the canvas draws: what is visible, and what is emphasised.
	 *
	 * Every field is a getter over the value it comes from, so the canvas's
	 * derivations (groups, regions, the arrangement) track only the fields they
	 * actually read. A `$derived` object would instead make each of them depend on
	 * the whole bundle, so a hover or a selection would recompute the arrangement
	 * under the pointer.
	 */
	const viewModel = {
		get effectiveLayout() {
			return effectiveLayout;
		},
		get isolated() {
			return view.isolatedInEffect;
		},
		get layoutNodes() {
			return projectedLayoutNodes;
		},
		get layoutLinks() {
			return layoutGraph.links;
		},
		get visibleNodes() {
			return projectedVisibleNodes;
		},
		get visibleLinks() {
			return visibleGraph.links;
		},
		get selectedId() {
			return view.selectedId;
		},
		get hoveredId() {
			return view.hoveredId;
		},
		get ghostedIds() {
			return ghostedIds;
		},
		get labelIds() {
			return labelIds;
		},
		get restingLabelIds() {
			return restingLabelIds;
		},
		get linkRegions() {
			return linkRegionReadings;
		},
		get spotlightIds() {
			return spotlightIds;
		},
		get highlightIds(): ReadonlySet<string> | undefined {
			return highlightIds;
		}
	};

	function handleSelect(workerId: string) {
		view.select(workerId);
	}

	/** A drawn search result becomes the selection (never a toggle off) and takes focus. */
	function chooseResult(workerId: string) {
		view.selectedId = workerId;
		void tick().then(() => {
			canvasElement?.querySelector<SVGElement>(`[data-node-id="${CSS.escape(workerId)}"]`)?.focus();
		});
	}

	/** A hidden result opens in Workers; no filter, grouping or Isolate changes on the way. */
	function openResultInWorkers(workerId: string) {
		person.workersSelectedId = workerId;
		void goto(resolve('/workers'));
	}

	/**
	 * Escape closes the worker card from anywhere in the map's chrome (the card
	 * itself, or focus nowhere), not only from a node. Focus goes back to the node
	 * if it is still drawn, else to the canvas. Keys the map or an open control
	 * already took (defaultPrevented) and text fields are left alone.
	 */
	function handleEscape(event: KeyboardEvent) {
		if (event.key !== 'Escape' || event.defaultPrevented || !selectedWorker) return;
		const target = event.target;
		if (target instanceof Element) {
			if (
				target.closest(
					'input, textarea, select, [role="listbox"], [role="dialog"], [aria-expanded="true"]'
				)
			)
				return;
			if (target !== document.body && !canvasElement?.contains(target)) return;
		}
		const id = selectedWorker.id;
		view.select('');
		void tick().then(() => {
			const node = canvasElement?.querySelector<SVGElement>(`[data-node-id="${CSS.escape(id)}"]`);
			(node ?? canvasElement?.querySelector<HTMLElement>('[role="application"]'))?.focus();
		});
	}

	/** The last clear or reset, held briefly so a wrong click can be taken back. */
	let undo = $state<{ snapshot: MapViewCapture; label: string } | null>(null);
	let undoTimer: ReturnType<typeof setTimeout> | undefined;

	function startUndoTimer() {
		clearTimeout(undoTimer);
		undoTimer = setTimeout(() => (undo = null), 6000);
	}

	function offerUndo(label: string) {
		undo = { snapshot: view.capture(), label };
		startUndoTimer();
	}

	function pauseUndoTimer() {
		clearTimeout(undoTimer);
	}

	function resumeUndoTimer() {
		if (undo) startUndoTimer();
	}

	function dismissUndo() {
		undo = null;
		clearTimeout(undoTimer);
	}

	function runClearFilters() {
		offerUndo(m.mapping_undo_filters_cleared());
		view.clearFilters();
	}

	/** The explicit clear: the unavailable Grouping leaves state and address. */
	function clearGrouping() {
		view.clearGrouping();
	}

	/** A transient explanation for a refused expansion; state and address stay untouched. */
	let expansionRefusal = $state<ExpansionRefusal | null>(null);
	let subExpansionRefusal = $state<ExpansionRefusal | null>(null);

	/**
	 * Attempts one branch of the primary Grouping. Only a candidate that still puts every
	 * displayed Worker in one region commits; a refusal keeps the coarser view as it was.
	 */
	function togglePrimaryExpansion(answerId: string, expand: boolean) {
		const attribute = view.groupingAttribute;
		if (!attribute) return;
		if (!expand) {
			view.expanded = collapseBranch(attribute, view.expanded, answerId);
			expansionRefusal = null;
			return;
		}
		const attempt = attemptExpansion(groupingInput, attribute.id, view.expanded, answerId);
		if (attempt.status === 'available') {
			view.expanded = attempt.expandedIds;
			expansionRefusal = null;
		} else {
			expansionRefusal = attempt.reason;
		}
	}

	/** The same attempt for the paired Sub-grouping's own Attribute. */
	function toggleSecondaryExpansion(answerId: string, expand: boolean) {
		const attribute = view.subGroupingAttribute;
		if (!attribute) return;
		if (!expand) {
			view.expandedSub = collapseBranch(attribute, view.expandedSub, answerId);
			subExpansionRefusal = null;
			return;
		}
		const attempt = attemptExpansion(groupingInput, attribute.id, view.expandedSub, answerId);
		if (attempt.status === 'available') {
			view.expandedSub = attempt.expandedIds;
			subExpansionRefusal = null;
		} else {
			subExpansionRefusal = attempt.reason;
		}
	}

	$effect(() => {
		// A different Grouping is a different branch list, so an old attempt no longer applies.
		void view.groupBy;
		void view.subGroupBy;
		untrack(() => {
			expansionRefusal = null;
			subExpansionRefusal = null;
		});
	});

	function runReset() {
		offerUndo(m.mapping_undo_view_reset());
		view.reset();
		panZoom.resetView();
	}

	function applyUndo() {
		if (!undo) return;
		view.restore(undo.snapshot);
		undo = null;
		clearTimeout(undoTimer);
	}

	onDestroy(() => clearTimeout(undoTimer));
	// The dot-size key keeps the map's relative dot sizes at one fixed scale (dot-size-key.ts).
	const dotSizeKey = dotSizeKeyGeometry();
	// Initial readiness stays true across later resizes and user-driven reframing.
	let mapReady = $state(false);
</script>

<svelte:window onkeydown={handleEscape} />

<div class="relative flex h-full min-h-0 min-w-0 flex-1 flex-col">
	<p class="sr-only" aria-live="polite">
		<!-- The map announces both the selection and the Isolated reframe. -->
		{#if selectedWorker}
			{view.isolatedInEffect
				? m.mapping_selected_isolated({ name: selectedWorker.name })
				: m.mapping_selected({ name: selectedWorker.name })}
		{/if}
	</p>
	<!--
		Below lg the stacked panels (control strip, bottom bar, dot key) are in normal
		flow inside this canvas band. On a short viewport the panels want more height
		than the band has: flex then collapses the drawing surface to zero (or to a
		sliver), so there is nothing usable to measure and the map never becomes
		ready. A floor under the band keeps a real map height and lets the page
		scroller take the overflow instead of hiding the map. Taller phones and
		desktop fit already, so the floor never applies there.
	-->
	<div
		data-testid="relationship-map-canvas"
		data-map-ready={mapReady ? 'true' : undefined}
		bind:this={canvasElement}
		class="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-surface bg-panel shadow-surface max-lg:[@media(max-height:44.999rem)]:min-h-[38rem]"
	>
		<MapCanvas
			nodes={projectedLayoutNodes}
			attributes={tooltipAttributes}
			{groupingAttribute}
			subGroupingAttribute={effectiveSubGroupingAttribute}
			{viewModel}
			{colorFor}
			{radiusFor}
			formatValue={formatAttributeValue}
			{chartConfig}
			{panZoom}
			{stripHeight}
			barHeight={0}
			keySize={{ width: keyWidth, height: keyHeight }}
			dotKeySize={{ width: dotKeyWidth, height: dotKeyHeight }}
			cardOpen={selectedWorker !== undefined}
			groupGap={view.groupGap}
			{emptyKind}
			isolateName={selectedWorker?.name}
			onExitIsolate={() => (view.isolated = false)}
			hiddenCount={filteredIds.size}
			{activeFilterLabels}
			onClearFilters={runClearFilters}
			onSelect={handleSelect}
			onHover={(id) => (view.hoveredId = id)}
			onReady={() => (mapReady = true)}
		>
			{#snippet children({ resetFrame })}
				<a
					href="#mapping-table"
					tabindex="-1"
					class="sr-only"
					data-testid="skip-to-map-table"
					onclick={(event) => {
						event.preventDefault();
						document.getElementById('mapping-table')?.focus();
					}}>{m.mapping_skip_to_table()}</a
				>
				<MapTable
					nodes={projectedVisibleNodes}
					links={visibleGraph.links}
					{groupingAttribute}
					subGroupingAttribute={effectiveSubGroupingAttribute}
					reading={activeGrouping}
					{languages}
					{highlightIds}
					selectedId={view.selectedId}
					onSelect={handleSelect}
				/>
				<MapToolbar
					{panZoom}
					bind:query={view.query}
					matchCount={queryMatches.size}
					results={searchResultList.results}
					onChooseResult={chooseResult}
					onOpenResultInWorkers={openResultInWorkers}
					{view}
					{savedViews}
					{attributes}
					{languages}
					{highlightCount}
					{groupingReadings}
					{subGroupingReadings}
					{activeGroupingReading}
					{workerNames}
					expansionBranches={primaryExpansionBranches}
					{expansionRefusal}
					subExpansionBranches={secondaryExpansionBranches}
					{subExpansionRefusal}
					onToggleExpansion={togglePrimaryExpansion}
					onToggleSubExpansion={toggleSecondaryExpansion}
					onClearGrouping={clearGrouping}
					{undo}
					onUndo={applyUndo}
					onDismissUndo={dismissUndo}
					onPauseUndo={pauseUndoTimer}
					onResumeUndo={resumeUndoTimer}
					onReset={runReset}
					onResetFrame={resetFrame}
					onClearFilters={runClearFilters}
					boundary={canvasElement}
					bind:stripHeight
				/>
			{/snippet}
		</MapCanvas>
		<SavedViewReviewDialog views={savedViews} {attributes} />
		<!-- A footer, not an overlay. As an overlay it covered the toolbar's own
	     bottom bar, so the Isolate control was unreadable and unaidable on
	     every phone while still being the hit target underneath.

	     It is a division inside the pad rather than a surface of its own: the
	     rule is the only thing between the map and the key, because two
	     surfaces here would have to differ by a stop and neither has one to
	     spare. Its counts are the label voice.

     The bar tightens vertically on phones. Height is the scarce resource
     there — the canvas is the whole point of the surface and must still
     end above the fold with the option rail reachable beneath it — while
     from the tablet rung up there is room to give the key a comfortable
     band, which is what every other bar in the app takes.

     At lg the key floats over the canvas on the bottom bar's own row, and its
     width is capped by the bar's measured controls, so the two share the row
     and cannot overlap; the key wraps to a second line instead. -->
		<div
			data-testid="mapping-bottom-bar"
			bind:offsetHeight={keyHeight}
			bind:offsetWidth={keyWidth}
			role="group"
			aria-label={m.mapping_key_group()}
			data-material={floatingChrome.current ? 'glass' : undefined}
			style:--key-room="{dotKeyWidth + floatingGutter * 3}px"
			class="flex shrink-0 flex-col gap-1 border-t border-rule bg-panel px-4 py-2 md:py-3 lg:pointer-events-none lg:absolute lg:bottom-3 lg:left-3 lg:z-10 lg:max-w-[calc(100%-var(--key-room))] lg:rounded-control lg:border-0 lg:bg-transparent lg:p-0"
		>
			<!--
				Two rows are reserved (2.875rem = 2×1.3125rem row + 0.25rem gap; 46px
				at Standard density). The items sit within a pixel of the container
				width, so their sub-pixel settlement flips the row count after mount;
				that late wrap grew this legend by 25px and shrank the canvas under
				its own chart, which then clipped. A rem value keeps the reserve
				exactly two rows at every density, so the canvas size is fixed from
				the first paint.
			-->
			<ul
				class="flex min-h-[2.875rem] w-full min-w-0 flex-wrap items-center gap-x-1 gap-y-1 text-sm lg:pointer-events-auto lg:min-h-0 lg:w-auto lg:gap-x-0 lg:rounded-control lg:p-0 lg:text-[0.6875rem]"
			>
				{#each assessmentOptions as assessment (assessment)}
					{@const shown = !view.hiddenAssessments.includes(assessment)}
					<li>
						<!-- Kept raw: the strike-through of a hidden assessment is not part of any ui control. -->
						<button
							type="button"
							aria-pressed={shown}
							aria-label={shown
								? (baseCounts[assessment] ?? 0) === 1
									? m.mapping_key_shown_one({
											assessment: assessmentLabel(assessment),
											count: baseCounts[assessment] ?? 0
										})
									: m.mapping_key_shown_other({
											assessment: assessmentLabel(assessment),
											count: baseCounts[assessment] ?? 0
										})
								: (baseCounts[assessment] ?? 0) === 1
									? m.mapping_key_hidden_one({
											assessment: assessmentLabel(assessment),
											count: baseCounts[assessment] ?? 0
										})
									: m.mapping_key_hidden_other({
											assessment: assessmentLabel(assessment),
											count: baseCounts[assessment] ?? 0
										})}
							class="flex min-h-tap items-center gap-2 rounded-control px-2 whitespace-nowrap hover:bg-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring aria-[pressed=false]:text-ink-3 aria-[pressed=false]:line-through md:min-h-8 lg:gap-1 lg:px-0.5"
							onclick={() => view.toggleAssessment(assessment)}
						>
							<span
								aria-hidden="true"
								class="size-2 shrink-0 rounded-full"
								style={`background-color: ${assessmentColorFor(assessment)}`}
								style:opacity={shown ? 1 : 0.3}
							></span>
							{assessmentLabel(assessment)}
							<span class="label num text-ink">{baseCounts[assessment] ?? 0}</span>
						</button>
					</li>
				{/each}
				{#if isolatedNeighbourhood}
					<li class="px-0 text-[0.6875rem] text-ink-3">
						{m.mapping_key_direct({
							direct: isolatedNeighbourhood.firstDegree.size,
							second: isolatedNeighbourhood.secondDegree.size
						})}
					</li>
				{/if}
			</ul>
		</div>
		<!-- The dot-size key: one line along the bottom right, its circles in the map's
		     proportions at one fixed size, so the key never changes size with the zoom.
		     Below lg it is its own row under the colour key; from lg up it floats over
		     the canvas. -->
		<div
			data-testid="mapping-dot-key"
			bind:offsetHeight={dotKeyHeight}
			bind:offsetWidth={dotKeyWidth}
			role="img"
			aria-label={m.mapping_dot_key_aria()}
			class="flex w-full shrink-0 flex-col items-end gap-1 border-t border-rule bg-panel px-4 py-2 text-[0.6875rem] text-ink-3 lg:pointer-events-auto lg:absolute lg:right-3 lg:bottom-3 lg:z-10 lg:w-fit lg:max-w-[calc(100%-1.5rem)] lg:border-0 lg:bg-transparent lg:p-0"
		>
			<span class="label text-ink-3">{m.domain_relationships()}</span>
			<svg
				aria-hidden="true"
				viewBox={`0 0 ${dotSizeKey.width} ${dotSizeKey.height}`}
				width={dotSizeKey.width}
				class="h-auto max-w-[22rem] shrink-0 overflow-visible"
			>
				{#each dotSizeKey.steps as step (step.label)}
					<circle
						cx={step.x}
						cy={dotSizeKey.height / 2}
						r={step.r}
						fill="none"
						class="stroke-ink-3"
					/>
					<text
						x={step.x + step.r + 3}
						y={dotSizeKey.height / 2}
						dominant-baseline="middle"
						class="num fill-ink-3">{step.label}</text
					>
				{/each}
			</svg>
		</div>
		<!-- An overlay above the keys, outside their measured boxes: the keys' size steers name
		     placement and the canvas height, so the reading must not change either. -->
		<p
			data-testid="map-scope-reading"
			data-material="glass"
			style:bottom="{(floatingChrome.current ? keyHeight : keyHeight + dotKeyHeight) + 12}px"
			class="label num pointer-events-none absolute left-3 z-10 max-w-[calc(100%-1.5rem)] rounded-item px-2 py-1 text-ink-3"
		>
			{[
				m.mapping_scope_drawn({ drawn: scope.drawn, total: scope.total }),
				...(scope.hidden > 0 ? [m.mapping_scope_hidden({ hidden: scope.hidden })] : []),
				...(view.isolatedInEffect
					? [m.mapping_scope_isolated({ listed: scope.listed, away: scope.isolatedAway })]
					: []),
				...(groupingAttribute
					? [m.mapping_scope_grouped({ attribute: groupingAttribute.name })]
					: [])
			].join(' · ')}
		</p>
		{#if selectedWorker}
			<WorkerDossier
				worker={selectedWorker}
				neighbours={selectedNeighbours}
				{attributes}
				{languages}
				isolated={view.isolatedInEffect}
				onSelectNeighbour={handleSelect}
				onIsolate={() => (view.isolated = !view.isolated)}
				onOpenInWorkers={() => (person.workersSelectedId = selectedWorker?.id ?? null)}
				onClose={() => view.select('')}
				dockTop={stripHeight}
				dockBottom={0}
			/>
		{/if}
	</div>
</div>
