import type { Point } from './graph-layout.ts';
import {
	boundsOf,
	boxPolygon,
	boxesOverlap,
	convexSeparation,
	flattenPath,
	inflateBox,
	pointSegmentDistance,
	polygonRelation,
	segmentConvexInterval,
	segmentPolygonDistance,
	segmentsProperlyIntersect,
	type Box
} from './graph-shapes.ts';
import {
	compositionWorkLimits,
	createWorkBudget,
	WorkExhausted,
	type WorkBudget
} from './graph-work-budget.ts';
import type { CompositionPacket } from './graph-composition-types.ts';

export type QualityRelationship = { id: string; source: string; target: string };
export type QualityBody = { id: string; members: readonly string[] };
type QualityFootprint =
	| { kind: 'circle'; x: number; y: number; radius: number }
	| { kind: 'rect'; x: number; y: number; width: number; height: number };

type LayoutQualityInput = {
	positions: ReadonlyMap<string, Point>;
	links: readonly QualityRelationship[];
	/** Bodies are evaluated independently at each level (community, group, sub-group). */
	bodies: readonly QualityBody[];
	/** One worker-to-body partition per level. Only ties crossing a level count as outward. */
	outwardPartitions: readonly ReadonlyMap<string, string>[];
	canvas: { width: number; height: number };
	/** Dot radii in map units. Missing radii use 0, so callers must pass drawn radii for scoring. */
	radii?: ReadonlyMap<string, number>;
	/** Extra clearance around dot hulls. */
	bodyPadding?: number;
	/** Clearance a tie must keep from a dot it does not end at. */
	dotClearance?: number;
	/** Actual drawn dot/name footprints in frozen screen coordinates; ties and regions are excluded. */
	footprints?: readonly QualityFootprint[];
	/** Fixed screen-space sampling cell size (default 4px). */
	sampleSize?: number;
};

type LayoutQualityScore = {
	properCrossings: number;
	collinearOverlaps: number;
	longestToMedianRatio: number;
	bodyPassThroughs: number;
	/** Total outward Relationship length in map units. */
	outwardLength: number;
	/** Outward length divided by the Arrangement extent diagonal, invariant under uniform scaling. */
	normalizedOutwardLength: number;
	/** Crossings that land in the outer fifth of either tie, rather than near its middle. */
	endCrossings: number;
	/** Ties that pass through (or within the clearance of) a dot they do not end at. */
	dotHits: number;
	/** The smallest edge-to-edge gap between any two dots. */
	minimumDotGap: number;
	/** The smallest edge-to-edge gap between dots of different top-level bodies. */
	minimumBodyGap: number;
	/** The dots' bounding box area over the canvas area, after scaling the box to fit the canvas. */
	fill: number;
	/** |log(box aspect / canvas aspect)|: 0 when the arrangement has the canvas's shape. */
	aspectError: number;
	usefulCoverage: number;
	largestEmptyPocket: number;
};

type Segment = { id: string; source: string; target: string; a: Point; b: Point; length: number };
const epsilon = 1e-9;

/** Pure, evaluation-only geometry metrics for a settled Arrangement. */
export function scoreLayoutQuality(input: LayoutQualityInput): LayoutQualityScore {
	const segments: Segment[] = input.links.flatMap((link) => {
		const a = input.positions.get(link.source);
		const b = input.positions.get(link.target);
		return a && b
			? [{ id: link.id, source: link.source, target: link.target, a, b, length: distance(a, b) }]
			: [];
	});
	const lengths = segments.map(({ length }) => length).sort((a, b) => a - b);
	const median = lengths.length === 0 ? 0 : medianOfSorted(lengths);
	const longest = lengths.at(-1) ?? 0;
	const ratios = Number.isFinite(longest / (median || (longest ? Number.EPSILON : 1)))
		? longest / (median || (longest ? Number.EPSILON : 1))
		: Number.MAX_VALUE;
	let properCrossings = 0;
	let collinearOverlaps = 0;
	let endCrossings = 0;
	for (let i = 0; i < segments.length; i += 1) {
		for (let j = i + 1; j < segments.length; j += 1) {
			const first = segments[i];
			const second = segments[j];
			if (
				first.source === second.source ||
				first.source === second.target ||
				first.target === second.source ||
				first.target === second.target
			)
				continue;
			const intersection = classifyIntersection(first.a, first.b, second.a, second.b);
			if (intersection === 'cross') {
				properCrossings += 1;
				const [t, u] = crossingParameters(first.a, first.b, second.a, second.b);
				if (Math.min(t, 1 - t, u, 1 - u) < 0.2) endCrossings += 1;
			}
			if (intersection === 'overlap') collinearOverlaps += 1;
		}
	}
	const bodyPassThroughs = countPassThroughs(
		segments,
		input.bodies,
		input.positions,
		input.radii,
		input.bodyPadding ?? 0
	);
	let outwardLength = 0;
	for (const segment of segments) {
		for (const partition of input.outwardPartitions) {
			const aBody = partition.get(segment.source);
			const bBody = partition.get(segment.target);
			if (aBody !== undefined && bBody !== undefined && aBody !== bBody) {
				outwardLength += segment.length;
				break;
			}
		}
	}
	const points = [...input.positions.values()];
	const bounds =
		points.length === 0
			? { width: 0, height: 0 }
			: {
					width: Math.max(...points.map(({ x }) => x)) - Math.min(...points.map(({ x }) => x)),
					height: Math.max(...points.map(({ y }) => y)) - Math.min(...points.map(({ y }) => y))
				};
	const diagonal = Math.hypot(bounds.width, bounds.height);
	const radiusOf = (id: string) => Math.max(0, input.radii?.get(id) ?? 0);
	const clearance = input.dotClearance ?? 4;
	let dotHits = 0;
	for (const segment of segments) {
		for (const [id, centre] of input.positions) {
			if (id === segment.source || id === segment.target) continue;
			if (distanceToSegment(centre, segment.a, segment.b) < radiusOf(id) + clearance) dotHits += 1;
		}
	}
	const entries = [...input.positions];
	const topLevel = input.outwardPartitions[0];
	let minimumDotGap = Infinity;
	let minimumBodyGap = Infinity;
	for (let i = 0; i < entries.length; i += 1) {
		for (let j = i + 1; j < entries.length; j += 1) {
			const [aId, a] = entries[i];
			const [bId, b] = entries[j];
			const gap = distance(a, b) - radiusOf(aId) - radiusOf(bId);
			minimumDotGap = Math.min(minimumDotGap, gap);
			const aBody = topLevel?.get(aId);
			const bBody = topLevel?.get(bId);
			if (aBody !== undefined && bBody !== undefined && aBody !== bBody)
				minimumBodyGap = Math.min(minimumBodyGap, gap);
		}
	}
	const extent = boxOf(input.positions, input.radii);
	const canvasAspect = input.canvas.width / Math.max(input.canvas.height, epsilon);
	const boxAspect = extent.width / Math.max(extent.height, epsilon);
	const coverage = sampleFootprintCoverage(
		input.canvas,
		input.footprints ?? [],
		input.sampleSize ?? 4
	);
	return {
		fill:
			extent.width > 0 && extent.height > 0
				? Math.min(boxAspect / canvasAspect, canvasAspect / boxAspect)
				: 0,
		aspectError:
			extent.width > 0 && extent.height > 0 ? Math.abs(Math.log(boxAspect / canvasAspect)) : 0,
		endCrossings,
		dotHits,
		minimumDotGap: Number.isFinite(minimumDotGap) ? minimumDotGap : 0,
		minimumBodyGap: Number.isFinite(minimumBodyGap) ? minimumBodyGap : 0,
		properCrossings,
		collinearOverlaps,
		longestToMedianRatio: ratios,
		bodyPassThroughs,
		outwardLength,
		normalizedOutwardLength: diagonal > 0 ? outwardLength / diagonal : 0,
		...coverage
	};
}

/** Fixed-grid union measure; region fill and Relationship ink never enter it. */
function sampleFootprintCoverage(
	canvas: { width: number; height: number },
	footprints: readonly QualityFootprint[],
	step: number
): Pick<LayoutQualityScore, 'usefulCoverage' | 'largestEmptyPocket'> {
	if (!footprints.length || !(canvas.width > 0 && canvas.height > 0))
		return { usefulCoverage: 0, largestEmptyPocket: 0 };
	const cell = Math.max(1, step);
	const columns = Math.ceil(canvas.width / cell);
	const rows = Math.ceil(canvas.height / cell);
	const occupied = new Uint8Array(columns * rows);
	for (let row = 0; row < rows; row += 1) {
		for (let column = 0; column < columns; column += 1) {
			const x = (column + 0.5) * cell;
			const y = (row + 0.5) * cell;
			if (
				footprints.some((shape) =>
					shape.kind === 'circle'
						? (x - shape.x) ** 2 + (y - shape.y) ** 2 <= shape.radius ** 2
						: x >= shape.x &&
							x <= shape.x + shape.width &&
							y >= shape.y &&
							y <= shape.y + shape.height
				)
			)
				occupied[row * columns + column] = 1;
		}
	}
	let largestSide = 0;
	const squares = new Uint16Array(occupied.length);
	for (let row = 0; row < rows; row += 1) {
		for (let column = 0; column < columns; column += 1) {
			const index = row * columns + column;
			if (occupied[index]) continue;
			const left = column > 0 ? squares[index - 1] : 0;
			const above = row > 0 ? squares[index - columns] : 0;
			const diagonal = row > 0 && column > 0 ? squares[index - columns - 1] : 0;
			squares[index] = Math.min(left, above, diagonal) + 1;
			largestSide = Math.max(largestSide, squares[index]);
		}
	}
	return {
		usefulCoverage: occupied.reduce((sum, bit) => sum + bit, 0) / occupied.length,
		largestEmptyPocket: largestSide * largestSide * cell * cell
	};
}

function medianOfSorted(values: readonly number[]): number {
	const middle = Math.floor(values.length / 2);
	return values.length % 2 ? values[middle] : (values[middle - 1] + values[middle]) / 2;
}

function distance(a: Point, b: Point): number {
	return Math.hypot(a.x - b.x, a.y - b.y);
}

function distanceToSegment(point: Point, a: Point, b: Point): number {
	const dx = b.x - a.x;
	const dy = b.y - a.y;
	const lengthSquared = dx * dx + dy * dy;
	const t = lengthSquared
		? Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSquared))
		: 0;
	return distance(point, { x: a.x + t * dx, y: a.y + t * dy });
}

/** Where two properly crossing segments meet, as a fraction along each. */
/** The parameters of a proper crossing of segments a1-a2 and b1-b2, or null when they do not cross properly. */
export function properIntersectionParams(
	a1: Point,
	a2: Point,
	b1: Point,
	b2: Point
): { t: number; u: number } | null {
	if (classifyIntersection(a1, a2, b1, b2) !== 'cross') return null;
	const [t, u] = crossingParameters(a1, a2, b1, b2);
	return { t, u };
}

function crossingParameters(a: Point, b: Point, c: Point, d: Point): [number, number] {
	const r = { x: b.x - a.x, y: b.y - a.y };
	const s = { x: d.x - c.x, y: d.y - c.y };
	const denominator = r.x * s.y - r.y * s.x;
	const t = ((c.x - a.x) * s.y - (c.y - a.y) * s.x) / denominator;
	const u = ((c.x - a.x) * r.y - (c.y - a.y) * r.x) / denominator;
	return [t, u];
}

function orient(a: Point, b: Point, c: Point): number {
	return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

function classifyIntersection(
	a: Point,
	b: Point,
	c: Point,
	d: Point
): 'cross' | 'overlap' | 'none' {
	const abC = orient(a, b, c);
	const abD = orient(a, b, d);
	const cdA = orient(c, d, a);
	const cdB = orient(c, d, b);
	if (
		((abC > epsilon && abD < -epsilon) || (abC < -epsilon && abD > epsilon)) &&
		((cdA > epsilon && cdB < -epsilon) || (cdA < -epsilon && cdB > epsilon))
	)
		return 'cross';
	if (Math.abs(abC) > epsilon || Math.abs(abD) > epsilon) return 'none';
	const useX = Math.abs(b.x - a.x) >= Math.abs(b.y - a.y);
	const first = useX ? [a.x, b.x].sort((x, y) => x - y) : [a.y, b.y].sort((x, y) => x - y);
	const second = useX ? [c.x, d.x].sort((x, y) => x - y) : [c.y, d.y].sort((x, y) => x - y);
	return Math.min(first[1], second[1]) - Math.max(first[0], second[0]) > epsilon
		? 'overlap'
		: 'none';
}

function countPassThroughs(
	segments: readonly Segment[],
	bodies: readonly QualityBody[],
	positions: ReadonlyMap<string, Point>,
	radii: ReadonlyMap<string, number> | undefined,
	padding: number
): number {
	let count = 0;
	for (const body of bodies) {
		const memberSet = new Set(body.members);
		const hull = convexHull(
			body.members.flatMap((id) => {
				const centre = positions.get(id);
				if (!centre) return [];
				const radius = Math.max(0, radii?.get(id) ?? 0) + Math.max(0, padding);
				return Array.from({ length: 24 }, (_, index) => {
					const angle = (index / 24) * Math.PI * 2;
					return { x: centre.x + Math.cos(angle) * radius, y: centre.y + Math.sin(angle) * radius };
				});
			})
		);
		if (hull.length < 3) continue;
		for (const segment of segments) {
			if (memberSet.has(segment.source) || memberSet.has(segment.target)) continue;
			if (entersConvexHull(segment.a, segment.b, hull)) count += 1;
		}
	}
	return count;
}

/** Builds the convex hull of sampled dot circles; one/two members become a circle/capsule. */
function convexHull(points: Point[]): Point[] {
	const sorted = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
	if (sorted.length < 3) return sorted;
	const half = (values: Point[]) => {
		const result: Point[] = [];
		for (const point of values) {
			while (
				result.length >= 2 &&
				orient(result[result.length - 2], result[result.length - 1], point) <= 0
			)
				result.pop();
			result.push(point);
		}
		return result;
	};
	return [...half(sorted).slice(0, -1), ...half(sorted.reverse()).slice(0, -1)];
}

/** Convex half-plane clipping; a positive interior interval excludes mere tangency. */
function entersConvexHull(start: Point, end: Point, hull: readonly Point[]): boolean {
	let low = 0;
	let high = 1;
	for (let index = 0; index < hull.length; index += 1) {
		const a = hull[index];
		const b = hull[(index + 1) % hull.length];
		const atStart = orient(a, b, start);
		const atEnd = orient(a, b, end);
		if (atStart < -epsilon && atEnd < -epsilon) return false;
		if (atStart >= -epsilon && atEnd >= -epsilon) continue;
		const t = atStart / (atStart - atEnd);
		if (atStart < -epsilon) low = Math.max(low, t);
		else high = Math.min(high, t);
		if (high - low <= epsilon) return false;
	}
	return high - low > epsilon;
}

/** The dots' bounding box, radii included. */
function boxOf(positions: ReadonlyMap<string, Point>, radii?: ReadonlyMap<string, number>) {
	let minX = Infinity,
		minY = Infinity,
		maxX = -Infinity,
		maxY = -Infinity;
	for (const [id, p] of positions) {
		const r = radii?.get(id) ?? 0;
		minX = Math.min(minX, p.x - r);
		minY = Math.min(minY, p.y - r);
		maxX = Math.max(maxX, p.x + r);
		maxY = Math.max(maxY, p.y + r);
	}
	return Number.isFinite(minX)
		? { width: maxX - minX, height: maxY - minY }
		: { width: 0, height: 0 };
}

// ---------------------------------------------------------------------------
// The completed drawing: final paths, reserved text and regions together.

type DrawingRoute = { id: string; source: string; target: string; d: string };
type DrawingDot = { id: string; x: number; y: number; r: number };
type DrawingBox = { id: string; worker?: string; box: Box };
type DrawingRegion = {
	key: string;
	polygon: readonly Point[];
	outlined: boolean;
	/** The enclosing region's key for a sub-region; undefined for a top-level region. */
	parent?: string;
	/** The polygon is convex, so overlap and gaps can use the cheaper convex test. */
	convex?: boolean;
};

export type DrawingInput = {
	routes: readonly DrawingRoute[];
	dots: readonly DrawingDot[];
	/** Resting worker names as reserved boxes; a name belongs to the worker it names. */
	names: readonly DrawingBox[];
	headings: readonly DrawingBox[];
	/** Floating chrome that drawing must not run under: the Assessment key and the dot-size key. */
	chrome?: readonly DrawingBox[];
	/** Top-level regions, for separation and for ties that cross them. */
	regions: readonly DrawingRegion[];
	/** The region keys each Worker sits inside; a tie may traverse its ends' own regions. */
	workerRegions: ReadonlyMap<string, readonly string[]>;
	/** Map units per reference CSS pixel. */
	unit: number;
	/** Half the drawn stroke width, in reference pixels. */
	strokeHalfPx?: number;
	budget?: WorkBudget;
	/** Skip the checks that involve no tie (overlaps, unreadable text, outline gaps): for callers that only compare routes. */
	skipLayoutConflicts?: boolean;
};

export type DrawingEvaluation = {
	/** Unresolved route conflicts by identity `pair:obstacle`, kept in separate categories. */
	dotConflicts: string[];
	nameConflicts: string[];
	headingConflicts: string[];
	regionConflicts: string[];
	/** Hard layout conflicts that do not involve a tie: overlaps and unreadable text. */
	layoutConflicts: string[];
	/** Paths whose curve could not be certified, or that miss an endpoint. */
	invalidRoutes: string[];
	/** The smallest gap between two outlined regions, in map units; Infinity when fewer than two. */
	outlineGap: number;
	/** Pairs of Relationships that cross, counted once per pair; shared endpoints are not crossings. */
	properCrossings: number;
	/** Crossing pairs meeting at under 20 degrees. */
	shallowCrossings: number;
	/** Pairs running within 2 reference pixels of each other for at least 12. */
	sharedRuns: number;
	totalLength: number;
	longestLength: number;
	routeLengths: ReadonlyMap<string, number>;
};

const shallowAngle = (20 * Math.PI) / 180;
const sharedRunPx = 12;
const sharedWidthPx = 2;
const flattenPx = 0.5;
const evaluatedMaxSegments = 64;

type FlatRoute = DrawingRoute & { points: Point[]; certified: boolean };

/**
 * Reads the completed drawing back from final path data and reserved shapes,
 * independent of whatever produced it. Routes are flattened from their SVG `d`,
 * so a curve entering an obstacle between its waypoints is still found.
 */
export function evaluateDrawing(input: DrawingInput): DrawingEvaluation {
	const unit = input.unit;
	const strokeHalf = (input.strokeHalfPx ?? 1) * unit;
	const budget = input.budget;
	const spend = (amount: number) => budget?.spend('evaluation', amount);
	const flat: FlatRoute[] = input.routes.map((route) => {
		const flattened = flattenPath(route.d, flattenPx * unit, evaluatedMaxSegments);
		return {
			...route,
			points: flattened?.points ?? [],
			certified: Boolean(flattened?.certified)
		};
	});
	const dotById = new Map(input.dots.map((dot) => [dot.id, dot]));
	const invalidRoutes = flat
		.filter((route) => {
			const first = route.points[0];
			const last = route.points[route.points.length - 1];
			const a = dotById.get(route.source);
			const b = dotById.get(route.target);
			return (
				!route.certified ||
				!first ||
				!last ||
				!a ||
				!b ||
				Math.hypot(first.x - a.x, first.y - a.y) > 0.01 ||
				Math.hypot(last.x - b.x, last.y - b.y) > 0.01
			);
		})
		.map((route) => route.id);

	// Route against obstacles.
	const dotConflicts: string[] = [];
	const nameConflicts: string[] = [];
	const headingConflicts: string[] = [];
	const regionConflicts: string[] = [];
	const regionBounds = input.regions.map((region) => ({
		region,
		bounds: boundsOf(region.polygon)
	}));
	const dotCell = 64 * unit;
	const dotGrid = new Map<string, DrawingDot[]>();
	spend(input.dots.length * 4);
	for (const dot of input.dots) {
		for (
			let x = Math.floor((dot.x - dot.r) / dotCell);
			x <= Math.floor((dot.x + dot.r) / dotCell);
			x += 1
		) {
			for (
				let y = Math.floor((dot.y - dot.r) / dotCell);
				y <= Math.floor((dot.y + dot.r) / dotCell);
				y += 1
			) {
				const key = `${x},${y}`;
				const list = dotGrid.get(key);
				if (list) list.push(dot);
				else dotGrid.set(key, [dot]);
			}
		}
	}
	for (const route of flat) {
		if (route.points.length < 2) continue;
		const own = new Set([route.source, route.target]);
		const traversable = new Set([
			...(input.workerRegions.get(route.source) ?? []),
			...(input.workerRegions.get(route.target) ?? [])
		]);
		const dotsHit = new Set<string>();
		const namesHit = new Set<string>();
		const headingsHit = new Set<string>();
		const regionsHit = new Set<string>();
		for (let i = 1; i < route.points.length; i += 1) {
			const a = route.points[i - 1];
			const b = route.points[i];
			const box = boundsOf([a, b]);
			const cells: DrawingDot[] = [];
			const x0 = Math.floor((box.left - 24 * unit) / dotCell);
			const x1 = Math.floor((box.right + 24 * unit) / dotCell);
			const y0 = Math.floor((box.top - 24 * unit) / dotCell);
			const y1 = Math.floor((box.bottom + 24 * unit) / dotCell);
			spend((x1 - x0 + 1) * (y1 - y0 + 1));
			for (let x = x0; x <= x1; x += 1) {
				for (let y = y0; y <= y1; y += 1) cells.push(...(dotGrid.get(`${x},${y}`) ?? []));
			}
			spend(cells.length);
			for (const dot of cells) {
				if (own.has(dot.id) || dotsHit.has(dot.id)) continue;
				if (pointSegmentDistance(dot, a, b) < dot.r + strokeHalf) dotsHit.add(dot.id);
			}
			spend(input.names.length + input.headings.length);
			for (const name of input.names) {
				if (name.worker && own.has(name.worker)) continue;
				if (segmentConvexInterval(a, b, boxPolygon(inflateBox(name.box, strokeHalf)))) {
					namesHit.add(name.id);
				}
			}
			for (const heading of input.headings) {
				if (segmentConvexInterval(a, b, boxPolygon(inflateBox(heading.box, strokeHalf)))) {
					headingsHit.add(heading.id);
				}
			}
			for (const { region, bounds } of regionBounds) {
				if (!region.outlined || traversable.has(region.key) || regionsHit.has(region.key)) continue;
				if (
					box.right < bounds.left ||
					box.left > bounds.right ||
					box.bottom < bounds.top ||
					box.top > bounds.bottom
				)
					continue;
				if (segmentPolygonDistance(a, b, region.polygon, budget, 'evaluation') === 0) {
					regionsHit.add(region.key);
				}
			}
		}
		for (const id of dotsHit) dotConflicts.push(`${route.id}:${id}`);
		for (const id of namesHit) nameConflicts.push(`${route.id}:${id}`);
		for (const id of headingsHit) headingConflicts.push(`${route.id}:${id}`);
		for (const key of regionsHit) regionConflicts.push(`${route.id}:${key}`);
	}

	// Crossings, shallow crossings and shared runs between route pairs.
	type Seg = { route: number; a: Point; b: Point; id: number };
	const segments: Seg[] = [];
	flat.forEach((route, routeIndex) => {
		for (let i = 1; i < route.points.length; i += 1) {
			segments.push({
				route: routeIndex,
				a: route.points[i - 1],
				b: route.points[i],
				id: segments.length
			});
		}
	});
	const cell = 64 * unit;
	const grid = new Map<string, number[]>();
	spend(segments.length * 4);
	for (const segment of segments) {
		const box = boundsOf([segment.a, segment.b]);
		for (let x = Math.floor(box.left / cell); x <= Math.floor(box.right / cell); x += 1) {
			for (let y = Math.floor(box.top / cell); y <= Math.floor(box.bottom / cell); y += 1) {
				const key = `${x},${y}`;
				const list = grid.get(key);
				if (list) list.push(segment.id);
				else grid.set(key, [segment.id]);
			}
		}
	}
	const seen = new Set<number>();
	const crossed = new Set<string>();
	const shallow = new Set<string>();
	const runs = new Map<string, number>();
	for (const list of grid.values()) {
		spend((list.length * (list.length - 1)) / 2);
		for (let i = 0; i < list.length; i += 1) {
			for (let j = i + 1; j < list.length; j += 1) {
				const first = segments[list[i]];
				const second = segments[list[j]];
				if (first.route === second.route) continue;
				const token = first.id * segments.length + second.id;
				if (seen.has(token)) continue;
				seen.add(token);
				const r1 = flat[first.route];
				const r2 = flat[second.route];
				if (
					r1.source === r2.source ||
					r1.source === r2.target ||
					r1.target === r2.source ||
					r1.target === r2.target
				)
					continue;
				const pair = `${Math.min(first.route, second.route)}:${Math.max(first.route, second.route)}`;
				const d1 = { x: first.b.x - first.a.x, y: first.b.y - first.a.y };
				const d2 = { x: second.b.x - second.a.x, y: second.b.y - second.a.y };
				const l1 = Math.hypot(d1.x, d1.y);
				const l2 = Math.hypot(d2.x, d2.y);
				if (l1 < epsilon || l2 < epsilon) continue;
				const angle = Math.acos(Math.min(1, Math.abs(d1.x * d2.x + d1.y * d2.y) / (l1 * l2)));
				if (segmentsProperlyIntersect(first.a, first.b, second.a, second.b)) {
					crossed.add(pair);
					if (angle < shallowAngle) shallow.add(pair);
				} else if (angle < (8 * Math.PI) / 180) {
					// Near-parallel: how much of the two runs lie within the shared width of each other.
					const unitDirection = { x: d1.x / l1, y: d1.y / l1 };
					const along = (p: Point) =>
						(p.x - first.a.x) * unitDirection.x + (p.y - first.a.y) * unitDirection.y;
					const lateral = (p: Point) =>
						Math.abs((p.x - first.a.x) * unitDirection.y - (p.y - first.a.y) * unitDirection.x);
					if (
						lateral(second.a) <= sharedWidthPx * unit &&
						lateral(second.b) <= sharedWidthPx * unit
					) {
						const lo = Math.max(0, Math.min(along(second.a), along(second.b)));
						const hi = Math.min(l1, Math.max(along(second.a), along(second.b)));
						if (hi > lo) runs.set(pair, (runs.get(pair) ?? 0) + (hi - lo));
					}
				}
			}
		}
	}
	const sharedRuns = [...runs.values()].filter((length) => length >= sharedRunPx * unit).length;

	const routeLengths = new Map<string, number>();
	let totalLength = 0;
	let longestLength = 0;
	for (const route of flat) {
		let length = 0;
		for (let i = 1; i < route.points.length; i += 1)
			length += distance(route.points[i - 1], route.points[i]);
		routeLengths.set(route.id, length);
		totalLength += length;
		longestLength = Math.max(longestLength, length);
	}

	// Layout conflicts that involve no tie.
	const layoutConflicts: string[] = [];
	let outlineGap = Infinity;
	if (!input.skipLayoutConflicts) {
		const dots = input.dots;
		// Dots only meet dots in the same cell neighbourhood: linear in the dots, not quadratic.
		const meetCell = Math.max(dotCell, 2 * Math.max(0, ...dots.map((dot) => dot.r)));
		const near = new Map<string, number[]>();
		dots.forEach((dot, index) => {
			const key = `${Math.floor(dot.x / meetCell)},${Math.floor(dot.y / meetCell)}`;
			const list = near.get(key);
			if (list) list.push(index);
			else near.set(key, [index]);
		});
		spend(dots.length * 9);
		for (let i = 0; i < dots.length; i += 1) {
			const cx = Math.floor(dots[i].x / meetCell);
			const cy = Math.floor(dots[i].y / meetCell);
			for (let x = cx - 1; x <= cx + 1; x += 1) {
				for (let y = cy - 1; y <= cy + 1; y += 1) {
					const others = near.get(`${x},${y}`) ?? [];
					spend(others.length);
					for (const j of others) {
						if (j <= i) continue;
						if (distance(dots[i], dots[j]) < dots[i].r + dots[j].r) {
							layoutConflicts.push(`dots:${dots[i].id}:${dots[j].id}`);
						}
					}
				}
			}
		}
		const texts = [
			...input.names.map((name) => ({ kind: 'name', ...name })),
			...input.headings.map((heading) => ({ kind: 'heading', ...heading }))
		];
		spend(texts.length * dots.length + (texts.length * (texts.length - 1)) / 2);
		for (const text of texts) {
			for (const dot of dots) {
				const nearestX = Math.max(text.box.left, Math.min(dot.x, text.box.right));
				const nearestY = Math.max(text.box.top, Math.min(dot.y, text.box.bottom));
				if (Math.hypot(nearestX - dot.x, nearestY - dot.y) < dot.r) {
					layoutConflicts.push(`${text.kind}-dot:${text.id}:${dot.id}`);
				}
			}
		}
		for (let i = 0; i < texts.length; i += 1) {
			for (let j = i + 1; j < texts.length; j += 1) {
				if (boxesOverlap(texts[i].box, texts[j].box)) {
					layoutConflicts.push(`${texts[i].kind}-${texts[j].kind}:${texts[i].id}:${texts[j].id}`);
				}
			}
		}
		for (const chrome of input.chrome ?? []) {
			for (const text of texts) {
				if (boxesOverlap(text.box, chrome.box)) {
					layoutConflicts.push(`chrome-${text.kind}:${text.id}:${chrome.id}`);
				}
			}
			for (const dot of dots) {
				const nearestX = Math.max(chrome.box.left, Math.min(dot.x, chrome.box.right));
				const nearestY = Math.max(chrome.box.top, Math.min(dot.y, chrome.box.bottom));
				if (Math.hypot(nearestX - dot.x, nearestY - dot.y) < dot.r) {
					layoutConflicts.push(`chrome-dot:${dot.id}:${chrome.id}`);
				}
			}
		}
		const outlined = input.regions.filter((region) => region.outlined);
		for (let i = 0; i < outlined.length; i += 1) {
			for (let j = i + 1; j < outlined.length; j += 1) {
				// Only regions at one level can overlap: children live inside their parent.
				if (outlined[i].parent !== outlined[j].parent) continue;
				let overlap: boolean;
				let gap: number;
				if (outlined[i].convex && outlined[j].convex) {
					gap = convexSeparation(
						outlined[i].polygon,
						outlined[j].polygon,
						budget,
						'evaluation'
					).gap;
					overlap = gap <= 0;
				} else {
					const relation = polygonRelation(outlined[i].polygon, outlined[j].polygon, budget);
					overlap = relation.overlap;
					gap = relation.overlap ? 0 : relation.distance;
				}
				outlineGap = Math.min(outlineGap, gap);
				if (overlap) {
					layoutConflicts.push(`regions:${outlined[i].key}:${outlined[j].key}`);
				}
			}
		}
		for (const heading of input.headings) {
			for (const { region, bounds } of regionBounds) {
				if (!region.outlined || !boxesOverlap(heading.box, { ...bounds })) continue;
				if (heading.id === region.key) continue;
				// A sub-heading stands inside its own group, and a group may enclose its children.
				if (region.parent !== undefined || heading.id.split('::')[0] === region.key) continue;
				const headingOverlap = region.convex
					? convexSeparation(boxPolygon(heading.box), region.polygon, budget, 'evaluation').gap <= 0
					: polygonRelation(boxPolygon(heading.box), region.polygon, budget).overlap;
				if (headingOverlap) {
					layoutConflicts.push(`heading-region:${heading.id}:${region.key}`);
				}
			}
		}
	}

	return {
		dotConflicts: dotConflicts.sort(),
		nameConflicts: nameConflicts.sort(),
		headingConflicts: headingConflicts.sort(),
		regionConflicts: regionConflicts.sort(),
		layoutConflicts: layoutConflicts.sort(),
		invalidRoutes,
		outlineGap,
		properCrossings: crossed.size,
		shallowCrossings: shallow.size,
		sharedRuns,
		totalLength,
		longestLength,
		routeLengths
	};
}

/** The conflict report a completed drawing publishes. */
export type ReportConflicts = CompositionPacket['conflicts'];

/**
 * The conflicts the rendered drawing publishes: the composition-time conflict set with
 * its route contacts re-read against the dots, name boxes and headings the renderer
 * actually used. The composition evaluation still selects candidates; it is no longer
 * the source of the published reading, because the renderer may re-place a packet name
 * or lay headings out at a camera other than the packet's own fit.
 */
export function publishedConflicts(input: {
	conflicts: ReportConflicts;
	drawing: DrawingInput;
}): ReportConflicts {
	try {
		// This runs at render time, so it gets its own bounded allowance and skips the
		// layout checks the report discards: only the four route-contact categories below
		// are re-read, and the layout categories stay the composition reading.
		const evaluation = evaluateDrawing({
			...input.drawing,
			skipLayoutConflicts: true,
			budget: createWorkBudget(compositionWorkLimits)
		});
		return {
			...input.conflicts,
			dot: evaluation.dotConflicts,
			name: evaluation.nameConflicts,
			heading: evaluation.headingConflicts,
			region: evaluation.regionConflicts
		};
	} catch (error) {
		if (!(error instanceof WorkExhausted)) throw error;
		// An exhausted reading publishes the composition-time report unchanged, exactly
		// as it did before the renderer re-read its own boxes.
		return input.conflicts;
	}
}
