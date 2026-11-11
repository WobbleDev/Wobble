/**
 * Pure readings of the drawing the canvas keeps: the frame the camera travels to, the
 * regions with their headings stepped around the names, which regions a spotlight or
 * Highlight keeps lit, the halo clip, the flattened final paths and the floating-key
 * rectangles a layout reserves. Every input is passed in; nothing here holds state.
 */
import { arrange, type ArrangeInput } from './layout/graph-arrangement.ts';
import { buildBucketTree, groupValue } from './layout/graph-analysis.ts';
import type { CompositionPacket } from './composition/graph-composition.ts';
import { floatingGutter } from './layout/graph-free-canvas.ts';
import {
	regionKey,
	regionsExtent,
	subRegionKey,
	type Point,
	type Region
} from './layout/graph-layout.ts';
import { mapLabelText, type TieSegment } from './labels/graph-label-placement.ts';
import { flattenPath } from './layout/graph-shapes.ts';
import type { TextSnapshot } from './labels/graph-text-metrics.ts';
import { screenFixed } from './map-style.ts';
import type { WorkerAttributeDefinition } from '#lib/domain-vocabulary.ts';
import type { WorkerGraphNode } from './worker-relationship-map-model.ts';

type Rect = { x: number; y: number; width: number; height: number };
type Size = { width: number; height: number };

/**
 * The resting arrangement's extent in map coordinates, which the framing travels to:
 * the drawn Workers padded for their names, joined with the region outlines when grouped,
 * or the composition's own frame when it moved something.
 */
export function settledFrameOf(input: {
	visibleNodes: readonly WorkerGraphNode[];
	positions: ReadonlyMap<string, Point>;
	baseRadiusFor: (node: WorkerGraphNode) => number;
	labelGap: number;
	grouped: boolean;
	composedFrame: Rect | undefined;
	regions: Parameters<typeof regionsExtent>[0];
}): Rect | undefined {
	const { visibleNodes } = input;
	if (visibleNodes.length === 0) return undefined;

	const widest = Math.max(...visibleNodes.map((node) => input.baseRadiusFor(node)));
	const margin = widest + input.labelGap;

	// The extent of the drawn Workers only: leaving Isolate, or a change of
	// filters, frames what is drawn rather than the whole arrangement.
	let minX = Infinity;
	let minY = Infinity;
	let maxX = -Infinity;
	let maxY = -Infinity;
	for (const node of visibleNodes) {
		const point = input.positions.get(node.id);
		if (!point) continue;
		minX = Math.min(minX, point.x);
		minY = Math.min(minY, point.y);
		maxX = Math.max(maxX, point.x);
		maxY = Math.max(maxY, point.y);
	}
	if (minX === Infinity) return undefined;

	const dots = {
		x: minX - margin,
		y: minY - margin,
		width: maxX - minX + margin * 2,
		height: maxY - minY + margin * 2
	};
	if (!input.grouped) return dots;

	// A composition frames the extent it built its clearances at.
	if (input.composedFrame) return input.composedFrame;
	const regions = regionsExtent(input.regions, 15);
	if (!regions) return dots;
	const left = Math.min(dots.x, regions.x);
	const top = Math.min(dots.y, regions.y);
	const right = Math.max(dots.x + dots.width, regions.x + regions.width);
	const bottom = Math.max(dots.y + dots.height, regions.y + regions.height);
	return { x: left, y: top, width: right - left, height: bottom - top };
}

/** The floating keys, in pixels from the free canvas's top-left: text steps around them. */
export function layoutReservedRects(input: {
	floating: boolean;
	free: Size;
	keySize: Size | undefined;
	dotKeySize: Size | undefined;
}): Rect[] {
	if (!input.floating) return [];
	const { free, keySize, dotKeySize } = input;
	const rects = [];
	if (keySize && keySize.width > 0) {
		rects.push({
			x: floatingGutter,
			y: free.height - floatingGutter - keySize.height,
			width: keySize.width,
			height: keySize.height
		});
	}
	if (dotKeySize && dotKeySize.width > 0) {
		rects.push({
			x: free.width - floatingGutter - dotKeySize.width,
			y: free.height - floatingGutter - dotKeySize.height,
			width: dotKeySize.width,
			height: dotKeySize.height
		});
	}
	return rects;
}

/** Which regions (and sub-regions) hold a Worker whose id is in `ids`; empty without ids. */
export function regionKeysOf(
	nodes: readonly WorkerGraphNode[],
	ids: ReadonlySet<string> | undefined,
	groupingAttribute: WorkerAttributeDefinition | undefined,
	subGroupingAttribute: WorkerAttributeDefinition | undefined
): Set<string> {
	const keys = new Set<string>();
	if (ids === undefined || ids.size === 0) return keys;

	for (const node of nodes) {
		if (!ids.has(node.id)) continue;

		const group = groupValue(node, groupingAttribute);
		keys.add(group);
		if (subGroupingAttribute) {
			keys.add(`${group}::${groupValue(node, subGroupingAttribute)}`);
		}
	}

	return keys;
}

/**
 * One region per group, each holding the regions of its sub-groups, with headings
 * laid out around the names that can stand on the map.
 */
export function labelViewRegions(input: {
	arrangement: ArrangeInput;
	/** The mounted map owns the calculation cache. */
	arranger?: typeof arrange;
	drawn: ReadonlyMap<string, Point>;
	visibleNodes: readonly WorkerGraphNode[];
	radiusFor: (node: WorkerGraphNode) => number;
	labelGap: number;
	isolated: boolean;
	ghostedIds: ReadonlySet<string>;
	composed: boolean;
	textSnapshot: TextSnapshot | undefined;
	/** At the composition's own fit its headings are exactly the ones it reserved. */
	reference: CompositionPacket['headings'] | undefined;
	camera: { zoom: number; panX: number; panY: number };
	/** The free canvas in map-surface pixels, and the surface's own size. */
	free: Rect;
	surface: Size;
	floating: boolean;
	keySize: Size | undefined;
	dotKeySize: Size | undefined;
}) {
	const { camera, surface, floating, keySize, dotKeySize, drawn, radiusFor } = input;
	const { width, height } = surface;
	const { zoom } = camera;
	const free = input.free;
	const room = {
		x: (free.x - camera.panX) / zoom,
		y: (free.y - camera.panY) / zoom,
		width: free.width / zoom,
		height: free.height / zoom
	};
	// The key floats over the bottom-left corner without shrinking the free
	// canvas: the labels step around it instead.
	const keyObstacles =
		floating && keySize && keySize.width > 0
			? [
					{
						x: (-width / 2 + floatingGutter - camera.panX) / zoom,
						y: (height / 2 - floatingGutter - keySize.height - camera.panY) / zoom,
						width: keySize.width / zoom,
						height: keySize.height / zoom
					}
				]
			: [];
	const dotKeyObstacles =
		floating && dotKeySize && dotKeySize.width > 0
			? [
					{
						x: (width / 2 - floatingGutter - dotKeySize.width - camera.panX) / zoom,
						y: (height / 2 - floatingGutter - dotKeySize.height - camera.panY) / zoom,
						width: dotKeySize.width / zoom,
						height: dotKeySize.height / zoom
					}
				]
			: [];
	// Without a composition every possible name is reserved, so hover and selection
	// cannot repack regions. A composition reserved the names that stand at rest
	// itself; headings then only step around the floating key chips.
	const obstacles = input.composed
		? []
		: input.visibleNodes.flatMap((node) => {
				const p = drawn.get(node.id);
				return p
					? [
							{
								x: p.x - node.name.length * 4,
								y: p.y + radiusFor(node) + input.labelGap - 16,
								width: node.name.length * 8,
								height: 20
							}
						]
					: [];
			});
	obstacles.push(...keyObstacles, ...dotKeyObstacles);
	const headingSizes =
		input.composed && input.textSnapshot
			? new Map(
					[...input.textSnapshot.headings].map(([key, size]) => [
						key,
						{
							width: screenFixed(size.width, zoom),
							height: screenFixed(size.height, zoom),
							baseline: size.baseline === undefined ? undefined : screenFixed(size.baseline, zoom)
						}
					])
				)
			: undefined;
	const computed = (input.arranger ?? arrange)({
		...input.arrangement,
		labelView: {
			positions: drawn,
			nodes: input.visibleNodes,
			freeCanvas: room,
			obstacles,
			headingSizes,
			fixedHeadings: input.reference !== undefined,
			priorityIds: input.isolated
				? new Set(
						input.visibleNodes
							.filter((node) => !input.ghostedIds.has(node.id))
							.map((node) => node.id)
					)
				: undefined
		}
	}).regions;
	const { reference } = input;
	if (!reference) return computed;
	const withHeading = <T extends Region>(region: T): T => {
		const heading = reference.get(region.key);
		if (!heading) return region;
		return {
			...region,
			labelAt: heading.labelAt,
			labelBox: {
				x: heading.box.left,
				y: heading.box.top,
				width: heading.box.right - heading.box.left,
				height: heading.box.bottom - heading.box.top
			},
			displayLabel: heading.displayLabel,
			displayCount: heading.displayCount
		};
	};
	return computed.map((region) => ({
		...withHeading(region),
		subRegions: region.subRegions.map(withHeading)
	}));
}

/** The clip path that leaves a hole at every painted dot inside the box around all hit areas. */
export function haloClipPathOf(
	dots: readonly { x: number; y: number; radius: number; hit: number }[]
): string {
	if (!dots.length) return '';
	const left = Math.min(...dots.map((dot) => dot.x - dot.hit));
	const right = Math.max(...dots.map((dot) => dot.x + dot.hit));
	const top = Math.min(...dots.map((dot) => dot.y - dot.hit));
	const bottom = Math.max(...dots.map((dot) => dot.y + dot.hit));
	const holes = dots.map(({ x, y, radius }) => {
		// Include the painted circle's 2-unit stroke in the hole.
		const r = radius + 1;
		return `M ${x - r} ${y} a ${r} ${r} 0 1 0 ${2 * r} 0 a ${r} ${r} 0 1 0 ${-2 * r} 0 Z`;
	});
	return `M ${left} ${top} H ${right} V ${bottom} H ${left} Z ${holes.join(' ')}`;
}

/** Flattened final paths, for names to stand clear of: only the ties, never the leaders. */
export function flattenedRoutes(
	routes: ReadonlyMap<string, { d: string; source: string; target: string }> | undefined,
	scale: number | undefined
): TieSegment[] | undefined {
	if (!routes) return undefined;
	const tolerance = 1 / (scale ?? 1);
	const segments: TieSegment[] = [];
	for (const route of routes.values()) {
		const flat = flattenPath(route.d, tolerance, 64);
		if (!flat) continue;
		for (let i = 1; i < flat.points.length; i += 1) {
			segments.push({
				source: route.source,
				target: route.target,
				ax: flat.points[i - 1].x,
				ay: flat.points[i - 1].y,
				bx: flat.points[i].x,
				by: flat.points[i].y
			});
		}
	}
	return segments;
}

/**
 * The strings the composition reserves room for: the names that stand at rest
 * and the group headings with their counts. Selection, hover and search are
 * not in it.
 */
export function textStringsOf(input: {
	layoutNodes: readonly WorkerGraphNode[];
	restingLabelIds: Iterable<string>;
	composes: boolean;
	groupingAttribute: WorkerAttributeDefinition | undefined;
	subGroupingAttribute: WorkerAttributeDefinition | undefined;
}) {
	const { layoutNodes, groupingAttribute, subGroupingAttribute } = input;
	const byId = new Map(layoutNodes.map((node) => [node.id, node]));
	const names = [...input.restingLabelIds].flatMap((id) => {
		const node = byId.get(id);
		return node ? [{ id, text: mapLabelText(node.name) }] : [];
	});
	const headings =
		input.composes && groupingAttribute
			? buildBucketTree(layoutNodes, groupingAttribute, subGroupingAttribute).flatMap((bucket) => [
					{
						key: regionKey(bucket.value),
						label: bucket.label,
						count: bucket.count,
						child: false
					},
					...bucket.subGroups.map((sub) => ({
						key: subRegionKey(bucket.value, sub.value),
						label: sub.label,
						count: sub.count,
						child: true
					}))
				])
			: [];
	return { names, headings, key: JSON.stringify([names, headings]) };
}
