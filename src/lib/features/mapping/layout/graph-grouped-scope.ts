/**
 * The grouped arrangement: the scope one grouped frame solves in — per-group local layouts,
 * bodies, centres, drawn members — and the steps that place, draw, tidy and route it.
 * `graph-arrangement` chooses the mode and owns the caches; this owns the grouped pipeline,
 * so a grouped frame reads as a sequence of steps over one scope.
 */
import { regionPadding, type Point } from './graph-layout.ts';
import { answerPositionLabel, groupValue, type LabelOf } from './graph-analysis.ts';
import type { StressPoint } from './graph-stress.ts';
import { groupOuterPadding } from './graph-sub-group-layout.ts';
import { fitGroupsToCanvas } from './graph-canvas-fit.ts';
import { fanLeaves, type LeafBound } from './graph-leaf-placement.ts';
import { orientBodies } from './graph-body-orientation.ts';
import { tidyLayout } from './graph-tidy.ts';
import { drawnPosition, settlePhysics, type GroupBody } from './graph-group-physics.ts';
import { composeGrouped, type CompositionPacket } from '../composition/graph-composition.ts';
import { createWorkBudget } from './graph-work-budget.ts';
import type { Route } from '../routing/graph-relationship-routing.ts';
import type { WorkerGraphLink } from '../canvas/worker-relationship-map-model.ts';
import type { ArrangeInput } from './graph-arrangement.ts';

/** The part of the arranger's cached local layout that a grouped frame reads. */
export type GroupedLocalLayout = {
	partitioned: readonly { value: string; members: readonly { id: string }[] }[];
	offsetsByGroup: Map<string, ReadonlyMap<string, StressPoint>>;
	bodies: GroupBody[];
	relationshipCountsByPair: Map<string, number>;
	orientedOffsetsByGap: Map<number, Map<string, ReadonlyMap<string, StressPoint>>>;
	fittedCentresByGap: Map<number, Map<string, Point>>;
	composed?: {
		key: string;
		gap: number;
		positions: Map<string, Point>;
		centres: Map<string, Point>;
		offsets: Map<string, Map<string, Point>>;
		packet: CompositionPacket;
	};
};

/** The cached lookups the arranger owns and the grouped pipeline reads. */
export type GroupedScopeDeps = {
	localLayout: (input: ArrangeInput) => GroupedLocalLayout;
	isComposing: (input: ArrangeInput) => boolean;
	compositionKey: (input: ArrangeInput) => string;
	quotientCentresFor(
		local: GroupedLocalLayout,
		gap: number,
		label: LabelOf
	): Map<string, StressPoint>;
	/** The next composition packet revision: a packet is never reused by number. */
	nextPacketRevision: () => number;
};
/** How far past its group or sub-group circle a Worker may move while tidying, in layout units. */
export const subGroupTidySlack = 40;
/** Physics ticks for group placement: a fresh layout gets one collision-only pass. */
const freshMaxTicks = 1;

function createGroupedScope(
	input: ArrangeInput,
	grouping: NonNullable<ArrangeInput['groupingAttribute']>,
	canvas: ArrangeInput['canvas'],
	radiusById: Map<string, number>,
	radiusFor: (id: string) => number,
	positions: Map<string, Point>,
	deps: GroupedScopeDeps
) {
	const { nodes, links } = input;
	const local = deps.localLayout(input);
	const { partitioned, offsetsByGroup, bodies: anchored, relationshipCountsByPair } = local;
	const composing = deps.isComposing(input);
	const composedKey = deps.compositionKey(input);
	const composedHere = () =>
		local.composed?.key === composedKey && local.composed.gap === input.gap
			? local.composed
			: undefined;
	const composedLayout = composing ? composedHere() : undefined;
	const drawingOffsets =
		composedLayout?.offsets ?? local.orientedOffsetsByGap.get(input.gap) ?? offsetsByGroup;

	const quotientCentres = deps.quotientCentresFor(local, input.gap, answerPositionLabel(grouping));
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

function composeGroupedRoutes(
	g: GroupedScope,
	deps: GroupedScopeDeps
): {
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
			const revision = deps.nextPacketRevision();
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
				packet: { ...result.packet, revision }
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

/** One grouped frame: place the bodies, draw their members, tidy a fresh layout, route it. */
export function arrangeGrouped(
	input: ArrangeInput,
	grouping: NonNullable<ArrangeInput['groupingAttribute']>,
	canvas: ArrangeInput['canvas'],
	radiusById: Map<string, number>,
	radiusFor: (id: string) => number,
	deps: GroupedScopeDeps
): {
	positions: Map<string, Point>;
	centres: Map<string, Point>;
	crossLinkIds: ReadonlySet<string>;
	routes?: ReadonlyMap<string, Route>;
	composition?: CompositionPacket;
} {
	const positions = new Map<string, Point>();
	const g = createGroupedScope(input, grouping, canvas, radiusById, radiusFor, positions, deps);
	placeGroupCentres(g);
	drawGroupMembers(g);
	settleFreshLayout(g);
	const { composition, routes } = composeGroupedRoutes(g, deps);
	const crossLinkIds = crossLinkIdsOf(g.links, g.memberOf);
	return { positions, centres: g.centres, crossLinkIds, routes, composition };
}
