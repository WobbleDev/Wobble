/**
 * The bullseye's ties, routed. Every tie leaves its inner dot straight out, turns
 * onto a circular lane in the space between two bands' rows, runs along it, and
 * turns straight out to the outer dot. Every segment is radial or circular, so
 * two ties can only cross at a right angle, and where they do the lane run breaks
 * under the radial leg. Read ADR-0012 before changing the rule.
 *
 * The lanes need room, and the room comes out of the bands: `bullseyeLayout`
 * measures how many lanes each zone needs, asks `bandLayout` for the shortfall on
 * the outer band's inner edge, and lays the dots out again, up to a cap. A tie
 * that still finds no lane is left to appear only while one of its ends is active.
 */
import { assessedOptions, type AssessmentOption, type Worker } from '#lib/domain-vocabulary.ts';
import {
	bandLayout,
	CHART_CENTER,
	DOT_FOOTPRINT,
	hostileTrackRadius,
	plotWorkerGroups,
	reachTree,
	tiePath,
	type BandLayout,
	type PlacedDot,
	type PlotGroup,
	type RelationshipTie,
	type RingNames
} from './bullseye-geometry.ts';

export interface RoutedTie extends RelationshipTie {
	/** Drawn only while one of its ends is hovered or focused. */
	revealOnly: boolean;
	/** Points (user units) where this tie's lane run passes under another tie's leg; the chart breaks the stroke there. */
	gaps: { x: number; y: number }[];
}

export interface BullseyeLayout {
	bands: BandLayout[];
	groups: PlotGroup[];
	ties: RoutedTie[];
	hostileRadius: number;
}

/** The radial step between neighbouring lanes in a zone, in user units. */
const LANE_PITCH = 2.2;

/** The least length a leg keeps between a dot's gap and its lane, in user units. */
const MIN_LEG = 0.5;

/** A tie whose ends are this close along the arc, at the zone's middle, is one straight line. */
const DIRECT_ARC = 3;

/** Angle added to each side of a lane run when asking whether two runs overlap, in radians. */
const RUN_PADDING = 0.06;

/** Extra clearance a radial leg keeps from a dot it does not join, beyond the dot's footprint. */
const LEG_MARGIN = 0.25;

/** The most room lanes may take out of the bands in all, in user units. */
const MAX_LANE_ROOM = 10;

/** How many times the bands are re-laid out to give lanes their room. */
const MAX_PASSES = 6;

/** A cap on lanes tried per zone, so measuring with no limit still ends. */
const MAX_LANES = 64;

const TAU = Math.PI * 2;

type Point = { x: number; y: number };
type Segment = { x1: number; y1: number; x2: number; y2: number };

interface Zone {
	lo: number;
	hi: number;
	mid: number;
}

interface Run {
	radius: number;
	/** Where the run starts, and which way it turns. */
	start: number;
	direction: 1 | -1;
	/** The arc it covers between its two corners, in radians. */
	span: number;
}

interface Candidate {
	id: string;
	from: PlacedDot;
	to: PlacedDot;
	inner: PlacedDot;
	outer: PlacedDot;
	innerBand: number;
	outerBand: number;
}

interface Routed {
	candidate: Candidate;
	d: string;
	revealOnly: boolean;
	zone: number | null;
	lane: number | null;
	run: Run | null;
	/** The straight stretches that can cross other ties' lane runs. */
	segments: Segment[];
}

const BAND_OF: Partial<Record<AssessmentOption, number>> = Object.fromEntries(
	assessedOptions.map((assessment, index) => [assessment, index])
);

const byId = (a: string, b: string): number => a.localeCompare(b);

const radiusOf = (dot: { cx: number; cy: number }): number =>
	Math.hypot(dot.cx - CHART_CENTER, dot.cy - CHART_CENTER);

const angleOf = (dot: { cx: number; cy: number }): number =>
	Math.atan2(dot.cy - CHART_CENTER, dot.cx - CHART_CENTER);

const pointAt = (radius: number, angle: number): Point => ({
	x: CHART_CENTER + Math.cos(angle) * radius,
	y: CHART_CENTER + Math.sin(angle) * radius
});

const fmt = (point: Point): string => `${+point.x.toFixed(2)} ${+point.y.toFixed(2)}`;

const wrap = (angle: number): number => ((angle % TAU) + TAU) % TAU;

/**
 * Every tie to draw: the reach tree's branches, then each Committee tie to a tree
 * worker that the tree leaves out. Trees come first, each in id order, so the
 * extras are the last to find a lane and the first to fall back.
 */
function tieCandidates(workers: Worker[], groups: PlotGroup[]): Candidate[] {
	const dots = new Map(
		groups.flatMap((group) => group.dots.map((dot) => [dot.worker.id, dot] as const))
	);
	const byWorkerId = new Map(workers.map((worker) => [worker.id, worker]));
	const tree = reachTree(workers);
	const pairs: { from: string; to: string }[] = [];
	for (const [childId, parentId] of [...tree].sort((a, b) =>
		byId(`${a[1]}--${a[0]}`, `${b[1]}--${b[0]}`)
	)) {
		pairs.push({ from: parentId, to: childId });
	}
	const extras: { from: string; to: string }[] = [];
	const members = workers.filter((worker) => worker.assessment === 'Leader');
	for (const childId of tree.keys()) {
		const child = byWorkerId.get(childId)!;
		for (const member of members) {
			if (member.id === tree.get(childId)) continue;
			if (!child.relationships.includes(member.id) && !member.relationships.includes(childId))
				continue;
			extras.push({ from: member.id, to: childId });
		}
	}
	extras.sort((a, b) => byId(`${a.from}--${a.to}`, `${b.from}--${b.to}`));

	const candidates: Candidate[] = [];
	for (const { from, to } of [...pairs, ...extras]) {
		const start = dots.get(from);
		const end = dots.get(to);
		const startBand = BAND_OF[start?.worker.assessment ?? 'Unassessed'];
		const endBand = BAND_OF[end?.worker.assessment ?? 'Unassessed'];
		if (!start || !end || startBand === undefined || endBand === undefined) continue;
		if (startBand === 0 && endBand === 0) continue;
		const flip = endBand < startBand;
		candidates.push({
			id: `${from}--${to}`,
			from: start,
			to: end,
			inner: flip ? end : start,
			outer: flip ? start : end,
			innerBand: Math.min(startBand, endBand),
			outerBand: Math.max(startBand, endBand)
		});
	}
	return candidates;
}

/**
 * The lane zones, one between each pair of neighbouring rows: Leader and
 * Activist, Activist and Supporter, Supporter and Disengaged, and Disengaged and
 * the Hostile track.
 */
function laneZones(bands: BandLayout[], groups: PlotGroup[]): Zone[] {
	const centre = (index: number) =>
		index < bands.length ? bands[index].centerlineRadius : hostileTrackRadius(bands);
	return [0, 1, 2, 3].map((index) => {
		const rowsIn = groups[index].dots.map(radiusOf);
		const rowsOut = groups[index + 1].dots.map(radiusOf);
		const inner = rowsIn.length > 0 ? Math.max(...rowsIn) : centre(index);
		const outer = rowsOut.length > 0 ? Math.min(...rowsOut) : centre(index + 1);
		const lo = inner + DOT_FOOTPRINT + 1;
		const hi = outer - DOT_FOOTPRINT - 1;
		return { lo, hi, mid: (lo + hi) / 2 };
	});
}

/** Lane radii, middle first and then alternately inside and outside it. */
function laneRadii(zone: Zone, limited: boolean): number[] {
	const radii: number[] = [];
	for (let step = 0; radii.length < MAX_LANES; step++) {
		const offsets = step === 0 ? [0] : [-step, step];
		for (const offset of offsets) {
			const radius = zone.mid + offset * LANE_PITCH;
			if (!limited || (radius >= zone.lo - 1e-9 && radius <= zone.hi + 1e-9)) radii.push(radius);
		}
		if (limited && step * LANE_PITCH > Math.abs(zone.hi - zone.lo) + LANE_PITCH) break;
	}
	return radii;
}

/** Whether two arcs of the circle, given by start and length, share any angle. */
function overlaps(a: { start: number; length: number }, b: { start: number; length: number }) {
	const offset = wrap(b.start - a.start);
	return offset <= a.length || TAU - offset <= b.length;
}

function distanceToSegment(dot: { cx: number; cy: number }, segment: Segment): number {
	const dx = segment.x2 - segment.x1;
	const dy = segment.y2 - segment.y1;
	const length2 = dx * dx + dy * dy;
	const t =
		length2 === 0
			? 0
			: Math.max(
					0,
					Math.min(1, ((dot.cx - segment.x1) * dx + (dot.cy - segment.y1) * dy) / length2)
				);
	return Math.hypot(dot.cx - (segment.x1 + t * dx), dot.cy - (segment.y1 + t * dy));
}

/** The route of one tie at lane radius `radius`, or null when its legs would run over a dot. */
function lanePath(candidate: Candidate, radius: number, dots: PlacedDot[]) {
	const { inner, outer } = candidate;
	const ru = radiusOf(inner);
	const rv = radiusOf(outer);
	const as = angleOf(inner);
	const delta = Math.atan2(Math.sin(angleOf(outer) - as), Math.cos(angleOf(outer) - as));
	const ae = as + delta;
	const direction = delta >= 0 ? 1 : -1;
	const s1 = Math.sign(radius - ru) || 1;
	const s2 = Math.sign(rv - radius) || 1;
	// A lane close to a dot gives up a little of the gap rather than turn back on itself.
	const start = Math.min(DOT_FOOTPRINT + 1, Math.abs(radius - ru) - MIN_LEG);
	const end = Math.min(DOT_FOOTPRINT + 1, Math.abs(rv - radius) - MIN_LEG);
	const p0 = pointAt(ru + s1 * start, as);
	const c1 = pointAt(radius, as);
	const c2 = pointAt(radius, ae);
	const p3 = pointAt(rv - s2 * end, ae);
	const legs: Segment[] = [
		{ x1: p0.x, y1: p0.y, x2: c1.x, y2: c1.y },
		{ x1: c2.x, y1: c2.y, x2: p3.x, y2: p3.y }
	];
	const blocked = dots.some(
		(dot) =>
			dot !== inner &&
			dot !== outer &&
			legs.some((leg) => distanceToSegment(dot, leg) < DOT_FOOTPRINT + LEG_MARGIN)
	);
	if (blocked) return null;
	// Square turns: the leg meets the lane at a corner, not a curve.
	const large = Math.abs(delta) > Math.PI ? 1 : 0;
	const sweep = direction > 0 ? 1 : 0;
	const d = `M ${fmt(p0)} L ${fmt(c1)} A ${+radius.toFixed(2)} ${+radius.toFixed(2)} 0 ${large} ${sweep} ${fmt(c2)} L ${fmt(p3)}`;
	const run: Run = { radius, start: as, direction, span: Math.abs(delta) };
	return { d, run, legs };
}

/**
 * Give every tie a route. Ties are taken in order and each takes the first lane
 * whose run overlaps no earlier one; `limited` keeps lanes to those that fit the
 * zone, and without it the zone is as wide as it needs to be, which is how the
 * room a zone asks for is measured.
 */
function routeTies(
	candidates: Candidate[],
	zones: Zone[],
	dots: PlacedDot[],
	limited: boolean
): { routed: Routed[]; needed: number[] } {
	const lanes = zones.map((zone) => laneRadii(zone, limited));
	const taken = zones.map((_, zone) =>
		lanes[zone].map(() => [] as { start: number; length: number }[])
	);
	const needed = zones.map(() => 0);
	const routed: Routed[] = [];
	const straight = (candidate: Candidate, revealOnly: boolean): Routed => {
		const { from, to } = candidate;
		return {
			candidate,
			d: tiePath(from, to, dots),
			revealOnly,
			zone: null,
			lane: null,
			run: null,
			segments: [{ x1: from.cx, y1: from.cy, x2: to.cx, y2: to.cy }]
		};
	};
	for (const candidate of candidates) {
		const { inner, outer, innerBand, outerBand } = candidate;
		const primary = innerBand === outerBand ? innerBand - 1 : innerBand;
		const options = [primary];
		for (let zone = innerBand; zone < outerBand; zone++) if (zone !== primary) options.push(zone);
		const as = angleOf(inner);
		const delta = Math.atan2(Math.sin(angleOf(outer) - as), Math.cos(angleOf(outer) - as));
		if (Math.abs(delta) * zones[primary].mid < DIRECT_ARC) {
			routed.push(straight(candidate, false));
			continue;
		}
		const interval = {
			start: wrap(Math.min(as, as + delta) - RUN_PADDING),
			length: Math.abs(delta) + RUN_PADDING * 2
		};
		let placed: Routed | null = null;
		for (const zone of options) {
			const lane = lanes[zone].findIndex(
				(_, index) => !taken[zone][index].some((other) => overlaps(interval, other))
			);
			if (lane < 0) continue;
			const radius = lanes[zone][lane];
			if (Math.abs(delta) * radius < MIN_LEG) continue;
			const path = lanePath(candidate, radius, dots);
			if (!path) continue;
			taken[zone][lane].push(interval);
			needed[zone] = Math.max(needed[zone], lane + 1);
			placed = {
				candidate,
				d: path.d,
				revealOnly: false,
				zone,
				lane,
				run: path.run,
				segments: path.legs
			};
			break;
		}
		routed.push(placed ?? straight(candidate, true));
	}
	return { routed, needed };
}

/** Where the circle of `radius` meets a segment, as points. */
function circleCrossings(segment: Segment, radius: number): Point[] {
	const dx = segment.x2 - segment.x1;
	const dy = segment.y2 - segment.y1;
	const fx = segment.x1 - CHART_CENTER;
	const fy = segment.y1 - CHART_CENTER;
	const a = dx * dx + dy * dy;
	if (a === 0) return [];
	const b = 2 * (fx * dx + fy * dy);
	const c = fx * fx + fy * fy - radius * radius;
	const discriminant = b * b - 4 * a * c;
	if (discriminant < 0) return [];
	const root = Math.sqrt(discriminant);
	return [(-b - root) / (2 * a), (-b + root) / (2 * a)]
		.filter((t, index, all) => t >= 0 && t <= 1 && (index === 0 || t !== all[0]))
		.map((t) => ({ x: segment.x1 + t * dx, y: segment.y1 + t * dy }));
}

/** The points where each drawn lane run passes under another tie that shares no end with it. */
function gapsFor(routed: Routed[]): Map<string, Point[]> {
	const drawn = routed.filter((tie) => !tie.revealOnly);
	const gaps = new Map<string, Point[]>();
	for (const tie of drawn) {
		const { run } = tie;
		if (!run) continue;
		const points: Point[] = [];
		for (const other of drawn) {
			if (other === tie) continue;
			const a = tie.candidate;
			const b = other.candidate;
			if (a.from === b.from || a.from === b.to || a.to === b.from || a.to === b.to) continue;
			for (const segment of other.segments) {
				for (const point of circleCrossings(segment, run.radius)) {
					const along = wrap(
						(Math.atan2(point.y - CHART_CENTER, point.x - CHART_CENTER) - run.start) * run.direction
					);
					if (along <= run.span) points.push(point);
				}
			}
		}
		gaps.set(tie.candidate.id, points);
	}
	return gaps;
}

/**
 * The bullseye as drawn: bands, dots and routed ties. The bands first give the
 * lanes the room they ask for. Each pass lays the chart out, routes the ties with
 * as many lanes as they need, and widens by the shortfall the zone that is short
 * of them; the room is capped, and what the last layout cannot fit falls back to
 * appearing on hover.
 */
export function bullseyeLayout(
	workers: Worker[],
	counts: Partial<Record<AssessmentOption, number>>,
	names: RingNames
): BullseyeLayout {
	const rooms = [0, 0, 0, 0];
	let bands = bandLayout(counts, rooms);
	let groups = plotWorkerGroups(workers, bands, names);
	for (let pass = 0; ; pass++) {
		const zones = laneZones(bands, groups);
		const dots = groups.flatMap((group) => group.dots);
		const { needed } = routeTies(tieCandidates(workers, groups), zones, dots, false);
		let grew = false;
		zones.forEach((zone, index) => {
			// The Hostile track has no band to widen, so its zone keeps the room it has.
			if (needed[index] === 0 || index + 1 >= bands.length) return;
			const shortfall = (needed[index] - 1) * LANE_PITCH - (zone.hi - zone.lo);
			if (shortfall <= 0.01) return;
			const total = rooms.reduce((sum, value) => sum + value, 0);
			const add = Math.min(shortfall + 0.5, MAX_LANE_ROOM - total);
			if (add <= 0.001) return;
			rooms[index + 1] += add;
			grew = true;
		});
		if (!grew) break;
		bands = bandLayout(counts, rooms);
		groups = plotWorkerGroups(workers, bands, names);
		if (pass === MAX_PASSES - 1) break;
	}

	const zones = laneZones(bands, groups);
	const dots = groups.flatMap((group) => group.dots);
	const { routed } = routeTies(tieCandidates(workers, groups), zones, dots, true);
	const gaps = gapsFor(routed);
	const ties: RoutedTie[] = routed
		.map(({ candidate, d, revealOnly }) => ({
			id: candidate.id,
			from: candidate.from.worker.id,
			to: candidate.to.worker.id,
			x1: candidate.from.cx,
			y1: candidate.from.cy,
			x2: candidate.to.cx,
			y2: candidate.to.cy,
			d,
			revealOnly,
			gaps: (gaps.get(candidate.id) ?? []).map((point) => ({
				x: +point.x.toFixed(2),
				y: +point.y.toFixed(2)
			}))
		}))
		.sort((a, b) => byId(a.id, b.id));
	return { bands, groups, ties, hostileRadius: hostileTrackRadius(bands) };
}
