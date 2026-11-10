/**
 * Where every Worker's name stands on the drawn map. The canvas hands over a
 * {@link NameScene} — the drawn facts a placement reads — and gets back the placed
 * names; nothing here owns state. The scene is read through getters, so a placement
 * reads live drawing state at the moment it runs, exactly as if it lived in the canvas.
 */
import type { GroupRegion, Point, Region } from './graph-layout.ts';
import type { CompositionPacket } from './graph-composition.ts';
import { floatingGutter, freeCanvasInMap, type Box as FreeBox } from './graph-free-canvas.ts';
import {
	boxFor,
	estimateLabelWidth,
	freeNamePlacement,
	mapLabelText,
	nameLeader,
	placeLabels,
	type Box as LabelBox,
	type LabelPlacement,
	type LabelRequest,
	type LabelSide,
	type Obstacle,
	type TieSegment
} from './graph-label-placement.ts';
import { nameFontPx, type TextSnapshot } from './graph-text-metrics.ts';
import type { Rect } from './map-name-framing.ts';
import { screenFixed, showsLabel } from './map-style.ts';
import type { MapViewModel } from './map-view-model.ts';
import type { WorkerGraphNode } from './worker-relationship-map-model.ts';

export type Camera = { zoom: number; panX: number; panY: number };

/** A name's placement, with the short leader a name that stands off from its dot gets. */
export type PlacedName = LabelPlacement & {
	leader?: { x1: number; y1: number; x2: number; y2: number };
	/** The box, in map units, this placement draws: the published name boxes are these. */
	box: LabelBox;
};

/** The side and ring a standing Free name chose at the anchor camera. */
export type KeptName = { side: LabelSide; ring: number };

/** The drawn facts a name placement reads. Every member is read when a placement runs. */
export type NameScene = {
	readonly viewModel: MapViewModel;
	/** Whether the map is grouped (it draws regions); false is Free. */
	readonly grouped: boolean;
	/** True when a composition that moved something is the drawing. */
	readonly composed: boolean;
	readonly radiusFor: (node: WorkerGraphNode) => number;
	readonly textSnapshot: TextSnapshot | undefined;
	readonly regions: readonly GroupRegion[];
	readonly counts: ReadonlyMap<string, number>;
	/** Where the dots are drawn now (eased), and where the arrangement settles them. */
	readonly drawn: ReadonlyMap<string, Point>;
	readonly settledPositions: ReadonlyMap<string, Point>;
	/** The dots' extent a Free name stays inside; undefined elsewhere. */
	readonly nameBounds: LabelBox | undefined;
	/** The live camera. */
	readonly camera: () => Camera;
	/** The usable canvas at whole-map framing, or undefined away from it. */
	readonly viewport: () => LabelBox | undefined;
	/** Floating keys in map coordinates at a camera. */
	readonly chrome: (camera: Camera) => LabelBox[];
	/** Floating keys at the camera that frames `frame` at `zoom`. */
	readonly chromeAtFit: (zoom: number, frame: Rect) => LabelBox[];
	/** The packet's flattened final paths, when the drawing published them. */
	readonly routeSegments: TieSegment[] | undefined;
	/** True at the packet's own fit, where its reference names are the drawing. */
	readonly atReference: boolean;
	/**
	 * True on a narrow canvas (below the Narrow tier), where a resting name that cannot
	 * clear another resting name is dropped instead of drawn over it.
	 */
	readonly narrow?: boolean;
};

/** Floating keys in map coordinates at the camera being evaluated. */
export function floatingKeyBoxes(
	input: {
		floating: boolean;
		width: number;
		height: number;
		keySize: { width: number; height: number } | undefined;
		dotKeySize: { width: number; height: number } | undefined;
	},
	camera: Camera
): LabelBox[] {
	const { floating, width, height } = input;
	if (!floating) return [];
	return [
		{ size: input.keySize, right: false },
		{ size: input.dotKeySize, right: true }
	].flatMap(({ size, right }) => {
		if (!size || size.width <= 0) return [];
		const left = right ? width / 2 - floatingGutter - size.width : -width / 2 + floatingGutter;
		const top = height / 2 - floatingGutter - size.height;
		return [
			{
				left: (left - camera.panX - 2) / camera.zoom,
				right: (left + size.width - camera.panX + 2) / camera.zoom,
				top: (top - camera.panY - 2) / camera.zoom,
				bottom: (top + size.height - camera.panY + 2) / camera.zoom
			}
		];
	});
}

/** Screen-fixed names must fit the current usable canvas at whole-map framing. */
export function wholeMapViewport(input: {
	isolated: boolean;
	camera: Camera;
	framedZoom: number;
	surface: { width: number; height: number };
	chrome: Parameters<typeof freeCanvasInMap>[1];
}): LabelBox | undefined {
	const { camera } = input;
	if (input.isolated || Math.abs(camera.zoom / input.framedZoom - 1) > 0.02) return undefined;
	const free: FreeBox = freeCanvasInMap(input.surface, input.chrome);
	return {
		left: (free.x - camera.panX) / camera.zoom,
		right: (free.x + free.width - camera.panX) / camera.zoom,
		top: (free.y - camera.panY) / camera.zoom,
		bottom: (free.y + free.height - camera.panY) / camera.zoom
	};
}

/**
 * A region label's box in map units. Its font is screen-fixed, so the box is
 * re-measured at every zoom; the factor covers the tracked uppercase face.
 */
function regionLabelBox(
	scene: NameScene,
	region: Region,
	count: number | undefined,
	px: number
): LabelBox {
	// A measured heading is placed with its real box.
	if (scene.composed && scene.textSnapshot && region.labelBox) {
		const box = region.labelBox;
		return { left: box.x, top: box.y, right: box.x + box.width, bottom: box.y + box.height };
	}
	const zoom = scene.camera().zoom;
	const fontSize = screenFixed(px, zoom);
	const text = region.displayLabel ?? region.label;
	const suffix = count !== undefined && region.displayCount !== false ? `  · ${count}` : '';
	const width = [...(text + suffix)].length * fontSize * 0.72;
	const { x, y, textAnchor } = region.labelAt;
	const left = textAnchor === 'start' ? x : textAnchor === 'end' ? x - width : x - width / 2;
	const pad = screenFixed(3, zoom);
	return {
		left: left - pad,
		right: left + width + pad,
		top: y - fontSize - pad,
		bottom: y + fontSize * 0.3 + pad
	};
}

/** Every name in `labelNodes` placed by the order given, around dots, headings and ties. */
function placeNames(
	scene: NameScene,
	input: {
		labelNodes: readonly WorkerGraphNode[];
		positions: ReadonlyMap<string, Point>;
		zoom: number;
		reserved: readonly LabelBox[];
		/** Free-only: the side and ring each resting name chose at the framing camera. */
		kept?: ReadonlyMap<string, KeptName>;
		/** The resting names a narrow canvas may leave off rather than overprint. */
		dropIds?: ReadonlySet<string>;
	}
) {
	const { viewModel, radiusFor, textSnapshot } = scene;
	const { positions, zoom } = input;
	const obstacles: Obstacle[] = viewModel.visibleNodes.flatMap((node) => {
		const point = positions.get(node.id) ?? { x: 0, y: 0 };
		return [{ id: node.id, x: point.x, y: point.y, radius: radiusFor(node) }];
	});
	const requests: LabelRequest[] = input.labelNodes.map((node) => {
		const point = positions.get(node.id) ?? { x: 0, y: 0 };
		const text = mapLabelText(node.name);
		return {
			id: node.id,
			x: point.x,
			y: point.y,
			radius: radiusFor(node),
			// The heuristic intentionally leaves room for the proportional font's
			// wider glyphs and the outline used to keep text readable on hulls.
			width:
				screenFixed(
					textSnapshot?.names.get(node.id)?.width ??
						estimateLabelWidth(text, nameFontPx) + text.length * nameFontPx * 0.12,
					zoom
				) + screenFixed(3, zoom),
			height: screenFixed(Math.max(16, textSnapshot?.names.get(node.id)?.height ?? 16), zoom)
		};
	});
	const ties: TieSegment[] = tiesAt(viewModel, positions);
	const placements = placeLabels(requests, obstacles, screenFixed(8, zoom), input.reserved, ties, {
		// Free keeps its names close: denser rings and a ring cost, so a name accepts a
		// Relationship under it rather than travel. Grouped keeps the shipped cost model.
		...(scene.grouped ? {} : freeNamePlacement),
		kept: input.kept,
		within: scene.nameBounds,
		viewport: scene.grouped ? scene.viewport() : undefined,
		dropOnNameCollision: scene.narrow ? input.dropIds : undefined
	});
	return { requests, placements };
}

/** The straight tie between each visible pair at the given positions. */
function tiesAt(viewModel: MapViewModel, positions: ReadonlyMap<string, Point>): TieSegment[] {
	return viewModel.visibleLinks.flatMap((link) => {
		const source = positions.get(link.source);
		const target = positions.get(link.target);
		return source && target
			? [
					{
						source: link.source,
						target: link.target,
						ax: source.x,
						ay: source.y,
						bx: target.x,
						by: target.y
					}
				]
			: [];
	});
}

/**
 * Free's one stable resting order: the busiest Workers first, then by id, so equal
 * ranks never swap between placements. Grouped keeps its shipped order.
 */
function restingNameOrder(a: WorkerGraphNode, b: WorkerGraphNode): number {
	return b.relationshipCount - a.relationshipCount || a.id.localeCompare(b.id);
}

/** The drawn nodes for a set of label ids, in the stable resting order. */
export function nameNodes(scene: NameScene, ids: Iterable<string>): WorkerGraphNode[] {
	const visibleById = new Map(scene.viewModel.visibleNodes.map((node) => [node.id, node]));
	return [...ids]
		.map((id) => visibleById.get(id))
		.filter((node): node is WorkerGraphNode => node !== undefined)
		.sort(restingNameOrder);
}

/** Group headings and floating keys: the text a name must step around at a camera. */
function reservedNameBoxes(scene: NameScene, camera: Camera): LabelBox[] {
	const boxes: LabelBox[] = scene.regions.flatMap((region) => [
		regionLabelBox(scene, region, scene.counts.get(region.key), 11),
		...region.subRegions.map((sub) => regionLabelBox(scene, sub, scene.counts.get(sub.key), 11))
	]);
	boxes.push(...scene.chrome(camera));
	return boxes;
}

/**
 * The side and ring each standing name chose at the anchor camera. Placement at another
 * zoom replays these while the spot stays clear, so zooming does not rearrange names.
 */
export function keptNames(scene: NameScene, camera: Camera): Map<string, KeptName> {
	const labelNodes = nameNodes(scene, scene.viewModel.restingLabelIds);
	const { placements } = placeNames(scene, {
		labelNodes,
		positions: scene.settledPositions,
		zoom: camera.zoom,
		reserved: reservedNameBoxes(scene, camera),
		dropIds: scene.narrow ? new Set(labelNodes.map((node) => node.id)) : undefined
	});
	const kept = new Map<string, KeptName>();
	for (const node of labelNodes) {
		const placement = placements.get(node.id);
		if (placement?.ring !== undefined)
			kept.set(node.id, { side: placement.side, ring: placement.ring });
	}
	return kept;
}

/**
 * The shipped name placement, around the drawn ties. Grouped places an active name
 * first, as it always has; Free places the names already standing first, then the
 * selected and hovered names, so the pointer never moves a name that was already showing.
 */
export function legacyPlacements(
	scene: NameScene,
	freeKept: ReadonlyMap<string, KeptName> | undefined
): Map<string, PlacedName> {
	const { viewModel } = scene;
	const visibleById = new Map(viewModel.visibleNodes.map((node) => [node.id, node]));
	const free = !scene.grouped;
	const priority = (id: string) =>
		id === viewModel.selectedId ? 0 : id === viewModel.hoveredId ? 1 : 2;
	// In Isolate every drawn Worker is named, so those names stand as they are and a
	// hover adds nothing. Elsewhere the cap's resting set stands, and only an active name
	// outside it is placed after them (selected first, then hovered).
	const standing = free && viewModel.isolated ? viewModel.labelIds : viewModel.restingLabelIds;
	const freeRank = (id: string) =>
		standing.has(id) ? 0 : id === viewModel.selectedId ? 1 : id === viewModel.hoveredId ? 2 : 0;
	const labelNodes = [...viewModel.labelIds]
		.map((id) => visibleById.get(id))
		.filter((node): node is WorkerGraphNode => node !== undefined)
		.filter((node) => showsLabel(node.id, viewModel))
		.sort((a, b) =>
			free
				? freeRank(a.id) - freeRank(b.id) || (freeRank(a.id) === 0 ? restingNameOrder(a, b) : 0)
				: priority(a.id) - priority(b.id)
		);
	// Group and sub-group labels are drawn first, so names step around them.
	const camera = scene.camera();
	const reserved = reservedNameBoxes(scene, camera);
	const { requests, placements } = placeNames(scene, {
		labelNodes,
		positions: scene.drawn,
		zoom: camera.zoom,
		reserved,
		kept: free && !viewModel.isolated ? freeKept : undefined,
		// On a narrow canvas only the names already standing may be dropped; a selected or
		// hovered name outside the resting set keeps its priority and its place.
		dropIds: scene.narrow
			? new Set(labelNodes.filter((node) => standing.has(node.id)).map((node) => node.id))
			: undefined
	});
	// A crowded cluster can push a name away from its dot in any layout. Keep its
	// Worker association visible.
	const named = new Map<string, PlacedName>();
	for (const request of requests) {
		const placement = placements.get(request.id);
		if (placement) {
			const box = boxFor(request, placement);
			named.set(request.id, {
				...placement,
				box,
				leader: nameLeader(request, box, screenFixed(12, camera.zoom))
			});
		}
	}
	return named;
}

/**
 * The boxes, in map units, of the names that stand at rest on the settled Free arrangement
 * at a given zoom: what the whole-map framing and the reset must keep inside the canvas.
 */
export function restingNameBoxes(scene: NameScene, zoom: number, frame: Rect): Rect[] {
	const labelNodes = nameNodes(scene, scene.viewModel.restingLabelIds);
	const { requests, placements } = placeNames(scene, {
		labelNodes,
		positions: scene.settledPositions,
		zoom,
		reserved: scene.chromeAtFit(zoom, frame),
		dropIds: scene.narrow ? new Set(labelNodes.map((node) => node.id)) : undefined
	});
	return requests.flatMap((asked) => {
		const placement = placements.get(asked.id);
		const box = placement && boxFor(asked, placement);
		return box
			? [{ x: box.left, y: box.top, width: box.right - box.left, height: box.bottom - box.top }]
			: [];
	});
}

/**
 * The composed names: those that stand at rest keep their places whatever is
 * selected, hovered or searched, and an active name is placed last over the
 * fixed geometry.
 */
function composedPlacements(
	scene: NameScene,
	published: CompositionPacket
): Map<string, PlacedName> {
	const { viewModel, radiusFor, textSnapshot, drawn } = scene;
	const zoom = scene.camera().zoom;
	const visibleById = new Map(viewModel.visibleNodes.map((node) => [node.id, node]));
	const resting = [...viewModel.restingLabelIds].filter((id) => visibleById.has(id));
	const restingSet = new Set(resting);
	const actives = [viewModel.selectedId, viewModel.hoveredId].filter(
		(id, i, all) => id !== '' && visibleById.has(id) && !restingSet.has(id) && all.indexOf(id) === i
	);
	const placed = new Map<string, PlacedName>();
	const request = (id: string): LabelRequest => {
		const node = visibleById.get(id)!;
		const point = drawn.get(id) ?? { x: 0, y: 0 };
		const text = mapLabelText(node.name);
		const size = textSnapshot?.names.get(id) ?? {
			width: estimateLabelWidth(text, nameFontPx) + text.length * nameFontPx * 0.12,
			height: 14
		};
		return {
			id,
			x: point.x,
			y: point.y,
			radius: radiusFor(node),
			width: screenFixed(size.width + 3, zoom),
			height: screenFixed(size.height, zoom)
		};
	};
	const reserved: LabelBox[] = reservedNameBoxes(scene, scene.camera());
	let toPlace = [...resting, ...actives];
	if (scene.atReference) {
		toPlace = [...actives];
		for (const id of resting) {
			const fixed = published.names.get(id);
			const viewport = scene.viewport();
			const clipped =
				fixed &&
				viewport &&
				(fixed.box.left < viewport.left ||
					fixed.box.right > viewport.right ||
					fixed.box.top < viewport.top ||
					fixed.box.bottom > viewport.bottom);
			const covered =
				fixed &&
				scene
					.chrome(scene.camera())
					.some(
						(box) =>
							fixed.box.left < box.right &&
							fixed.box.right > box.left &&
							fixed.box.top < box.bottom &&
							fixed.box.bottom > box.top
					);
			// A packet composed over earlier positions can leave a reused name on a
			// dot or another name: only reuse a fixed box that still clears the drawn
			// geometry, otherwise let the fresh search below place it.
			// The packet boxes were sized for the composition scale while names draw
			// at a screen-fixed size: after the camera fits wider, a reused box can
			// be narrower on screen than its own text. Only reuse a box that still
			// covers its text at the current zoom.
			const zoomNow = scene.camera().zoom;
			const snap = fixed && textSnapshot?.names.get(id);
			const coversText =
				!fixed ||
				!snap ||
				((fixed.box.right - fixed.box.left) * zoomNow >= snap.width + 3 &&
					(fixed.box.bottom - fixed.box.top) * zoomNow >= snap.height);
			// The drawn contract shrinks a dot's box by two screen pixels before
			// testing the overlap, and forbids even a corner graze of that box.
			const shrinkNow = zoomNow > 0 ? 2 / zoomNow : 0;
			const overlaps =
				fixed &&
				(viewModel.visibleNodes.some((node) => {
					if (node.id === id) return false;
					const point = drawn.get(node.id) ?? { x: 0, y: 0 };
					const r = radiusFor(node) - shrinkNow;
					return (
						fixed.box.left < point.x + r &&
						point.x - r < fixed.box.right &&
						fixed.box.top < point.y + r &&
						point.y - r < fixed.box.bottom
					);
				}) ||
					[...placed.values()].some(
						(other) =>
							fixed.box.left < other.box.right &&
							other.box.left < fixed.box.right &&
							fixed.box.top < other.box.bottom &&
							other.box.top < fixed.box.bottom
					));
			if (!fixed || clipped || covered || overlaps || !coversText) {
				toPlace.unshift(id);
				continue;
			}
			placed.set(id, {
				x: fixed.x,
				y: fixed.y,
				textAnchor: fixed.textAnchor,
				side: fixed.side as LabelPlacement['side'],
				box: fixed.box,
				leader: fixed.leader
			});
			reserved.push(fixed.box);
		}
	}
	const requests = toPlace.map(request);
	const obstacles: Obstacle[] = viewModel.visibleNodes.flatMap((node) => {
		const point = drawn.get(node.id) ?? { x: 0, y: 0 };
		return [{ id: node.id, x: point.x, y: point.y, radius: radiusFor(node) }];
	});
	const ties: TieSegment[] = scene.routeSegments ?? tiesAt(viewModel, drawn);
	const found = placeLabels(requests, obstacles, screenFixed(8, zoom), reserved, ties, {
		rings: [1, 2, 3, 4, 5, 6],
		tieWeight: 6,
		viewport: scene.viewport(),
		dropOnNameCollision: scene.narrow ? new Set(resting) : undefined
	});
	for (const asked of requests) {
		const placement = found.get(asked.id);
		if (!placement) continue;
		const box = boxFor(asked, placement);
		placed.set(asked.id, {
			...placement,
			box,
			leader: nameLeader(asked, box, screenFixed(12, zoom))
		});
	}
	return placed;
}

/** The names the visibility policy shows, placed by whichever reading the drawing is in. */
export function placeAllNames(
	scene: NameScene,
	composedPacket: CompositionPacket | undefined,
	freeKept: ReadonlyMap<string, KeptName> | undefined
): Map<string, PlacedName> {
	if (!composedPacket) return legacyPlacements(scene, freeKept);
	const placed = composedPlacements(scene, composedPacket);
	// Only the names the visibility policy shows draw, wherever the rest were placed.
	return new Map([...placed].filter(([id]) => showsLabel(id, scene.viewModel)));
}
