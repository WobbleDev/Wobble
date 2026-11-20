/**
 * The Mapping's Grouping, read once for the whole map: what each choice would do to the
 * displayed Workers, the branches the Group control can open, the refusals it explains, and
 * the solver's projected view of the same partition. The map owns the view and the layout
 * set; this owns what they mean for Grouping.
 */
import { untrack } from 'svelte';
import { SvelteMap, SvelteSet } from 'svelte/reactivity';
import type { Worker, WorkerAttributeDefinition } from '#lib/domain-vocabulary.ts';
import { answerDisplayLabel } from '#lib/shared/workers/answer-path.ts';
import { collapseBranch } from '#lib/shared/workers/answer-hierarchy.ts';
import type { toPopulationFilters } from '#lib/shared/workers/contextual-filters.ts';
import type {
	ExpansionBranch,
	ExpansionRefusal,
	SubGroupingReading
} from '../grouping/grouping-types.ts';
import { attemptExpansion, projectLayoutInput, readGrouping } from '../grouping/map-grouping.ts';
import type { MapViewState } from '../map-view-state.svelte.ts';
import { resolveEffectiveLayout } from '../map-view-model.ts';
import type { WorkerGraphNode } from './worker-relationship-map-model.ts';

/** What the Grouping reads from the map. Each is read lazily, so every derivation tracks it. */
export type MapGroupingHost = {
	view: MapViewState;
	workers: () => readonly Worker[];
	attributes: () => readonly WorkerAttributeDefinition[];
	/** The layout set the filters leave: Isolate never moves a dot, so it is not narrowed here. */
	layoutNodes: () => readonly WorkerGraphNode[];
	populationFilters: () => ReturnType<typeof toPopulationFilters>;
};

export function createMapGrouping(host: MapGroupingHost) {
	const view = host.view;
	/**
	 * The one grouping ledger every choice reads: the layout set's Workers and their
	 * own held answers. Availability for every choice is cheap; narrowing guidance is
	 * asked for only for the refusal that is actually on screen.
	 */
	const groupingInput = $derived({
		nodes: host.layoutNodes(),
		workers: host.workers(),
		attributes: host.attributes(),
		filters: host.populationFilters()
	});
	const groupingReadings = $derived.by(
		() =>
			new SvelteMap(
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
		const parents = new SvelteSet(
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
		const position = new SvelteMap(attribute.answers.map((answer, index) => [answer.id, index]));
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
		if (!primary || !activeGrouping) return new SvelteMap<string, SubGroupingReading | undefined>();
		return new SvelteMap(
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
			host.layoutNodes(),
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
		new SvelteMap((projectedGrouping?.nodes ?? []).map((node) => [node.id, node]))
	);
	const projectedLayoutNodes = $derived(projectedGrouping?.nodes ?? host.layoutNodes());
	const tooltipAttributes = $derived(
		host
			.attributes()
			.map((attribute) =>
				attribute.id === groupingAttribute?.id
					? groupingAttribute
					: attribute.id === effectiveSubGroupingAttribute?.id
						? effectiveSubGroupingAttribute
						: attribute
			)
	);

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

	return {
		get groupingInput() {
			return groupingInput;
		},
		get groupingReadings() {
			return groupingReadings;
		},
		get activeGroupingReading() {
			return activeGroupingReading;
		},
		get activeGrouping() {
			return activeGrouping;
		},
		get primaryExpansionBranches() {
			return primaryExpansionBranches;
		},
		get secondaryExpansionBranches() {
			return secondaryExpansionBranches;
		},
		get subGroupingReadings() {
			return subGroupingReadings;
		},
		get groupingAttribute() {
			return groupingAttribute;
		},
		get effectiveSubGroupingAttribute() {
			return effectiveSubGroupingAttribute;
		},
		get effectiveLayout() {
			return effectiveLayout;
		},
		get projectedNodesById() {
			return projectedNodesById;
		},
		get projectedLayoutNodes() {
			return projectedLayoutNodes;
		},
		get tooltipAttributes() {
			return tooltipAttributes;
		},
		get expansionRefusal() {
			return expansionRefusal;
		},
		get subExpansionRefusal() {
			return subExpansionRefusal;
		},
		togglePrimaryExpansion,
		toggleSecondaryExpansion
	};
}
