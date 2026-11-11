/**
 * The single source for what the map shows: the effective layout, the visible nodes
 * and ties, which Workers carry labels, and which region each tie belongs to.
 */
import type { WorkerAttributeDefinition } from '#lib/domain-vocabulary.ts';
import { groupValue, isolatedDegrees, linkEndId } from './layout/graph-analysis.ts';
import type { Point } from './layout/graph-layout.ts';
import { separateOverlappingDots } from './layout/isolate-separation.ts';
import type { WorkerGraphLink, WorkerGraphNode } from './canvas/worker-relationship-map-model.ts';

/** A box in one coordinate space: the free canvas, or a set of drawn positions. */
type Box = { x: number; y: number; width: number; height: number };

export type MapLayoutMode = 'grouped' | 'free';

/** The derived view the canvas draws: what is visible, and what is emphasised. */
export type MapViewModel = {
	effectiveLayout: MapLayoutMode;
	/** Whether the Isolate focus is on: it needs a selected Worker, and moves no dot. */
	isolated: boolean;
	/** The Workers the arrangement places: everyone the filters leave, whatever the focus. */
	layoutNodes: readonly WorkerGraphNode[];
	layoutLinks: readonly WorkerGraphLink[];
	/** The Workers and ties the map draws: the layout set narrowed by the Isolate focus. */
	visibleNodes: readonly WorkerGraphNode[];
	visibleLinks: readonly WorkerGraphLink[];
	selectedId: string;
	hoveredId: string;
	ghostedIds: ReadonlySet<string>;
	labelIds: ReadonlySet<string>;
	/**
	 * The Workers whose names stand at rest, in priority order: the same cap and
	 * ranking as `labelIds` with selection and hover neutralized, so the
	 * composition can reserve them without ever depending on the pointer.
	 */
	restingLabelIds: ReadonlySet<string>;
	spotlightIds: ReadonlySet<string>;
	/**
	 * The Workers a complete Highlight query selects. Undefined when there is no
	 * complete query, so nothing is faded by it; an empty set fades everyone. Separate
	 * from `spotlightIds`, which is hover and search driven and transient.
	 */
	highlightIds: ReadonlySet<string> | undefined;
	/** Each drawn Relationship read as crossing between regions or staying within one. */
	linkRegions: ReadonlyMap<string, LinkRegion>;
};

/**
 * The one place the drawn layout mode is decided, so the rule cannot drift
 * between the state, the wrapper and the canvas.
 *
 * - Without a grouping there are no regions to group into, so any mode draws
 *   `free` (the ungrouped stress layout).
 * - Isolate is a focus, not a layout mode: it never changes the layout.
 */
export function resolveEffectiveLayout(
	layout: MapLayoutMode,
	groupingAttribute: WorkerAttributeDefinition | undefined
): MapLayoutMode {
	return groupingAttribute ? layout : 'free';
}

/**
 * The Isolate drawn-set rule, partitioned once: the selected Worker and its first
 * degree at full strength, its second degree ghosted, everyone else outside the
 * neighbourhood. Undefined when Isolate is not in effect.
 */
type IsolateNeighbourhood = {
	selectedId: string;
	/** The Workers one Relationship away, drawn at full strength. */
	firstDegree: ReadonlySet<string>;
	/** The Workers two away, drawn faded. */
	secondDegree: ReadonlySet<string>;
	/** The selected Worker and both degrees: everyone Isolate keeps on the map. */
	keptIds: ReadonlySet<string>;
};

export function isolateNeighbourhood(
	adjacency: Map<string, Set<string>>,
	selectedId: string,
	isolated: boolean
): IsolateNeighbourhood | undefined {
	if (!isIsolateInEffect(isolated, selectedId)) return undefined;
	const { firstDegree, secondDegree } = isolatedDegrees(adjacency, selectedId);
	return {
		selectedId,
		firstDegree: new Set(firstDegree),
		secondDegree: new Set(secondDegree),
		keptIds: new Set([selectedId, ...firstDegree, ...secondDegree])
	};
}

/**
 * The Relationships Isolate draws: those touching the selected Worker, those
 * between two first-degree Workers, and the ones between a first- and a
 * second-degree Worker (drawn ghosted, like the second degree itself).
 *
 * Two second-degree Workers are never joined on the map — that Relationship lies at the rim of
 * the neighbourhood rather than part of how it is reached, and drawing it
 * would turn it into a tangle — and neither is a Relationship touching anyone
 * outside the neighbourhood.
 */
export function isolateDrawnLinkIds(
	links: readonly WorkerGraphLink[],
	neighbourhood: IsolateNeighbourhood
): Set<string> {
	const { selectedId, firstDegree, secondDegree } = neighbourhood;
	const kept = (id: string) => id === selectedId || firstDegree.has(id) || secondDegree.has(id);
	const drawn = new Set<string>();

	for (const link of links) {
		const source = linkEndId(link.source);
		const target = linkEndId(link.target);
		if (!kept(source) || !kept(target)) continue;
		if (secondDegree.has(source) && secondDegree.has(target)) continue;
		drawn.add(link.id);
	}

	return drawn;
}

/** Isolate is in effect only while a Worker is selected to isolate. */
export function isIsolateInEffect(isolated: boolean, selectedId: string): boolean {
	return isolated && selectedId !== '';
}

/** How far Isolate's fit keeps the drawn set from the free canvas's edges, in map units. */
const isolateFitPadding = 56;
/** The most Isolate spreads a neighbourhood: three times the whole map's spacing. */
const isolateFitMaxScale = 3;
/** The smallest dot Isolate draws: a lone Worker's radius, so no dot shrinks below a normal one. */
const isolateMinRadius = 4;
/** The most Isolate grows a dot: 1.25× its normal radius, reached at a fit of 1.25× or more. */
const isolateMaxRadiusGrowth = 1.25;

/**
 * Isolate's fit: a view-level transform over the arrangement, never a re-layout.
 *
 * The drawn set is scaled uniformly about its own centroid until its bounds fit
 * the free canvas with padding, then centred in that canvas. The scale is capped
 * at 3× — a tiny neighbourhood is given room rather than flung to the edges. A
 * large one is drawn more tightly than the whole map (scale below 1×), so it
 * always fits the free canvas.
 *
 * Dot radii follow the fit both ways. Each drawn dot's radius is multiplied by
 * the fit, capped at `isolateMaxRadiusGrowth` (1.25×): below 1× a dot shrinks,
 * but never below `isolateMinRadius` (a dot already at or below that floor is
 * left as it is); from 1× up to 1.25× it grows in step with the room, and at
 * 1.25× or more it stays 1.25× its normal size. The growth is what tells Isolate
 * apart from the regular map. Scaling down can still leave two dots closer than
 * their radii allow, so the drawn dots are then separated just enough to keep a
 * clear gap between every pair, and the set is re-centred (see
 * `separateOverlappingDots`, which runs on the drawn radii).
 *
 * Distances between drawn Workers change, and so do the drawn dots' radii; label
 * size and stroke width are the Worker's own, never the fit's. Every Worker
 * outside the drawn set keeps the position the arrangement gave it. The returned
 * positions are a copy: the arrangement is never recomputed or mutated, so
 * leaving Isolate gives back exactly the map that was left. The returned radii
 * cover the drawn Workers only.
 */
export function isolateFitPositions(input: {
	/** The arrangement: where every Worker draws before Isolate's fit. */
	positions: ReadonlyMap<string, Point>;
	/** The drawn set: the selected Worker and its two degrees. */
	drawnIds: Iterable<string>;
	/** The free canvas the fit centres in, in the map's own coordinates. */
	freeCanvas: Box;
	/** Each drawn Worker's base dot radius; a Worker with none given is taken as radius zero. */
	radii?: ReadonlyMap<string, number>;
	padding?: number;
}): { positions: Map<string, Point>; radii: Map<string, number> } {
	const { positions, freeCanvas } = input;
	const padding = input.padding ?? isolateFitPadding;
	const baseRadii = input.radii ?? new Map<string, number>();
	const fitted = new Map(positions);

	const drawn = [...input.drawnIds].flatMap((id) => {
		const point = positions.get(id);
		return point ? [[id, point] as const] : [];
	});
	if (drawn.length === 0) return { positions: fitted, radii: new Map() };

	const centroid = centroidOf(drawn.map(([, point]) => point));
	const halfWidth = Math.max(...drawn.map(([, { x }]) => Math.abs(x - centroid.x)));
	const halfHeight = Math.max(...drawn.map(([, { y }]) => Math.abs(y - centroid.y)));

	// A neighbourhood with no extent on one axis — a row of Workers — is fitted by
	// the other one, and a lone Worker has none at all to fit, so it simply keeps
	// the position the arrangement gave it.
	const fit = Math.min(
		(freeCanvas.width - padding * 2) / (halfWidth * 2),
		(freeCanvas.height - padding * 2) / (halfHeight * 2)
	);
	const scale = Number.isFinite(fit) ? Math.min(isolateFitMaxScale, fit) : 1;
	// Radii follow the fit, growing up to 1.25× and shrinking below 1×; the fit is already capped at 3×.
	const radiusScale = Math.min(isolateMaxRadiusGrowth, scale);
	const radii = new Map(
		drawn.map(([id]) => {
			const base = baseRadii.get(id) ?? 0;
			return [id, Math.max(Math.min(base, isolateMinRadius), base * radiusScale)] as const;
		})
	);

	const scaled = drawn.map(
		([id, point]) =>
			[
				id,
				{
					x: centroid.x + (point.x - centroid.x) * scale,
					y: centroid.y + (point.y - centroid.y) * scale
				}
			] as const
	);
	// Scaled about the centroid, then moved so the drawn bounds sit centred in the
	// free canvas: the shape is the whole map's, the room is Isolate's.
	const bounds = boundsOf(scaled.map(([, point]) => point));
	const offset = {
		x: freeCanvas.x + freeCanvas.width / 2 - (bounds.x + bounds.width / 2),
		y: freeCanvas.y + freeCanvas.height / 2 - (bounds.y + bounds.height / 2)
	};

	const placed = new Map(
		scaled.map(([id, point]) => [id, { x: point.x + offset.x, y: point.y + offset.y }] as const)
	);

	// Scaling down can bring two dots closer than their shrunk radii allow: a separation
	// pass clears them, then the set is re-centred. With nothing overlapping the
	// pass returns the same map, so a neighbourhood that fits is left exactly as fitted.
	const separated = separateOverlappingDots(placed, radii);
	const settled = separated === placed ? placed : recentredOn(separated, freeCanvas);

	for (const [id, point] of settled) {
		fitted.set(id, point);
	}

	return { positions: fitted, radii };
}

type Camera = { zoom: number; panX: number; panY: number };
type Size = { width: number; height: number };

/**
 * How far the canvas has shrunk or grown since the arrangement was laid out: the
 * smaller of the two size ratios. It depends only on the two sizes, never on the
 * path between them, so any resize back to the layout size gives exactly 1.
 */
export function viewportFactor(layout: Size, live: Size): number {
	if (layout.width <= 0 || layout.height <= 0 || live.width <= 0 || live.height <= 0) return 1;
	return Math.min(live.width / layout.width, live.height / layout.height);
}

/**
 * The viewport refit: the camera shown for the live canvas, read from a reference
 * camera held in the layout canvas's frame. Zoom and pan scale about the canvas
 * centre (the map's origin), so a smaller window zooms the whole map out and a
 * larger one zooms it back in. A view-level reading: the arrangement is untouched.
 */
export function cameraForSize(input: { reference: Camera; layout: Size; live: Size }): Camera {
	const factor = viewportFactor(input.layout, input.live);
	const { reference } = input;
	return {
		zoom: reference.zoom * factor,
		panX: reference.panX * factor,
		panY: reference.panY * factor
	};
}

/** The reference camera a camera the organizer set at the live size stands for. */
export function referenceFromCamera(input: { camera: Camera; layout: Size; live: Size }): Camera {
	const factor = viewportFactor(input.layout, input.live);
	const { camera } = input;
	return { zoom: camera.zoom / factor, panX: camera.panX / factor, panY: camera.panY / factor };
}

function centroidOf(points: readonly Point[]): Point {
	return points.reduce(
		(total, point) => ({
			x: total.x + point.x / points.length,
			y: total.y + point.y / points.length
		}),
		{ x: 0, y: 0 }
	);
}

/** The same points, moved so their bounds sit centred in the free canvas. */
function recentredOn(points: ReadonlyMap<string, Point>, freeCanvas: Box): Map<string, Point> {
	const bounds = boundsOf([...points.values()]);
	const offset = {
		x: freeCanvas.x + freeCanvas.width / 2 - (bounds.x + bounds.width / 2),
		y: freeCanvas.y + freeCanvas.height / 2 - (bounds.y + bounds.height / 2)
	};

	return new Map(
		[...points].map(
			([id, point]) => [id, { x: point.x + offset.x, y: point.y + offset.y }] as const
		)
	);
}

function boundsOf(points: readonly Point[]): Box {
	const xs = points.map((point) => point.x);
	const ys = points.map((point) => point.y);
	const minX = Math.min(...xs);
	const minY = Math.min(...ys);

	return {
		x: minX,
		y: minY,
		width: Math.max(...xs) - minX,
		height: Math.max(...ys) - minY
	};
}

/**
 * The nodes and links the map draws under the current filters.
 *
 * Every Worker in the exclusion set is dropped — the caller unions the Workers
 * hidden by filters with the Workers outside the Isolate neighbourhood. Ghosting never
 * affects visibility. A relationship survives only while both its ends do.
 * Endpoints are ids here: the simulation replaces them with node objects only
 * after this derivation.
 */
export function deriveVisibleGraph(
	nodes: readonly WorkerGraphNode[],
	links: readonly WorkerGraphLink[],
	excludedIds: ReadonlySet<string>
): { nodes: readonly WorkerGraphNode[]; links: readonly WorkerGraphLink[] } {
	const visibleNodes = nodes.filter((node) => !excludedIds.has(node.id));
	const visibleIds = new Set(visibleNodes.map((node) => node.id));
	const visibleLinks = links.filter(
		(link) => visibleIds.has(link.source) && visibleIds.has(link.target)
	);

	return { nodes: visibleNodes, links: visibleLinks };
}

/** How many names the map keeps before a hover or a selection adds its own. */
const labelCap = 5;

/**
 * The workers that keep a name on the map. The selected and hovered workers are
 * never dropped, and the rest fill the cap by Relationship count, so the people
 * who hold the network together are the ones that stay legible.
 */
export function labelledWorkerIds(
	nodes: readonly WorkerGraphNode[],
	options: { selectedId?: string; hoveredId?: string; cap?: number } = {}
): Set<string> {
	const cap = options.cap ?? labelCap;
	const ids = new Set<string>();
	if (options.selectedId) ids.add(options.selectedId);
	if (options.hoveredId) ids.add(options.hoveredId);
	if (ids.size >= cap) return ids;

	const ranked = [...nodes].sort((a, b) => b.relationshipCount - a.relationshipCount);
	for (const node of ranked) {
		if (ids.size >= cap) break;
		ids.add(node.id);
	}

	return ids;
}

/** Whether a Relationship stays inside one Grouping region or crosses between two. */
type LinkRegion = 'cross' | 'within';

/**
 * Reads every Relationship as crossing or staying within its Grouping regions, so
 * the bridges between groups can be drawn as the figure. Without a grouping there
 * are no regions, so every link is within.
 */
export function linkRegions(
	nodes: readonly WorkerGraphNode[],
	links: readonly WorkerGraphLink[],
	groupingAttribute: WorkerAttributeDefinition | undefined
): Map<string, LinkRegion> {
	const readings = new Map<string, LinkRegion>();
	if (!groupingAttribute) return readings;

	const regionOf = new Map(nodes.map((node) => [node.id, groupValue(node, groupingAttribute)]));

	for (const link of links) {
		const source = regionOf.get(linkEndId(link.source));
		const target = regionOf.get(linkEndId(link.target));
		readings.set(link.id, source !== undefined && source === target ? 'within' : 'cross');
	}

	return readings;
}

type DossierNeighbour = {
	id: string;
	name: string;
	assessment: WorkerGraphNode['assessment'];
	relationshipCount: number;
};

/** The selected worker's direct neighbours, alphabetized for the record card. */
export function dossierNeighbours(
	selectedId: string,
	adjacency: ReadonlyMap<string, ReadonlySet<string>>,
	nodesById: ReadonlyMap<string, WorkerGraphNode>
): DossierNeighbour[] {
	return [...(adjacency.get(selectedId) ?? [])]
		.flatMap((id) => {
			const node = nodesById.get(id);
			return node
				? [
						{
							id: node.id,
							name: node.name,
							assessment: node.assessment,
							relationshipCount: node.relationshipCount
						}
					]
				: [];
		})
		.sort((a, b) => a.name.localeCompare(b.name));
}
