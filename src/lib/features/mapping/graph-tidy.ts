/**
 * A final, local tidy of a settled layout. Each Worker is nudged, one at a
 * time, to the nearby spot that best keeps the map's legibility rules: no tie
 * runs through a dot it does not end at, ties cross as little as possible and,
 * when they must, near their middles, and dots keep a comfortable gap. A pull
 * back toward the settled position keeps the layout's structure.
 *
 * Deterministic: Workers are visited in id order and candidates in a fixed order.
 */
import type { LeafBound } from './graph-leaf-placement.ts';
import type { StressPoint } from './graph-stress.ts';

type Tie = { source: string; target: string };

export type TidyOptions = {
	/** A Worker may not leave its bound, so groups and sub-groups keep their members. */
	bounds?: ReadonlyMap<string, LeafBound>;
	/** Clearance a tie keeps from a dot it does not end at. */
	clearance?: number;
	/** The gap between dots below which spacing is penalised. */
	spacing?: number;
	sweeps?: number;
};

const weights = {
	dotHit: 6,
	crossing: 1,
	endCrossing: 2,
	spacing: 3,
	cramped: 20,
	stretch: 2,
	facing: 0.5,
	anchor: 0.6
};
/** Ties × Workers above which the pass is skipped. */
const workBudget = 60_000;
/** A move must buy at least this much, so settled detail (leaf fans) is not nudged for nothing. */
const minimumGain = 0.25;
const directions = Array.from({ length: 8 }, (_, index) => {
	const angle = (index / 8) * Math.PI * 2;
	return { x: Math.cos(angle), y: Math.sin(angle) };
});

export function tidyLayout(
	positions: ReadonlyMap<string, StressPoint>,
	links: readonly Tie[],
	radiusFor: (id: string) => number,
	options: TidyOptions = {}
): Map<string, StressPoint> {
	const result = new Map([...positions].map(([id, p]) => [id, { x: p.x, y: p.y }]));
	const ties = links.filter(
		(tie) => tie.source !== tie.target && result.has(tie.source) && result.has(tie.target)
	);
	// The pass compares ties pairwise, so it is kept to workshop-sized maps;
	// a larger worksite keeps its settled layout untouched.
	if (ties.length === 0 || ties.length * result.size > workBudget) return result;
	const clearance = options.clearance ?? 4;
	const spacing = options.spacing ?? 40;
	const sweeps = options.sweeps ?? 8;

	const lengths = ties
		.map((tie) => distance(result.get(tie.source)!, result.get(tie.target)!))
		.sort((a, b) => a - b);
	const unit = Math.max(lengths[Math.floor(lengths.length / 2)], 1);
	const steps = [unit * 0.5, unit * 0.25, unit * 0.12];
	const reach = steps[0];

	const incident = new Map<string, Tie[]>();
	for (const tie of ties) {
		for (const id of [tie.source, tie.target]) {
			const list = incident.get(id) ?? [];
			list.push(tie);
			incident.set(id, list);
		}
	}
	const ids = [...result.keys()].sort();
	const origin = new Map([...result].map(([id, p]) => [id, { ...p }]));

	for (let sweep = 0; sweep < sweeps; sweep += 1) {
		let moved = false;
		for (const id of ids) {
			const own = incident.get(id) ?? [];
			// A leaf is fanned around its partner afterwards; moving it here would
			// only let it take the room its partner should step into. A pair (both
			// ends with one tie) is not fanned, so it tidies like anyone else.
			if (own.length === 1 && (incident.get(other(own[0], id))?.length ?? 0) > 1) continue;
			const here = result.get(id)!;
			// Only ties and dots near this Worker's reach can change its cost.
			const box = expand(boxOf([here, ...own.map((tie) => result.get(other(tie, id))!)]), reach);
			const nearTies = ties.filter((tie) =>
				overlaps(boxOf([result.get(tie.source)!, result.get(tie.target)!]), box)
			);
			const nearDots = ids.filter((dot) => dot !== id && inside(result.get(dot)!, box, reach));
			const cost = (p: StressPoint) =>
				costAt(id, p, own, nearTies, nearDots, result, radiusFor, {
					clearance,
					spacing,
					anchor: origin.get(id)!,
					unit,
					bound: options.bounds?.get(id)
				});
			let best = here;
			let bestCost = cost(here);
			for (const step of steps) {
				for (const direction of directions) {
					const candidate = { x: here.x + direction.x * step, y: here.y + direction.y * step };
					const bound = options.bounds?.get(id);
					if (
						bound &&
						distance(candidate, bound.centre) + radiusFor(id) > bound.radius + 1e-9 &&
						distance(candidate, bound.centre) > distance(here, bound.centre)
					)
						continue;
					const value = cost(candidate);
					if (value < bestCost - minimumGain) {
						best = candidate;
						bestCost = value;
					}
				}
			}
			if (best !== here) {
				result.set(id, best);
				moved = true;
			}
		}
		if (!moved) break;
	}
	return result;
}

function costAt(
	id: string,
	p: StressPoint,
	own: readonly Tie[],
	nearTies: readonly Tie[],
	nearDots: readonly string[],
	positions: ReadonlyMap<string, StressPoint>,
	radiusFor: (id: string) => number,
	settings: {
		clearance: number;
		spacing: number;
		anchor: StressPoint;
		unit: number;
		bound?: LeafBound;
	}
): number {
	const at = (dot: string) => (dot === id ? p : positions.get(dot)!);
	let cost = 0;
	// This dot sitting on a tie it does not end at.
	for (const tie of nearTies) {
		if (tie.source === id || tie.target === id) continue;
		if (distanceToSegment(p, at(tie.source), at(tie.target)) < radiusFor(id) + settings.clearance)
			cost += weights.dotHit;
	}
	// A bridge keeps facing out of its body toward the partner it reaches.
	const bound = settings.bound;
	if (bound) {
		const ox = p.x - bound.centre.x;
		const oy = p.y - bound.centre.y;
		const out = Math.hypot(ox, oy);
		for (const tie of own) {
			const partner = at(other(tie, id));
			const dx = partner.x - bound.centre.x;
			const dy = partner.y - bound.centre.y;
			const reach = Math.hypot(dx, dy);
			if (reach <= bound.radius || out < 1e-9) continue;
			cost += weights.facing * (1 - (ox * dx + oy * dy) / (out * reach));
		}
	}
	for (const tie of own) {
		const a = at(tie.source);
		const b = at(tie.target);
		// A tie stretched well past the typical length reads as a stray line.
		const stretch = distance(a, b) / settings.unit - 2;
		if (stretch > 0) cost += weights.stretch * stretch * stretch;
		// This dot's ties running through other dots.
		for (const dot of nearDots) {
			if (dot === tie.source || dot === tie.target) continue;
			if (distanceToSegment(at(dot), a, b) < radiusFor(dot) + settings.clearance)
				cost += weights.dotHit;
		}
		// This dot's ties crossing other ties, worse near either end.
		for (const otherTie of nearTies) {
			if (
				otherTie.source === tie.source ||
				otherTie.source === tie.target ||
				otherTie.target === tie.source ||
				otherTie.target === tie.target
			)
				continue;
			const crossing = crossingParameters(a, b, at(otherTie.source), at(otherTie.target));
			if (!crossing) continue;
			cost += weights.crossing;
			if (Math.min(crossing[0], 1 - crossing[0], crossing[1], 1 - crossing[1]) < 0.2)
				cost += weights.endCrossing;
		}
	}
	for (const dot of nearDots) {
		const gap = distance(p, at(dot)) - radiusFor(id) - radiusFor(dot);
		// Overlapping dots are never a fair trade.
		if (gap < 0) return Number.POSITIVE_INFINITY;
		if (gap < settings.spacing)
			cost += (weights.spacing * (settings.spacing - gap)) / settings.spacing;
		// Dots that nearly touch read as one: never trade that for a crossing.
		if (gap < settings.spacing / 2) cost += weights.cramped;
	}
	cost += weights.anchor * (distance(p, settings.anchor) / settings.unit) ** 2;
	return cost;
}

function other(tie: Tie, id: string): string {
	return tie.source === id ? tie.target : tie.source;
}

type Box = { minX: number; minY: number; maxX: number; maxY: number };

function boxOf(points: readonly StressPoint[]): Box {
	return {
		minX: Math.min(...points.map((p) => p.x)),
		minY: Math.min(...points.map((p) => p.y)),
		maxX: Math.max(...points.map((p) => p.x)),
		maxY: Math.max(...points.map((p) => p.y))
	};
}

function expand(box: Box, by: number): Box {
	return { minX: box.minX - by, minY: box.minY - by, maxX: box.maxX + by, maxY: box.maxY + by };
}

function overlaps(a: Box, b: Box): boolean {
	return a.minX <= b.maxX && b.minX <= a.maxX && a.minY <= b.maxY && b.minY <= a.maxY;
}

function inside(p: StressPoint, box: Box, by: number): boolean {
	return (
		p.x >= box.minX - by && p.x <= box.maxX + by && p.y >= box.minY - by && p.y <= box.maxY + by
	);
}

function distance(a: StressPoint, b: StressPoint): number {
	return Math.hypot(a.x - b.x, a.y - b.y);
}

function distanceToSegment(point: StressPoint, a: StressPoint, b: StressPoint): number {
	const dx = b.x - a.x;
	const dy = b.y - a.y;
	const lengthSquared = dx * dx + dy * dy;
	const t = lengthSquared
		? Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSquared))
		: 0;
	return distance(point, { x: a.x + t * dx, y: a.y + t * dy });
}

/** Where two segments properly cross, as a fraction along each; undefined if they do not. */
function crossingParameters(
	a: StressPoint,
	b: StressPoint,
	c: StressPoint,
	d: StressPoint
): [number, number] | undefined {
	const r = { x: b.x - a.x, y: b.y - a.y };
	const s = { x: d.x - c.x, y: d.y - c.y };
	const denominator = r.x * s.y - r.y * s.x;
	if (Math.abs(denominator) < 1e-12) return undefined;
	const t = ((c.x - a.x) * s.y - (c.y - a.y) * s.x) / denominator;
	const u = ((c.x - a.x) * r.y - (c.y - a.y) * r.x) / denominator;
	return t > 0 && t < 1 && u > 0 && u < 1 ? [t, u] : undefined;
}
