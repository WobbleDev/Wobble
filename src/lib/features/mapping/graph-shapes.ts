/**
 * Geometry shared by composition, routing and evaluation: sampling the drawn
 * outlines, and signed intersection / containment / separation tests between
 * the shapes the map actually draws. Pure and numeric. Operations that loop
 * over shape edges take an optional work budget and reserve their loop first.
 */
import type { Point } from './graph-layout.ts';
import type { WorkBudget, WorkKind } from './graph-work-budget.ts';

export type Box = { left: number; top: number; right: number; bottom: number };

export const epsilon = 1e-9;

export function boxPolygon(box: Box): Point[] {
	return [
		{ x: box.left, y: box.top },
		{ x: box.right, y: box.top },
		{ x: box.right, y: box.bottom },
		{ x: box.left, y: box.bottom }
	];
}

export function boundsOf(points: readonly Point[]): Box {
	let left = Infinity;
	let top = Infinity;
	let right = -Infinity;
	let bottom = -Infinity;
	for (const { x, y } of points) {
		left = Math.min(left, x);
		top = Math.min(top, y);
		right = Math.max(right, x);
		bottom = Math.max(bottom, y);
	}
	return { left, top, right, bottom };
}

export function inflateBox(box: Box, margin: number): Box {
	return {
		left: box.left - margin,
		top: box.top - margin,
		right: box.right + margin,
		bottom: box.bottom + margin
	};
}

export function boxesOverlap(a: Box, b: Box): boolean {
	return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

export function translatePolygon(points: readonly Point[], dx: number, dy: number): Point[] {
	return points.map((p) => ({ x: p.x + dx, y: p.y + dy }));
}

export function rotatePolygon(points: readonly Point[], origin: Point, angle: number): Point[] {
	const cos = Math.cos(angle);
	const sin = Math.sin(angle);
	return points.map((p) => {
		const dx = p.x - origin.x;
		const dy = p.y - origin.y;
		return { x: origin.x + dx * cos - dy * sin, y: origin.y + dx * sin + dy * cos };
	});
}

function spend(budget: WorkBudget | undefined, kind: WorkKind, amount: number) {
	budget?.spend(kind, amount);
}

// ---------------------------------------------------------------------------
// Path sampling

export type Flattened = { points: Point[]; certified: boolean; segments: number };

const numberPattern = /[MLCQZmlcqzAa]|-?\d*\.?\d+(?:e[-+]?\d+)?/gi;

/**
 * Flattens an absolute SVG path (M, L, C, Q, Z) into a polyline whose
 * deviation from the curve is at most `tolerance`. `certified` is false when
 * that needs more than `maxSegments` pieces in total; callers reject such a
 * path rather than trust a coarser one. Returns undefined for commands it does
 * not understand.
 */
export function flattenPath(
	d: string,
	tolerance: number,
	maxSegments: number
): Flattened | undefined {
	const tokens = d.match(numberPattern);
	if (!tokens) return undefined;
	const points: Point[] = [];
	let segments = 0;
	let current: Point = { x: 0, y: 0 };
	let start: Point = { x: 0, y: 0 };
	let index = 0;
	const next = () => Number(tokens[index++]);
	let command = '';
	while (index < tokens.length) {
		if (/^[A-Za-z]$/.test(tokens[index])) command = tokens[index++];
		if (command === 'Z') {
			if (points.length > 0 && (current.x !== start.x || current.y !== start.y)) {
				points.push({ ...start });
				segments += 1;
			}
			current = start;
			continue;
		}
		if (command === 'M') {
			current = { x: next(), y: next() };
			start = current;
			points.push({ ...current });
			// Further pairs after an M are implicit lines.
			command = 'L';
		} else if (command === 'L') {
			current = { x: next(), y: next() };
			points.push({ ...current });
			segments += 1;
		} else if (command === 'Q') {
			const c = { x: next(), y: next() };
			const end = { x: next(), y: next() };
			const deviation = Math.hypot(current.x - 2 * c.x + end.x, current.y - 2 * c.y + end.y);
			const n = Math.max(1, Math.ceil(Math.sqrt(deviation / (4 * tolerance))));
			for (let step = 1; step <= n; step += 1) {
				const t = step / n;
				const u = 1 - t;
				points.push({
					x: u * u * current.x + 2 * u * t * c.x + t * t * end.x,
					y: u * u * current.y + 2 * u * t * c.y + t * t * end.y
				});
			}
			segments += n;
			current = end;
		} else if (command === 'C') {
			const c1 = { x: next(), y: next() };
			const c2 = { x: next(), y: next() };
			const end = { x: next(), y: next() };
			const deviation = Math.max(
				Math.hypot(current.x - 2 * c1.x + c2.x, current.y - 2 * c1.y + c2.y),
				Math.hypot(c1.x - 2 * c2.x + end.x, c1.y - 2 * c2.y + end.y)
			);
			const n = Math.max(1, Math.ceil(Math.sqrt((0.75 * deviation) / tolerance)));
			for (let step = 1; step <= n; step += 1) {
				const t = step / n;
				const u = 1 - t;
				points.push({
					x:
						u * u * u * current.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * end.x,
					y: u * u * u * current.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * end.y
				});
			}
			segments += n;
			current = end;
		} else {
			return undefined;
		}
	}
	return { points, certified: segments <= maxSegments, segments };
}

// ---------------------------------------------------------------------------
// Points, segments

export function pointSegmentDistance(p: Point, a: Point, b: Point): number {
	const dx = b.x - a.x;
	const dy = b.y - a.y;
	const lengthSquared = dx * dx + dy * dy;
	const t = lengthSquared
		? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSquared))
		: 0;
	return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

function cross(o: Point, a: Point, b: Point): number {
	return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
}

/** Whether two segments cross at a point interior to both. */
export function segmentsProperlyIntersect(a: Point, b: Point, c: Point, d: Point): boolean {
	const abc = cross(a, b, c);
	const abd = cross(a, b, d);
	const cda = cross(c, d, a);
	const cdb = cross(c, d, b);
	return (
		((abc > epsilon && abd < -epsilon) || (abc < -epsilon && abd > epsilon)) &&
		((cda > epsilon && cdb < -epsilon) || (cda < -epsilon && cdb > epsilon))
	);
}

/** The closest pair of points on two non-intersecting segments. */
function closestPoints(a: Point, b: Point, c: Point, d: Point): { p: Point; q: Point } {
	const project = (point: Point, from: Point, to: Point): Point => {
		const dx = to.x - from.x;
		const dy = to.y - from.y;
		const lengthSquared = dx * dx + dy * dy;
		const t = lengthSquared
			? Math.max(
					0,
					Math.min(1, ((point.x - from.x) * dx + (point.y - from.y) * dy) / lengthSquared)
				)
			: 0;
		return { x: from.x + t * dx, y: from.y + t * dy };
	};
	const options = [
		{ p: a, q: project(a, c, d) },
		{ p: b, q: project(b, c, d) },
		{ p: project(c, a, b), q: c },
		{ p: project(d, a, b), q: d }
	];
	let best = options[0];
	let bestDistance = Math.hypot(best.p.x - best.q.x, best.p.y - best.q.y);
	for (const option of options.slice(1)) {
		const distance = Math.hypot(option.p.x - option.q.x, option.p.y - option.q.y);
		if (distance < bestDistance) {
			best = option;
			bestDistance = distance;
		}
	}
	return best;
}

function segmentSegmentDistance(a: Point, b: Point, c: Point, d: Point): number {
	if (segmentsProperlyIntersect(a, b, c, d)) return 0;
	const { p, q } = closestPoints(a, b, c, d);
	return Math.hypot(p.x - q.x, p.y - q.y);
}

// ---------------------------------------------------------------------------
// Polygons

function signedArea(points: readonly Point[]): number {
	let sum = 0;
	for (let i = 0; i < points.length; i += 1) {
		const a = points[i];
		const b = points[(i + 1) % points.length];
		sum += a.x * b.y - b.x * a.y;
	}
	return sum / 2;
}

/** Even-odd containment. */
export function pointInPolygon(p: Point, polygon: readonly Point[]): boolean {
	let inside = false;
	for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
		const a = polygon[i];
		const b = polygon[j];
		if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) {
			inside = !inside;
		}
	}
	return inside;
}

/**
 * The relation of two arbitrary (not necessarily convex) polygons: whether they
 * intersect or one contains the other, else the distance between them.
 */
export function polygonRelation(
	first: readonly Point[],
	second: readonly Point[],
	budget?: WorkBudget,
	kind: WorkKind = 'evaluation'
): { overlap: boolean; distance: number } {
	spend(budget, kind, first.length * second.length * 5);
	let distance = Infinity;
	for (let i = 0; i < first.length; i += 1) {
		const a = first[i];
		const b = first[(i + 1) % first.length];
		for (let j = 0; j < second.length; j += 1) {
			const c = second[j];
			const d = second[(j + 1) % second.length];
			if (segmentsProperlyIntersect(a, b, c, d)) return { overlap: true, distance: 0 };
			distance = Math.min(distance, segmentSegmentDistance(a, b, c, d));
		}
	}
	if (first.length && pointInPolygon(first[0], second)) return { overlap: true, distance: 0 };
	if (second.length && pointInPolygon(second[0], first)) return { overlap: true, distance: 0 };
	return { overlap: false, distance };
}

/** The distance from a segment to a polygon: 0 when it enters or touches. */
export function segmentPolygonDistance(
	a: Point,
	b: Point,
	polygon: readonly Point[],
	budget?: WorkBudget,
	kind: WorkKind = 'evaluation'
): number {
	spend(budget, kind, polygon.length * 3);
	let distance = Infinity;
	for (let i = 0; i < polygon.length; i += 1) {
		distance = Math.min(
			distance,
			segmentSegmentDistance(a, b, polygon[i], polygon[(i + 1) % polygon.length])
		);
		if (distance === 0) return 0;
	}
	if (pointInPolygon(a, polygon)) return 0;
	return distance;
}

export type Separation = {
	/** Signed edge-to-edge distance: negative when the shapes overlap, by their penetration depth. */
	gap: number;
	/** Unit direction that moves the second shape away from the first. */
	normal: Point;
};

/** Whether the polygon winds so its interior is to the left of each edge. */
function interiorSign(polygon: readonly Point[]): 1 | -1 {
	return signedArea(polygon) >= 0 ? 1 : -1;
}

/**
 * The signed separation of two convex polygons. Disjoint shapes report their
 * true distance; overlapping ones the (negative) penetration depth along the
 * axis that separates them soonest, so translating the second along `normal`
 * by `minimum - gap` leaves exactly `minimum` between them.
 */
export function convexSeparation(
	first: readonly Point[],
	second: readonly Point[],
	budget?: WorkBudget,
	kind: WorkKind = 'placement'
): Separation {
	const n = first.length;
	const m = second.length;
	spend(budget, kind, 2 * n * m);
	let best = -Infinity;
	let bestNormal: Point = { x: 1, y: 0 };
	const axes = (polygon: readonly Point[], other: readonly Point[], flip: number) => {
		const sign = interiorSign(polygon);
		for (let i = 0; i < polygon.length; i += 1) {
			const a = polygon[i];
			const b = polygon[(i + 1) % polygon.length];
			const length = Math.hypot(b.x - a.x, b.y - a.y);
			if (length < epsilon) continue;
			// Outward normal of this edge.
			const nx = (sign * (b.y - a.y)) / length;
			const ny = (sign * -(b.x - a.x)) / length;
			const offset = nx * a.x + ny * a.y;
			let nearest = Infinity;
			for (const q of other) nearest = Math.min(nearest, nx * q.x + ny * q.y);
			const separation = nearest - offset;
			if (separation > best) {
				best = separation;
				bestNormal = { x: nx * flip, y: ny * flip };
			}
		}
	};
	axes(first, second, 1);
	axes(second, first, -1);
	if (best <= 0) return { gap: best, normal: bestNormal };

	// Disjoint convex shapes: the closest approach is a vertex against an edge.
	spend(budget, kind, 2 * n * m);
	let distance = Infinity;
	let direction = bestNormal;
	const consider = (p: Point, a: Point, b: Point, flip: number) => {
		const dx = b.x - a.x;
		const dy = b.y - a.y;
		const lengthSquared = dx * dx + dy * dy;
		const t = lengthSquared
			? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSquared))
			: 0;
		const cx = a.x + t * dx;
		const cy = a.y + t * dy;
		const length = Math.hypot(p.x - cx, p.y - cy);
		if (length < distance) {
			distance = length;
			// `flip` points from the first shape toward the second.
			if (length > epsilon)
				direction = { x: ((p.x - cx) / length) * flip, y: ((p.y - cy) / length) * flip };
		}
	};
	for (const p of first) {
		for (let j = 0; j < m; j += 1) consider(p, second[j], second[(j + 1) % m], -1);
	}
	for (const q of second) {
		for (let i = 0; i < n; i += 1) consider(q, first[i], first[(i + 1) % n], 1);
	}
	return { gap: Math.max(distance, best), normal: direction };
}

/** A polygon grown outward by `margin`, for a convex input (mitred, clamped at sharp corners). */
export function inflateConvex(polygon: readonly Point[], margin: number): Point[] {
	if (polygon.length < 3 || margin === 0) return [...polygon];
	const sign = interiorSign(polygon);
	const normals = polygon.map((a, i) => {
		const b = polygon[(i + 1) % polygon.length];
		const length = Math.hypot(b.x - a.x, b.y - a.y) || 1;
		return { x: (sign * (b.y - a.y)) / length, y: (sign * -(b.x - a.x)) / length };
	});
	return polygon.map((vertex, i) => {
		const before = normals[(i + polygon.length - 1) % polygon.length];
		const after = normals[i];
		const bisector = { x: before.x + after.x, y: before.y + after.y };
		const factor = Math.max(1 + before.x * after.x + before.y * after.y, 0.25);
		return {
			x: vertex.x + (bisector.x / factor) * margin,
			y: vertex.y + (bisector.y / factor) * margin
		};
	});
}

/** A regular polygon that contains the disc, so tests against it are conservative. */
export function discPolygon(centre: Point, radius: number, sides = 16): Point[] {
	const reach = radius / Math.cos(Math.PI / sides);
	return Array.from({ length: sides }, (_, i) => {
		const angle = (i / sides) * Math.PI * 2;
		return { x: centre.x + Math.cos(angle) * reach, y: centre.y + Math.sin(angle) * reach };
	});
}

/**
 * The parameter interval over which a segment lies inside a convex polygon, or
 * undefined if it never does (tangency is not entry).
 */
export function segmentConvexInterval(
	a: Point,
	b: Point,
	polygon: readonly Point[]
): [number, number] | undefined {
	const sign = interiorSign(polygon);
	let enter = 0;
	let leave = 1;
	const dx = b.x - a.x;
	const dy = b.y - a.y;
	for (let i = 0; i < polygon.length; i += 1) {
		const p = polygon[i];
		const q = polygon[(i + 1) % polygon.length];
		const ex = q.x - p.x;
		const ey = q.y - p.y;
		// Inside is where `inside(t) >= 0`.
		const atStart = sign * (ex * (a.y - p.y) - ey * (a.x - p.x));
		const slope = sign * (ex * dy - ey * dx);
		if (Math.abs(slope) < epsilon) {
			if (atStart < 0) return undefined;
			continue;
		}
		const t = -atStart / slope;
		if (slope > 0) enter = Math.max(enter, t);
		else leave = Math.min(leave, t);
		if (enter > leave - 1e-9) return undefined;
	}
	return [enter, leave];
}

/**
 * Reduces a convex polygon to at most `max` vertices without ever shrinking it:
 * the shortest edge is dropped by extending its two neighbours until they meet,
 * which only adds area, so a test against the result stays conservative.
 */
export function simplifyConvex(polygon: readonly Point[], max: number): Point[] {
	let points = [...polygon];
	while (points.length > Math.max(3, max)) {
		let best: { index: number; point: Point; added: number } | undefined;
		const n = points.length;
		for (let i = 0; i < n; i += 1) {
			const a = points[(i + n - 1) % n];
			const b = points[i];
			const c = points[(i + 1) % n];
			const d = points[(i + 2) % n];
			const r = { x: b.x - a.x, y: b.y - a.y };
			const q = { x: d.x - c.x, y: d.y - c.y };
			const denominator = r.x * q.y - r.y * q.x;
			if (Math.abs(denominator) < epsilon) continue;
			const t = ((c.x - a.x) * q.y - (c.y - a.y) * q.x) / denominator;
			const u = ((c.x - a.x) * r.y - (c.y - a.y) * r.x) / denominator;
			// The extended edges must meet beyond both vertices they replace.
			if (t <= 1 || u >= 0) continue;
			const point = { x: a.x + t * r.x, y: a.y + t * r.y };
			const added = Math.abs(signedArea([b, point, c]));
			if (!best || added < best.added) best = { index: i, point, added };
		}
		if (!best) break;
		const i = best.index;
		const next: Point[] = [];
		for (let k = 0; k < n; k += 1) {
			if (k === i) next.push(best.point);
			else if (k !== (i + 1) % n) next.push(points[k]);
		}
		points = next;
	}
	return points;
}

/** A path through the waypoints with quadratic corners no larger than the rounding limit. */
export function roundedPath(points: readonly Point[], rounding: number): string {
	const fmt = (v: number) => Math.round(v * 100) / 100;
	let d = `M ${fmt(points[0].x)} ${fmt(points[0].y)}`;
	for (let i = 1; i < points.length; i += 1) {
		const here = points[i];
		const prev = points[i - 1];
		const next = points[i + 1];
		if (!next) {
			d += ` L ${fmt(here.x)} ${fmt(here.y)}`;
			continue;
		}
		const l1 = Math.hypot(here.x - prev.x, here.y - prev.y);
		const l2 = Math.hypot(next.x - here.x, next.y - here.y);
		const radius = Math.min(rounding, l1 / 4, l2 / 4);
		if (radius < 1e-6) {
			d += ` L ${fmt(here.x)} ${fmt(here.y)}`;
			continue;
		}
		const u1 = { x: (here.x - prev.x) / l1, y: (here.y - prev.y) / l1 };
		const u2 = { x: (next.x - here.x) / l2, y: (next.y - here.y) / l2 };
		d += ` L ${fmt(here.x - u1.x * radius)} ${fmt(here.y - u1.y * radius)}`;
		d += ` Q ${fmt(here.x)} ${fmt(here.y)} ${fmt(here.x + u2.x * radius)} ${fmt(here.y + u2.y * radius)}`;
	}
	return d;
}
