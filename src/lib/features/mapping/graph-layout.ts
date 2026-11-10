/**
 * Where the map draws its region hulls. The geometry is
 * deliberate — read the bullseye and Mapping ADRs before changing it.
 *
 * Group anchors no longer live here: the grouped arrangement is laid out by
 * `graph-arrangement.ts` (per-group stress bodies placed by the group physics),
 * so this module holds only the hull/region drawing helpers.
 */
import { isSystemRegion } from '#lib/shared/region-identity.ts';

export type Point = { x: number; y: number };

function crossProduct(origin: Point, a: Point, b: Point): number {
	return (a.x - origin.x) * (b.y - origin.y) - (a.y - origin.y) * (b.x - origin.x);
}

/** Monotone-chain convex hull. Returns points in clockwise order. */
export function convexHull(points: readonly Point[]): Point[] {
	if (points.length < 3) return [...points];

	const sorted = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
	const build = (input: readonly Point[]) => {
		const chain: Point[] = [];
		for (const point of input) {
			while (
				chain.length >= 2 &&
				crossProduct(chain[chain.length - 2], chain[chain.length - 1], point) <= 0
			) {
				chain.pop();
			}
			chain.push(point);
		}
		return chain;
	};

	const lower = build(sorted);
	const upper = build([...sorted].reverse());

	return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}

export function centroidOf(points: readonly Point[]): Point {
	if (points.length === 0) return { x: 0, y: 0 };

	return points.reduce(
		(total, point) => ({
			x: total.x + point.x / points.length,
			y: total.y + point.y / points.length
		}),
		{ x: 0, y: 0 }
	);
}

/** Pushes each hull vertex away from the given origin so the region clears the nodes. */
export function padHull(hull: readonly Point[], padding: number, origin: Point): Point[] {
	return hull.map((point) => {
		const dx = point.x - origin.x;
		const dy = point.y - origin.y;
		const length = Math.hypot(dx, dy) || 1;
		return {
			x: point.x + (dx / length) * padding,
			y: point.y + (dy / length) * padding
		};
	});
}

/** Points sampled around each vertex by `dilateHull`. Eight keeps the error under a tenth of the distance. */
const dilationSegments = 8;
/**
 * Grows a shape by a real distance in every direction. Radial padding from a distant origin
 * moves a vertex along one ray and can leave a neighbouring edge cutting inside the padding,
 * which is why containment is built on this instead: every input vertex is grown by a disc
 * that contains it, and the hull of those discs contains the whole input shape.
 */
export function dilateHull(points: readonly Point[], distance: number): Point[] {
	if (points.length === 0 || distance <= 0) return [...points];

	const grown = [...points];
	for (const point of points) {
		for (let step = 0; step < dilationSegments; step += 1) {
			const angle = (step / dilationSegments) * Math.PI * 2;
			grown.push({
				x: point.x + Math.cos(angle) * distance,
				y: point.y + Math.sin(angle) * distance
			});
		}
	}

	return convexHull(grown);
}

/** Consecutive hull points turning less than this (degrees) add nothing to the curve. */
const collinearToleranceDegrees = 8;

function thinCollinear(hull: readonly Point[]): Point[] {
	let points = [...hull];
	let changed = true;
	while (changed && points.length > 3) {
		changed = false;
		for (let index = 0; index < points.length; index += 1) {
			const previous = points[(index + points.length - 1) % points.length];
			const point = points[index];
			const next = points[(index + 1) % points.length];
			const turn = Math.abs(
				Math.atan2(
					(point.x - previous.x) * (next.y - point.y) - (point.y - previous.y) * (next.x - point.x),
					(point.x - previous.x) * (next.x - point.x) + (point.y - previous.y) * (next.y - point.y)
				)
			);
			if ((turn * 180) / Math.PI < collinearToleranceDegrees) {
				points = points.filter((_, other) => other !== index);
				changed = true;
				break;
			}
		}
	}
	return points;
}

const round = (value: number) => Math.round(value * 100) / 100;

/** A closed centripetal Catmull-Rom curve (alpha 0.5) through the points, as cubic segments. */
function smoothClosedPath(points: readonly Point[]): string {
	const count = points.length;
	const at = (index: number) => points[((index % count) + count) % count];
	let path = `M ${round(points[0].x)} ${round(points[0].y)}`;

	for (let index = 0; index < count; index += 1) {
		const p0 = at(index - 1);
		const p1 = at(index);
		const p2 = at(index + 1);
		const p3 = at(index + 2);
		// With alpha 0.5 the squared knot step is the chord length itself.
		const s1 = Math.hypot(p1.x - p0.x, p1.y - p0.y) || 1;
		const s2 = Math.hypot(p2.x - p1.x, p2.y - p1.y) || 1;
		const s3 = Math.hypot(p3.x - p2.x, p3.y - p2.y) || 1;
		const d1 = Math.sqrt(s1);
		const d2 = Math.sqrt(s2);
		const d3 = Math.sqrt(s3);
		const c1 = {
			x: (s1 * p2.x - s2 * p0.x + (2 * s1 + 3 * d1 * d2 + s2) * p1.x) / (3 * d1 * (d1 + d2)),
			y: (s1 * p2.y - s2 * p0.y + (2 * s1 + 3 * d1 * d2 + s2) * p1.y) / (3 * d1 * (d1 + d2))
		};
		const c2 = {
			x: (s3 * p1.x - s2 * p3.x + (2 * s3 + 3 * d3 * d2 + s2) * p2.x) / (3 * d3 * (d3 + d2)),
			y: (s3 * p1.y - s2 * p3.y + (2 * s3 + 3 * d3 * d2 + s2) * p2.y) / (3 * d3 * (d3 + d2))
		};
		path += ` C ${round(c1.x)} ${round(c1.y)} ${round(c2.x)} ${round(c2.y)} ${round(p2.x)} ${round(p2.y)}`;
	}

	return `${path} Z`;
}

function hullPath(hull: readonly Point[]): string {
	if (hull.length === 0) return '';
	const r = minRegionRadius;
	if (hull.length === 1) {
		const { x, y } = hull[0];
		return `M ${x - r} ${y} a ${r} ${r} 0 1 0 ${2 * r} 0 a ${r} ${r} 0 1 0 ${-2 * r} 0 Z`;
	}
	if (hull.length === 2) {
		const [a, b] = hull;
		const length = Math.hypot(b.x - a.x, b.y - a.y) || 1;
		const nx = (-(b.y - a.y) / length) * r;
		const ny = ((b.x - a.x) / length) * r;
		return (
			`M ${a.x + nx} ${a.y + ny} L ${b.x + nx} ${b.y + ny} A ${r} ${r} 0 0 0 ${b.x - nx} ${b.y - ny} ` +
			`L ${a.x - nx} ${a.y - ny} A ${r} ${r} 0 0 0 ${a.x + nx} ${a.y + ny} Z`
		);
	}

	return smoothClosedPath(thinCollinear(hull));
}

export type LabelAnchor = { x: number; y: number; textAnchor: 'start' | 'middle' | 'end' };

/** A drawn region: one group's, or one sub-group's. */
export type Region = {
	key: string;
	label: string;
	hull: Point[];
	/** The single closed outline of the region; drawn with a round line join for soft corners. */
	path: string;
	top: number;
	labelX: number;
	/** Where the label draws: the group's above its outline, a sub-group's just outside its own. */
	labelAt: LabelAnchor;
	displayLabel?: string;
	displayCount?: boolean;
	labelBox?: import('./graph-free-canvas.ts').Box;
	/** A bucket standing for an absent answer is never outlined. */
	outlined: boolean;
};

export type GroupRegion = Region & { subRegions: Region[] };

/** Bounds around every region hull and its rendered label anchor. */
export function regionsExtent(
	regions: readonly GroupRegion[],
	labelHeight: number
): import('./graph-free-canvas.ts').Box | undefined {
	let minX = Infinity;
	let minY = Infinity;
	let maxX = -Infinity;
	let maxY = -Infinity;
	const include = (point: Point) => {
		minX = Math.min(minX, point.x);
		minY = Math.min(minY, point.y);
		maxX = Math.max(maxX, point.x);
		maxY = Math.max(maxY, point.y);
	};
	for (const region of regions) {
		for (const point of region.hull) include(point);
		include({ x: region.labelAt.x, y: region.labelAt.y - labelHeight });
		for (const subRegion of region.subRegions) {
			for (const point of subRegion.hull) include(point);
			include({ x: subRegion.labelAt.x, y: subRegion.labelAt.y - labelHeight });
		}
	}
	if (minX === Infinity) return undefined;
	return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/** The value one worker holds at each level, `''` when it holds none. */
export type PlacedWorker = {
	x: number;
	y: number;
	group: string;
	subGroup: string;
};

export type RegionGroup = {
	value: string;
	label: string;
	subGroups: readonly { value: string; label: string }[];
};

/** Region keys must carry both levels, since one dimension alone is not unique. */
export function regionKey(value: string): string {
	return value || '__unassigned';
}

export function subRegionKey(group: string, subGroup: string): string {
	return `${regionKey(group)}::${regionKey(subGroup)}`;
}

/** A sub-group's outline clears its members by this much. */
export const regionPadding = 44;
/** The group's outline then grows this much further, around its sub-groups. */
export const groupRegionPadding = 28;
/** The smallest a region can be, so a lone worker still gets a readable shape. */
const minRegionRadius = 34;

/**
 * Members strung out in a line have no area to hull, so each is given a region the size
 * of the minimum region radius instead. Anything roomier is hulled as it is.
 */
function memberBounds(bounds: readonly Point[]): Point[] {
	const hull = convexHull(bounds);
	const width =
		Math.max(...hull.map((point) => point.x)) - Math.min(...hull.map((point) => point.x));
	const height =
		Math.max(...hull.map((point) => point.y)) - Math.min(...hull.map((point) => point.y));

	if (hull.length >= 3 && Math.min(width, height) >= minRegionRadius) return hull;

	return convexHull(
		bounds.flatMap((point) => [
			{ x: point.x - minRegionRadius, y: point.y },
			{ x: point.x, y: point.y - minRegionRadius },
			{ x: point.x + minRegionRadius, y: point.y },
			{ x: point.x, y: point.y + minRegionRadius }
		])
	);
}

function toRegion(
	key: string,
	label: string,
	hull: Point[],
	labelX: number,
	outlined: boolean
): Region {
	return {
		key,
		label,
		hull,
		path: hullPath(hull),
		top: Math.min(...hull.map((point) => point.y)),
		labelX,
		labelAt: { x: labelX, y: Math.min(...hull.map((point) => point.y)) - 20, textAnchor: 'middle' },
		outlined
	};
}

/** How far a sub-group's label stands off its outline. */
const subLabelStandoff = 10;
/** Rough label metrics, for keeping labels from colliding (the font is fixed). */
const subLabelCharWidth = 5.4;
const groupLabelCharWidth = 6.4;
const labelHeight = 12;

/** Where a ray from `origin` along unit `direction` leaves a convex hull. */
function exitDistance(hull: readonly Point[], origin: Point, direction: Point): number {
	let best = 0;
	for (let index = 0; index < hull.length; index += 1) {
		const a = hull[index];
		const b = hull[(index + 1) % hull.length];
		const ex = b.x - a.x;
		const ey = b.y - a.y;
		const denominator = direction.x * ey - direction.y * ex;
		if (Math.abs(denominator) < 1e-9) continue;
		const t = ((a.x - origin.x) * ey - (a.y - origin.y) * ex) / denominator;
		const u = ((a.x - origin.x) * direction.y - (a.y - origin.y) * direction.x) / denominator;
		if (t > best && u >= -1e-9 && u <= 1 + 1e-9) best = t;
	}
	return best;
}

/** Just outside the outline, on the ray from the group's centre through the sub-group's. */
function subLabelAnchor(hull: readonly Point[], groupCentre: Point, subCentre: Point): LabelAnchor {
	let dx = subCentre.x - groupCentre.x;
	let dy = subCentre.y - groupCentre.y;
	const length = Math.hypot(dx, dy);
	if (length < 1) {
		dx = 0;
		dy = -1;
	} else {
		dx /= length;
		dy /= length;
	}
	const reach = exitDistance(hull, subCentre, { x: dx, y: dy }) + subLabelStandoff;
	const x = subCentre.x + dx * reach;
	const y = subCentre.y + dy * reach;
	const textAnchor = dx > 0.35 ? 'start' : dx < -0.35 ? 'end' : 'middle';
	// Text sits above its baseline, so a label below the outline drops by its height.
	return { x, y: dy > 0.35 ? y + labelHeight - 2 : y, textAnchor };
}

type LabelBox = { left: number; right: number; top: number; bottom: number };

function labelBox(anchor: LabelAnchor, characters: number, charWidth: number): LabelBox {
	const width = characters * charWidth;
	const left =
		anchor.textAnchor === 'start'
			? anchor.x
			: anchor.textAnchor === 'end'
				? anchor.x - width
				: anchor.x - width / 2;
	return { left, right: left + width, top: anchor.y - labelHeight, bottom: anchor.y + 2 };
}

const overlaps = (a: LabelBox, b: LabelBox) =>
	a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

/**
 * Draws one region per group, each holding the regions of its sub-groups. A group's
 * outline is built around its sub-group outlines and grown by a real distance in every
 * direction, so no sub-group can fall outside its group. Groups the caller passes with
 * no sub-groups are drawn flat, which is what a map without a sub-grouping gets.
 */
export function layoutGroupRegions(
	groups: readonly RegionGroup[],
	workers: readonly PlacedWorker[]
): GroupRegion[] {
	return groups
		.map((group) => {
			const members = workers.filter((worker) => worker.group === group.value);
			if (members.length === 0) return undefined;

			const centre = centroidOf(members);
			const subRegions = group.subGroups
				.map((subGroup) => {
					const subMembers = members.filter((worker) => worker.subGroup === subGroup.value);
					if (subMembers.length === 0) return undefined;

					// Padded from the sub-group's own centre: padding it from the group's centre
					// would push its outline away from the very members it is meant to enclose.
					const subCentre = centroidOf(subMembers);
					const subHull = padHull(memberBounds(subMembers), regionPadding, subCentre);

					const region = toRegion(
						subRegionKey(group.value, subGroup.value),
						subGroup.label,
						subHull,
						subCentre.x,
						!isSystemRegion(subGroup.value)
					);
					region.labelAt = subLabelAnchor(subHull, centre, subCentre);
					return region;
				})
				.filter((subRegion) => subRegion !== undefined);

			const hull =
				subRegions.length > 0
					? dilateHull(
							convexHull(subRegions.flatMap((subRegion) => subRegion.hull)),
							groupRegionPadding
						)
					: padHull(memberBounds(members), regionPadding, centre);

			const region = toRegion(
				regionKey(group.value),
				group.label,
				hull,
				centre.x,
				!isSystemRegion(group.value)
			);
			// The group label stays above its outline, but lifts clear of any sub-group label
			// (the Unanswered one has no outline to keep it out of the way).
			for (const subRegion of subRegions) {
				const groupBox = labelBox(region.labelAt, group.label.length + 4, groupLabelCharWidth);
				const subBox = labelBox(subRegion.labelAt, subRegion.label.length + 4, subLabelCharWidth);
				if (overlaps(groupBox, subBox)) region.labelAt.y = subBox.top - 8;
			}
			return { ...region, subRegions };
		})
		.filter((group) => group !== undefined);
}
