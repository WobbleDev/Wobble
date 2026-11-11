/**
 * A Free map framed and named the way the canvas does it on first load, from modules
 * alone: the arrangement, the framing with the names that stand at rest, the kept sides,
 * the placement and the frozen names. Test support only.
 *
 * Not reproduced: the DOM-measured text (names use the placement's own estimate), the
 * measured control strip, bottom bar and floating keys (the surface is the whole free
 * canvas), and the canvas's final name-fit pass over the rendered box.
 */
import { NARROW_BREAKPOINT } from '#lib/hooks/is-mobile.svelte.ts';
import { arrange } from '#lib/features/mapping/layout/graph-arrangement.ts';
import { freeCanvasInMap } from '#lib/features/mapping/layout/graph-free-canvas.ts';
import { groupGapDefault } from '#lib/features/mapping/layout/graph-group-physics.ts';
import type { Point } from '#lib/features/mapping/layout/graph-layout.ts';
import type { Box } from '#lib/features/mapping/labels/graph-label-placement.ts';
import { freezeName, type FrozenName } from '#lib/features/mapping/map-frozen-names.ts';
import { settledFrameOf } from '#lib/features/mapping/map-drawing.ts';
import { frameWithNames } from '#lib/features/mapping/labels/map-name-framing.ts';
import {
	keptNames,
	placeAllNames,
	restingNameBoxes,
	wholeMapViewport,
	type Camera,
	type NameScene,
	type PlacedName
} from '#lib/features/mapping/labels/map-name-placement.ts';
import { fitCamera } from '#lib/features/mapping/map-pan-zoom.svelte.ts';
import { nodeRadius } from '#lib/features/mapping/map-style.ts';
import {
	isolateDrawnLinkIds,
	isolateFitPositions,
	isolateNeighbourhood,
	labelledWorkerIds,
	type MapViewModel
} from '#lib/features/mapping/map-view-model.ts';
import type {
	WorkerGraphLink,
	WorkerGraphNode
} from '#lib/features/mapping/worker-relationship-map-model.ts';

/** What the pointer or the card is on; the rest of the view model follows from it as it does in the map. */
export type FreeFocus = { hoveredId?: string; selectedId?: string; isolated?: boolean };

export function freeNamedMap(
	graph: { nodes: readonly WorkerGraphNode[]; links: readonly WorkerGraphLink[] },
	surface: { width: number; height: number }
) {
	const { nodes, links } = graph;
	const arrangement = arrange({
		mode: 'free',
		nodes,
		links,
		groupingAttribute: undefined,
		canvas: surface,
		gap: groupGapDefault
	});
	const positions = arrangement.positions;
	const radiusFor = (node: WorkerGraphNode) => nodeRadius(node.relationshipCount);
	const nodeById = new Map(nodes.map((node) => [node.id, node]));
	const neighbours = new Map(nodes.map((node) => [node.id, new Set<string>()]));
	for (const link of links) {
		neighbours.get(link.source)!.add(link.target);
		neighbours.get(link.target)!.add(link.source);
	}
	const restingLabelIds = labelledWorkerIds(nodes, {});
	const bounds = (() => {
		const points = [...positions.values()];
		return {
			left: Math.min(...points.map((p) => p.x)),
			right: Math.max(...points.map((p) => p.x)),
			top: Math.min(...points.map((p) => p.y)),
			bottom: Math.max(...points.map((p) => p.y))
		};
	})();

	/** The view model of a Free map under a pointer or a selection, as the map derives it. */
	function viewModelFor(focus: FreeFocus): MapViewModel {
		const labelIds = new Set(restingLabelIds);
		const anchor = focus.hoveredId || focus.selectedId || '';
		const spotlightIds = new Set<string>();
		if (anchor) {
			spotlightIds.add(anchor);
			for (const id of neighbours.get(anchor) ?? []) spotlightIds.add(id);
		}
		if (focus.isolated) for (const node of nodes) labelIds.add(node.id);
		for (const id of [focus.selectedId, focus.hoveredId]) if (id) labelIds.add(id);
		return {
			effectiveLayout: 'free',
			isolated: focus.isolated ?? false,
			layoutNodes: nodes,
			layoutLinks: links,
			visibleNodes: nodes,
			visibleLinks: links,
			selectedId: focus.selectedId ?? '',
			hoveredId: focus.hoveredId ?? '',
			ghostedIds: new Set<string>(),
			labelIds,
			restingLabelIds,
			spotlightIds,
			highlightIds: undefined,
			linkRegions: new Map()
		};
	}

	/** The name scene at a camera. `framedZoom` is where whole-map framing holds. */
	function sceneAt(camera: Camera, focus: FreeFocus = {}, framedZoom = camera.zoom): NameScene {
		return {
			viewModel: viewModelFor(focus),
			grouped: false,
			composed: false,
			radiusFor,
			textSnapshot: undefined,
			regions: [],
			counts: new Map(),
			drawn: positions,
			settledPositions: positions,
			nameBounds: bounds,
			camera: () => camera,
			viewport: () =>
				wholeMapViewport({
					isolated: focus.isolated ?? false,
					camera,
					framedZoom,
					surface,
					chrome: { top: 0, right: 0, bottom: 0, left: 0 }
				}),
			chrome: () => [],
			chromeAtFit: () => [],
			routeSegments: undefined,
			atReference: false,
			narrow: surface.width < NARROW_BREAKPOINT
		};
	}

	const view = {
		width: surface.width,
		height: surface.height,
		left: 0,
		top: 0,
		matrixE: surface.width / 2,
		matrixF: surface.height / 2,
		insets: { top: 0, bottom: 0, left: 0, right: 0 }
	};
	/** The first framing: the dots with the names that stand at rest, kept off the zoom ceiling of 1.2. */
	const fitCap = 1.2;
	const dots = settledFrameOf({
		visibleNodes: nodes,
		positions,
		baseRadiusFor: radiusFor,
		labelGap: 8,
		grouped: false,
		composedFrame: undefined,
		regions: arrangement.regions
	})!;
	const named = frameWithNames({
		dots,
		namesAt: (zoom, frame) => restingNameBoxes(sceneAt({ zoom, panX: 0, panY: 0 }), zoom, frame),
		zoomFor: (box) => fitCamera(box, view, 28, fitCap).zoom
	});
	const camera: Camera = fitCamera(named.frame, view, 28, named.zoom ?? fitCap);

	/** Names at rest at the framing: the kept sides, the placement and the freeze. */
	const rest = sceneAt(camera);
	const kept = keptNames(rest, camera);
	const placed = placeAllNames(rest, undefined, kept);
	const frozen = new Map<string, FrozenName>();
	for (const node of nodes) {
		const name = placed.get(node.id);
		if (name && restingLabelIds.has(node.id))
			frozen.set(node.id, freezeName(name, positions.get(node.id)!, radiusFor(node), camera.zoom));
	}

	return {
		nodes,
		nodeById,
		neighbours,
		positions,
		radiusFor,
		camera,
		kept,
		placed,
		frozen,
		/** The framed extent of the dots, and the surface the camera frames them in. */
		dots,
		view,
		restingLabelIds,
		sceneAt,
		/** Where the dot is: its position and its radius. */
		dot: (id: string): Point & { r: number } => ({
			...positions.get(id)!,
			r: radiusFor(nodeById.get(id)!)
		})
	};
}

export type FreeNamedMap = ReturnType<typeof freeNamedMap>;

/**
 * The same map in Isolate on one Worker: the neighbourhood spread over the free canvas at
 * 1x, every drawn Worker named, the pointer's spotlight hiding names outside its reading.
 */
export function isolatedNames(
	graph: { nodes: readonly WorkerGraphNode[]; links: readonly WorkerGraphLink[] },
	surface: { width: number; height: number },
	anchor: string
) {
	const map = freeNamedMap(graph, surface);
	const neighbourhood = isolateNeighbourhood(map.neighbours, anchor, true)!;
	const drawnLinks = isolateDrawnLinkIds(graph.links, neighbourhood);
	const visibleNodes = graph.nodes.filter((node) => neighbourhood.keptIds.has(node.id));
	const visibleLinks = graph.links.filter((link) => drawnLinks.has(link.id));
	const fit = isolateFitPositions({
		positions: map.positions,
		drawnIds: visibleNodes.map((node) => node.id),
		freeCanvas: freeCanvasInMap(surface, { top: 0, right: 0, bottom: 0, left: 0 }),
		radii: new Map(visibleNodes.map((node) => [node.id, nodeRadius(node.relationshipCount)]))
	});
	const radiusFor = (node: WorkerGraphNode) =>
		fit.radii.get(node.id) ?? nodeRadius(node.relationshipCount);
	const camera: Camera = { zoom: 1, panX: 0, panY: 0 };
	/** Names in Isolate with the pointer on `hoveredId`, or the selection alone. */
	function sceneFor(hoveredId = ''): NameScene {
		const read = hoveredId || anchor;
		const spotlightIds = new Set([read, ...(map.neighbours.get(read) ?? [])]);
		return {
			viewModel: {
				effectiveLayout: 'free',
				isolated: true,
				layoutNodes: graph.nodes,
				layoutLinks: graph.links,
				visibleNodes,
				visibleLinks,
				selectedId: anchor,
				hoveredId,
				ghostedIds: neighbourhood.secondDegree,
				labelIds: new Set(visibleNodes.map((node) => node.id)),
				restingLabelIds: map.restingLabelIds,
				spotlightIds,
				highlightIds: undefined,
				linkRegions: new Map()
			},
			grouped: false,
			composed: false,
			radiusFor,
			textSnapshot: undefined,
			regions: [],
			counts: new Map(),
			drawn: fit.positions,
			settledPositions: map.positions,
			nameBounds: undefined,
			camera: () => camera,
			viewport: () => undefined,
			chrome: () => [],
			chromeAtFit: () => [],
			routeSegments: undefined,
			atReference: false,
			narrow: surface.width < NARROW_BREAKPOINT
		};
	}
	return { neighbours: map.neighbours, visibleNodes, sceneFor };
}

/** How far a name's box stands off its own dot's surface, in map units. */
export function standoff(dot: Point & { r: number }, box: Box): number {
	const x = Math.max(box.left, Math.min(dot.x, box.right));
	const y = Math.max(box.top, Math.min(dot.y, box.bottom));
	return Math.hypot(x - dot.x, y - dot.y) - dot.r;
}

/**
 * Which side of its dot a name stands on, read from the nearest point of its box: the
 * centreline sides have one axis at zero, and the diagonal sides sit on the 45 degree corner.
 */
export function nameSide(dot: Point, box: Box): string {
	const x = Math.max(box.left, Math.min(dot.x, box.right));
	const y = Math.max(box.top, Math.min(dot.y, box.bottom));
	const dx = x - dot.x;
	const dy = y - dot.y;
	const across = Math.abs(dx);
	const down = Math.abs(dy);
	const vertical = dy < 0 ? 'above' : 'below';
	const horizontal = dx < 0 ? 'left' : 'right';
	if (down < 0.5) return horizontal;
	if (across < 0.5) return vertical;
	if (Math.abs(across - down) < 2) return `${vertical}-${horizontal}`;
	return across > down ? horizontal : vertical;
}

export type Placed = PlacedName;
