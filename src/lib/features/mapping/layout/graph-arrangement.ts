/**
 * The map's arrangement: where every visible Worker draws, whichever layout
 * mode is active. One module decides the geometry, so the live frame and the
 * settled pass cannot drift — both call `arrange`, and the parameters live in
 * this file's constants.
 *
 * - Ungrouped: free physics over the whole graph, run once to rest, fitted to the canvas.
 * - Grouped: per-group stress layouts as rigid bodies, run against each other
 *   by the group physics, with bridge ports facing each partner.
 */
import { layoutGroupRegions, regionKey, subRegionKey, type GroupRegion } from './graph-layout.ts';
import { buildBucketTree } from './graph-analysis.ts';
import { placeRegionLabels } from '../labels/graph-label-placement.ts';
import type { Box } from './graph-free-canvas.ts';
import type { Point } from './graph-layout.ts';
import { answerPositionLabel, groupValue, type LabelOf } from './graph-analysis.ts';
import type { StressPoint } from './graph-stress.ts';
import { layoutGroup, type CrossTie, type GroupMember } from './graph-group-layout.ts';
import { layoutSubGroups } from './graph-sub-group-layout.ts';
import { placeQuotientBodies } from './graph-quotient-layout.ts';
import { groupPairKey, type GroupBody } from './graph-group-physics.ts';
import {
	spacingPolicy,
	type CompositionInput,
	type CompositionPacket
} from '../composition/graph-composition.ts';
import type { Route } from '../routing/graph-relationship-routing.ts';

import { nodeRadius } from '../map-style.ts';
import type { WorkerGraphLink, WorkerGraphNode } from '../canvas/worker-relationship-map-model.ts';
import type { WorkerAttributeDefinition } from '#lib/domain-vocabulary.ts';
import type { MapLayoutMode } from '../map-view-model.ts';
import { applyManual, type ManualGeometry } from './graph-manual.ts';
import { arrangeGrouped } from './graph-grouped-scope.ts';
import { arrangeFree } from './graph-free-arrangement.ts';

export type ArrangeInput = {
	mode: MapLayoutMode;
	/** Camera and Isolate geometry affect labels only, never the worker solver. */
	labelView?: {
		positions?: ReadonlyMap<string, Point>;
		nodes?: readonly WorkerGraphNode[];
		freeCanvas: Box;
		priorityIds?: ReadonlySet<string>;
		obstacles?: readonly Box[];
		/** Measured heading sizes in map units at the live zoom; the estimate applies without them. */
		headingSizes?: ReadonlyMap<string, { width: number; height: number; baseline?: number }>;
		/** The headings come from the composition: hulls only, no heading search at this camera. */
		fixedHeadings?: boolean;
	};
	nodes: readonly WorkerGraphNode[];
	links: readonly WorkerGraphLink[];
	groupingAttribute: WorkerAttributeDefinition | undefined;
	/** When set, each group is laid out as packed sub-group bodies. */
	subGroupingAttribute?: WorkerAttributeDefinition | undefined;
	canvas: { width: number; height: number };
	/** The user-set gap between group bodies. */
	gap: number;
	/**
	 * The organizer's manual geometry, laid over the automatic arrangement as a pure
	 * translation. It is never part of the arrangement key: moving a Worker or a group
	 * recomputes nothing.
	 */
	manual?: ManualGeometry;
	/**
	 * Asks a one-level Grouped map to be composed: group placement, names and
	 * Relationship paths chosen together from numeric screen facts. Without it
	 * the shipped arrangement is returned unchanged.
	 */
	composition?: CompositionInput;
};

export type Arrangement = {
	/**
	 * Which automatic arrangement this is. It changes only when the data, filters,
	 * grouping, hierarchy or canvas facts change — never for a manual move.
	 */
	revision: number;
	regions: GroupRegion[];
	/** Every drawn node position, by worker id. */
	positions: Map<string, Point>;
	/** Each group body's centre, so the next frame starts where this one rests. */
	centres: Map<string, Point>;
	/** The resting extent, for the framing. */
	min: Point;
	max: Point;
	/** Which link ids are cross-group ties. */
	crossLinkIds: ReadonlySet<string>;
	/**
	 * Final complete paths for exactly `positions`, one per eligible pair. Absent
	 * in the original drawing, during a live drag, and in modes composition does
	 * not cover: those draw straight ties between the dots.
	 */
	routes?: ReadonlyMap<string, Route>;
	/** The selected composition's reference text, headings and diagnostics. */
	composition?: CompositionPacket;
};

export type { GroupBody };

/** Test instrumentation; geometry caches themselves belong to an individual arranger. */
export const localLayoutSolves = { count: 0 };

/** Each mounted map owns its caches and stable automatic-scene identities. */
export function createArranger() {
	/** Bumped for every different automatic arrangement that is computed. */
	let arrangementRevision = 0;
	let solves = 0;
	/** The same key keeps its revision when the one-slot cache is evicted and recomputed. */
	const revisionByKey = new Map<string, number>();
	function revisionFor(key: string): number {
		let revision = revisionByKey.get(key);
		if (revision === undefined) {
			revision = arrangementRevision += 1;
			revisionByKey.set(key, revision);
			if (revisionByKey.size > 32) revisionByKey.delete(revisionByKey.keys().next().value!);
		}
		return revision;
	}

	/** Group members and their cross ties, partitioned by the grouping attribute. */
	function partitionGroups(
		nodes: readonly WorkerGraphNode[],
		links: readonly WorkerGraphLink[],
		groupingAttribute: WorkerAttributeDefinition
	): { value: string; members: GroupMember[]; crossTies: CrossTie[] }[] {
		const memberOf = new Map(nodes.map((node) => [node.id, groupValue(node, groupingAttribute)]));
		const radiusFor = (node: WorkerGraphNode) => nodeRadiusOf(node);

		const groups = new Map<string, { members: GroupMember[]; crossTies: CrossTie[] }>();
		for (const node of nodes) {
			const value = memberOf.get(node.id) ?? '';
			let group = groups.get(value);
			if (!group) {
				group = { members: [], crossTies: [] };
				groups.set(value, group);
			}
			group.members.push({ id: node.id, radius: radiusFor(node) });
		}

		// Both links ends are ids in the visible graph: the relationship model
		// builds them as strings, and deriveVisibleGraph preserves that.
		for (const link of links) {
			const source = link.source as string;
			const target = link.target as string;
			const sourceGroup = memberOf.get(source);
			const targetGroup = memberOf.get(target);
			if (sourceGroup === undefined || targetGroup === undefined) continue;
			if (sourceGroup === targetGroup) continue;
			groups.get(sourceGroup)?.crossTies.push({ workerId: source, partnerGroup: targetGroup });
			groups.get(targetGroup)?.crossTies.push({ workerId: target, partnerGroup: sourceGroup });
		}

		return [...groups.entries()].map(([value, group]) => ({
			value,
			members: group.members,
			crossTies: group.crossTies
		}));
	}

	// The radius law has one home: `nodeRadius` in map-style. Reached directly here
	// rather than passed down, so the grouped and ungrouped paths cannot
	// drift from the drawn dots' size.
	function nodeRadiusOf(node: WorkerGraphNode): number {
		return nodeRadius(node.relationshipCount);
	}

	/** Whether this input asks for the one-level Grouped composition. */
	function isComposing(input: ArrangeInput): boolean {
		return Boolean(input.composition && input.groupingAttribute);
	}

	/**
	 * What the composition depends on beyond the shipped solve: the frozen canvas,
	 * the resting names and their measured text, and the spacing rules. Selection,
	 * hover, search, the card, the live camera, the theme and late font arrival are
	 * not in it.
	 */
	function compositionKey(input: ArrangeInput): string {
		const composition = input.composition;
		if (!composition || !isComposing(input)) return '';
		const names = new Map(input.nodes.map((node) => [node.id, node.name]));
		return JSON.stringify([
			spacingPolicy.revision,
			composition.freeCanvas.width,
			composition.freeCanvas.height,
			composition.reserved ?? [],
			composition.restingNameIds.map((id) => [id, names.get(id)]),
			composition.text?.revision ?? 'estimate'
		]);
	}

	/** Bumped for every different composed geometry published. */
	let packetRevision = 0;

	/**
	 * A cache key over everything that changes the geometry, and nothing that does
	 * not (hover, spotlight, labels, colors). Building it is O(nodes + links);
	 * recomputing the arrangement is the solver's whole cost, so a hover or a
	 * selection that leaves the geometry alone must not pay for it again.
	 *
	 * The selection is not part of the key: no mode reads it, and Isolate is a
	 * focus that moves no dot, so a click must not re-run the solver.
	 */
	/** The ids of the answers some Worker holds for the Attribute, in the Attribute's list order. */
	function heldAnswerOrder(
		nodes: readonly WorkerGraphNode[],
		attribute: WorkerAttributeDefinition | undefined
	): string {
		if (!attribute) return '';
		const held = new Set(nodes.map((node) => groupValue(node, attribute)));
		return attribute.answers
			.filter((answer) => held.has(answer.id))
			.map((answer) => answer.id)
			.join(',');
	}

	function arrangementKey(input: ArrangeInput, full = true): string {
		const { mode, nodes, links, canvas, gap } = input;
		const parts: string[] = [
			mode,
			input.groupingAttribute?.id ?? '',
			input.subGroupingAttribute?.id ?? '',
			// The layout orders groups by answer position, so the order of the answers Workers hold is
			// part of the key. An answer nobody holds, or its text, never reaches the layout.
			heldAnswerOrder(nodes, input.groupingAttribute),
			heldAnswerOrder(nodes, input.subGroupingAttribute),
			String(canvas.width),
			String(canvas.height)
		];
		if (full) parts.push(String(gap), compositionKey(input));
		for (const node of nodes) {
			parts.push(node.id, String(node.relationshipCount));
			// Ungrouped Free physics does not read Category answers.
			if (input.groupingAttribute) {
				parts.push(groupValue(node, input.groupingAttribute));
				if (input.subGroupingAttribute) parts.push(groupValue(node, input.subGroupingAttribute));
			}
		}
		for (const link of links) parts.push(link.id, link.source, link.target);
		return parts.join('\u0001');
	}

	let cachedKey: string | undefined;
	let cachedBase: Arrangement | undefined;
	let cachedLabelKey: string | undefined;
	let cachedLabeled: Arrangement | undefined;

	/**
	 * The map's arrangement: where every visible Worker draws, whichever layout mode
	 * is active. Memoized on {@link arrangementKey}, so the pure result is computed
	 * once per geometry — callers must treat the returned maps as read-only.
	 */
	function arrange(input: ArrangeInput): Arrangement {
		const key = arrangementKey(input);
		if (key !== cachedKey || cachedBase === undefined) {
			cachedBase = { ...computeArrangement(input), revision: revisionFor(key) };
			solves += 1;
			cachedKey = key;
			cachedLabelKey = undefined;
		}
		// Manual geometry is a pure translation laid over the solved layout: it never re-runs the solver.
		const cachedResult = applyManual(
			cachedBase,
			input.manual,
			input.nodes,
			input.groupingAttribute,
			input.subGroupingAttribute
		);
		const view = input.labelView;
		const nodes = view?.nodes ?? input.nodes;
		const positions = view?.positions ?? cachedResult.positions;
		const groups = buildBucketTree(nodes, input.groupingAttribute, input.subGroupingAttribute);
		const room = view?.freeCanvas ?? {
			x: -input.canvas.width / 2,
			y: -input.canvas.height / 2,
			...input.canvas
		};
		const labelKey = JSON.stringify([
			groups,
			room,
			nodes.map((n) => [n.id, positions.get(n.id)]),
			[...(view?.priorityIds ?? [])].sort(),
			view?.obstacles,
			view?.headingSizes ? [...view.headingSizes] : undefined,
			view?.fixedHeadings ?? false,
			cachedResult.routes ? cachedResult.composition?.revision : 'direct'
		]);
		if (labelKey === cachedLabelKey && cachedLabeled) return cachedLabeled;
		const regions = layoutGroupRegions(
			groups,
			nodes.flatMap((node) => {
				const point = positions.get(node.id);
				return point
					? [
							{
								...point,
								group: groupValue(node, input.groupingAttribute),
								subGroup: groupValue(node, input.subGroupingAttribute)
							}
						]
					: [];
			})
		);
		const counts = new Map<string, number>();
		const priority = new Set<string>();
		for (const group of groups) {
			counts.set(regionKey(group.value), group.count);
			for (const sub of group.subGroups)
				counts.set(subRegionKey(group.value, sub.value), sub.count);
		}
		for (const node of nodes) {
			if (!view?.priorityIds?.has(node.id)) continue;
			const group = groupValue(node, input.groupingAttribute);
			priority.add(regionKey(group));
			priority.add(subRegionKey(group, groupValue(node, input.subGroupingAttribute)));
		}
		cachedLabeled = {
			...cachedResult,
			regions: view?.fixedHeadings
				? regions
				: placeRegionLabels(regions, room, counts, priority, view?.obstacles)
		};
		cachedLabelKey = labelKey;
		return cachedLabeled;
	}

	type LocalLayout = {
		partitioned: ReturnType<typeof partitionGroups>;
		offsetsByGroup: Map<string, ReadonlyMap<string, StressPoint>>;
		/** Each group's body at its initial anchor. */
		bodies: GroupBody[];
		relationshipCountsByPair: Map<string, number>;
		quotientTies: { source: string; target: string; strength: number }[];
		quotientCentresByGap: Map<number, Map<string, StressPoint>>;
		orientedOffsetsByGap: Map<number, Map<string, ReadonlyMap<string, StressPoint>>>;
		/** Group centres after the canvas fit, which the oriented offsets are relative to. */
		fittedCentresByGap: Map<number, Map<string, Point>>;
		/**
		 * The selected composition, when asked for. Manual placement, drag collision
		 * and every later frame read these offsets and centres, never the shipped
		 * layout's, so a first drag cannot recover pre-composition geometry.
		 */
		composed?: {
			key: string;
			gap: number;
			positions: Map<string, Point>;
			centres: Map<string, Point>;
			offsets: Map<string, Map<string, Point>>;
			packet: CompositionPacket;
		};
	};

	let cachedLocalKey: string | undefined;
	let cachedLocal: LocalLayout | undefined;

	/**
	 * The per-group local layouts and initial bodies: everything the grouped solve
	 * needs that the gap and the composition do not change. Cached,
	 * so a group drag re-runs only the body physics.
	 */
	function localLayout(input: ArrangeInput): LocalLayout {
		const key = arrangementKey(input, false);
		if (key === cachedLocalKey && cachedLocal) return cachedLocal;
		localLayoutSolves.count += 1;
		const { nodes, links, canvas } = input;
		const grouping = input.groupingAttribute;
		if (!grouping) {
			return {
				partitioned: [],
				offsetsByGroup: new Map(),
				bodies: [],
				relationshipCountsByPair: new Map(),
				quotientTies: [],
				quotientCentresByGap: new Map(),
				orientedOffsetsByGap: new Map(),
				fittedCentresByGap: new Map()
			};
		}
		const partitioned = partitionGroups(nodes, links, grouping);

		// Deterministic initial anchors: groups ordered by cross-tie count
		// (descending, ties broken by value), placed on a circle.
		const groupLabel = answerPositionLabel(input.groupingAttribute);
		const orderedGroups = [...partitioned].sort(
			(a, b) =>
				b.crossTies.length - a.crossTies.length ||
				groupLabel(a.value).localeCompare(groupLabel(b.value))
		);
		const anchors = new Map<string, Point>();
		{
			const m = Math.max(1, orderedGroups.length);
			// An ellipse with the canvas's ratio, so groups spread along the long side.
			const anchorY = Math.min(canvas.width, canvas.height) * anchorEllipseShare;
			const anchorX = anchorY * (canvas.width / Math.max(canvas.height, 1));
			orderedGroups.forEach((group, index) => {
				const angle = (index / m) * Math.PI * 2 + Math.PI;
				anchors.set(group.value, {
					x: Math.cos(angle) * anchorX,
					y: Math.sin(angle) * anchorY
				});
			});
		}

		const degree = new Map(nodes.map((n) => [n.id, 0]));
		for (const { source, target } of links) {
			degree.set(source, (degree.get(source) ?? 0) + 1);
			degree.set(target, (degree.get(target) ?? 0) + 1);
		}
		const leafIds = new Set([...degree].filter(([, count]) => count === 1).map(([id]) => id));
		// Each group's local layout, with ports facing its partner anchors.
		const offsetsByGroup = new Map<string, ReadonlyMap<string, StressPoint>>();
		const radiusByGroup = new Map<string, number>();
		const bodies: GroupBody[] = [];
		const unitDirectionsByGroup = new Map<string, Map<string, Point>>();

		const subAttribute = input.subGroupingAttribute;
		const subGrouping = subAttribute
			? new Map(nodes.map((node) => [node.id, groupValue(node, subAttribute)]))
			: undefined;

		for (const group of partitioned) {
			const anchor = anchors.get(group.value) ?? { x: 0, y: 0 };
			const partnerDirections = new Map<string, Point>();
			for (const { partnerGroup } of group.crossTies) {
				if (partnerDirections.has(partnerGroup)) continue;
				const partnerAnchor = anchors.get(partnerGroup) ?? { x: 0, y: 0 };
				const dx = partnerAnchor.x - anchor.x;
				const dy = partnerAnchor.y - anchor.y;
				const length = Math.hypot(dx, dy) || 1;
				partnerDirections.set(partnerGroup, { x: dx / length, y: dy / length });
			}
			unitDirectionsByGroup.set(group.value, partnerDirections);

			const internalIds = new Set(group.members.map(({ id }) => id));
			const internalLinks = links
				.map((link) => ({ source: link.source as string, target: link.target as string }))
				.filter(({ source, target }) => internalIds.has(source) && internalIds.has(target));

			const { offsets, radius } = subGrouping
				? layoutSubGroups({
						members: group.members,
						internalLinks,
						subOf: subGrouping,
						leafIds,
						labelOf: answerPositionLabel(subAttribute)
					})
				: layoutGroup({
						members: group.members,
						leafIds,
						internalLinks,
						crossTies: group.crossTies,
						partnerDirections,
						overlapAware: true
					});

			offsetsByGroup.set(group.value, offsets);
			radiusByGroup.set(group.value, radius);
			bodies.push({
				key: group.value,
				x: anchor.x,
				y: anchor.y,
				radius,
				crossTies: group.crossTies.length
			});
		}

		const relationshipCountsByPair = new Map<string, number>();
		const quotientTiesByPair = new Map<
			string,
			{ source: string; target: string; strength: number }
		>();
		for (const group of partitioned) {
			for (const tie of group.crossTies) {
				if (group.value >= tie.partnerGroup) continue;
				const key = groupPairKey(group.value, tie.partnerGroup);
				const strength = (relationshipCountsByPair.get(key) ?? 0) + 1;
				relationshipCountsByPair.set(key, strength);
				quotientTiesByPair.set(key, { source: group.value, target: tie.partnerGroup, strength });
			}
		}
		cachedLocal = {
			partitioned,
			offsetsByGroup,
			bodies,
			relationshipCountsByPair,
			quotientTies: [...quotientTiesByPair.values()],
			quotientCentresByGap: new Map(),
			orientedOffsetsByGap: new Map(),
			fittedCentresByGap: new Map()
		};
		cachedLocalKey = key;
		return cachedLocal;
	}

	function quotientCentresFor(
		local: LocalLayout,
		gap: number,
		labelOf: LabelOf
	): Map<string, StressPoint> {
		const cached = local.quotientCentresByGap.get(gap);
		if (cached) return cached;
		const centres = placeQuotientBodies(local.bodies, local.quotientTies, gap, gap, labelOf);
		local.quotientCentresByGap.set(gap, centres);
		return centres;
	}

	/** Fraction of the canvas's shorter side that sets the initial anchor ellipse's short radius, in layout units. */
	const anchorEllipseShare = 0.35;
	/** How much larger than the view the layouts spread. */
	const layoutSpread = 1.95;

	/**
	 * The arrangement itself, for whichever mode is active: free physics when
	 * ungrouped, per-group layouts run against each other by the group physics when
	 * grouped.
	 */
	function computeArrangement(input: ArrangeInput): Omit<Arrangement, 'revision'> {
		const { nodes } = input;
		// Layouts spread across a canvas larger than the view, for roomier clusters.
		const canvas = {
			...input.canvas,
			width: input.canvas.width * layoutSpread,
			height: input.canvas.height * layoutSpread
		};

		// One radius lookup for the whole arrangement. The separator calls this in
		// its inner pair loop, so it must be O(1) — a scan over `nodes` there makes a
		// 500-worker map take tens of seconds.
		const radiusById = new Map(nodes.map((node) => [node.id, nodeRadiusOf(node)]));
		const radiusFor = (id: string) => radiusById.get(id) ?? 0;

		const grouping = input.groupingAttribute;
		if (!grouping) {
			const free = arrangeFree(input, canvas, radiusFor);
			const extent = extentOf(free.positions);
			return {
				regions: [],
				positions: free.positions,
				centres: new Map(),
				min: extent.min,
				max: extent.max,
				crossLinkIds: free.crossLinkIds
			};
		}

		const grouped = arrangeGrouped(input, grouping, canvas, radiusById, radiusFor, {
			localLayout,
			isComposing,
			compositionKey,
			quotientCentresFor,
			nextPacketRevision: () => (packetRevision += 1)
		});
		const extent = extentOf(grouped.positions);
		return {
			regions: [],
			positions: grouped.positions,
			centres: grouped.centres,
			min: extent.min,
			max: extent.max,
			crossLinkIds: grouped.crossLinkIds,
			routes: grouped.routes,
			composition: grouped.composition
		};
	}

	function extentOf(positions: Map<string, Point>): { min: Point; max: Point } {
		const min = { x: Number.POSITIVE_INFINITY, y: Number.POSITIVE_INFINITY };
		const max = { x: Number.NEGATIVE_INFINITY, y: Number.NEGATIVE_INFINITY };
		for (const { x, y } of positions.values()) {
			min.x = Math.min(min.x, x);
			min.y = Math.min(min.y, y);
			max.x = Math.max(max.x, x);
			max.y = Math.max(max.y, y);
		}
		if (positions.size === 0) return { min: { x: 0, y: 0 }, max: { x: 0, y: 0 } };
		return { min, max };
	}

	return Object.defineProperty(arrange, 'solves', { get: () => solves }) as typeof arrange & {
		readonly solves: number;
	};
}

/** Standalone calculations and algorithm tests use a separate default instance. */
export const arrange = createArranger();
