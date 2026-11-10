/**
 * Individual Relationship paths over fixed positions. A tie stays the direct
 * segment between its two dots unless something unrelated is in the way: an
 * unrelated dot, a reserved name or heading, or an unrelated region. A blocked
 * tie takes a restrained detour around the first obstacle it meets (at most
 * three encounters, two sides each), with softened corners, and the final
 * rounded curve is validated against the real shapes before it is accepted.
 *
 * Pure and bounded: obstacles are indexed on a uniform grid, every loop is
 * charged to the shared routing allowance, and nothing here changes a
 * position.
 *
 * After routing, long near-parallel ties that share a corridor may move into
 * parallel lanes 6 reference px apart that join and diverge near their own dots, and detours round one obstacle ride in lanes the same distance apart
 * (see graph-relationship-tracks.ts). Each tie stays its own line: pairs are
 * never merged or aggregated.
 */
import type { Point } from './graph-layout.ts';
import {
	boundsOf,
	discPolygon,
	pointSegmentDistance,
	epsilon,
	flattenPath,
	inflateBox,
	inflateConvex,
	boxPolygon,
	pointInPolygon,
	roundedPath,
	segmentConvexInterval,
	type Box
} from './graph-shapes.ts';
import { convexHull } from './graph-layout.ts';
import { createWorkBudget, type WorkBudget } from './graph-work-budget.ts';
import { evaluateDrawing } from './graph-layout-quality.ts';
import { applyTracks, type TrackMetrics } from './graph-relationship-tracks.ts';
import { trackSettings } from './graph-track-corridors.ts';

export type RouteObstacleSpec =
	| { id: string; kind: 'dot'; worker: string; x: number; y: number; r: number }
	| { id: string; kind: 'name' | 'heading'; worker?: string; box: Box }
	| { id: string; kind: 'region'; region: string; polygon: readonly Point[] };

export type RouteRequest = { id: string; source: string; target: string };

export type Route = {
	id: string;
	source: string;
	target: string;
	/** The SVG path: `M…L…` when direct, with `Q` rounded corners when detoured. */
	d: string;
	/** The waypoints the path passes through, endpoints included. */
	waypoints: Point[];
	/** Polyline length of the waypoints, in map units. */
	length: number;
	direct: boolean;
	/** Obstacle ids that still block this pair; empty for a clear route. */
	blockers: string[];
	/** Why no restrained detour was found, for a pair that kept its direct segment. */
	failure?: string;
	/** Set when this tie rides a parallel track: the bundle it belongs to (its first member's id) and its lane (0 = lowest lateral position). */
	track?: { bundle: string; lane: number };
};

export type RoutedSet = {
	routes: Map<string, Route>;
	unresolved: string[];
	/**
	 * The same routes with long near-parallel ties moved into parallel lanes (see
	 * graph-relationship-tracks.ts). Run on the drawing that is published, not on every
	 * candidate: it has its own fixed allowance, so it can never starve the composer's
	 * shared routing allowance. Returns `routes` itself when nothing is tracked.
	 */
	tidy: (limit?: number) => Map<string, Route>;
};

export type RouterSettings = {
	/** Map units per reference CSS pixel (the inverse of the frozen reference fit). */
	unit: number;
	/** Half the drawn stroke width in reference pixels. */
	strokeHalfPx?: number;
};

const defaultStrokeHalfPx = 1;
const clearancePx = { dot: 4, name: 8, heading: 8, region: 4 } as const;
const wrapSlackPx = 0.1;
/** Detours round the same obstacle ride side by side, as far apart as tracks (two strokes and a visible gap), so they never share a run. */
const laneStepPx = trackSettings.trackStepPx;
const maxLanes = 3;
const roundingPx = 8;
const detourRatio = 1.5;
const detourExtraPx = 16;
const maxEncounters = 3;
const cellPx = 64;
const flattenTolerancePx = 0.5;
const maxFlattenSegments = 64;
/** The fixed routing allowance one tidy pass may spend, separate from the composer's shared allowance. */
const trackWorkLimit = 100_000;

type Prepared = {
	spec: RouteObstacleSpec;
	/** Hit-test polygon: the shape grown by the clearance. */
	test: Point[];
	/** Where a detour walks: just outside `test`, so arcs never count as entering it. */
	wrap: Point[];
	/** The real shape grown only by stroke and flattening uncertainty: final validation. */
	valid: Point[];
	bounds: Box;
	/** A circle around the wrap polygon: one cheap test before any polygon work. */
	centre: Point;
	reach: number;
	/** The wrap polygon pushed `extra` further out: a later detour on its own lane. */
	widen: (extra: number) => Point[];
};

function prepare(spec: RouteObstacleSpec, unit: number, strokeHalf: number): Prepared {
	const kind = spec.kind;
	const clearance = clearancePx[kind] * unit + strokeHalf;
	const validMargin = strokeHalf + flattenTolerancePx * unit;
	const grow = (margin: number): Point[] => {
		if (spec.kind === 'dot') return discPolygon({ x: spec.x, y: spec.y }, spec.r + margin, 12);
		if (spec.kind === 'region') {
			const hull = convexHull(spec.polygon);
			return inflateConvex(hull.length >= 3 ? hull : [...spec.polygon], margin);
		}
		return boxPolygon(inflateBox(spec.box, margin));
	};
	const test = grow(clearance);
	const wrap = grow(clearance + wrapSlackPx * unit);
	const bounds = boundsOf(wrap);
	const centre = { x: (bounds.left + bounds.right) / 2, y: (bounds.top + bounds.bottom) / 2 };
	const reach = wrap.reduce(
		(far, p) => Math.max(far, Math.hypot(p.x - centre.x, p.y - centre.y)),
		0
	);
	return {
		spec,
		test,
		wrap,
		valid: grow(validMargin),
		bounds,
		centre,
		reach,
		widen: (extra) => grow(clearance + wrapSlackPx * unit + extra)
	};
}

type Grid = { cell: number; cells: Map<string, number[]> };

function cellRange(grid: Grid, box: Box) {
	return {
		x0: Math.floor(box.left / grid.cell),
		x1: Math.floor(box.right / grid.cell),
		y0: Math.floor(box.top / grid.cell),
		y1: Math.floor(box.bottom / grid.cell)
	};
}

/** The prepared obstacles, indexed for queries along a segment. */
export type ObstacleIndex = {
	prepared: Prepared[];
	grid: Grid;
	unit: number;
	strokeHalf: number;
	/** How many detours already wrap each obstacle side: the next one takes the next lane out. */
	lanes: Map<string, number>;
};

export function buildObstacleIndex(
	obstacles: readonly RouteObstacleSpec[],
	settings: RouterSettings,
	budget: WorkBudget
): ObstacleIndex {
	const unit = settings.unit;
	const strokeHalf = (settings.strokeHalfPx ?? defaultStrokeHalfPx) * unit;
	const prepared = obstacles.map((spec) => prepare(spec, unit, strokeHalf));
	const grid: Grid = { cell: cellPx * unit, cells: new Map() };
	// Linear in the represented data: one entry per overlapped cell.
	budget.spend('routing', prepared.length * 4);
	prepared.forEach((item, index) => {
		const { x0, x1, y0, y1 } = cellRange(grid, item.bounds);
		budget.spend('routing', (x1 - x0 + 1) * (y1 - y0 + 1));
		for (let x = x0; x <= x1; x += 1) {
			for (let y = y0; y <= y1; y += 1) {
				const key = `${x},${y}`;
				const list = grid.cells.get(key);
				if (list) list.push(index);
				else grid.cells.set(key, [index]);
			}
		}
	});
	return { prepared, grid, unit, strokeHalf, lanes: new Map() };
}

/** The obstacle indices whose cells the segment passes through, in stable order. */
function nearbyAlong(index: ObstacleIndex, a: Point, b: Point, budget: WorkBudget): number[] {
	const cell = index.grid.cell;
	let cx = Math.floor(a.x / cell);
	let cy = Math.floor(a.y / cell);
	const endX = Math.floor(b.x / cell);
	const endY = Math.floor(b.y / cell);
	const dx = b.x - a.x;
	const dy = b.y - a.y;
	const stepX = dx > 0 ? 1 : -1;
	const stepY = dy > 0 ? 1 : -1;
	const nextX = dx === 0 ? Infinity : ((stepX > 0 ? cx + 1 : cx) * cell - a.x) / dx;
	const nextY = dy === 0 ? Infinity : ((stepY > 0 ? cy + 1 : cy) * cell - a.y) / dy;
	const deltaX = dx === 0 ? Infinity : (stepX * cell) / dx;
	const deltaY = dy === 0 ? Infinity : (stepY * cell) / dy;
	let tx = nextX;
	let ty = nextY;
	const found = new Set<number>();
	let visited = 0;
	// Amanatides-Woo: every cell the segment crosses, and no others.
	const limit = Math.abs(endX - cx) + Math.abs(endY - cy) + 1;
	for (let step = 0; step < limit; step += 1) {
		visited += 1;
		for (const i of index.grid.cells.get(`${cx},${cy}`) ?? []) found.add(i);
		if (tx < ty) {
			tx += deltaX;
			cx += stepX;
		} else {
			ty += deltaY;
			cy += stepY;
		}
	}
	budget.spend('routing', visited + found.size);
	return [...found].sort((p, q) => p - q);
}

function distance(a: Point, b: Point): number {
	return Math.hypot(a.x - b.x, a.y - b.y);
}

function polylineLength(points: readonly Point[]): number {
	let sum = 0;
	for (let i = 1; i < points.length; i += 1) sum += distance(points[i - 1], points[i]);
	return sum;
}

type Context = {
	index: ObstacleIndex;
	budget: WorkBudget;
	source: string;
	target: string;
	/** Regions the pair may traverse: its endpoints' own. */
	regions: ReadonlySet<string>;
	a: Point;
	b: Point;
	/** Obstacles whose clearance polygon an endpoint already sits inside, shrunk for this pair. */
	adapted: Map<number, { test: Point[]; wrap: Point[] }>;
};

function exempt(item: Prepared, context: Context): boolean {
	const spec = item.spec;
	if (spec.kind === 'region') return context.regions.has(spec.region);
	return spec.worker === context.source || spec.worker === context.target;
}

function polygonsFor(index: number, context: Context) {
	const item = context.index.prepared[index];
	return context.adapted.get(index) ?? item;
}

/** Shrinks the clearance of an obstacle an endpoint already sits in, so the pair can still leave. */
function adaptObstacles(context: Context) {
	const { index, a, b } = context;
	const unit = index.unit;
	for (const endpoint of [a, b]) {
		for (const i of nearbyAlong(index, endpoint, endpoint, context.budget)) {
			const item = index.prepared[i];
			if (exempt(item, context) || context.adapted.has(i)) continue;
			if (distance(endpoint, item.centre) > item.reach) continue;
			context.budget.spend('routing', item.test.length);
			if (!pointInPolygon(endpoint, item.test)) continue;
			const spec = item.spec;
			if (spec.kind === 'region') continue;
			let free: number;
			if (spec.kind === 'dot') free = distance(endpoint, spec) - spec.r;
			else {
				const box = spec.box;
				const dx = Math.max(box.left - endpoint.x, 0, endpoint.x - box.right);
				const dy = Math.max(box.top - endpoint.y, 0, endpoint.y - box.bottom);
				free = Math.hypot(dx, dy);
			}
			if (free <= index.strokeHalf) continue;
			const margin = Math.max(0, free - 0.5 * unit);
			context.adapted.set(
				i,
				spec.kind === 'dot'
					? {
							test: discPolygon(spec, spec.r + margin),
							wrap: discPolygon(spec, spec.r + margin + wrapSlackPx * unit)
						}
					: {
							test: boxPolygon(inflateBox(spec.box, margin)),
							wrap: boxPolygon(inflateBox(spec.box, margin + wrapSlackPx * unit))
						}
			);
		}
	}
}

type Hit = { t: number; index: number };

/** The first obstacle a segment enters, by parameter; ties break on obstacle order. */
function firstHit(
	a: Point,
	b: Point,
	context: Context,
	skip?: ReadonlySet<number>
): Hit | undefined {
	const candidates = nearbyAlong(context.index, a, b, context.budget);
	let best: Hit | undefined;
	for (const i of candidates) {
		if (skip?.has(i)) continue;
		const item = context.index.prepared[i];
		if (exempt(item, context)) continue;
		context.budget.spend('routing', 1);
		if (pointSegmentDistance(item.centre, a, b) > item.reach) continue;
		const polygon = polygonsFor(i, context).test;
		context.budget.spend('routing', polygon.length);
		const interval = segmentConvexInterval(a, b, polygon);
		if (!interval) continue;
		if (!best || interval[0] < best.t - epsilon) best = { t: interval[0], index: i };
	}
	return best;
}

function clear(a: Point, b: Point, context: Context): boolean {
	return !firstHit(a, b, context);
}

/** The vertices of a convex polygon on one side of the chord, in walking order from `a` toward `b`. */
function arcAround(
	polygon: readonly Point[],
	a: Point,
	b: Point,
	side: 1 | -1
): Point[] | undefined {
	const n = polygon.length;
	const chord = { x: b.x - a.x, y: b.y - a.y };
	const sideOf = polygon.map((p) => side * (chord.x * (p.y - a.y) - chord.y * (p.x - a.x)));
	const onSide = sideOf.map((s) => s > epsilon);
	if (!onSide.some(Boolean) || onSide.every(Boolean)) return undefined;
	// The contiguous run of vertices on this side.
	let first = -1;
	for (let i = 0; i < n; i += 1) {
		if (onSide[i] && !onSide[(i + n - 1) % n]) first = i;
	}
	if (first < 0) return undefined;
	const run: number[] = [];
	for (let k = 0; k < n && onSide[(first + k) % n]; k += 1) run.push((first + k) % n);
	// The edges leaving the run cross the chord line; the one nearer `a` starts the walk.
	const along = (outside: number, inside: number) => {
		const s0 = sideOf[outside];
		const s1 = sideOf[inside];
		const t = s0 / (s0 - s1 || 1);
		const p = {
			x: polygon[outside].x + (polygon[inside].x - polygon[outside].x) * t,
			y: polygon[outside].y + (polygon[inside].y - polygon[outside].y) * t
		};
		return ((p.x - a.x) * chord.x + (p.y - a.y) * chord.y) / (chord.x ** 2 + chord.y ** 2 || 1);
	};
	const entryAt = along((run[0] + n - 1) % n, run[0]);
	const exitAt = along((run[run.length - 1] + 1) % n, run[run.length - 1]);
	const ordered = entryAt <= exitAt ? run : [...run].reverse();
	return ordered.map((i) => polygon[i]);
}

/**
 * The single point where the tangent from `a` and the tangent from `b` to a convex
 * obstacle meet on one side of it. A path through it clears the whole shape with one
 * corner, where hugging the polygon's own vertices would wobble.
 */
function tangentCorner(
	polygon: readonly Point[],
	a: Point,
	b: Point,
	side: 1 | -1
): Point | undefined {
	const chord = { x: b.x - a.x, y: b.y - a.y };
	const widest = (from: Point, toward: Point) => {
		const along = { x: toward.x - from.x, y: toward.y - from.y };
		let best: Point | undefined;
		let bestAngle = -Infinity;
		for (const v of polygon) {
			const rx = v.x - from.x;
			const ry = v.y - from.y;
			// Lateral offset toward the chosen side, against how far ahead the vertex lies.
			const angle = Math.atan2(side * (chord.x * ry - chord.y * rx), along.x * rx + along.y * ry);
			if (angle > bestAngle) {
				bestAngle = angle;
				best = v;
			}
		}
		return best;
	};
	const ta = widest(a, b);
	const tb = widest(b, a);
	if (!ta || !tb) return undefined;
	const d1 = { x: ta.x - a.x, y: ta.y - a.y };
	const d2 = { x: tb.x - b.x, y: tb.y - b.y };
	const denominator = d1.x * d2.y - d1.y * d2.x;
	if (Math.abs(denominator) < epsilon) return undefined;
	const t = ((b.x - a.x) * d2.y - (b.y - a.y) * d2.x) / denominator;
	const u = ((b.x - a.x) * d1.y - (b.y - a.y) * d1.x) / denominator;
	// Both tangents must run on past the vertices they touch before they meet.
	if (t < 1 - 1e-9 || u < 1 - 1e-9) return undefined;
	return { x: a.x + t * d1.x, y: a.y + t * d1.y };
}

type Plan = { points: Point[]; wraps: string[] };

/** Waypoints from `a` to `b`, endpoints included, resolving at most `depth` obstacle encounters. */
function plan(
	a: Point,
	b: Point,
	context: Context,
	depth: number,
	wrapped: ReadonlySet<number>
): Plan | undefined {
	const hit = firstHit(a, b, context, wrapped);
	if (!hit) return { points: [a, b], wraps: [] };
	if (depth === 0) return undefined;
	const used = new Set(wrapped).add(hit.index);
	let best: (Plan & { length: number }) | undefined;
	for (const side of [1, -1] as const) {
		const token = `${hit.index}:${side}`;
		const lane = Math.min(context.index.lanes.get(token) ?? 0, maxLanes);
		const adapted = context.adapted.get(hit.index);
		const polygon =
			lane > 0 && !adapted
				? context.index.prepared[hit.index].widen(lane * laneStepPx * context.index.unit)
				: polygonsFor(hit.index, context).wrap;
		const hugging = arcAround(polygon, a, b, side);
		if (!hugging) continue;
		// One clean corner when it costs little more than hugging the outline.
		const corner = tangentCorner(polygon, a, b, side);
		const arcLength = polylineLength([a, ...hugging, b]);
		const cornerLength = corner ? distance(a, corner) + distance(corner, b) : Infinity;
		const arc =
			corner && cornerLength <= arcLength * 1.15 + 3 * context.index.unit ? [corner] : hugging;
		const head = plan(a, arc[0], context, depth - 1, used);
		const tail = plan(arc[arc.length - 1], b, context, depth - 1, used);
		if (!head || !tail) continue;
		const joined =
			arc.length > 1
				? [...head.points, ...arc.slice(1, -1), ...tail.points]
				: [...head.points, ...tail.points.slice(1)];
		const points = simplify(joined, context);
		const length = polylineLength(points);
		if (!best || length < best.length - 1e-6) {
			best = { points, length, wraps: [...head.wraps, token, ...tail.wraps] };
		}
	}
	return best;
}

/** Drops waypoints a straight, clear leg can skip. */
function simplify(points: readonly Point[], context: Context): Point[] {
	if (points.length <= 2) return [...points];
	const out = [points[0]];
	let i = 0;
	while (i < points.length - 1) {
		let j = points.length - 1;
		while (j > i + 1 && !clear(points[i], points[j], context)) j -= 1;
		out.push(points[j]);
		i = j;
	}
	return out;
}

/** Whether the flattened curve stays clear of every obstacle's validation shape. */
function validates(d: string, context: Context): boolean {
	const flat = flattenPath(d, flattenTolerancePx * context.index.unit, maxFlattenSegments);
	if (!flat || !flat.certified) return false;
	const points = flat.points;
	context.budget.spend('routing', points.length * 2);
	for (let i = 1; i < points.length; i += 1) {
		const a = points[i - 1];
		const b = points[i];
		for (const index of nearbyAlong(context.index, a, b, context.budget)) {
			const item = context.index.prepared[index];
			if (exempt(item, context)) continue;
			context.budget.spend('routing', 1);
			if (pointSegmentDistance(item.centre, a, b) > item.reach + context.index.unit) continue;
			const polygon = context.adapted.has(index) ? shrinkValid(item, context) : item.valid;
			context.budget.spend('routing', polygon.length);
			if (segmentConvexInterval(a, b, polygon)) return false;
		}
	}
	return true;
}

/**
 * Whether every flattened piece of the curve keeps the planning clearance a direct tie
 * keeps from each unrelated obstacle, except within reach of the tie's own `corners`.
 * A detoured tie's corner sits at that clearance by construction (and its rounding cuts
 * inside it); the router already validated that corner, so a track is not held to it.
 */
function keepsClearance(d: string, context: Context, corners: readonly Point[]): boolean {
	const flat = flattenPath(d, flattenTolerancePx * context.index.unit, maxFlattenSegments);
	if (!flat || !flat.certified) return false;
	const points = flat.points;
	const exempt = 2 * roundingPx * context.index.unit;
	const atCorner = (p: Point) => corners.some((corner) => distance(p, corner) <= exempt);
	for (let i = 1; i < points.length; i += 1) {
		if (atCorner(points[i - 1]) && atCorner(points[i])) continue;
		if (!clear(points[i - 1], points[i], context)) return false;
	}
	return true;
}

/** A pair whose endpoint sits near a dot or name is validated against that real shape only. */
function shrinkValid(item: Prepared, context: Context): Point[] {
	const spec = item.spec;
	const margin = context.index.strokeHalf;
	if (spec.kind === 'dot') return discPolygon(spec, spec.r + margin);
	if (spec.kind === 'region') return item.valid;
	return boxPolygon(inflateBox(spec.box, margin));
}

/** The straight pair, drawn when nothing clears; its blockers stay on record. */
function direct(
	request: RouteRequest,
	a: Point,
	b: Point,
	blockers: string[],
	failure?: string
): Route {
	return {
		id: request.id,
		source: request.source,
		target: request.target,
		d: `M ${Math.round(a.x * 100) / 100} ${Math.round(a.y * 100) / 100} L ${Math.round(b.x * 100) / 100} ${Math.round(b.y * 100) / 100}`,
		waypoints: [a, b],
		length: distance(a, b),
		direct: true,
		blockers,
		failure
	};
}

/**
 * Routes every request over fixed positions. `endpointRegions` names the
 * regions each Worker's ties may traverse (its own enclosing regions); every
 * other region, every other Worker's dot and every reserved box is an obstacle.
 */
export function routeRelationships(input: {
	requests: readonly RouteRequest[];
	positions: ReadonlyMap<string, Point>;
	index: ObstacleIndex;
	endpointRegions: ReadonlyMap<string, readonly string[]>;
	budget: WorkBudget;
}): RoutedSet {
	const { index, budget } = input;
	const routes = new Map<string, Route>();
	const unresolved: string[] = [];
	const ordered = [...input.requests].sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
	const contextFor = (request: RouteRequest, work: WorkBudget): Context | undefined => {
		const a = input.positions.get(request.source);
		const b = input.positions.get(request.target);
		if (!a || !b) return undefined;
		return {
			index,
			budget: work,
			source: request.source,
			target: request.target,
			regions: new Set([
				...(input.endpointRegions.get(request.source) ?? []),
				...(input.endpointRegions.get(request.target) ?? [])
			]),
			a,
			b,
			adapted: new Map()
		};
	};
	for (const request of ordered) {
		const context = contextFor(request, budget);
		if (!context) continue;
		const { a, b } = context;
		adaptObstacles(context);
		const blocked = firstHit(a, b, context);
		if (!blocked) {
			routes.set(request.id, direct(request, a, b, []));
			continue;
		}
		const unit = index.unit;
		const limit = detourRatio * distance(a, b) + detourExtraPx * unit;
		const planned = plan(a, b, context, maxEncounters, new Set());
		const waypoints = planned?.points;
		let route: Route | undefined;
		let failure = 'no detour within three obstacle encounters';
		if (waypoints) {
			const length = polylineLength(waypoints);
			failure = `detour ${length.toFixed(0)} over budget ${limit.toFixed(0)}`;
			if (length <= limit) {
				failure = 'rounded corner enters an obstacle';
				// Full rounding, then half; a corner that cannot be smoothed clear stays a sharp, validated one.
				for (const rounding of [roundingPx * unit, (roundingPx * unit) / 2, 0]) {
					const d = roundedPath(waypoints, rounding);
					if (validates(d, context)) {
						route = {
							id: request.id,
							source: request.source,
							target: request.target,
							d,
							waypoints,
							length,
							direct: false,
							blockers: []
						};
						for (const token of new Set(planned.wraps)) {
							index.lanes.set(token, (index.lanes.get(token) ?? 0) + 1);
						}
						break;
					}
				}
			}
		}
		if (!route) {
			unresolved.push(request.id);
			route = direct(request, a, b, [index.prepared[blocked.index].spec.id], failure);
		}
		routes.set(request.id, route);
	}

	const tidy = (limit = trackWorkLimit): Map<string, Route> => {
		const child = createWorkBudget({ placement: 0, routing: limit, evaluation: 0 });
		const requestById = new Map(input.requests.map((request) => [request.id, request]));
		const validate = (id: string, d: string, corners: readonly Point[]): boolean => {
			const request = requestById.get(id);
			if (!request) return false;
			const context = contextFor(request, child);
			if (!context) return false;
			adaptObstacles(context);
			return validates(d, context) && keepsClearance(d, context, corners);
		};
		const dotSpecs = index.prepared.flatMap(({ spec }) =>
			spec.kind === 'dot' ? [{ id: spec.worker, x: spec.x, y: spec.y, r: spec.r }] : []
		);
		const nameSpecs = index.prepared.flatMap(({ spec }) =>
			spec.kind === 'name' ? [{ id: spec.id, worker: spec.worker, box: spec.box }] : []
		);
		const headingSpecs = index.prepared.flatMap(({ spec }) =>
			spec.kind === 'heading' ? [{ id: spec.id, box: spec.box }] : []
		);
		const regionSpecs = index.prepared.flatMap(({ spec }) =>
			spec.kind === 'region' ? [{ key: spec.region, polygon: spec.polygon, outlined: true }] : []
		);
		// Evaluation is charged to the same capped track allowance as the tracks themselves.
		const trackBudget: WorkBudget = {
			used: child.used,
			limits: child.limits,
			remaining: (kind) => child.remaining(kind),
			spend: (_kind, amount) => child.spend('routing', amount)
		};
		const measure = (measured: ReadonlyMap<string, Route>): TrackMetrics => {
			const evaluation = evaluateDrawing({
				routes: [...measured.values()].map(({ id, source, target, d }) => ({
					id,
					source,
					target,
					d
				})),
				dots: dotSpecs,
				names: nameSpecs,
				headings: headingSpecs,
				regions: regionSpecs,
				workerRegions: input.endpointRegions,
				unit: index.unit,
				strokeHalfPx: index.strokeHalf / index.unit,
				skipLayoutConflicts: true,
				budget: trackBudget
			});
			return {
				properCrossings: evaluation.properCrossings,
				shallowCrossings: evaluation.shallowCrossings,
				conflicts: new Set([
					...evaluation.dotConflicts,
					...evaluation.nameConflicts,
					...evaluation.headingConflicts,
					...evaluation.regionConflicts
				]),
				invalidRoutes: new Set(evaluation.invalidRoutes),
				lengths: evaluation.routeLengths
			};
		};
		return applyTracks({ routes, unit: index.unit, budget: child, validate, measure });
	};
	return { routes, unresolved, tidy };
}
