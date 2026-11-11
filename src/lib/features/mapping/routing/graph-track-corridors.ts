import type { Point } from '../graph-layout.ts';
import type { WorkBudget } from '../graph-work-budget.ts';

/** Tunable; reference CSS pixels (angle in degrees, count plain). */
export const trackSettings = {
	minTrackLengthPx: 120, // shorter ties are not worth a lane
	joinDistancePx: 28, // ties further apart than this are not "in the same corridor"
	minRunPx: 80, // a shared stretch shorter than this is not worth joining
	maxAngleDeg: 12, // near-parallel only
	maxTracks: 6, // a bundle wider than this reads as a ribbon
	trackStepPx: 6, // lane spacing; two 2 px cross-tie strokes then read as two lines with a 4 px gap, and detour lanes use the same step
	rampPx: 24, // minimum length of the ramp into and out of a lane
	roundingPx: 8 // the same corner softening the router uses
} as const;

export type TrackRoute = {
	id: string;
	source: string;
	target: string;
	waypoints: readonly Point[];
};
export type Leg = { id: string; index: number; a: Point; b: Point };

type Candidate = {
	id: string;
	leg: Leg;
	length: number;
	minX: number;
	maxX: number;
	minY: number;
	maxY: number;
};

function distance(a: Point, b: Point): number {
	return Math.hypot(b.x - a.x, b.y - a.y);
}

function byId(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

/** The longest waypoint segment of the route, in route direction (a = waypoints[index], b = waypoints[index+1]); undefined for fewer than two waypoints. Ties between equal lengths take the lowest index. */
export function longestLeg(route: TrackRoute): Leg | undefined {
	let best: Leg | undefined;
	let bestLength = -1;
	for (let index = 0; index + 1 < route.waypoints.length; index += 1) {
		const a = route.waypoints[index];
		const b = route.waypoints[index + 1];
		const length = distance(a, b);
		if (length > bestLength) {
			bestLength = length;
			best = { id: route.id, index, a, b };
		}
	}
	return best;
}

function polylineLength(route: TrackRoute): number {
	let total = 0;
	for (let index = 0; index + 1 < route.waypoints.length; index += 1) {
		total += distance(route.waypoints[index], route.waypoints[index + 1]);
	}
	return total;
}

function candidateOf(route: TrackRoute, unit: number): Candidate | undefined {
	const leg = longestLeg(route);
	if (!leg || polylineLength(route) < trackSettings.minTrackLengthPx * unit) return undefined;
	const length = distance(leg.a, leg.b);
	if (length < trackSettings.minRunPx * unit) return undefined;
	return {
		id: route.id,
		leg,
		length,
		minX: Math.min(leg.a.x, leg.b.x),
		maxX: Math.max(leg.a.x, leg.b.x),
		minY: Math.min(leg.a.y, leg.b.y),
		maxY: Math.max(leg.a.y, leg.b.y)
	};
}

/**
 * Whether two legs run side by side over a long enough stretch. The longer leg
 * is the reference; the other is measured against its line, so the test is
 * symmetric in the order the pair was found.
 */
function pairJoins(p: Candidate, q: Candidate, unit: number): boolean {
	const pIsReference = p.length !== q.length ? p.length > q.length : p.id < q.id;
	const reference = pIsReference ? p : q;
	const other = pIsReference ? q : p;
	const origin = reference.leg.a;
	const ux = (reference.leg.b.x - origin.x) / reference.length;
	const uy = (reference.leg.b.y - origin.y) / reference.length;
	const along = (pt: Point) => (pt.x - origin.x) * ux + (pt.y - origin.y) * uy;
	const across = (pt: Point) => Math.abs((pt.x - origin.x) * uy - (pt.y - origin.y) * ux);

	const oa = other.leg.a;
	const ob = other.leg.b;
	const ovx = (ob.x - oa.x) / other.length;
	const ovy = (ob.y - oa.y) / other.length;
	const cos = Math.min(1, Math.abs(ux * ovx + uy * ovy));
	if ((Math.acos(cos) * 180) / Math.PI > trackSettings.maxAngleDeg) return false;

	const tA = along(oa);
	const tB = along(ob);
	const low = Math.max(Math.min(0, reference.length), Math.min(tA, tB));
	const high = Math.min(Math.max(0, reference.length), Math.max(tA, tB));
	if (high - low < trackSettings.minRunPx * unit) return false;

	// Ties that converge are far apart at one end and together at the other: only the stretch
	// where they are within reach has to be long enough. The offset is linear along the run.
	const offsetAt = (t: number) => {
		const s = (t - tA) / (tB - tA);
		return across({ x: oa.x + s * (ob.x - oa.x), y: oa.y + s * (ob.y - oa.y) });
	};
	const reach = trackSettings.joinDistancePx * unit;
	const near = withinReach(offsetAt(low), offsetAt(high), low, high, reach);
	return near !== undefined && near.high - near.low >= trackSettings.minRunPx * unit;
}

/**
 * The part of [low, high] where an offset that changes linearly from `atLow` to
 * `atHigh` stays within `reach`; undefined when none of it does.
 */
function withinReach(
	atLow: number,
	atHigh: number,
	low: number,
	high: number,
	reach: number
): { low: number; high: number } | undefined {
	const lowNear = atLow <= reach;
	const highNear = atHigh <= reach;
	if (lowNear && highNear) return { low, high };
	if (!lowNear && !highNear) return undefined;
	const crossing = low + ((reach - atLow) / (atHigh - atLow)) * (high - low);
	return lowNear ? { low, high: crossing } : { low: crossing, high };
}

/**
 * Groups of route ids whose longest legs share a corridor. Each group has 2..maxTracks ids sorted ascending; groups are sorted by first id; a route is in at most one group. Throws WorkExhausted (from the budget) if the allowance runs out.
 */
export function findBundles(
	routes: readonly TrackRoute[],
	unit: number,
	budget: WorkBudget
): string[][] {
	const candidates = routes
		.toSorted((a, b) => byId(a.id, b.id))
		.map((route) => candidateOf(route, unit))
		.filter((candidate): candidate is Candidate => candidate !== undefined)
		.toSorted((a, b) => a.minX - b.minX || byId(a.id, b.id));

	const reach = trackSettings.joinDistancePx * unit;
	const pairs: [string, string][] = [];
	for (let i = 0; i < candidates.length; i += 1) {
		const p = candidates[i];
		for (let j = i + 1; j < candidates.length; j += 1) {
			const q = candidates[j];
			if (q.minX > p.maxX + reach) break;
			budget.spend('routing', 1);
			if (q.minY > p.maxY + reach || p.minY > q.maxY + reach) continue;
			budget.spend('routing', 8);
			if (pairJoins(p, q, unit)) {
				pairs.push(byId(p.id, q.id) < 0 ? [p.id, q.id] : [q.id, p.id]);
			}
		}
	}
	pairs.sort(([a1, b1], [a2, b2]) => byId(a1, a2) || byId(b1, b2));

	const parent = new Map<string, string>();
	const size = new Map<string, number>();
	for (const candidate of candidates) {
		parent.set(candidate.id, candidate.id);
		size.set(candidate.id, 1);
	}
	const root = (id: string): string => {
		let current = id;
		while (parent.get(current) !== current) current = parent.get(current) ?? current;
		return current;
	};
	for (const [a, b] of pairs) {
		const ra = root(a);
		const rb = root(b);
		if (ra === rb) continue;
		const combined = (size.get(ra) ?? 1) + (size.get(rb) ?? 1);
		if (combined > trackSettings.maxTracks) continue;
		parent.set(rb, ra);
		size.set(ra, combined);
	}

	const groups = new Map<string, string[]>();
	for (const candidate of candidates) {
		const key = root(candidate.id);
		groups.set(key, [...(groups.get(key) ?? []), candidate.id]);
	}
	return [...groups.values()]
		.filter((members) => members.length >= 2)
		.map((members) => members.toSorted(byId))
		.toSorted((a, b) => byId(a[0], b[0]));
}
