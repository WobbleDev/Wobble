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
import { placeRegionLabels } from './graph-label-placement.ts';
import type { Box } from './graph-free-canvas.ts';
import { regionPadding, type Point } from './graph-layout.ts';
import { answerPositionLabel, groupValue, type LabelOf } from './graph-analysis.ts';
import { fitAndSeparate, type StressPoint } from './graph-stress.ts';
import { freePhysicsLayout } from './graph-free-physics.ts';
import { detectCommunities, gatherStart } from './graph-communities.ts';
import { layoutGroup, type CrossTie, type GroupMember } from './graph-group-layout.ts';
import { groupOuterPadding, layoutSubGroups } from './graph-sub-group-layout.ts';
import { fitGroupsToCanvas } from './graph-canvas-fit.ts';
import { fanLeaves, type LeafBound } from './graph-leaf-placement.ts';
import { orientBodies } from './graph-body-orientation.ts';
import { tidyLayout } from './graph-tidy.ts';
import { placeQuotientBodies } from './graph-quotient-layout.ts';
import {
	drawnPosition,
	groupPairKey,
	settlePhysics,
	type GroupBody
} from './graph-group-physics.ts';
import {
	composeGrouped,
	spacingPolicy,
	type CompositionInput,
	type CompositionPacket
} from './composition/graph-composition.ts';
import { createWorkBudget } from './graph-work-budget.ts';
import type { Route } from './graph-relationship-routing.ts';

import { nodeRadius } from './map-style.ts';
import type { WorkerGraphLink, WorkerGraphNode } from './worker-relationship-map-model.ts';
import type { WorkerAttributeDefinition } from '#lib/domain-vocabulary.ts';
import type { MapLayoutMode } from './map-view-model.ts';
import { applyManual, type ManualGeometry } from './graph-manual.ts';

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

/** The low alpha a fresh Free layout settles at from its gathered start. */
const freeGatherAlpha = 0.05;

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

	/** How far past its group or sub-group circle a Worker may move while tidying, in layout units. */
	const subGroupTidySlack = 40;
	/** Fraction of the canvas's shorter side that sets the initial anchor ellipse's short radius, in layout units. */
	const anchorEllipseShare = 0.35;
	/** Padding handed to the final dot separator of the ungrouped layout, in layout units. */
	const freeFitPad = 10;
	/** Physics ticks for group placement: a fresh layout gets one collision-only pass. */
	const freshMaxTicks = 1;
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
		if (!grouping) return computeFreeArrangement(input, canvas, radiusFor);

		const positions = new Map<string, Point>();
		const g = createGroupedScope(input, grouping, canvas, radiusById, radiusFor, positions);
		placeGroupCentres(g);
		drawGroupMembers(g);
		settleFreshLayout(g);
		const { composition, routes } = composeGroupedRoutes(g);
		const crossLinkIds = crossLinkIdsOf(g.links, g.memberOf);

		const extent = extentOf(positions);
		return {
			regions: [],
			positions,
			centres: g.centres,
			min: extent.min,
			max: extent.max,
			crossLinkIds,
			routes,
			composition
		};
	}

	function computeFreeArrangement(
		input: ArrangeInput,
		canvas: ArrangeInput['canvas'],
		radiusFor: (id: string) => number
	): Omit<Arrangement, 'revision'> {
		const { nodes, links } = input;
		const positions = new Map<string, Point>();
		const crossLinkIds = new Set<string>();
		// Ungrouped: free physics over the whole graph, from a fresh gathered start.
		const communities = detectCommunities(
			nodes.map((node) => node.id),
			links
		);
		const gathered = gatherStart(
			nodes.map((node) => node.id),
			communities,
			canvas,
			links,
			radiusFor
		);

		const laid = freePhysicsLayout(
			nodes.map((node) => ({ id: node.id })),
			links.map((link) => ({ source: link.source, target: link.target })),
			{ width: canvas.width, height: canvas.height },
			{ start: gathered, alpha: freeGatherAlpha }
		);
		const oriented = orientBodies(
			laid,
			new Map([...communities].map(([id, key]) => [id, String(key)])),
			links,
			radiusFor
		);
		// Preserve the existing uniform fit after rigid orientation. The final
		// separator corrects only dot clearance; it does not re-aim communities.
		const fanned = fanLeaves(oriented, links, radiusFor);
		const fitted = fitAndSeparate(fanned, radiusFor, canvas, { pad: freeFitPad });
		// Each Worker tidies within reach of its community, so a cluster stays one
		// cluster. Tidy can move a hub; its leaves are fanned again around it.
		const placed = fanLeaves(
			tidyLayout(fitted, links, radiusFor, {
				bounds: communityBounds(fitted, communities, radiusFor)
			}),
			links,
			radiusFor
		);
		for (const [id, point] of placed) positions.set(id, point);

		const extent = extentOf(positions);
		return {
			regions: [],
			positions,
			centres: new Map(),
			min: extent.min,
			max: extent.max,
			crossLinkIds
		};
	}

	function createGroupedScope(
		input: ArrangeInput,
		grouping: NonNullable<ArrangeInput['groupingAttribute']>,
		canvas: ArrangeInput['canvas'],
		radiusById: Map<string, number>,
		radiusFor: (id: string) => number,
		positions: Map<string, Point>
	) {
		const { nodes, links } = input;
		const local = localLayout(input);
		const { partitioned, offsetsByGroup, bodies: anchored, relationshipCountsByPair } = local;
		const composing = isComposing(input);
		const composedKey = compositionKey(input);
		const composedHere = () =>
			local.composed?.key === composedKey && local.composed.gap === input.gap
				? local.composed
				: undefined;
		const composedLayout = composing ? composedHere() : undefined;
		const drawingOffsets =
			composedLayout?.offsets ?? local.orientedOffsetsByGap.get(input.gap) ?? offsetsByGroup;

		const quotientCentres = quotientCentresFor(local, input.gap, answerPositionLabel(grouping));
		const bodies: GroupBody[] = anchored.map((body) => {
			const placed = quotientCentres.get(body.key);
			const seed = placed
				? { x: placed.x + canvas.width / 2, y: placed.y + canvas.height / 2 }
				: undefined;
			const composedCentre = composedLayout?.centres.get(body.key);
			return {
				...body,
				x: composedCentre?.x ?? seed?.x ?? body.x,
				y: composedCentre?.y ?? seed?.y ?? body.y
			};
		});

		// Single-group graphs skip physics; multi-group run it to rest with the
		// shared parameter dictionary.
		const centres: Map<string, Point> = new Map(
			bodies.map((body) => [body.key, { x: body.x, y: body.y }])
		);
		const rotationBy = new Map<string, number>();
		const memberOf = new Map(
			nodes.map((node) => [node.id, groupValue(node, input.groupingAttribute)])
		);
		return {
			input,
			nodes,
			links,
			canvas,
			radiusById,
			radiusFor,
			positions,
			local,
			grouping,
			partitioned,
			offsetsByGroup,
			relationshipCountsByPair,
			composing,
			composedKey,
			composedHere,
			composedLayout,
			drawingOffsets,
			bodies,
			centres,
			rotationBy,
			memberOf
		};
	}

	type GroupedScope = ReturnType<typeof createGroupedScope>;

	function placeGroupCentres(g: GroupedScope): void {
		const { bodies, input, canvas, relationshipCountsByPair } = g;
		if (bodies.length > 1) {
			const start = {
				centres: new Map(bodies.map((body) => [body.key, { x: body.x, y: body.y }])),
				rotations: new Map<string, number>()
			};
			const settled = settlePhysics(
				start,
				{
					bodies,
					relationshipCountsByPair,
					partnersByGroup: new Map(),
					offsetsByGroup: new Map(),
					gap: input.gap,
					// Quotient stress already places fresh groups from their weighted
					// shortest paths. One collision-only pass removes residual overlaps
					// without relaxing that geometry back toward the old tie equilibrium.
					collisionOnly: true,
					canvas: { width: canvas.width, height: canvas.height }
				},
				{ maxTicks: freshMaxTicks }
			);
			for (const [key, centre] of settled.centres) {
				g.centres.set(key, centre);
			}
			g.rotationBy = settled.rotations;
		}
	}

	function drawGroupMembers(g: GroupedScope): void {
		const { local, input, centres, partitioned, drawingOffsets, positions } = g;
		let { rotationBy } = g;
		// A fresh layout reuses where the canvas fit put each group last time.
		const fittedCentres = local.fittedCentresByGap.get(input.gap);
		if (fittedCentres) {
			for (const [key, centre] of fittedCentres) centres.set(key, centre);
			rotationBy = new Map();
		}
		// Draw every node at its body's transformed offset.
		for (const group of partitioned) {
			const centre = centres.get(group.value) ?? { x: 0, y: 0 };
			const rotation = rotationBy.get(group.value) ?? 0;
			const offsets = drawingOffsets.get(group.value) ?? new Map();
			for (const [id, offset] of offsets) {
				positions.set(id, drawnPosition(centre, rotation, offset));
			}
		}
	}

	function orientFreshGroups(g: GroupedScope): {
		oriented: Map<string, StressPoint>;
		groupLabel: ReturnType<typeof answerPositionLabel>;
	} {
		const { input, grouping, positions, memberOf, links, radiusFor, centres, nodes } = g;
		const groupLabel = answerPositionLabel(grouping);
		let oriented = orientBodies(positions, memberOf, links, radiusFor, centres, groupLabel, {
			dotHits: true
		});
		if (input.subGroupingAttribute) {
			// Parent transforms are final before reconciling sub-bodies. Full
			// Relationships retain each outside-parent Worker endpoint; sibling
			// and parent-external partners therefore compete in the same objective.
			const subOf = new Map(
				nodes.map((node) => [
					node.id,
					JSON.stringify([memberOf.get(node.id), groupValue(node, input.subGroupingAttribute)])
				])
			);
			// A sub-body key is the JSON of its group and sub-group ids, ordered as the JSON of their list positions.
			const subLabel = answerPositionLabel(input.subGroupingAttribute);
			const subKeyLabel = (key: string) => {
				const [group, sub] = JSON.parse(key) as [string, string];
				return JSON.stringify([groupLabel(group), subLabel(sub)]);
			};
			oriented = orientBodies(oriented, subOf, links, radiusFor, undefined, subKeyLabel, {
				endCrossings: true
			});
		}
		return { oriented, groupLabel };
	}

	function fitFreshGroups(
		g: GroupedScope,
		start: Map<string, StressPoint>,
		groupLabel: ReturnType<typeof answerPositionLabel>
	): Map<string, StressPoint> {
		const { input, centres, memberOf, radiusFor, relationshipCountsByPair } = g;
		let oriented = start;
		// Shape the whole arrangement to the view's canvas, moving groups whole.
		const fitted = fitGroupsToCanvas({
			labelOf: groupLabel,
			positions: oriented,
			centres,
			memberOf,
			radiusFor,
			canvas: input.canvas,
			gap: input.gap,
			padding: groupOuterPadding,
			groupTies: [...relationshipCountsByPair.keys()].map(
				(key) => JSON.parse(key) as [string, string]
			)
		});
		oriented = fitted.positions;
		for (const [key, centre] of fitted.centres) centres.set(key, centre);
		return oriented;
	}

	function tidyFreshGroups(
		g: GroupedScope,
		start: Map<string, StressPoint>
	): Map<string, StressPoint> {
		const { input, nodes, memberOf, bodies, centres, links, radiusFor } = g;
		let oriented = start;
		// Final fan reconciliation sees all occupied Relationship directions. Its
		// fixed body circles keep membership, clearance, and manual body radii.
		const bounds = new Map<string, LeafBound>();
		// How much room each Worker gets past its sub-group circle in the tidy pass.
		const tidySlack = new Map<string, number>();
		if (input.subGroupingAttribute) {
			const siblings: { group: unknown; centre: Point; radius: number; ids: string[] }[] = [];
			const buckets = new Map<string, string[]>();
			for (const node of nodes) {
				const key = JSON.stringify([
					memberOf.get(node.id),
					groupValue(node, input.subGroupingAttribute)
				]);
				const ids = buckets.get(key) ?? [];
				ids.push(node.id);
				buckets.set(key, ids);
			}
			for (const ids of buckets.values()) {
				const centre = {
					x: ids.reduce((sum, id) => sum + oriented.get(id)!.x, 0) / ids.length,
					y: ids.reduce((sum, id) => sum + oriented.get(id)!.y, 0) / ids.length
				};
				const radius = Math.max(
					...ids.map(
						(id) =>
							Math.hypot(oriented.get(id)!.x - centre.x, oriented.get(id)!.y - centre.y) +
							radiusFor(id)
					)
				);
				for (const id of ids) bounds.set(id, { centre, radius });
				siblings.push({ group: memberOf.get(ids[0]), centre, radius, ids });
			}
			// Two sibling sub-regions are hulls padded by `regionPadding`; share the free
			// gap between neighbouring circles so the slack can't make them touch.
			for (const body of siblings) {
				let slack = subGroupTidySlack;
				for (const other of siblings) {
					if (other === body || other.group !== body.group) continue;
					const free =
						Math.hypot(body.centre.x - other.centre.x, body.centre.y - other.centre.y) -
						body.radius -
						other.radius -
						2 * regionPadding;
					slack = Math.min(slack, Math.max(0, free / 2));
				}
				for (const id of body.ids) tidySlack.set(id, slack);
			}
		} else {
			for (const body of bodies)
				for (const node of nodes)
					if (memberOf.get(node.id) === body.key)
						bounds.set(node.id, { centre: centres.get(body.key)!, radius: body.radius });
		}
		oriented = fanLeaves(oriented, links, radiusFor, undefined, bounds);
		// Members get some room past their body's circle to step off a crossing;
		// the gap between groups is wider than that room.
		oriented = tidyLayout(oriented, links, radiusFor, {
			bounds: new Map(
				[...bounds].map(([id, b]) => [
					id,
					{ ...b, radius: b.radius + (tidySlack.get(id) ?? subGroupTidySlack) }
				])
			)
		});
		oriented = fanLeaves(oriented, links, radiusFor, undefined, bounds);
		return oriented;
	}

	function storeFreshLayout(g: GroupedScope, oriented: Map<string, StressPoint>): void {
		const { partitioned, centres, offsetsByGroup, local, input, positions } = g;
		const canonical = new Map<string, ReadonlyMap<string, StressPoint>>();
		for (const group of partitioned) {
			const centre = centres.get(group.value)!;
			canonical.set(
				group.value,
				new Map(
					[...(offsetsByGroup.get(group.value)?.keys() ?? [])].map((id) => {
						const p = oriented.get(id)!;
						return [id, { x: p.x - centre.x, y: p.y - centre.y }];
					})
				)
			);
		}
		local.orientedOffsetsByGap.set(input.gap, canonical);
		local.fittedCentresByGap.set(input.gap, new Map(centres));
		// Redraw through the stored canonical offsets, exactly as a later frame
		// reusing this cache does (`drawnPosition` with no rotation): the stored
		// form is `p - centre`, and reading it back is `centre + offset`, which
		// can differ from `p` by one ulp. Normalizing here keeps a fresh solve
		// bit-identical to a reuse of its own cache.
		for (const group of partitioned) {
			const centre = centres.get(group.value)!;
			for (const [id, offset] of canonical.get(group.value)!) {
				positions.set(id, drawnPosition(centre, 0, offset));
			}
		}
	}

	function settleFreshLayout(g: GroupedScope): void {
		if (!g.local.orientedOffsetsByGap.has(g.input.gap)) {
			const { oriented: start, groupLabel } = orientFreshGroups(g);
			const fitted = fitFreshGroups(g, start, groupLabel);
			const tidied = tidyFreshGroups(g, fitted);
			storeFreshLayout(g, tidied);
		}
	}

	function composeGroupedRoutes(g: GroupedScope): {
		composition: CompositionPacket | undefined;
		routes: ReadonlyMap<string, Route> | undefined;
	} {
		const {
			composing,
			composedHere,
			nodes,
			links,
			grouping,
			input,
			positions,
			centres,
			radiusById,
			composedKey,
			partitioned,
			local
		} = g;
		let composition: CompositionPacket | undefined;
		let routes: ReadonlyMap<string, Route> | undefined;
		if (composing) {
			let composed = composedHere();
			if (!composed) {
				const result = composeGrouped({
					nodes,
					links,
					groupingAttribute: grouping,
					subGroupingAttribute: input.subGroupingAttribute,
					positions,
					centres,
					radiusFor: (id) => radiusById.get(id) ?? 0,
					composition: input.composition!,
					budget: createWorkBudget()
				});
				packetRevision += 1;
				const offsets = new Map<string, Map<string, Point>>();
				for (const group of partitioned) {
					const centre = result.centres.get(group.value)!;
					offsets.set(
						group.value,
						new Map(
							group.members.map(({ id }) => {
								const p = result.positions.get(id)!;
								return [id, { x: p.x - centre.x, y: p.y - centre.y }];
							})
						)
					);
				}
				composed = {
					key: composedKey,
					gap: input.gap,
					positions: result.positions,
					centres: result.centres,
					offsets,
					packet: { ...result.packet, revision: packetRevision }
				};
				local.composed = composed;
			}
			if (composed) {
				for (const [id, point] of composed.positions) positions.set(id, point);
				for (const [key, centre] of composed.centres) centres.set(key, centre);
			}
			composition = composed?.packet;
			routes = composition?.routes;
		}
		return { composition, routes };
	}

	/** Each Worker's community circle, with the same give sub-group members get. */
	function communityBounds(
		positions: ReadonlyMap<string, Point>,
		communities: ReadonlyMap<string, unknown>,
		radiusFor: (id: string) => number
	): Map<string, LeafBound> {
		const members = new Map<unknown, string[]>();
		for (const id of positions.keys()) {
			const key = communities.get(id) ?? id;
			const list = members.get(key) ?? [];
			list.push(id);
			members.set(key, list);
		}
		const bounds = new Map<string, LeafBound>();
		for (const ids of members.values()) {
			const centre = {
				x: ids.reduce((sum, id) => sum + positions.get(id)!.x, 0) / ids.length,
				y: ids.reduce((sum, id) => sum + positions.get(id)!.y, 0) / ids.length
			};
			const radius = Math.max(
				...ids.map((id) => {
					const p = positions.get(id)!;
					return Math.hypot(p.x - centre.x, p.y - centre.y) + radiusFor(id);
				})
			);
			for (const id of ids) bounds.set(id, { centre, radius: radius + subGroupTidySlack });
		}
		return bounds;
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

	/** Which link ids cross group boundaries, for their established visual classification. */
	function crossLinkIdsOf(
		links: readonly WorkerGraphLink[],
		memberOf: ReadonlyMap<string, string>
	): Set<string> {
		return new Set(
			links.flatMap((link) => {
				const source = memberOf.get(link.source);
				const target = memberOf.get(link.target);
				return source !== undefined && target !== undefined && source !== target ? [link.id] : [];
			})
		);
	}

	return Object.defineProperty(arrange, 'solves', { get: () => solves }) as typeof arrange & {
		readonly solves: number;
	};
}

/** Standalone calculations and algorithm tests use a separate default instance. */
export const arrange = createArranger();
