import type { Point } from '../layout/graph-layout.ts';
import { roundedPath } from '../layout/graph-shapes.ts';
import { longestLeg, trackSettings, type Leg, type TrackRoute } from './graph-track-corridors.ts';
import type { WorkBudget } from '../layout/graph-work-budget.ts';

export type MemberPath = { id: string; lane: number; waypoints: Point[]; d: string };

/** Two ties must be this far apart (reference px) at both ends to count as crossing; closer ones are converging, not flipped. */
const flipTolerancePx = 1;

type Frame = {
	lo: number;
	hi: number;
	lateral: (id: string, t: number) => number;
	pointOn: (id: string, t: number) => Point;
	at: (t: number, l: number) => Point;
	/** True when the route's own direction runs against the corridor's t direction. */
	reversed: (id: string) => boolean;
};

function byId(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

function unitOf(leg: Leg): Point {
	const length = Math.hypot(leg.b.x - leg.a.x, leg.b.y - leg.a.y);
	return { x: (leg.b.x - leg.a.x) / length, y: (leg.b.y - leg.a.y) / length };
}

/**
 * The shared frame of a set of legs: t runs along the averaged direction, l
 * across it. Undefined when the members have no common t-range.
 */
function layout(
	ids: readonly string[],
	legs: ReadonlyMap<string, Leg>,
	reach: number
): Frame | undefined {
	const first = legs.get(ids[0])!;
	const firstDir = unitOf(first);
	let sx = 0;
	let sy = 0;
	for (const id of ids) {
		const dir = unitOf(legs.get(id)!);
		const sign = dir.x * firstDir.x + dir.y * firstDir.y < 0 ? -1 : 1;
		sx += sign * dir.x;
		sy += sign * dir.y;
	}
	const length = Math.hypot(sx, sy);
	const u = { x: sx / length, y: sy / length };
	const n = { x: -u.y, y: u.x };
	const o = first.a;
	const project = (p: Point) => ({
		t: (p.x - o.x) * u.x + (p.y - o.y) * u.y,
		l: (p.x - o.x) * n.x + (p.y - o.y) * n.y
	});

	let lo = -Infinity;
	let hi = Infinity;
	for (const id of ids) {
		const leg = legs.get(id)!;
		const ta = project(leg.a).t;
		const tb = project(leg.b).t;
		lo = Math.max(lo, Math.min(ta, tb));
		hi = Math.min(hi, Math.max(ta, tb));
	}
	if (hi - lo <= 0) return undefined;

	const lateralOf = (id: string, t: number) => {
		const leg = legs.get(id)!;
		const a = project(leg.a);
		const b = project(leg.b);
		return a.l + ((t - a.t) / (b.t - a.t)) * (b.l - a.l);
	};
	// Converging ties are far apart where they start: the lanes begin only where every member
	// is within reach of the others, and the ties stay on their own lines before that.
	const near = nearStretch(
		(t) => {
			const values = ids.map((id) => lateralOf(id, t));
			return Math.max(...values) - Math.min(...values);
		},
		lo,
		hi,
		// A chain of ties each within reach of the next spans up to (members - 1) reaches.
		reach * Math.max(1, ids.length - 1)
	);
	if (!near) return undefined;
	lo = near.low;
	hi = near.high;

	const pointOn = (id: string, t: number): Point => {
		const leg = legs.get(id)!;
		const ta = project(leg.a).t;
		const f = (t - ta) / (project(leg.b).t - ta);
		return {
			x: leg.a.x + f * (leg.b.x - leg.a.x),
			y: leg.a.y + f * (leg.b.y - leg.a.y)
		};
	};
	const lateral = (id: string, t: number) => {
		const leg = legs.get(id)!;
		const a = project(leg.a);
		const b = project(leg.b);
		return a.l + ((t - a.t) / (b.t - a.t)) * (b.l - a.l);
	};
	const at = (t: number, l: number): Point => ({
		x: o.x + t * u.x + l * n.x,
		y: o.y + t * u.y + l * n.y
	});
	const reversed = (id: string) => {
		const leg = legs.get(id)!;
		return project(leg.a).t > project(leg.b).t;
	};
	return { lo, hi, lateral, pointOn, at, reversed };
}

/**
 * The part of [low, high] where `spread` (convex: the widest gap among linear offsets)
 * stays within `reach`; undefined when none does. Fixed iteration counts, so it is
 * deterministic and bounded.
 */
function nearStretch(
	spread: (t: number) => number,
	low: number,
	high: number,
	reach: number
): { low: number; high: number } | undefined {
	let a = low;
	let b = high;
	for (let step = 0; step < 40; step += 1) {
		const m1 = a + (b - a) / 3;
		const m2 = b - (b - a) / 3;
		if (spread(m1) <= spread(m2)) b = m2;
		else a = m1;
	}
	const best = (a + b) / 2;
	if (spread(best) > reach) return undefined;
	const bisect = (inside: number, outside: number) => {
		let near = inside;
		let far = outside;
		for (let step = 0; step < 40; step += 1) {
			const mid = (near + far) / 2;
			if (spread(mid) <= reach) near = mid;
			else far = mid;
		}
		return near;
	};
	return {
		low: spread(low) <= reach ? low : bisect(best, low),
		high: spread(high) <= reach ? high : bisect(best, high)
	};
}

/** Pairs whose lateral order flips between the two ends of the corridor, counted per member. */
function flipCounts(ids: readonly string[], frame: Frame, tolerance: number): Map<string, number> {
	const counts = new Map(ids.map((id) => [id, 0]));
	for (let i = 0; i < ids.length; i += 1) {
		for (let j = i + 1; j < ids.length; j += 1) {
			const dLo = frame.lateral(ids[i], frame.lo) - frame.lateral(ids[j], frame.lo);
			const dHi = frame.lateral(ids[i], frame.hi) - frame.lateral(ids[j], frame.hi);
			const flips = dLo * dHi < 0 && Math.abs(dLo) > tolerance && Math.abs(dHi) > tolerance;
			if (!flips) continue;
			counts.set(ids[i], counts.get(ids[i])! + 1);
			counts.set(ids[j], counts.get(ids[j])! + 1);
		}
	}
	return counts;
}

export function buildBundlePaths(
	routes: ReadonlyMap<string, TrackRoute>,
	memberIds: readonly string[],
	unit: number,
	budget: WorkBudget
): MemberPath[] | undefined {
	const n = memberIds.length;
	budget.spend('routing', 16 * n * n + 32 * n);
	const legs = new Map<string, Leg>();
	for (const id of [...memberIds].sort(byId)) {
		const route = routes.get(id);
		const leg = route && longestLeg(route);
		if (leg) legs.set(id, leg);
	}

	let ids = [...legs.keys()];
	let frame: Frame | undefined;
	for (;;) {
		if (ids.length < 2) return undefined;
		frame = layout(ids, legs, trackSettings.joinDistancePx * unit);
		if (!frame) return undefined;
		budget.spend('routing', 8 * ids.length * ids.length);
		const counts = flipCounts(ids, frame, flipTolerancePx * unit);
		let worst: string | undefined;
		let worstCount = 0;
		for (const id of ids) {
			const count = counts.get(id)!;
			if (count > worstCount || (count === worstCount && count > 0 && id > worst!)) {
				worst = id;
				worstCount = count;
			}
		}
		if (!worst) break;
		ids = ids.filter((id) => id !== worst);
	}
	const f = frame!;

	const lanes = ids
		.map((id) => ({ id, at: f.lateral(id, f.lo) }))
		.sort((a, b) => a.at - b.at || byId(a.id, b.id));
	const k = lanes.length;
	const axisLo = median(ids.map((id) => f.lateral(id, f.lo)));
	const axisHi = median(ids.map((id) => f.lateral(id, f.hi)));
	const step = trackSettings.trackStepPx * unit;
	const axis = (t: number) => axisLo + ((t - f.lo) / (f.hi - f.lo)) * (axisHi - axisLo);
	const laneLine = (lane: number, t: number) => axis(t) + (lane - (k - 1) / 2) * step;

	const ramp = trackSettings.rampPx * unit;
	let deviation = 0;
	lanes.forEach(({ id }, lane) => {
		deviation = Math.max(
			deviation,
			Math.abs(f.lateral(id, f.lo) - laneLine(lane, f.lo)),
			Math.abs(f.lateral(id, f.hi) - laneLine(lane, f.hi))
		);
	});
	const R = Math.max(ramp, 2 * deviation);
	const s = f.lo + R;
	const e = f.hi - R;
	if (e - s < ramp) return undefined;

	return lanes.map(({ id }, lane) => {
		const route = routes.get(id)!;
		const leg = legs.get(id)!;
		const w = route.waypoints;
		const i = leg.index;
		const pLo = f.pointOn(id, f.lo);
		const lIn = f.at(s, laneLine(lane, s));
		const lOut = f.at(e, laneLine(lane, e));
		const pHi = f.pointOn(id, f.hi);
		const inserted = f.reversed(id) ? [pHi, lOut, lIn, pLo] : [pLo, lIn, lOut, pHi];
		const before = w.slice(0, i + 1);
		const after = w.slice(i + 1);
		const tooClose = (p: Point, q: Point) => Math.hypot(p.x - q.x, p.y - q.y) <= 1e-6 * unit;
		if (tooClose(inserted[0], before[before.length - 1])) inserted.shift();
		if (tooClose(inserted[inserted.length - 1], after[0])) inserted.pop();
		const waypoints = [...before, ...inserted, ...after];
		return {
			id,
			lane,
			waypoints,
			d: roundedPath(waypoints, trackSettings.roundingPx * unit)
		};
	});
}

function median(values: number[]): number {
	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}
