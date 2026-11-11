/**
 * Where the groups sit and how much room they take: region geometry, frames and
 * the fit that converts reference pixels into map units.
 */
import { groupValue } from '../layout/graph-analysis.ts';
import {
	convexHull,
	layoutGroupRegions,
	regionKey,
	regionsExtent,
	subRegionKey,
	type GroupRegion,
	type Point,
	type Region
} from '../layout/graph-layout.ts';
import {
	boundsOf,
	boxPolygon,
	flattenPath,
	simplifyConvex,
	type Box
} from '../layout/graph-shapes.ts';
import type { TextSize } from '../labels/graph-text-metrics.ts';
import type { ComposerContext, Layout } from './graph-composition-context.ts';
import { sizeOfHeading } from './graph-composition-text.ts';

/**
 * The lowest fit the map framing may take. It only guards degenerate extents, so in
 * practice every map fits its canvas; the camera shares it.
 */
const fitFloor = 0.02;
const fitPadding = 28;
const labelGap = 8;
const regionLabelHeightEstimate = 15;

function fitScale(extent: Box, free: { width: number; height: number }): number {
	const width = Math.max(1e-6, extent.right - extent.left);
	const height = Math.max(1e-6, extent.bottom - extent.top);
	const fit = Math.min(
		(free.width - fitPadding * 2) / width,
		(free.height - fitPadding * 2) / height
	);
	return Math.max(fitFloor, fit);
}

/**
 * The reference fit once the headings are counted. Headings are screen-fixed, so at a
 * small fit they take more map space than the hull extent allows for. When the extent
 * with the headings placed at `scale` still fits the free canvas the scale stands as it
 * is; otherwise the screen pixels the headings reach beyond the hull are taken out of
 * the free canvas and the hull is fitted into what is left, once.
 */
function fitScaleWithHeadings(
	hull: Box,
	headings: readonly Box[],
	scale: number,
	free: { width: number; height: number }
): number {
	if (headings.length === 0) return scale;
	const reach = {
		left: Math.max(0, hull.left - Math.min(...headings.map((box) => box.left))),
		top: Math.max(0, hull.top - Math.min(...headings.map((box) => box.top))),
		right: Math.max(0, Math.max(...headings.map((box) => box.right)) - hull.right),
		bottom: Math.max(0, Math.max(...headings.map((box) => box.bottom)) - hull.bottom)
	};
	const extent = {
		left: hull.left - reach.left,
		top: hull.top - reach.top,
		right: hull.right + reach.right,
		bottom: hull.bottom + reach.bottom
	};
	if (fitScale(extent, free) >= scale) return scale;
	const width = Math.max(1e-6, hull.right - hull.left);
	const height = Math.max(1e-6, hull.bottom - hull.top);
	const fit = Math.min(
		(free.width - fitPadding * 2 - (reach.left + reach.right) * scale) / width,
		(free.height - fitPadding * 2 - (reach.top + reach.bottom) * scale) / height
	);
	return Math.max(fitFloor, Math.min(scale, fit));
}

function keyOf(ctx: ComposerContext, id: string): string {
	return ctx.groupOf.get(id) ?? '';
}

function regionsOf(
	ctx: ComposerContext,
	positions: ReadonlyMap<string, Point>,
	group?: string
): GroupRegion[] {
	return layoutGroupRegions(
		group === undefined ? ctx.buckets : ctx.buckets.filter((bucket) => bucket.value === group),
		ctx.nodes.flatMap((node) => {
			const point = positions.get(node.id);
			if (!point) return [];
			if (group !== undefined && keyOf(ctx, node.id) !== group) return [];
			return [
				{
					...point,
					group: ctx.groupOf.get(node.id) ?? '',
					subGroup: groupValue(node, ctx.subAttribute)
				}
			];
		})
	);
}

function frameOf(
	ctx: ComposerContext,
	positions: ReadonlyMap<string, Point>,
	regions: readonly GroupRegion[]
): Box {
	let widest = 0;
	for (const node of ctx.nodes) widest = Math.max(widest, ctx.params.radiusFor(node.id));
	const margin = widest + labelGap;
	const dots = boundsOf([...positions.values()]);
	const extent = regionsExtent(regions, regionLabelHeightEstimate);
	const left = Math.min(dots.left - margin, extent?.x ?? Infinity);
	const top = Math.min(dots.top - margin, extent?.y ?? Infinity);
	const right = Math.max(dots.right + margin, extent ? extent.x + extent.width : -Infinity);
	const bottom = Math.max(dots.bottom + margin, extent ? extent.y + extent.height : -Infinity);
	return { left, top, right, bottom };
}

export { fitFloor, fitScale, fitScaleWithHeadings, keyOf, regionsOf, frameOf };

/** A body's collision shape: its drawn outline's convex envelope, and the heading box above it. */
export type Body = { key: string; hull: Point[]; heading: Point[] };

export function bodyFromRegion(key: string, region: Region, heading: TextSize, unit: number): Body {
	const hull = outlineProxy(region, unit);
	const bounds = boundsOf(region.hull);
	const bottom = bounds.top - 16;
	const width = heading.width * unit;
	return {
		key,
		hull,
		heading: boxPolygon({
			left: region.labelX - width / 2,
			right: region.labelX + width / 2,
			top: bottom - heading.height * unit,
			bottom
		})
	};
}

/** The outline as a small convex polygon that contains the drawn curve to within 2 reference pixels. */
export function outlineProxy(region: Region, unit: number): Point[] {
	return simplifyConvex(convexHull(polygonOfRegion(region, unit)), 16);
}

function polygonOfRegion(region: Region, unit: number): Point[] {
	const flat = flattenPath(region.path, 2 * unit, 256);
	return flat && flat.points.length >= 3 ? flat.points : region.hull;
}

export function distance(a: Point, b: Point) {
	return Math.hypot(a.x - b.x, a.y - b.y);
}

/** The region keys a Worker sits inside: its group, then its sub-group. */
export function chainOf(ctx: ComposerContext, id: string): string[] {
	const group = keyOf(ctx, id);
	const node = ctx.nodeIndex.get(id)!;
	return ctx.subAttribute
		? [regionKey(group), subRegionKey(group, groupValue(node, ctx.subAttribute))]
		: [regionKey(group)];
}

export function bodyOf(
	ctx: ComposerContext,
	key: string,
	positions: ReadonlyMap<string, Point>
): Body {
	return bodyFromRegion(
		key,
		regionsOf(ctx, positions, key)[0],
		sizeOfHeading(ctx, regionKey(key)),
		ctx.unit0
	);
}

/** All centres move together, members and offsets intact. */
export function movedLayout(
	ctx: ComposerContext,
	centreFor: (key: string, centre: Point) => Point,
	from: Layout = ctx.original
): Layout {
	const layout: Layout = { positions: new Map(from.positions), centres: new Map() };
	for (const key of ctx.keys) {
		const was = from.centres.get(key)!;
		const to = centreFor(key, was);
		layout.centres.set(key, to);
		for (const id of ctx.membersByKey.get(key) ?? []) {
			const p = from.positions.get(id)!;
			layout.positions.set(id, { x: p.x + to.x - was.x, y: p.y + to.y - was.y });
		}
	}
	return layout;
}

export function meanOf(points: readonly Point[]): Point {
	return {
		x: points.reduce((sum, p) => sum + p.x, 0) / Math.max(1, points.length),
		y: points.reduce((sum, p) => sum + p.y, 0) / Math.max(1, points.length)
	};
}

/** The drawn dots of workers without an outlined sub-region, as one convex footprint. */
export function dotOutline(
	ctx: ComposerContext,
	ids: readonly string[],
	positions: ReadonlyMap<string, Point>
): Point[] {
	const samples: Point[] = [];
	for (const id of ids) {
		const p = positions.get(id)!;
		const r = ctx.params.radiusFor(id);
		for (let k = 0; k < 8; k += 1) {
			const angle = (k / 8) * Math.PI * 2;
			samples.push({ x: p.x + Math.cos(angle) * r, y: p.y + Math.sin(angle) * r });
		}
	}
	if (samples.length === 0) return [];
	if (samples.length < 3) return [...samples];
	return simplifyConvex(convexHull(samples), 16);
}
