/**
 * The organizer's manual geometry over an automatic arrangement.
 *
 * Contract: manual moves are pure translations. A group move shifts its members,
 * centre, standing names, headings and internal paths by the same vector; a Worker
 * move shifts only that Worker, its attached name and the ends of its paths. Nothing
 * is searched, collided or re-routed — a path that joins moved ends is bent by a
 * linear blend of the two end shifts, so it stays attached and changes shape
 * smoothly. Overlap or offscreen placement the organizer makes is accepted.
 */
import {
	regionKey,
	subRegionKey,
	type Point,
	type Region,
	type GroupRegion
} from './graph-layout.ts';
import { groupValue } from './graph-analysis.ts';
import type { Arrangement } from './graph-arrangement.ts';
import type { Route } from '../routing/graph-relationship-routing.ts';
import type { NamePlacement, HeadingPlacement } from '../composition/graph-composition-drawing.ts';
import type { WorkerGraphNode } from '../canvas/worker-relationship-map-model.ts';
import type { WorkerAttributeDefinition } from '#lib/domain-vocabulary.ts';

export type ManualGeometry = {
	/** How far each group (by key) has been moved from its automatic place. */
	groupShift: ReadonlyMap<string, Point>;
	/** How far each Worker has been moved from where its group puts it. */
	workerShift: ReadonlyMap<string, Point>;
};

export const noManual: ManualGeometry = { groupShift: new Map(), workerShift: new Map() };

function isManual(manual: ManualGeometry | undefined): manual is ManualGeometry {
	return Boolean(manual && (manual.groupShift.size > 0 || manual.workerShift.size > 0));
}

const zero: Point = { x: 0, y: 0 };

function add(a: Point, b: Point): Point {
	return { x: a.x + b.x, y: a.y + b.y };
}

/** Adds a delta to one entry, dropping it when it returns to nothing. */
export function shifted(
	map: ReadonlyMap<string, Point>,
	key: string,
	delta: Point
): Map<string, Point> {
	const next = new Map(map);
	const sum = add(map.get(key) ?? zero, delta);
	if (sum.x === 0 && sum.y === 0) next.delete(key);
	else next.set(key, sum);
	return next;
}

const tokenPattern = /([A-Za-z])|(-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?)/gi;

/** Rewrites every coordinate pair of an absolute `M`/`L`/`Q` path through `map`. */
export function mapPath(d: string, map: (point: Point) => Point): string {
	const out: string[] = [];
	const pending: number[] = [];
	const flush = () => {
		for (let i = 0; i + 1 < pending.length; i += 2) {
			const p = map({ x: pending[i], y: pending[i + 1] });
			out.push(`${round(p.x)} ${round(p.y)}`);
		}
		pending.length = 0;
	};
	for (const match of d.matchAll(tokenPattern)) {
		if (match[1] !== undefined) {
			flush();
			out.push(match[1]);
		} else pending.push(Number(match[2]));
	}
	flush();
	return out.join(' ');
}

function round(value: number): number {
	return Math.round(value * 1000) / 1000;
}

/** Where along the waypoints a point projects, as a fraction of their length. */
function fractionAlong(waypoints: readonly Point[], at: Point): number {
	let total = 0;
	let best = { distance: Number.POSITIVE_INFINITY, along: 0 };
	for (let i = 1; i < waypoints.length; i += 1) {
		const a = waypoints[i - 1];
		const b = waypoints[i];
		const length = Math.hypot(b.x - a.x, b.y - a.y);
		const t =
			length === 0
				? 0
				: Math.max(
						0,
						Math.min(
							1,
							((at.x - a.x) * (b.x - a.x) + (at.y - a.y) * (b.y - a.y)) / (length * length)
						)
					);
		const distance = Math.hypot(at.x - (a.x + (b.x - a.x) * t), at.y - (a.y + (b.y - a.y) * t));
		if (distance < best.distance) best = { distance, along: total + length * t };
		total += length;
	}
	return total === 0 ? 0 : best.along / total;
}

/** A path with its two ends moved by their own shifts and everything between blended. */
export function shiftRoute(route: Route, from: Point, to: Point): Route {
	if (from.x === to.x && from.y === to.y) {
		if (from.x === 0 && from.y === 0) return route;
		const move = (p: Point) => add(p, from);
		return { ...route, d: mapPath(route.d, move), waypoints: route.waypoints.map(move) };
	}
	const blend = (t: number): Point => ({
		x: from.x + (to.x - from.x) * t,
		y: from.y + (to.y - from.y) * t
	});
	const move = (p: Point) => add(p, blend(fractionAlong(route.waypoints, p)));
	const waypoints = route.waypoints.map(move);
	let length = 0;
	for (let i = 1; i < waypoints.length; i += 1) {
		length += Math.hypot(waypoints[i].x - waypoints[i - 1].x, waypoints[i].y - waypoints[i - 1].y);
	}
	return { ...route, d: mapPath(route.d, move), waypoints, length };
}

function shiftName(name: NamePlacement, by: Point): NamePlacement {
	const { x, y } = by;
	return {
		...name,
		x: name.x + x,
		y: name.y + y,
		box: {
			left: name.box.left + x,
			right: name.box.right + x,
			top: name.box.top + y,
			bottom: name.box.bottom + y
		},
		leader: name.leader && {
			x1: name.leader.x1 + x,
			y1: name.leader.y1 + y,
			x2: name.leader.x2 + x,
			y2: name.leader.y2 + y
		}
	};
}

function shiftHeading(heading: HeadingPlacement, by: Point): HeadingPlacement {
	return {
		...heading,
		labelAt: { ...heading.labelAt, x: heading.labelAt.x + by.x, y: heading.labelAt.y + by.y },
		box: {
			left: heading.box.left + by.x,
			right: heading.box.right + by.x,
			top: heading.box.top + by.y,
			bottom: heading.box.bottom + by.y
		}
	};
}

/**
 * The arrangement with the manual geometry laid over it. Pure, linear in the
 * number of Workers and ties, and independent of any camera.
 */
export function applyManual(
	base: Arrangement,
	manual: ManualGeometry | undefined,
	nodes: readonly WorkerGraphNode[],
	groupingAttribute: WorkerAttributeDefinition | undefined,
	subGroupingAttribute?: WorkerAttributeDefinition | undefined
): Arrangement {
	if (!isManual(manual)) return base;
	const groupOf = new Map(
		nodes.map((node) => [node.id, groupingAttribute ? groupValue(node, groupingAttribute) : ''])
	);
	const shiftOf = (id: string): Point => {
		const group = manual.groupShift.get(groupOf.get(id) ?? '') ?? zero;
		const own = manual.workerShift.get(id) ?? zero;
		return add(group, own);
	};

	const positions = new Map<string, Point>();
	let minX = Number.POSITIVE_INFINITY;
	let minY = Number.POSITIVE_INFINITY;
	let maxX = Number.NEGATIVE_INFINITY;
	let maxY = Number.NEGATIVE_INFINITY;
	for (const [id, point] of base.positions) {
		const p = add(point, shiftOf(id));
		positions.set(id, p);
		minX = Math.min(minX, p.x);
		minY = Math.min(minY, p.y);
		maxX = Math.max(maxX, p.x);
		maxY = Math.max(maxY, p.y);
	}
	const centres = new Map(
		[...base.centres].map(([key, centre]) => [key, add(centre, manual.groupShift.get(key) ?? zero)])
	);
	const shiftRoutes = (routes: ReadonlyMap<string, Route> | undefined) =>
		routes &&
		new Map(
			[...routes].map(([id, route]) => [
				id,
				shiftRoute(route, shiftOf(route.source), shiftOf(route.target))
			])
		);
	const routes = shiftRoutes(base.routes);

	let composition = base.composition;
	if (composition) {
		const headingShift = new Map<string, Point>();
		for (const node of nodes) {
			if (!groupingAttribute) break;
			const group = groupOf.get(node.id) ?? '';
			const shift = manual.groupShift.get(group) ?? zero;
			headingShift.set(regionKey(group), shift);
			if (subGroupingAttribute) {
				headingShift.set(subRegionKey(group, groupValue(node, subGroupingAttribute)), shift);
			}
		}
		const frame = composition.frame;
		const union = {
			left: Math.min(frame.x, minX - 40),
			top: Math.min(frame.y, minY - 40),
			right: Math.max(frame.x + frame.width, maxX + 40),
			bottom: Math.max(frame.y + frame.height, maxY + 40)
		};
		composition = {
			...composition,
			frame: {
				x: union.left,
				y: union.top,
				width: union.right - union.left,
				height: union.bottom - union.top
			},
			routes: shiftRoutes(composition.routes),
			names: new Map(
				[...composition.names].map(([id, name]) => [id, shiftName(name, shiftOf(id))])
			),
			headings: new Map(
				[...composition.headings].map(([key, heading]) => [
					key,
					shiftHeading(heading, headingShift.get(key) ?? zero)
				])
			)
		};
	}

	return {
		...base,
		positions,
		centres,
		min: Number.isFinite(minX) ? { x: minX, y: minY } : base.min,
		max: Number.isFinite(maxX) ? { x: maxX, y: maxY } : base.max,
		routes,
		composition
	};
}

/** Frozen outlines and headings travel with their group; camera changes never place them again. */
export function translateGroupRegions(
	regions: readonly GroupRegion[],
	from: ReadonlyMap<string, Point>,
	to: ReadonlyMap<string, Point>
): GroupRegion[] {
	const deltaByRegion = new Map<string, Point>();
	for (const key of new Set([...from.keys(), ...to.keys()])) {
		const a = from.get(key) ?? zero;
		const b = to.get(key) ?? zero;
		deltaByRegion.set(regionKey(key), { x: b.x - a.x, y: b.y - a.y });
	}
	const translate = (region: Region, delta: Point): Region => ({
		...region,
		hull: region.hull.map((p) => add(p, delta)),
		path: mapPath(region.path, (p) => add(p, delta)),
		top: region.top + delta.y,
		labelX: region.labelX + delta.x,
		labelAt: { ...region.labelAt, x: region.labelAt.x + delta.x, y: region.labelAt.y + delta.y },
		labelBox: region.labelBox && {
			...region.labelBox,
			x: region.labelBox.x + delta.x,
			y: region.labelBox.y + delta.y
		}
	});
	return regions.map((region) => {
		const delta = deltaByRegion.get(region.key) ?? zero;
		if (delta.x === 0 && delta.y === 0) return region;
		return {
			...translate(region, delta),
			subRegions: region.subRegions.map((child) => translate(child, delta))
		};
	});
}
